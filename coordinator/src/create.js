#!/usr/bin/env node
// Admin: create a ceremony (setup phase). Uploads the circuit r1cs to Walrus
// unless --r1cs-shared-blob is provided, then calls
// `groth16_phase2::create_ceremony(phase1_digest, r1cs_blob_id, auditors,
// threshold, coordinator_url, mode, allowed, slot_duration_ms)`, transferring the OrganizerCap to the sender.
//
//   node src/create.js --r1cs circuit.r1cs \
//     --ptau pot_final.ptau --auditors 0xAUD1,0xAUD2 --threshold 2 \
//     --run zklogin-ceremony --permissionless
//
// `phase1_digest` is the BLAKE2b-512 / b2sum of the phase-1 file.
// coordinator/artifacts/README.md describes that file.
// Pass --ptau <pot_final.ptau> to hash that file locally, or --phase1-hash
// <hex> directly. The genesis params come later via `admin.js start-phase2`.
// Writes the run-specific ceremony manifest.
//
// Options:
//   --r1cs <file>          circuit r1cs to upload + commit to
//   --r1cs-shared-blob <id> pre-uploaded durable Walrus SharedBlob for the r1cs;
//                           supplying --r1cs too verifies the local Walrus blob id
//   --ptau <file>          adopted phase-1 pot_final.ptau to hash for the commitment
//   --phase1-hash <hex>    commitment directly; with --ptau, verifies the local file
//   --auditors <a,b,..>    addresses allowed to approve the r1cs (default: none)
//   --threshold <n>        approvals required to start phase 2 (default: #auditors;
//                           0 skips the approval gate entirely -- rehearsals only)
//   --coordinator-url <u>  coordinator HTTP base URL for enrollment requests + telemetry (default: none)
//   --permissionless       allow any address to contribute
//   --permissioned         restrict contributions to an organizer-managed allowlist
//   --allowlist <a,b,..>   initial allowed contributor addresses (requires --permissioned)
//   --slot-duration-secs <n> positive whole seconds per claim (default: 900; maximum: 3600; for new claims)
//   --run <name>           ceremony run name (recommended)
//   --manifest <file>      explicit ceremony manifest path (alternative to --run)
//   --move-dir <dir>       Move package directory (default: ./move)
//   --publish-package      authorize a fresh publish without an interactive prompt
//   --no-publish-package   fail instead of prompting when no matching package exists
//   --publish-gas-budget <n> Move package publish gas budget (default: 200000000)
//   --network <n>          testnet | mainnet (default testnet)
//   --workdir <dir>        override coordinator run directory
//   --force                replace an existing ceremony manifest
//   --out <file>           legacy alias for --manifest

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Transaction } from '@mysten/sui/transactions';
import {
  REPO_ROOT,
  log,
  resolveCeremonyPaths,
} from './lib/config.js';
import { makeClient, loadKeypair, exec } from './lib/chain.js';
import { withWalletOperation } from './lib/funding-store.js';
import { ceremonyManifestBase, packagePublicationProvenance } from './lib/manifest.js';
import { PERMISSIONED, selectAccessMode } from './lib/access-mode.js';
import { parseSlotDurationMs } from './lib/slot-duration.js';
import { resolvePhase1Digest } from './crypto/commitments.js';
import { prepareMovePackage } from './lib/move-package.js';
import { requireBlobIsDurable, writeBlob, blobIdForFile, verifyBlobId } from './crypto/walrus.js';
import { updateFundingConfig, requirePublicCoordinatorUrl } from './lib/funding-config.js';

const { values: o } = parseArgs({ options: {
  r1cs: { type: 'string' },
  'r1cs-shared-blob': { type: 'string' },
  ptau: { type: 'string' },
  'phase1-hash': { type: 'string' },
  auditors: { type: 'string' },
  threshold: { type: 'string' },
  'coordinator-url': { type: 'string' },
  permissionless: { type: 'boolean' },
  permissioned: { type: 'boolean' },
  allowlist: { type: 'string' },
  'slot-duration-secs': { type: 'string' },
  run: { type: 'string' },
  manifest: { type: 'string' },
  'move-dir': { type: 'string', default: path.join(REPO_ROOT, 'move') },
  'publish-package': { type: 'boolean' },
  'no-publish-package': { type: 'boolean' },
  'publish-gas-budget': { type: 'string', default: '200000000' },
  network: { type: 'string', default: 'testnet' },
  workdir: { type: 'string' },
  out: { type: 'string' },
  force: { type: 'boolean' },
} });

const ALLOWLIST = (o.allowlist ? o.allowlist.split(',') : []).map((a) => a.trim()).filter(Boolean);
let MODE;
let SLOT_DURATION_MS;
try {
  SLOT_DURATION_MS = parseSlotDurationMs(o['slot-duration-secs']);
  MODE = selectAccessMode({ ...o, allowlist: ALLOWLIST });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (!o['r1cs-shared-blob'] && (!o.r1cs || !fs.existsSync(o.r1cs))) {
  console.error('missing --r1cs <file> or --r1cs-shared-blob <id>');
  process.exit(1);
}
if (o.out) console.error('warning: --out is deprecated; use --manifest or --run');
const paths = resolveCeremonyPaths(o);
const outPath = paths.manifest;
const existing = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
if (existing.ceremony_id && !o.force) {
  throw new Error(`ceremony manifest already contains ${existing.ceremony_id}: ${outPath} (choose a new --run, or pass --force intentionally)`);
}
const manifestBase = ceremonyManifestBase(existing, { force: o.force });
const COORDINATOR_URL = o['coordinator-url'] ?? existing.coordinator_url ?? '';
requirePublicCoordinatorUrl(COORDINATOR_URL);
const AUDITORS = (o.auditors ? o.auditors.split(',') : []).map((a) => a.trim()).filter(Boolean);
const THRESHOLD = o.threshold != null ? Number(o.threshold) : AUDITORS.length;
if (THRESHOLD > AUDITORS.length) { console.error(`threshold ${THRESHOLD} exceeds ${AUDITORS.length} auditors`); process.exit(1); }
if (THRESHOLD === 0 && AUDITORS.length) { console.error('threshold must be at least 1 when auditors are listed; pass no auditors to skip approval'); process.exit(1); }
// Threshold 0 is legal onchain (0 >= 0): the organizer alone decides when
// phase 2 opens. Warn rather than refuse so a rehearsal can skip auditors
// without a dedicated flag; the loud stderr is what keeps it deliberate.
if (THRESHOLD === 0) {
  console.error('warning: threshold 0 — no auditor approval required; start-phase2 will open phase 2');
  console.error('         without anyone attesting to the r1cs. This is intended for rehearsals and');
  console.error('         internal runs only; a public ceremony should list --auditors.');
}

const suppliedPhase1Digest = o['phase1-hash'] || '';
if (o.ptau && !fs.existsSync(o.ptau)) {
  console.error(`phase-1 file not found: ${o.ptau}`);
  process.exit(1);
}

async function resolveR1csBlob(client) {
  if (o['r1cs-shared-blob']) {
    const sharedBlobId = o['r1cs-shared-blob'];
    const blob = await requireBlobIsDurable(o.network, client, sharedBlobId, 'r1cs');
    log(`using pre-uploaded r1cs SharedBlob ${sharedBlobId} -> ${blob.contentBlobId}`);
    if (o.r1cs) {
      const localBlobId = blobIdForFile(o.network, o.r1cs, { label: 'local r1cs', log });
      verifyBlobId(localBlobId, blob.contentBlobId);
      log(`local r1cs content blob id matches ${localBlobId}`);
    }
    return { sharedBlobId, contentBlobId: blob.contentBlobId };
  }

  const size = fs.statSync(o.r1cs).size;
  log(`uploading r1cs ${o.r1cs} (${(size / 1048576).toFixed(2)} MB) to Walrus via CLI…`);
  return writeBlob(o.network, client, o.r1cs, { label: 'r1cs', workdir: paths.workdir });
}

async function main() {
  if (o.ptau) log(`hashing phase-1 file ${o.ptau} for commitment check…`);
  const phase1DigestHex = await resolvePhase1Digest({ ptau: o.ptau, suppliedDigest: suppliedPhase1Digest });

  const packagePublication = await prepareMovePackage({
    network: o.network,
    moveDir: o['move-dir'],
    gasBudget: o['publish-gas-budget'],
    publish: o['publish-package'],
    noPublish: o['no-publish-package'],
    publishOperation: (fn) => withWalletOperation(paths.workdir, { kind: 'publish-package', network: o.network }, fn),
    log,
  });
  const PACKAGE = packagePublication.packageId;
  const packageProvenance = packagePublicationProvenance(packagePublication, REPO_ROOT);

  const phase1Digest = Buffer.from(phase1DigestHex, 'hex');

  const client = makeClient(o.network);
  const keypair = loadKeypair({ workdir: paths.workdir });
  const sender = keypair.toSuiAddress();
  log(`organizer ${sender} | package ${PACKAGE}`);
  log(`auditors ${AUDITORS.length ? AUDITORS.join(', ') : '(none)'} | threshold ${THRESHOLD}`);
  log(`access ${MODE === PERMISSIONED ? `permissioned (${ALLOWLIST.length} allowed)` : 'permissionless'}`);
  log(`slot duration ${SLOT_DURATION_MS / 1000n} seconds`);
  log(`phase1_digest ${phase1DigestHex.slice(0, 16)}…`);

  const { sharedBlobId: r1csShared, contentBlobId: r1csBlob } = await resolveR1csBlob(client);
  log(`r1cs content blob ${r1csBlob} (SharedBlob ${r1csShared})`);

  log('calling groth16_phase2::create_ceremony (transfers the cap)…');
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE}::groth16_phase2::create_ceremony`,
    arguments: [
      tx.pure.vector('u8', Array.from(phase1Digest)),
      tx.pure.id(r1csShared),
      tx.pure.vector('address', AUDITORS),
      tx.pure.u64(THRESHOLD),
      tx.pure.string(COORDINATOR_URL),
      tx.pure.u8(MODE),
      tx.pure.vector('address', ALLOWLIST),
      tx.pure.u64(SLOT_DURATION_MS),
    ],
  });
  const t = await exec(client, keypair, tx, { returnTransaction: true });
  const digest = t.digest;
  log(`create tx ${digest}`);

  // Classify created objects (Ceremony shared, OrganizerCap owned).
  let ceremonyId = null, capId = null;
  for (const c of t.effects.changedObjects) {
    if (c.idOperation !== 'Created') continue;
    const type = t.objectTypes?.[c.objectId] || '';
    if (type.endsWith('::groth16_phase2::Ceremony')) ceremonyId = c.objectId;
    if (type.endsWith('::groth16_phase2::OrganizerCap')) capId = c.objectId;
  }

  const deployment = {
    ...manifestBase,
    schema_version: 1,
    kind: 'groth16-sui-ceremony',
    run: paths.run || manifestBase.run || path.basename(paths.runDir),
    network: o.network,
    package_id: PACKAGE,
    ...packageProvenance,
    ceremony_id: ceremonyId,
    organizer_cap_id: capId,
    organizer_address: sender,
    coordinator_url: COORDINATOR_URL,
    auditors: AUDITORS,
    threshold: THRESHOLD,
    permissioned: MODE === PERMISSIONED,
    allowlist: ALLOWLIST,
    slot_duration_ms: SLOT_DURATION_MS.toString(),
    r1cs: { file: o.r1cs ? path.resolve(o.r1cs) : null, content_blob_id: r1csBlob, shared_blob_id: r1csShared },
    phase1: { file: o.ptau ? path.resolve(o.ptau) : null, digest: phase1DigestHex },
    phase1_digest: phase1DigestHex,
    create_digest: digest,
    created_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2));
  updateFundingConfig(paths.workdir, o.network, ceremonyId);
  log(`done. ceremony ${ceremonyId} | cap ${capId} | wrote ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e?.message || e);
    for (let c = e?.cause; c; c = c.cause) console.error('  cause:', c.message || c);
    process.exit(1);
  });
