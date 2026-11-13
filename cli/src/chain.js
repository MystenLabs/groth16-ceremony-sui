// Contributor's view of the ceremony contract: read the head, claim the slot,
// submit a contribution. Plumbing around the Move calls; crypto stays in crypto.js.

import { signTransaction } from './crypto.js';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

const CLOCK = '0x6';
const DEFAULT_POLL_SECONDS = 30;

export function parsePollInterval(value = DEFAULT_POLL_SECONDS) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 2_147_483) {
    throw new Error('--poll-interval must be a whole number of seconds between 1 and 2147483');
  }
  return seconds * 1000;
}

function hexBytes(hex) {
  if (!/^[0-9a-fA-F]{128}$/.test(hex || '')) throw new Error('contribution hash must be 64-byte hex');
  return Array.from(Buffer.from(hex, 'hex'));
}

function isPermissioned(j) {
  if (typeof j.permissioned !== 'boolean') throw new Error('ceremony object missing permissioned field');
  return j.permissioned;
}

// Read the head + slot from the shared Ceremony object (parsed via include:{json}).
// The package id is recovered from the object's type, so the contributor only
// needs the ceremony object id.
export async function readHead(client, ceremonyId) {
  const { object } = await client.core.getObject({ objectId: ceremonyId, include: { json: true } });
  const m = /^(0x[0-9a-fA-F]+)::groth16_phase2::Ceremony$/.exec(object.type || '');
  if (!m) throw new Error(`${ceremonyId} is not a ceremony (type ${object.type})`);
  const j = object.json;
  const phase = j.phase?.['@variant'] || 'Setup';
  const permissioned = isPermissioned(j);
  return {
    packageId: m[1],
    headSharedBlobId: j.head_blob_id, // SharedBlob object id; resolve to content id to download
    organizer: j.organizer || null,   // refund target when organizer funding is verified
    permissionless: !permissioned,
    allowlist: j.allowlist?.contents ?? j.allowlist?.fields?.contents ?? [], // enforced only while permissioned (retained across set_access_mode)
    phase,
    started: phase !== 'Setup',
    finalized: phase === 'Phase2Beacon' || phase === 'Closed',
    closed: phase === 'Closed',
    coordinatorUrl: j.coordinator_url || null,
    slot: j.slot?.['@variant'] || 'Open',
    slotWho: j.slot?.who || null,
    slotBlobId: j.slot?.blob_id || null,
    slotContributionHash: j.slot?.contribution_hash ? Buffer.from(j.slot.contribution_hash, 'base64').toString('hex') : null,
    slotUntil: j.slot?.until_ms != null ? Number(j.slot.until_ms) : null, // Claimed deadline (ms)
    slotDurationMs: j.slot_duration_ms != null ? Number(j.slot_duration_ms) : null, // claim window; absent on older packages
    chainLen: Array.isArray(j.chain) ? j.chain.length : Number(j.chain ?? 0),
    // Accepted contributions, oldest first. `contributors` holds normalized addresses.
    chain: Array.isArray(j.chain) ? j.chain.map((e) => ({
      contributor: e.contributor || null,
      // Remove control characters. A name must not change the terminal.
      name: (e.name || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ''),
      contributionHash: e.contribution_hash ? Buffer.from(e.contribution_hash, 'base64').toString('hex') : null,
      tsMs: e.ts_ms != null ? Number(e.ts_ms) : null,
      sharedBlobId: e.blob_id || null, // SharedBlob object id, not the Walrus blob id
    })) : [],
    contributors: Array.isArray(j.chain) ? j.chain.map((e) => (e.contributor ? normalizeSuiAddress(e.contributor) : null)) : [],
  };
}

// Poll until the just-submitted contribution is accepted (head == ours) or
// rejected (our Pending slot moves on without becoming head). Returns
// 'accepted' | 'rejected' | 'timeout'. When the submit digest is provided, it is
// enough evidence that our Pending slot existed even if this poll loop missed it.
// Read the ceremony, and try again after a failed read. One fullnode error is usually temporary.
export async function readHeadWithRetry(client, ceremonyId, { tries = 3, waitMs = 2000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await readHead(client, ceremonyId); }
    catch (e) {
      if (attempt >= tries) throw e;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

export async function awaitVerdict(client, ceremonyId, mySharedBlobId, { timeoutMs = 600_000, pollMs = 5000, submitDigest = null } = {}) {
  if (submitDigest) await client.core.waitForTransaction({ digest: submitDigest });
  const deadline = Date.now() + timeoutMs;
  let sawMinePending = !!submitDigest;
  for (;;) {
    const h = await readHeadWithRetry(client, ceremonyId);
    if (h.headSharedBlobId === mySharedBlobId) return 'accepted';
    if (h.slot === 'Pending') {
      if (h.slotBlobId === mySharedBlobId) sawMinePending = true;
      else if (sawMinePending) return 'rejected'; // another pending replaced ours
    } else if (sawMinePending) {
      return 'rejected'; // our pending was cleared and we're not the head
    }
    if (Date.now() > deadline) return 'timeout';
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// Sweep this key's leftover funds back to `refundAddr`: all WAL, plus all SUI
// minus the gas this very tx spends (via transferObjects([tx.gas])). Throwaway
// keys hold one coin of each, so this drains them to dust. Returns the digest.
export async function sweepFunds(client, keypair, walCoinType, refundAddr) {
  const owner = keypair.toSuiAddress();
  const [suiRes, walRes] = await Promise.all([
    client.core.listCoins({ owner, coinType: '0x2::sui::SUI' }),
    client.core.listCoins({ owner, coinType: walCoinType }),
  ]);
  const walCoins = walRes.objects || [];
  if (!(suiRes.objects || []).length) return { skipped: 'no SUI to pay gas', wal: walCoins.length };
  const tx = new Transaction();
  const sweep = [tx.gas]; // the SUI remainder after this tx pays its own gas
  if (walCoins.length) {
    const primary = tx.object(walCoins[0].objectId);
    if (walCoins.length > 1) tx.mergeCoins(primary, walCoins.slice(1).map((c) => tx.object(c.objectId)));
    sweep.unshift(primary); // all WAL, merged
  }
  tx.transferObjects(sweep, tx.pure.address(refundAddr)); // WAL + leftover SUI, one command
  const digest = await exec(client, keypair, tx);
  return { digest, wal: walCoins.length };
}

async function exec(client, keypair, tx) {
  tx.setSender(keypair.toSuiAddress());
  const built = await tx.build({ client });
  const { signature } = await signTransaction(keypair, built);
  const res = await client.core.executeTransaction({ transaction: built, signatures: [signature], include: { effects: true } });
  const t = res.Transaction || res.FailedTransaction;
  if (res.FailedTransaction || t?.status?.success === false) {
    throw new Error(`tx failed: ${JSON.stringify(t?.status?.error || res)}`);
  }
  return t.digest;
}

export function claim(client, keypair, packageId, ceremonyId) {
  const tx = new Transaction();
  tx.moveCall({ target: `${packageId}::groth16_phase2::claim`, arguments: [tx.object(ceremonyId), tx.object(CLOCK)] });
  return exec(client, keypair, tx);
}

// Reopen an expired slot and claim it in one atomic PTB — so no one can snipe the
// slot between the reopen and the claim. Aborts (ENotExpired) if not actually past
// the deadline on-chain.
export function expireAndClaim(client, keypair, packageId, ceremonyId) {
  const tx = new Transaction();
  tx.moveCall({ target: `${packageId}::groth16_phase2::expire`, arguments: [tx.object(ceremonyId), tx.object(CLOCK)] });
  tx.moveCall({ target: `${packageId}::groth16_phase2::claim`, arguments: [tx.object(ceremonyId), tx.object(CLOCK)] });
  return exec(client, keypair, tx);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chainTimeMs(client) {
  const { object } = await client.core.getObject({ objectId: CLOCK, include: { json: true } });
  const value = object.json?.timestamp_ms;
  const now = value == null ? NaN : Number(value);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('cannot read the Sui clock; refusing to assume the claim is live');
  return now;
}

function claimRemainingMs(head, now) {
  if (!Number.isSafeInteger(head.slotUntil) || head.slotUntil < 0) throw new Error('claimed slot is missing a valid expiry time');
  return head.slotUntil - now;
}

// Wait until the single contribution slot is ours, then return. Polls the slot,
// claiming when it's Open (or reopening a claim that blew its deadline), and
// busy-waits with a message while another contributor holds it or is being
// verified. If a claim is sniped between "saw Open" and our tx, it just loops.
// Use Sui's clock, with a short buffer before attempting expiration. Throws if the
// ceremony finalizes/closes while we wait, or after too many failed attempts.
// A permissioned ceremony that does not list us is checked before every claim
// rather than left to the on-chain ENotAllowed abort: the organizer can flip a
// live ceremony to permissioned (set_access_mode), and each aborted claim would
// otherwise cost gas and read as a lost race. Checking only at claim time still
// lets the organizer enroll us while the slot is busy.
export async function claimWhenOpen(client, keypair, packageId, ceremonyId, myAddr, { pollMs = DEFAULT_POLL_SECONDS * 1000, bufferMs = 10_000, log = () => {}, onWaiting = () => {}, checkHealth = async () => {} } = {}) {
  let fails = 0;
  for (;;) {
    const h = await readHeadWithRetry(client, ceremonyId);
    if (h.closed || h.finalized) throw new Error('ceremony is finalized/closed; no further contributions accepted');
    const ours = h.slot === 'Claimed' && h.slotWho === myAddr;
    if (ours) await checkHealth(h);
    // Check the deadline after the HTTP request: it may expire while we wait.
    const remainingMs = h.slot === 'Claimed' ? claimRemainingMs(h, await chainTimeMs(client)) : null;
    if (ours && remainingMs > 0) {
      log(`your turn: ${Math.floor(remainingMs / 60_000)}m ${Math.floor(remainingMs / 1000) % 60}s remaining (Sui clock); deadline ${new Date(h.slotUntil).toISOString()}`);
      return { ...h, remainingMs };
    }
    const expired = remainingMs != null && remainingMs < -bufferMs;
    const claimable = h.slot === 'Open' || expired;
    if (claimable && !h.permissionless && !h.allowlist.includes(myAddr)) {
      throw new Error(`${myAddr} is not on the ceremony's allowlist (it is permissioned); ask the organizer to enroll this address`);
    }
    onWaiting(!claimable && (h.permissionless || h.allowlist.includes(myAddr)));
    // Keep health failures outside the transaction retry handler; they should
    // stop the CLI, not be reported as another contributor winning the slot.
    if (claimable && !ours) await checkHealth(h);
    try {
      if (claimable) {
        const claimSlot = expired ? expireAndClaim : claim;
        const d = await claimSlot(client, keypair, packageId, ceremonyId);
        log(`${expired ? 'reopened a stale claim + claimed' : 'claimed slot'} (${d})`, 'success');
        await client.core.waitForTransaction({ digest: d });
        continue;
      }
    } catch (e) {
      // Lost a race (someone claimed first) or a transient tx error — re-read and retry.
      if (++fails > 60) throw e;
      log('someone else took the turn first; waiting for the next turn', 'waiting');
      await sleep(pollMs);
      continue;
    }
    // Busy: held by a live claimant, or a contribution is being verified.
    const until = h.slotUntil ? ` until ${new Date(h.slotUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    const detail = ours
      ? 'your earlier turn expired; waiting for the next one'
      : h.slot === 'Pending'
      ? 'checking the previous contribution'
      : `someone else has the turn${until}`;
    log(detail, 'waiting');
    log(`slot ${h.slot}; checking again in ${pollMs / 1000}s`);
    await sleep(pollMs);
  }
}

export function submitContribution(client, keypair, packageId, ceremonyId, sharedBlobId, contributionHash, name) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::groth16_phase2::submit_contribution`,
    arguments: [
      tx.object(ceremonyId),
      tx.pure.id(sharedBlobId),
      tx.pure.vector('u8', hexBytes(contributionHash)),
      tx.pure.string(name),
      tx.object(CLOCK),
    ],
  });
  return exec(client, keypair, tx);
}
