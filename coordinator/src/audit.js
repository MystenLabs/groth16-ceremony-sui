#!/usr/bin/env node
// Closed-ceremony audit.
//
// Starts from a closed Ceremony object id and verifies:
//   1. downloaded r1cs bytes reproduce the on-chain Walrus content id, phase-1
//      bytes reproduce the on-chain digest, the downloaded r1cs matches the
//      operator's local r1cs when available, and both inputs get SHA-256/BLAKE2b
//      identities before final zkey verification;
//   2. every accepted on-chain p2c blob is retrievable, its on-chain
//      contribution_hash matches the blob, and the sequence matches final zkey;
//   3. extracting/compressing final zkey yields the final on-chain params blob;
//   4. uploaded vkey and final beacon metadata match the final zkey.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { makeClient, readCeremony } from './lib/chain.js';
import { loadIds, log, net, resolveCeremonyPaths, standaloneAuditPaths, PHASE1_URL } from './lib/config.js';
import { checkFinalCeremony, verifyFinalArtifacts } from './crypto/audit.js';
import { readBlob, blobIdForFile } from './crypto/walrus.js';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  ceremony: { type: 'string' },
  run: { type: 'string' },
  manifest: { type: 'string' },
  deployments: { type: 'string' },
  network: { type: 'string', default: 'testnet' },
  workdir: { type: 'string' },
  'blob-cache': { type: 'string' },
  ptau: { type: 'string' },
  'phase1-url': { type: 'string', default: PHASE1_URL },
  fresh: { type: 'boolean' },
} });

if (o.deployments) console.error('warning: --deployments is deprecated; use --manifest or --run');
const paths = o.run || o.manifest || o.deployments
  ? resolveCeremonyPaths(o)
  : null;
const manifestIds = paths ? loadIds(o.network, paths.manifest) : null;
const CER = o.ceremony || positionals[0] || manifestIds?.ceremonyId;
if (!CER) {
  console.error('usage: node coordinator/src/audit.js --run <name> [--network testnet] [--ptau pot_final.ptau]');
  console.error('   or: node coordinator/src/audit.js <closed-ceremony-object-id> [--workdir ./audit-work]');
  process.exit(1);
}
net(o.network);

const ZERO_ID = '0x0000000000000000000000000000000000000000000000000000000000000000';
function fail(msg) {
  throw new Error(`audit failed: ${msg}`);
}

function assertOk(cond, msg) {
  if (!cond) fail(msg);
}

function phaseOf(j) {
  return j.phase?.['@variant'] || 'Setup';
}

function isZeroId(id) {
  return !id || id === ZERO_ID || /^0x0+$/.test(id);
}

async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  if (!res.body) throw new Error(`download ${url}: empty response body`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

async function ensurePtau(runDir) {
  const runPtau = paths && path.join(paths.artifacts, 'pot_final.ptau');
  const manifestPtau = manifestIds?.dep.phase1?.file;
  const localPtau = o.ptau || (runPtau && fs.existsSync(runPtau) ? runPtau : null) || (manifestPtau && fs.existsSync(manifestPtau) ? manifestPtau : null);
  if (localPtau) {
    assertOk(fs.existsSync(localPtau), `ptau not found: ${localPtau}`);
    return localPtau;
  }
  const ptau = path.join(runDir, 'pot_final.ptau');
  if (o.fresh || !fs.existsSync(ptau)) {
    log(`downloading phase-1 ptau from ${o['phase1-url']}`);
    await download(o['phase1-url'], ptau);
  }
  return ptau;
}

async function fetchShared({ network, client, cacheDir, sharedBlobId, label, suffix }) {
  assertOk(!isZeroId(sharedBlobId), `${label} blob id is empty`);
  const blob = await readBlob(network, client, sharedBlobId, { label, cacheDir, suffix, force: o.fresh });
  log(`${label}: ${sharedBlobId} -> ${blob.contentBlobId}`);
  return blob;
}

async function main() {
  const client = makeClient(o.network);
  const standalone = paths ? null : standaloneAuditPaths(CER, o.workdir);
  const runDir = paths?.audit || standalone.audit;
  const blobCache = o['blob-cache'] || paths?.blobs || standalone.blobs;
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(blobCache, { recursive: true });

  const ceremony = await readCeremony(client, CER);
  const phase = phaseOf(ceremony);
  log(`auditing ceremony ${CER} on ${o.network} (${phase})`);
  log(`blob cache ${blobCache}`);
  log('walrus blob reads via cli');
  const { chain } = checkFinalCeremony(ceremony);

  const r1cs = await fetchShared({
    network: o.network,
    client,
    cacheDir: blobCache,
    sharedBlobId: ceremony.r1cs_blob_id,
    label: 'r1cs',
    suffix: '.r1cs',
  });
  const recomputedR1csBlobId = blobIdForFile(o.network, r1cs.file, { label: 'audited r1cs', log });
  const recordedR1cs = manifestIds?.dep.r1cs?.file;
  const localR1cs = recordedR1cs && fs.existsSync(recordedR1cs) ? recordedR1cs : null;
  if (!localR1cs) log('local r1cs comparison skipped; no recorded input file is available');

  const finalZkey = await fetchShared({
    network: o.network,
    client,
    cacheDir: blobCache,
    sharedBlobId: ceremony.final_zkey_blob_id,
    label: 'final zkey',
    suffix: '.zkey',
  });

  const finalVkey = await fetchShared({
    network: o.network,
    client,
    cacheDir: blobCache,
    sharedBlobId: ceremony.final_vkey_blob_id,
    label: 'final vkey',
    suffix: '.json',
  });

  const ptau = await ensurePtau(runDir);
  const contributions = [];
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i];
    const blob = await fetchShared({
      network: o.network, client, cacheDir: blobCache,
      sharedBlobId: c.blob_id, label: `chain #${i + 1} ${c.name || '(unnamed)'}`, suffix: '.p2c',
    });
    contributions.push({ sharedBlobId: c.blob_id, file: blob.file });
  }
  const result = await verifyFinalArtifacts({
    ceremony, r1cs: r1cs.file, expectedR1csBlobId: r1cs.contentBlobId,
    actualR1csBlobId: recomputedR1csBlobId, localR1cs,
    ptau, finalZkey: finalZkey.file, finalVkey: finalVkey.file,
    contributions, workdir: runDir, log,
  });
  log(`audit OK (${result.contributionCount} accepted contribution${result.contributionCount === 1 ? '' : 's'})`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e?.message || e);
    for (let c = e?.cause; c; c = c.cause) console.error('  cause:', c.message || c);
    process.exit(1);
  });
