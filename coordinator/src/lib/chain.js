// Sui plumbing shared by the coordinator tools: client, keypair, the Ceremony
// reader, and a transaction executor.

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { net } from './config.js';
import { loadCoordinatorKeypair, signTransaction } from '../crypto/identity.js';
import { withRunLock } from './funding-store.js';
import { Transaction } from '@mysten/sui/transactions';

const signerWorkdirs = new WeakMap();

export function makeClient(network) {
  return new SuiGrpcClient({ network, baseUrl: net(network).fullnode });
}

export function loadKeypair(options) {
  try {
    const kp = loadCoordinatorKeypair(options);
    if (options?.workdir) signerWorkdirs.set(kp, options.workdir);
    return kp;
  } catch (e) {
    console.error(e?.message || e);
    process.exit(1);
  }
}

export async function readCeremony(client, ceremonyId) {
  const { object } = await client.core.getObject({ objectId: ceremonyId, include: { json: true } });
  return object.json;
}

function b64Hex(v) {
  return v ? Buffer.from(v, 'base64').toString('hex') : null;
}

// The slot-derived view the attestor loop works from. blob ids are SharedBlob
// object ids (the contract stores `blob_id` as an `ID`).
export function parseSlot(j) {
  const s = j.slot || {};
  return {
    slot: s['@variant'] || 'Open',
    sharedBlobId: s.blob_id || null,
    contributionHash: b64Hex(s.contribution_hash),
    headSharedBlobId: j.head_blob_id || null,
    who: s.who || null,
    name: s.name || '',
    phase: j.phase?.['@variant'] || 'Setup',
    finalized: ['Phase2Beacon', 'Closed'].includes(j.phase?.['@variant']), // beacon drawn ⇒ finalized
    chainLen: Array.isArray(j.chain) ? j.chain.length : Number(j.chain ?? 0),
  };
}

// Build, sign, and execute a transaction; throw on failure, return the digest.
export async function exec(client, kp, tx, { returnTransaction = false } = {}) {
  const workdir = signerWorkdirs.get(kp);
  if (!workdir) throw new Error('coordinator transaction requires a ceremony workdir');
  const result = await withRunLock(workdir, (_store, guard) => execute(client, kp, tx, guard));
  return returnTransaction ? result : result.digest;
}

async function execute(client, kp, tx, guard) {
  tx.setSender(kp.toSuiAddress());
  const built = await tx.build({ client });
  const { signature } = await signTransaction(kp, built);
  const digest = await Transaction.from(built).getDigest();
  guard.block({ kind: 'transaction', digest, bytes: Buffer.from(built).toString('base64'), signature });
  const res = await client.core.executeTransaction({ transaction: built, signatures: [signature], include: { effects: true, objectTypes: true } });
  const t = res.Transaction || res.FailedTransaction;
  if (!t || t.digest !== digest || typeof t.status?.success !== 'boolean') throw new Error(`transaction ${digest} has an unresolved outcome; inspect funding.lock`);
  // The outcome is known here. An error in the wait must not keep the lock.
  guard.resolve();
  await client.core.waitForTransaction({ digest });
  if (res.FailedTransaction || t?.status?.success === false) throw new Error(JSON.stringify(t?.status?.error || res));
  return t;
}
