import { Transaction } from '@mysten/sui/transactions';
import { net } from './config.js';
import { readCeremony } from './chain.js';
import { fundingSecretMatches } from '../crypto/funding_secret.js';
import { readFundingConfig } from './funding-config.js';
import { signTransaction } from '../crypto/identity.js';
import { FundingError, normalizeFundingAddress, trackedPayout, withRunLock } from './funding-store.js';
import { fundingDefaults } from '../../../cli/src/funding-policy.js';

export async function buildFundingTransaction({ client, owner, network, packageId, ceremonyId, capId, address, enroll, sui = fundingDefaults(network).sui, wal = fundingDefaults(network).wal }) {
  const tx = new Transaction();
  tx.setSender(owner);
  if (enroll) tx.moveCall({
    target: `${packageId}::groth16_phase2::add_contributors`,
    arguments: [tx.object(capId), tx.object(ceremonyId), tx.pure.vector('address', [address])],
  });
  if (sui > 0n) tx.transferObjects([tx.splitCoins(tx.gas, [tx.pure.u64(sui)])[0]], tx.pure.address(address));
  if (wal > 0n) {
    let cursor = null, total = 0n;
    const coins = [];
    do {
      const page = await client.core.listCoins({ owner, coinType: net(network).walCoinType, cursor });
      for (const coin of page.objects) {
        coins.push(coin); total += BigInt(coin.balance);
        if (total >= wal) break;
      }
      cursor = page.hasNextPage ? page.cursor : null;
    } while (total < wal && cursor);
    if (total < wal) throw new FundingError(503, 'organizer has insufficient WAL; contact the organizer');
    const primary = tx.object(coins[0].objectId);
    if (coins.length > 1) tx.mergeCoins(primary, coins.slice(1).map((coin) => tx.object(coin.objectId)));
    tx.transferObjects([tx.splitCoins(primary, [tx.pure.u64(wal)])[0]], tx.pure.address(address));
  }
  return tx;
}

function transactionOutcome(result, digest) {
  const t = result.Transaction || result.FailedTransaction;
  if (!t || t.digest !== digest) return null;
  if (result.FailedTransaction || t.status?.success === false) return 'failed';
  return t.status?.success === true ? 'funded' : null;
}

export function createFundingService({ client, keypair, workdir, network, packageId, ceremonyId, capId, airdrop = fundingDefaults(network) }) {
  ceremonyId = normalizeFundingAddress(ceremonyId);
  const scope = `${network}:${ceremonyId}`;
  function authorize(secret) {
    const config = readFundingConfig(workdir, network, ceremonyId);
    if (!config || !fundingSecretMatches(secret, config.secret)) throw new FundingError(404, 'funding endpoint unavailable');
    if (!config.enabled) throw new FundingError(403, 'automatic funding is disabled; contact the organizer');
  }
  async function fund(address, { automatic = false, secret, enroll = true, topUp = false, sui = airdrop.sui, wal = airdrop.wal } = {}) {
    address = normalizeFundingAddress(address);
    const payoutScope = topUp ? `${scope}:top-up` : scope;
    return withRunLock(workdir, async (store) => {
      const check = async () => {
        if (automatic) authorize(secret);
        const head = await readCeremony(client, ceremonyId);
        if (automatic && head.phase?.['@variant'] !== 'Phase2Contribute') {
          throw new FundingError(409, 'ceremony is not accepting contributions');
        }
        if (typeof head.permissioned !== 'boolean') throw new Error('ceremony object missing permissioned field');
        return head;
      };
      await check();
      const operations = {
        prepare: async () => {
          const head = await check();
          if (!automatic && enroll && !head.permissioned) {
            throw new FundingError(409, 'manual enroll requires a permissioned ceremony; use fund for permissionless ceremonies');
          }
          const tx = await buildFundingTransaction({ client, owner: keypair.toSuiAddress(), network, packageId, ceremonyId, capId, address, enroll: enroll && head.permissioned, sui, wal });
          const bytes = await tx.build({ client });
          const { signature } = await signTransaction(keypair, bytes);
          const digest = await Transaction.from(bytes).getDigest();
          return { bytes: Buffer.from(bytes).toString('base64'), signature, digest, sui: String(sui), wal: String(wal) };
        },
        lookup: async (record) => transactionOutcome(await client.core.getTransaction({ digest: record.digest }), record.digest),
        beforeSend: check,
        send: async (record) => {
          const result = await client.core.executeTransaction({ transaction: Buffer.from(record.bytes, 'base64'), signatures: [record.signature], include: { effects: true } });
          const outcome = transactionOutcome(result, record.digest);
          if (outcome === 'funded') await client.core.waitForTransaction({ digest: record.digest });
          return outcome;
        },
      };
      // Explicit top-ups are repeatable and separate from enrollment eligibility.
      if (topUp) {
        const existing = store.get(scope, address);
        if (existing?.status === 'prepared') {
          throw new FundingError(409, 'resolve the pending enrollment payout before a manual top-up');
        }
        // A separate slot preserves any enrollment receipt. Re-running fund
        // first resolves an ambiguous previous top-up rather than sending twice.
        const previous = store.get(payoutScope, address);
        if (previous?.status === 'funded') store.put(payoutScope, address, { ...previous, status: 'failed', reason: 'new_manual_top_up' });
        const result = await trackedPayout(store, payoutScope, address, operations);
        return result;
      }
      return trackedPayout(store, scope, address, operations);
    }, { resume: { scope: payoutScope, address } });
  }
  return {
    authorize,
    fund,
    async request(secret, body) {
      authorize(secret);
      if (!body || body.network !== network || typeof body.ceremonyId !== 'string' || normalizeFundingAddress(body.ceremonyId) !== ceremonyId) {
        throw new FundingError(400, 'funding URL does not match the ceremony and network');
      }
      const result = await fund(body.address, { automatic: true, secret });
      return { ok: true, status: 'funded', digest: result.digest };
    },
  };
}
