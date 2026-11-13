#!/usr/bin/env node
// Verify benchmark — run the coordinator's actual phase-2 verification on this
// machine and report per-step timings, to compare hardware. It imports the real
// functions from coordinator/src/crypto (readBlob and runVerifySteps),
// so the numbers can't drift from what the attestor runs. Run it from a repo clone
// after installing the coordinator's deps:
//
//   cd coordinator && npm install && cd ..
//   node bench/verify-bench.mjs                       # default ceremony + coordinator/artifacts
//   node bench/verify-bench.mjs --base <zkey> --ptau <ptau> --ceremony 0x…
//   node bench/verify-bench.mjs --head <sharedBlobId> --sub <sharedBlobId> --expected-hash <hex>
//
// It pulls a real head + contribution from the ceremony's on-chain chain, so the
// only things to stage are the genesis full zkey + phase-1 ptau (for assemble /
// verifyFromInit), looked up in coordinator/artifacts by default.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { makeClient } from '../coordinator/src/lib/chain.js';
import { readBlob } from '../coordinator/src/crypto/walrus.js';
import { runVerifySteps } from '../coordinator/src/crypto/verify_contribution.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CEREMONY = '0x49d1102d8f069e5c30fd69b8ffe26e5f0c90d4cf43d8821191d14d9f87134eb9';
function findArtifact(name, override) {
  if (override) return override;
  for (const p of [path.join(HERE, '..', 'coordinator', 'artifacts', name), path.join(HERE, name)]) if (fs.existsSync(p)) return p;
  return path.join(HERE, '..', 'coordinator', 'artifacts', name); // best-effort (drives the "missing" message)
}

const { values: o } = parseArgs({ options: {
  network: { type: 'string', default: 'testnet' },
  ceremony: { type: 'string', default: DEFAULT_CEREMONY }, // sub = latest contribution, head = its predecessor
  head: { type: 'string' },              // or pass SharedBlob object ids explicitly
  sub: { type: 'string' },
  'expected-hash': { type: 'string' },    // required with explicit head/sub; otherwise read from the chain
  base: { type: 'string' },
  ptau: { type: 'string' },
  workdir: { type: 'string', default: path.join(HERE, 'bench-work') },
  cached: { type: 'boolean', default: false }, // pass --cached to reuse already-downloaded blobs; default redownloads so dlHead/dlSub are timed
} });
const BASE = findArtifact('circuit_0000.zkey', o.base);
const PTAU = findArtifact('pot_final.ptau', o.ptau);
fs.mkdirSync(o.workdir, { recursive: true });

const client = makeClient(o.network);
const timings = {};
const step = async (k, fn) => {
  process.stdout.write(`  ${k}… `);
  const s = Date.now();
  const r = await fn();
  timings[k] = +((Date.now() - s) / 1000).toFixed(1);
  console.log(`${timings[k]}s`);
  return r;
};

// Explicit --head/--sub win; otherwise take them from the ceremony's chain.
let headShared = o.head, subShared = o.sub;
let expectedHash = o['expected-hash']?.toLowerCase();
if (!headShared || !subShared) {
  const { object } = await client.core.getObject({ objectId: o.ceremony, include: { json: true } });
  const chain = object.json?.chain || [];
  if (chain.length < 2) { console.error(`ceremony ${o.ceremony} has ${chain.length} contribution(s); need ≥2 to bench (a contribution + its predecessor)`); process.exit(1); }
  subShared = chain[chain.length - 1].blob_id;
  headShared = chain[chain.length - 2].blob_id;
  expectedHash ??= Buffer.from(chain[chain.length - 1].contribution_hash || '', 'base64').toString('hex');
}
if (!expectedHash || !/^[0-9a-f]{128}$/.test(expectedHash)) {
  console.error('need a 64-byte contribution hash: use --expected-hash <hex> with explicit --head/--sub, or select a ceremony with a recorded hash');
  process.exit(1);
}

const cpu = os.cpus();
console.log(`machine: ${cpu[0]?.model?.trim() || '?'} | ${cpu.length} cores | ${(os.totalmem() / 2 ** 30).toFixed(0)} GB RAM | ${os.platform()}/${os.arch()} | node ${process.version}`);
console.log(`head=${headShared.slice(0, 12)}… sub=${subShared.slice(0, 12)}…`);

if (!(fs.existsSync(BASE) && fs.existsSync(PTAU))) {
  console.error(`missing base/ptau (looked at ${BASE} and ${PTAU}) — pass --base/--ptau or drop circuit_0000.zkey + pot_final.ptau in coordinator/artifacts`);
  process.exit(1);
}

const cacheDir = path.join(o.workdir, 'blobs');
const head = await step('dlHead', () => readBlob(o.network, client, headShared, { label: 'head', force: !o.cached, cacheDir }));
const sub = await step('dlSub', () => readBlob(o.network, client, subShared, { label: 'submission', force: !o.cached, cacheDir }));
const headPath = head.file;
const subPath = sub.file;

const verdict = await runVerifySteps({ headPath, subPath, baseZkey: BASE, ptau: PTAU, workdir: o.workdir, expectedHash, step });

const total = Object.values(timings).reduce((a, b) => a + b, 0);
console.log(`ok: ${verdict.ok}`);
if (!verdict.ok) { console.error(verdict.reason); process.exitCode = 1; }
console.log(`timings (s): ${Object.entries(timings).map(([k, v]) => `${k}=${v}`).join(' ')} | total=${total.toFixed(1)}`);
