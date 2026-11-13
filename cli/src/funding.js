import { normalizeSuiAddress, normalizeStructTag } from '@mysten/sui/utils';

const FUNDING_DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

// The private URL is deliberately never included in errors, logs, or state.
export function selectFundingMode(options, env = process.env) {
  if (options['funding-url'] != null && !options['funding-url'].trim()) {
    throw new Error('--funding-url is empty; CEREMONY_FUNDING_URL may be unset or empty in this terminal. Set it to the organizer\'s private funding URL, or omit --funding-url to fund the wallet yourself.');
  }
  const url = options['funding-url'] || env.CEREMONY_FUNDING_URL;
  if (options['self-funded'] && url) throw new Error('choose either --self-funded or --funding-url; unset CEREMONY_FUNDING_URL when self-funding');
  if (url) { validateFundingUrl(url); return { mode: 'automatic', url }; }
  return { mode: 'self-funded' };
}

// Use existing funds first. Only a confirmed payout through the private URI
// creates refund provenance; merely supplying a URI does not.
export async function ensureFunding(client, context, {
  fundingUrl, receipt, minSui, minWal, saveReceipt, waitForFunds,
  log = () => {}, request = requestFunding,
}) {
  const hasFunds = async () => {
    const [sui, wal] = await Promise.all([
      client.core.getBalance({ owner: context.address, coinType: '0x2::sui::SUI' }),
      client.core.getBalance({ owner: context.address, coinType: context.walCoinType }),
    ]);
    return BigInt(sui.balance.balance) >= minSui && BigInt(wal.balance.balance) >= minWal;
  };
  const previous = matchingFundingReceipt(receipt, context);
  let funding = previous?.refundDigest ? null : previous;
  if (funding) funding = await verifyFundingReceipt(client, funding.digest, context);
  if (await hasFunds()) return funding;
  if (!fundingUrl) {
    await waitForFunds();
    return funding;
  }
  log('requesting automatic enrollment and funding…');
  const digest = await request(fundingUrl, {
    address: context.address, ceremonyId: context.ceremonyId, network: context.network,
  }, { log });
  funding = await verifyFundingReceipt(client, digest, context);
  if (previous?.refundDigest && previous.digest === digest) {
    throw new Error('this address has already received and refunded its payout; fund the address yourself or ask the organizer for a manual top-up');
  }
  // Save before checking balances: a confirmed but already spent payout still
  // belongs to the organizer, including when the next attempt omits the URI.
  await saveReceipt(funding);
  log(`enrollment and funding confirmed (${digest})`, 'success');
  if (!await hasFunds()) {
    throw new Error('this address has already received its payout but has insufficient remaining funds; ask the organizer for a manual top-up');
  }
  return funding;
}

// Bind funding to this key, ceremony, network, and organizer. An old workdir
// without a receipt is not evidence of funding, even in a permissioned ceremony.
function matchingFundingReceipt(receipt, { network, ceremonyId, address, organizer }) {
  if (!receipt || receipt.version !== 1 || receipt.network !== network || !FUNDING_DIGEST.test(receipt.digest || '')) return null;
  for (const [key, expected] of Object.entries({ ceremonyId, address, organizer })) {
    if (!expected || typeof receipt[key] !== 'string' || normalizeSuiAddress(receipt[key]) !== normalizeSuiAddress(expected)) return null;
  }
  return receipt;
}

// A funding endpoint's response alone must not authorize sweeping a wallet.
// Confirm that the organizer actually paid this address on this network.
async function verifyFundingReceipt(client, digest, { network, ceremonyId, address, organizer, walCoinType }) {
  if (!FUNDING_DIGEST.test(digest || '')) throw new Error('invalid funding transaction digest');
  const result = await client.core.waitForTransaction({ digest, include: { transaction: true, balanceChanges: true } });
  const tx = result.Transaction;
  if (result.FailedTransaction || !tx || tx.digest !== digest || tx.status?.success !== true) {
    throw new Error('funding transaction did not succeed');
  }
  if (!organizer || !tx.transaction?.sender || normalizeSuiAddress(tx.transaction.sender) !== normalizeSuiAddress(organizer)) {
    throw new Error('funding transaction was not sent by the ceremony organizer');
  }
  const recipient = normalizeSuiAddress(address);
  const balance = (coinType) => (tx.balanceChanges || [])
    .filter((change) => normalizeSuiAddress(change.address) === recipient && normalizeStructTag(change.coinType) === normalizeStructTag(coinType))
    .reduce((sum, change) => sum + BigInt(change.amount), 0n);
  const sui = balance('0x2::sui::SUI'), wal = balance(walCoinType);
  if (sui < 0n || wal < 0n || (sui === 0n && wal === 0n)) {
    throw new Error('funding transaction did not credit SUI/WAL to this contribution address');
  }
  return {
    version: 1, network, ceremonyId: normalizeSuiAddress(ceremonyId), address: recipient,
    organizer: normalizeSuiAddress(organizer), digest, sui: String(sui), wal: String(wal),
  };
}

export function validatePublicCoordinatorUrl(value) {
  if (!value) return;
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid public coordinator URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /\/fund(?:\/|$)/.test(decodeURIComponent(url.pathname))) {
    throw new Error('use --funding-url for the private URL; coordinator-url must be public');
  }
}

// The organizer builds the funding link from the coordinator URL on-chain.
// A different host means that the link belongs to a different ceremony.
export function requireFundingLinkForCeremony(fundingUrl, coordinatorUrl) {
  const link = validateFundingUrl(fundingUrl);
  if (!coordinatorUrl) return;
  let coordinator;
  try { coordinator = new URL(coordinatorUrl); } catch { return; }
  if (link.origin !== coordinator.origin) {
    throw new Error('this funding link is for a different ceremony; ask the organizer for the link to this ceremony');
  }
}

export function validateFundingUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid private funding URL'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('private funding URL requires HTTPS (except localhost)');
  }
  if (url.username || url.password || url.search || url.hash || !/^\/fund\/[a-f0-9]{64}$/.test(url.pathname)) {
    throw new Error('invalid private funding URL; obtain it using the organizer funding-url command');
  }
  return url;
}

export async function requestFunding(value, body, { fetchFn = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = () => {}, attempts = 60 } = {}) {
  const url = validateFundingUrl(value);
  let failure = 'no funding confirmation received';
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await fetchFn(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch { failure = 'could not reach the funding endpoint (connection failed or timed out)'; }
    if (response) {
      failure = response.ok ? 'funding endpoint returned an invalid confirmation' : `funding endpoint returned HTTP ${response.status}`;
      if ([502, 503, 504].includes(response.status)) failure += '; the coordinator may be unavailable';
      if (response.status === 403) throw new Error('automatic funding is disabled; contact the organizer or rerun without a funding URL for manual funding');
      if (response.status === 404) throw new Error('private funding URL is invalid or unavailable; obtain the current URL from the organizer');
      if (response.status === 400) throw new Error('funding request does not match this ceremony/network or contribution address');
      if (response.status === 409) throw new Error('ceremony is not accepting automatic enrollment; contact the organizer');
      if (response.ok) {
        let result;
        try { result = await response.json(); } catch { /* retry invalid response */ }
        if (result?.ok === true && result.status === 'funded' && FUNDING_DIGEST.test(result.digest)) {
          return result.digest;
        }
      } else if (response.status < 500 && response.status !== 429) {
        throw new Error('funding request rejected; contact the organizer');
      }
    }
    if (attempt + 1 < attempts) {
      log(`${failure}; retrying automatic funding for the same address in 5s (${attempt + 1}/${attempts})…`, 'waiting');
      await sleep(5000);
    }
  }
  throw new Error(`automatic funding is still unconfirmed: ${failure}; rerun with the same workdir to resume safely`);
}
