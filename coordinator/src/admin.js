#!/usr/bin/env node
// Admin tooling for the organizer. Reads ids from a ceremony manifest;
// signing commands use the run's state.json and require it to match
// `sui client active-address` (for approve-r1cs, that's the auditor's key).
//
//   node src/admin.js funding-url
//   node src/admin.js enable-funding
//   node src/admin.js disable-funding
//   node src/admin.js rotate-funding-secret
//   node src/admin.js status
//   node src/admin.js view-allowlist
//   node src/admin.js set-slot-duration --slot-duration-secs 900
//   node src/admin.js set-url <https://coordinator.example>
//   node src/admin.js approve-r1cs
//   node src/admin.js start-phase2 --genesis circuit_0000.p2c
//   node src/admin.js reject-pending
//   node src/admin.js finalize-phase2
//   node src/admin.js seal [--name beacon] [--beacon-exp 10]
//   node src/admin.js submit-final --final-params 0x... --final-zkey 0x... --final-vkey 0x... --contribution-hash <hex>
//   node src/admin.js enroll-without-funding 0xA,0xB
//   node src/admin.js remove-contributors 0xA,0xB
//   node src/admin.js set-access-mode <permissioned|permissionless>
//   node src/admin.js view-pending-enrollments
//   node src/admin.js fund 0xA [--sui 0.1] [--wal 0.5]
//   node src/admin.js cost [--size BYTES] [--epochs N]
//
// Seal uses BASE_ZKEY/BASE_PTAU when set, matching attestor.js; otherwise it uses
// coordinator/artifacts/{circuit_0000.zkey,pot_final.ptau}.
//
// status         - chain, head, slot, auditor approvals, phase flags, beacons
// set-slot-duration - change the duration for future claims (active deadlines unchanged)
// set-url        - point contributors at a (new) coordinator host
// approve-r1cs   - an auditor attests the r1cs blob is the expected circuit
// start-phase2   - upload genesis params, seed the head, open contributions
// reject-pending - manually reject the current Pending contribution and reopen
//                  the slot (escape hatch for when the attestor halts on it)
// finalize-phase2- draw the phase-2 final beacon and freeze contributions
// seal           - the organizer's final contribution; uploads final params/zkey/vkey and closes
// submit-final   - close with already-uploaded final params/zkey/vkey SharedBlob ids
// enroll-without-funding    - add addresses to a permissioned ceremony's allowlist
// remove-contributors - remove addresses from a permissioned ceremony's allowlist
// set-access-mode     - switch a live ceremony between permissioned and permissionless (allowlist retained)
// view-allowlist      - view the stored contributor allowlist (enforced only while permissioned)
// view-pending-enrollments - view pending enrollment requests from the selected run
// fund                - send SUI + WAL to an address (top-up; no allowlist change)
// cost                - print the live WAL storage cost for a blob, to size the funding amounts

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Transaction } from '@mysten/sui/transactions';
import { CLOCK, RANDOM, net, log, loadIds, resolveBaseArtifacts, resolveCeremonyPaths } from './lib/config.js';
import { makeClient, loadKeypair, readCeremony, parseSlot, exec } from './lib/chain.js';
import { CONTRIB_EPOCHS, writeBlob, storageCost, requireBlobIsDurable } from './crypto/walrus.js';
import { buildFinalBeaconContribution } from './lib/seal.js';
import { readEnrollmentRequests, summarizeEnrollmentRequests } from './lib/enrollment_requests.js';
import { readContributorNames, slotLabel } from './lib/status.js';
import { createFundingService } from './lib/funding.js';
import { fundingDefaults, parseCoinAmount } from './lib/funding-policy.js';
import { updateFundingConfig, privateFundingUrl, requirePublicCoordinatorUrl } from './lib/funding-config.js';
import { PERMISSIONED, PERMISSIONLESS } from './lib/access-mode.js';
import { parseSlotDurationMs } from './lib/slot-duration.js';

const CMDS = ['set-slot-duration', 'funding-url', 'enable-funding', 'disable-funding', 'rotate-funding-secret', 'status', 'view-allowlist', 'view-pending-enrollments', 'set-url', 'approve-r1cs', 'start-phase2', 'reject-pending', 'finalize-phase2', 'seal', 'submit-final', 'enroll-without-funding', 'remove-contributors', 'set-access-mode', 'fund', 'cost'];
const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  network: { type: 'string', default: 'testnet' },
  'slot-duration-secs': { type: 'string' },
  name: { type: 'string', default: 'beacon' },
  genesis: { type: 'string' },
  run: { type: 'string' },
  manifest: { type: 'string' },
  deployments: { type: 'string' },
  workdir: { type: 'string' },
  'beacon-exp': { type: 'string', default: '10' },
  sui: { type: 'string' },
  wal: { type: 'string' },
  size: { type: 'string' },
  epochs: { type: 'string' },
  'final-params': { type: 'string' },
  'final-zkey': { type: 'string' },
  'final-vkey': { type: 'string' },
  'contribution-hash': { type: 'string' },
} });
const cmd = positionals[0];
if (!CMDS.includes(cmd)) {
  console.error(`usage: admin.js <${CMDS.join('|')}> [--genesis file] [--network testnet] [--name beacon]`);
  process.exit(1);
}
if (cmd === 'fund' && (positionals.length !== 2 || !/^0x[0-9a-fA-F]{1,64}$/.test(positionals[1]))) {
  console.error('usage: admin.js fund 0xADDRESS [--sui amount] [--wal amount] (exactly one address)');
  process.exit(1);
}

let slotDurationMs;
if (cmd === 'set-slot-duration') {
  try {
    if (positionals.length !== 1 || o['slot-duration-secs'] == null) {
      throw new Error('usage: admin.js set-slot-duration --slot-duration-secs <positive-seconds>');
    }
    slotDurationMs = parseSlotDurationMs(o['slot-duration-secs']);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

if (o.deployments) console.error('warning: --deployments is deprecated; use --manifest or --run');
const needsCeremony = cmd !== 'cost';
const paths = needsCeremony || o.run || o.manifest || o.deployments
  ? resolveCeremonyPaths(o)
  : null;
const ids = paths
  ? loadIds(o.network, paths.manifest, { required: needsCeremony ? ['packageId', 'ceremonyId'] : [] })
  : { packageId: null, ceremonyId: null, organizerCapId: null, dep: {}, path: null };
const { packageId: PKG, ceremonyId: CER, organizerCapId: CAP } = ids;
const client = makeClient(o.network);
const WORKDIR = paths?.workdir || (o.workdir && path.resolve(o.workdir));
const ARTIFACT_WORKDIR = paths?.artifacts || WORKDIR;
const artifactEnv = { ...process.env, BASE_PTAU: process.env.BASE_PTAU || ids.dep.phase1?.file };
const { baseZkey: BASE_ZKEY, basePtau: BASE_PTAU } = resolveBaseArtifacts(artifactEnv, paths ? { artifactsDir: paths.artifacts } : {});
const signer = () => loadKeypair({ workdir: WORKDIR });
const read = () => readCeremony(client, CER);
const beaconHex = (b) => (b ? Buffer.from(b, 'base64').toString('hex') : '');
const b64Hex = (b) => (b ? Buffer.from(b, 'base64').toString('hex') : '');
const phaseOf = (j) => j.phase?.['@variant'] || 'Setup';
const isFinalized = (j) => ['Phase2Beacon', 'Closed'].includes(phaseOf(j)); // beacon drawn ⇒ finalized
// too long file names will be rejected immidiately
const MAX_NAME_BYTES = 64;
const REFERENCE_CONTRIBUTION_BYTES = 120_371_812; // ~114.8 MiB compressed zkLogin contribution
function checkName(name) {
  const n = Buffer.byteLength(name || '', 'utf8');
  if (n > MAX_NAME_BYTES) throw new Error(`--name is ${n} bytes; the ceremony contract accepts at most ${MAX_NAME_BYTES}`);
  return name;
}

function updateManifest(update) {
  if (!ids.path) return;
  const manifest = fs.existsSync(ids.path) ? JSON.parse(fs.readFileSync(ids.path, 'utf8')) : {};
  update(manifest);
  manifest.updated_at = new Date().toISOString();
  fs.writeFileSync(ids.path, JSON.stringify(manifest, null, 2));
}

function hexBytes(hex, label = 'contribution hash') {
  if (!/^[0-9a-fA-F]{128}$/.test(hex || '')) throw new Error(`${label} must be 64-byte hex`);
  return Array.from(Buffer.from(hex, 'hex'));
}
function isPermissioned(j) {
  if (typeof j.permissioned !== 'boolean') throw new Error('ceremony object missing permissioned field');
  return j.permissioned;
}

// The on-chain Option is retained across set_access_mode switches, so a stored
// set can exist while permissionless; it is informational then, not enforced.
const allowKeys = (j) => j.allowlist?.contents ?? j.allowlist?.fields?.contents ?? [];
const accessLabel = (j) => {
  const n = allowKeys(j).length;
  if (isPermissioned(j)) return `permissioned (${n} allowed)`;
  return n ? `permissionless (${n} retained, not enforced)` : 'permissionless';
};

async function status() {
  const j = await read();
  let enrollmentSummary = null;
  if (isPermissioned(j)) {
    const { rows } = readEnrollmentRequests(WORKDIR, { ceremonyId: CER, network: o.network });
    enrollmentSummary = summarizeEnrollmentRequests(rows, { permissioned: true, allowlist: allowKeys(j) });
  }
  console.log(`ceremony ${CER}`);
  console.log(`  package      ${PKG}`);
  console.log(`  r1cs blob    ${j.r1cs_blob_id}`);
  console.log(`  phase-1      ${Buffer.from(j.phase1_digest, 'base64').toString('hex').slice(0, 24)}…`);
  console.log(`  auditors     ${j.approvals.length}/${j.threshold} approved of ${j.auditors.length}`);
  console.log(`  access       ${accessLabel(j)}`);
  if (enrollmentSummary) {
    const n = enrollmentSummary.rows.length;
    const p = enrollmentSummary.pending.length;
    const hint = p ? '  (node coordinator/src/admin.js view-pending-enrollments)' : '';
    console.log(`  enrollments  ${p} pending / ${n} request${n === 1 ? '' : 's'}${hint}`);
  }
  console.log(`  phase        ${phaseOf(j)}`);
  if (phaseOf(j) !== 'Setup') console.log(`  head blob    ${j.head_blob_id}  (chain length ${j.chain.length})`);
  console.log(`  slot         ${slotLabel(j, enrollmentSummary, await readContributorNames(WORKDIR, { ceremonyId: CER, network: o.network }))}`);
  if (j.slot_duration_ms != null) console.log(`  slot duration ${j.slot_duration_ms} ms`);
  console.log(`  coordinator  ${j.coordinator_url || '(none)'}`);
  if (isFinalized(j)) console.log(`  final beacon ${beaconHex(j.final_beacon)}`);
  if (phaseOf(j) === 'Closed') {
    console.log(`  final zkey   ${j.final_zkey_blob_id}`);
    console.log(`  final vkey   ${j.final_vkey_blob_id}`);
  }
  j.chain.forEach((c, i) => {
    const h = b64Hex(c.contribution_hash);
    console.log(`    #${i + 1} ${c.name}  ${c.contributor.slice(0, 12)}…  ${c.blob_id}${h ? `  hash ${h.slice(0, 16)}…` : ''}`);
  });
}

async function viewAllowlist() {
  const j = await read();
  const keys = allowKeys(j);
  if (!isPermissioned(j)) {
    if (!keys.length) { console.log('permissionless — no allowlist'); return; }
    console.log(`allowlist (${keys.length}, retained — not enforced while permissionless):`);
  } else {
    console.log(`allowlist (${keys.length}):`);
  }
  keys.forEach((a) => console.log(`  ${a}`));
}

async function enrollmentRequestSummary() {
  const { path: requestsPath, rows } = readEnrollmentRequests(WORKDIR, { ceremonyId: CER, network: o.network });
  const j = await read();
  const permissioned = isPermissioned(j);
  return { requestsPath, ...summarizeEnrollmentRequests(rows, { permissioned, allowlist: allowKeys(j) }) };
}

function printEnrollmentRequestSummary({ requestsPath, rows, pending, permissioned, allowed }) {
  if (!rows.length) {
    console.log(`no enrollment requests in ${requestsPath}`);
    return false;
  }
  console.log(`enrollment requests (${rows.length} unique) from ${requestsPath}:`);
  rows.forEach((r) => {
    const when = r.ts ? new Date(r.ts).toISOString() : '?';
    const who = [r.name, r.discord].filter(Boolean).join(' / ') || '?';
    const dup = r.requests > 1 ? ` (${r.requests} requests)` : '';
    const state = permissioned ? (allowed.has(r.address) ? 'enrolled' : 'pending') : 'permissionless';
    console.log(`  ${state.padEnd(14)} ${r.address}  ${who}  ${r.network || '?'}  ${when}${dup}`);
  });
  console.log('');
  if (!permissioned) {
    console.log('permissionless ceremony — no allowlist enrollment needed; use fund if these addresses need top-ups');
  } else if (pending.length) {
    console.log(`allowlist only:    node coordinator/src/admin.js enroll-without-funding ${pending.map((r) => r.address).join(',')}`);
  } else {
    console.log('all enrollment requests are already allowlisted; nothing pending');
  }
  return true;
}

async function viewPendingEnrollments() {
  const summary = await enrollmentRequestSummary();
  printEnrollmentRequestSummary(summary);
}

function moveCall(target, args) {
  const tx = new Transaction();
  tx.moveCall({ target: `${PKG}::groth16_phase2::${target}`, arguments: args(tx) });
  return tx;
}

async function setSlotDuration() {
  const d = await exec(client, signer(), moveCall('set_slot_duration', (tx) => [tx.object(CAP), tx.object(CER), tx.pure.u64(slotDurationMs)]));
  updateManifest((manifest) => {
    manifest.slot_duration_ms = slotDurationMs.toString();
    manifest.set_slot_duration_digest = d;
  });
  log(`slot duration set to ${slotDurationMs / 1000n} seconds for future claims; active deadlines unchanged (${d})`);
}

async function setUrl() {
  const url = positionals[1];
  if (url == null) { console.error('usage: admin.js set-url <https://coordinator.example>  (pass "" to clear)'); process.exit(1); }
  requirePublicCoordinatorUrl(url);
  const d = await exec(client, signer(), moveCall('set_coordinator_url', (tx) => [tx.object(CAP), tx.object(CER), tx.pure.string(url)]));
  updateManifest((manifest) => {
    manifest.coordinator_url = url;
    manifest.set_url_digest = d;
  });
  log(`coordinator url set to ${url || '(none)'} (${d})`);
}

async function approveR1cs() {
  const kp = signer();
  const d = await exec(client, kp, moveCall('approve_r1cs', (tx) => [tx.object(CER)]));
  updateManifest((manifest) => {
    manifest.r1cs_approvals ||= [];
    manifest.r1cs_approvals.push({ auditor: kp.toSuiAddress(), digest: d, approved_at: new Date().toISOString() });
  });
  const j = await read();
  log(`approved by ${kp.toSuiAddress()} (${d}); ${j.approvals.length}/${j.threshold} approvals`);
}

async function startPhase2() {
  if (!o.genesis || !fs.existsSync(o.genesis)) { console.error('start-phase2 needs --genesis <p2c file>'); process.exit(1); }
  const kp = signer();
  const size = fs.statSync(o.genesis).size;
  const fd = fs.openSync(o.genesis, 'r');
  const header = Buffer.alloc(3);
  fs.readSync(fd, header, 0, header.length, 0);
  fs.closeSync(fd);
  const magic = header.toString();
  log(`uploading genesis ${o.genesis} (${(size / 1048576).toFixed(2)} MB, magic "${magic}") to Walrus via CLI…`);
  const { sharedBlobId, contentBlobId: blob } = await writeBlob(o.network, client, o.genesis, { label: 'genesis', workdir: WORKDIR });
  log(`genesis content blob ${blob} (SharedBlob ${sharedBlobId})`);
  const d = await exec(client, kp, moveCall('start_phase_2', (tx) => [tx.object(CAP), tx.object(CER), tx.pure.id(sharedBlobId)]));
  log(`phase 2 started (${d}); head ${blob}`);
  updateManifest((manifest) => {
    manifest.genesis = {
      file: path.resolve(o.genesis),
      content_blob_id: blob,
      shared_blob_id: sharedBlobId,
      start_digest: d,
    };
  });
}

// Manually reject a stuck Pending contribution and reopen the slot.
async function rejectPending() {
  if (!CAP) { console.error('reject-pending requires the organizer cap id in the ceremony manifest'); process.exit(1); }
  const kp = signer();
  const c = parseSlot(await read());
  if (c.slot !== 'Pending') { console.error(`slot is ${c.slot}; nothing to reject`); process.exit(1); }
  log(`rejecting pending contribution "${c.name || '?'}" by ${c.who} (blob ${c.sharedBlobId})`);
  const d = await exec(client, kp, moveCall('reject', (tx) => [
    tx.object(CAP),
    tx.object(CER),
    tx.pure.id(c.sharedBlobId),
    tx.pure.vector('u8', hexBytes(c.contributionHash)),
    tx.pure.address(c.who),
  ]));
  updateManifest((manifest) => {
    manifest.manual_rejections ||= [];
    manifest.manual_rejections.push({ contributor: c.who, shared_blob_id: c.sharedBlobId, digest: d, rejected_at: new Date().toISOString() });
  });
  log(`rejected (${d}); slot reopened`);
}

async function finalizePhase2() {
  const d = await exec(client, signer(), moveCall('finalize_phase2', (tx) => [tx.object(CAP), tx.object(CER), tx.object(RANDOM)]));
  updateManifest((manifest) => { manifest.finalize_digest = d; });
  const j = await read();
  updateManifest((manifest) => { manifest.final_beacon = beaconHex(j.final_beacon); });
  log(`phase 2 finalized (${d}); final beacon ${beaconHex(j.final_beacon).slice(0, 24)}…`);
}

async function seal() {
  const kp = signer();
  checkName(o.name);
  const j = await read();
  if (phaseOf(j) !== 'Phase2Beacon') { console.error(phaseOf(j) === 'Closed' ? 'ceremony is already closed' : 'finalize-phase2 first'); process.exit(1); }
  const beacon = beaconHex(j.final_beacon);
  const sealed = await buildFinalBeaconContribution({
    network: o.network,
    client,
    headSharedBlobId: j.head_blob_id,
    beaconHex: beacon,
    name: o.name,
    baseZkey: BASE_ZKEY,
    ptau: BASE_PTAU,
    workdir: ARTIFACT_WORKDIR,
    beaconExp: o['beacon-exp'],
    log,
  });

  log(`uploading final params ${sealed.sealedP2c} to Walrus via CLI...`);
  const paramsBlob = await writeBlob(o.network, client, sealed.sealedP2c, { label: 'final params', workdir: WORKDIR });

  log(`uploading final zkey ${sealed.fullSealedZkey} to Walrus via CLI...`);
  const zkeyBlob = await writeBlob(o.network, client, sealed.fullSealedZkey, { label: 'final zkey', workdir: WORKDIR });

  log(`uploading final vkey ${sealed.verificationKey} to Walrus via CLI...`);
  const vkeyBlob = await writeBlob(o.network, client, sealed.verificationKey, { label: 'final vkey', workdir: WORKDIR });

  const d = await submitFinalBlobs({
    j,
    kp,
    paramsSharedBlobId: paramsBlob.sharedBlobId,
    zkeySharedBlobId: zkeyBlob.sharedBlobId,
    vkeySharedBlobId: vkeyBlob.sharedBlobId,
    name: o.name,
    contributionHash: sealed.hashHex,
    files: {
      params: sealed.sealedP2c,
      zkey: sealed.fullSealedZkey,
      vkey: sealed.verificationKey,
    },
  });
  log(`sealed & closed (${d}); final params ${paramsBlob.contentBlobId}, contribution hash ${sealed.hashHex.slice(0, 16)}…`);
  log(`final zkey ${sealed.fullSealedZkey}`);
  log(`final p2c  ${sealed.sealedP2c}`);
  log(`final vkey ${sealed.verificationKey}`);
}

function defaultFinalFiles() {
  return {
    params: path.join(ARTIFACT_WORKDIR, 'final.p2c'),
    zkey: path.join(ARTIFACT_WORKDIR, 'final.zkey'),
    vkey: path.join(ARTIFACT_WORKDIR, 'final.vkey.json'),
  };
}

function existingFileOrNull(p) {
  return p && fs.existsSync(p) ? path.resolve(p) : undefined;
}

async function submitFinalBlobs({ j, kp, paramsSharedBlobId, zkeySharedBlobId, vkeySharedBlobId, name, contributionHash, files = defaultFinalFiles() }) {
  if (!CAP) throw new Error('submit-final requires organizer cap id');
  const phase = phaseOf(j);
  if (phase !== 'Phase2Beacon') throw new Error(phase === 'Closed' ? 'ceremony is already closed' : 'finalize-phase2 first');
  const finalContributionHash = contributionHash || (fs.existsSync(ids.path) ? JSON.parse(fs.readFileSync(ids.path, 'utf8')).final?.contribution_hash : null);
  const finalContributionHashBytes = hexBytes(finalContributionHash);
  for (const [label, id] of [['final params', paramsSharedBlobId], ['final zkey', zkeySharedBlobId], ['final vkey', vkeySharedBlobId]]) {
    if (!id) throw new Error(`missing ${label} SharedBlob id`);
  }
  const paramsBlob = await requireBlobIsDurable(o.network, client, paramsSharedBlobId, 'final params');
  const zkeyBlob = await requireBlobIsDurable(o.network, client, zkeySharedBlobId, 'final zkey');
  const vkeyBlob = await requireBlobIsDurable(o.network, client, vkeySharedBlobId, 'final vkey');
  log(`final params content blob ${paramsBlob.contentBlobId} (SharedBlob ${paramsSharedBlobId})`);
  log(`final zkey content blob ${zkeyBlob.contentBlobId} (SharedBlob ${zkeySharedBlobId})`);
  log(`final vkey content blob ${vkeyBlob.contentBlobId} (SharedBlob ${vkeySharedBlobId})`);
  const d = await exec(client, kp, moveCall('submit_final', (tx) => [
    tx.object(CAP),
    tx.object(CER),
    tx.pure.id(j.head_blob_id),
    tx.pure.id(paramsSharedBlobId),
    tx.pure.vector('u8', finalContributionHashBytes),
    tx.pure.id(zkeySharedBlobId),
    tx.pure.id(vkeySharedBlobId),
    tx.pure.string(name),
    tx.object(CLOCK),
  ]));
  updateManifest((manifest) => {
    manifest.final = {
      name,
      beacon: beaconHex(j.final_beacon),
      contribution_hash: finalContributionHash,
      seal_digest: d,
      params: { file: existingFileOrNull(files.params), content_blob_id: paramsBlob.contentBlobId, shared_blob_id: paramsSharedBlobId },
      zkey: { file: existingFileOrNull(files.zkey), content_blob_id: zkeyBlob.contentBlobId, shared_blob_id: zkeySharedBlobId },
      vkey: { file: existingFileOrNull(files.vkey), content_blob_id: vkeyBlob.contentBlobId, shared_blob_id: vkeySharedBlobId },
    };
  });
  return d;
}

async function submitFinal() {
  const kp = signer();
  checkName(o.name);
  const j = await read();
  const d = await submitFinalBlobs({
    j,
    kp,
    paramsSharedBlobId: o['final-params'],
    zkeySharedBlobId: o['final-zkey'],
    vkeySharedBlobId: o['final-vkey'],
    name: o.name,
    contributionHash: o['contribution-hash'],
  });
  log(`sealed & closed with pre-uploaded final blobs (${d})`);
}

// Comma-separated addresses for allowlist management.
function addrsPositional() {
  const csv = positionals[1];
  if (!csv) { console.error(`usage: admin.js ${cmd} 0xADDR1,0xADDR2`); process.exit(1); }
  return csv.split(',').map((a) => a.trim()).filter(Boolean);
}

// add/remove allowlisted contributors (permissioned ceremonies).
async function manageContributors(fn) {
  const addrs = addrsPositional();
  const d = await exec(client, signer(), moveCall(fn, (tx) => [tx.object(CAP), tx.object(CER), tx.pure.vector('address', addrs)]));
  log(`${fn} ${addrs.length} address(es) (${d})`);
}

// Flip the on-chain access mode; the allowlist survives the round trip.
async function setAccessMode() {
  const word = positionals[1];
  const MODES = { permissioned: PERMISSIONED, permissionless: PERMISSIONLESS };
  const mode = Object.hasOwn(MODES, word) ? MODES[word] : null; // hasOwn: `toString` etc. must not pass as a mode
  if (mode == null) { console.error('usage: admin.js set-access-mode <permissioned|permissionless>'); process.exit(1); }
  const d = await exec(client, signer(), moveCall('set_access_mode', (tx) => [tx.object(CAP), tx.object(CER), tx.pure.u8(mode)]));
  log(`access mode set to ${word} (${d})`);
}

// Explicit fund is a repeatable manual top-up, independent of enrollment.
const fmtCoin = (b) => (Number(b) / 1e9).toFixed(4);
async function fundContributor() {
  const defaults = fundingDefaults(o.network);
  const sui = o.sui != null ? parseCoinAmount(o.sui, '--sui') : defaults.sui;
  const wal = o.wal != null ? parseCoinAmount(o.wal, '--wal') : defaults.wal;
  if (sui === 0n && wal === 0n) throw new Error('fund requires a nonzero amount');
  const service = createFundingService({ client, keypair: signer(), workdir: WORKDIR, network: o.network, packageId: PKG, ceremonyId: CER, capId: CAP });
  const address = positionals[1];
  const result = await service.fund(address, { enroll: false, topUp: true, sui, wal });
  log(`fund: ${address} funded (${result.digest})`);
}

async function fundingConfigCommand(action) {
  // Validate the public URL before creating configuration on an existing run.
  const head = action === 'url' ? await read() : null;
  if (head) privateFundingUrl(head.coordinator_url, '0'.repeat(64));
  const config = updateFundingConfig(WORKDIR, o.network, CER, action === 'url' ? 'ensure' : action);
  if (action === 'url') {
    if (!config.enabled) console.error('automatic funding is disabled; use enable-funding to resume');
    console.log(privateFundingUrl(head.coordinator_url, config.secret));
  } else log(`funding configuration updated (${action}); effective on the next request`);
}

// Live WAL storage cost for a blob — to choose the airdrop or --wal amount.
async function cost() {
  const size = o.size ? parseInt(o.size, 10) : REFERENCE_CONTRIBUTION_BYTES;
  const epochs = o.epochs ? parseInt(o.epochs, 10) : CONTRIB_EPOCHS;
  const c = await storageCost(o.network, client, size, epochs);
  log(`${(size / 1048576).toFixed(1)} MB × ${epochs} epochs: ${fmtCoin(c.totalCost)} WAL total (storage ${fmtCoin(c.storageCost)} + write ${fmtCoin(c.writeCost)})`);
}

const handlers = {
  'set-slot-duration': setSlotDuration,
  'funding-url': () => fundingConfigCommand('url'),
  'enable-funding': () => fundingConfigCommand('enable'),
  'disable-funding': () => fundingConfigCommand('disable'),
  'rotate-funding-secret': () => fundingConfigCommand('rotate'),
  status, 'view-allowlist': viewAllowlist, 'view-pending-enrollments': viewPendingEnrollments, cost, 'set-url': setUrl, 'approve-r1cs': approveR1cs, 'start-phase2': startPhase2,
  'reject-pending': rejectPending, 'finalize-phase2': finalizePhase2, seal, 'submit-final': submitFinal,
  'enroll-without-funding': () => manageContributors('add_contributors'),
  'remove-contributors': () => manageContributors('remove_contributors'),
  'set-access-mode': setAccessMode,
  fund: fundContributor,
};
handlers[cmd]()
  // Admin commands are short-lived CLIs. Some SDK/CLI internals can leave
  // keepalive handles around after all awaited work is done, so exit explicitly.
  .then(() => process.exit(0))
  .catch((e) => { console.error(e?.message || e); process.exit(1); });
