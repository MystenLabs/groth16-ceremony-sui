#!/usr/bin/env node
// Build the phase-2 genesis from the adopted phase-1 ptau + the circuit r1cs:
//   g16s(r1cs, pot_final.ptau)  -> circuit_0000.zkey   (the base contributors build on)
//   extract + compress v2params -> circuit_0000.p2c     (the genesis blob start-phase2 uploads)
//
//   node src/genesis.js --r1cs zklogin-o2.r1cs [--ptau artifacts/pot_final.ptau] [--out artifacts]
//   node src/genesis.js verify --r1cs zklogin-o2.r1cs [--ptau artifacts/pot_final.ptau] [--out artifacts]
//   node src/genesis.js clean [--out artifacts] [--dry-run]
//
// The adopted ptau is the public phase1/pot_final.ptau from:
//   https://github.com/sui-foundation/zklogin-ceremony-contributions/tree/main/phase1
// Its published BLAKE2b-512 / b2sum is the on-chain phase1_digest:
//   516fdf98bef4ab474bf01e336c801b275bdb4c5209ad06351b1f1ebc6f7060b77c11c9adaf861a776e77c2eff9f22cb4dae29fcab12f97489a9f049339904b3c
//
// g16s is memory-heavy for large circuits, so the snarkjs child gets a bigger
// V8 heap.

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGenesis, verifyZkeyFromR1cs, snarkLogger } from './crypto/snarkjs.js';
import { ceremonyRunPaths } from './lib/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  r1cs: { type: 'string' },
  ptau: { type: 'string' },
  zkey: { type: 'string' },
  run: { type: 'string' },
  out: { type: 'string' },
  'dry-run': { type: 'boolean' },
} });
if (o.run && o.out) throw new Error('pass --run or --out, not both');
const outDir = o.run ? ceremonyRunPaths(o.run).artifacts : (o.out || path.join(here, '..', 'artifacts'));
const ptau = o.ptau || path.join(outDir, 'pot_final.ptau');
const cmd = positionals[0] || 'build';
if (!['build', 'verify', 'clean'].includes(cmd) || positionals.length > 1) {
  console.error('usage: genesis.js [build] --r1cs <file> [--ptau <file>] [--out artifacts]');
  console.error('       genesis.js verify --r1cs <file> [--ptau <file>] [--zkey <file>] [--out artifacts]');
  console.error('       genesis.js clean [--out artifacts] [--dry-run]');
  process.exit(1);
}

const out = (f) => path.join(outDir, f);
const GENERATED = ['circuit_0000.zkey', 'circuit_0000.p2u', 'circuit_0000.p2c'];

function cleanGeneratedArtifacts() {
  let n = 0;
  for (const name of GENERATED) {
    const f = out(name);
    if (!fs.existsSync(f)) continue;
    n++;
    if (o['dry-run']) console.log(`would remove ${f}`);
    else {
      fs.rmSync(f, { force: true });
      console.log(`removed ${f}`);
    }
  }
  if (n === 0) console.log(`no generated genesis artifacts found in ${outDir}`);
  if (fs.existsSync(ptau)) console.log(`kept ${ptau}`);
}

if (cmd === 'clean') {
  cleanGeneratedArtifacts();
  process.exit(0);
}

if (!o.r1cs || !fs.existsSync(o.r1cs)) { console.error('missing --r1cs <file>'); process.exit(1); }
if (!fs.existsSync(ptau)) { console.error(`missing ptau ${ptau} (download the adopted pot_final.ptau)`); process.exit(1); }
const elapsedSeconds = (started) => Number(process.hrtime.bigint() - started) / 1e9;
async function timed(label, fn) {
  const started = process.hrtime.bigint();
  await fn();
  const seconds = elapsedSeconds(started);
  console.log(`${label} completed in ${seconds.toFixed(3)}s`);
  return seconds;
}

if (cmd === 'verify') {
  const zkey = o.zkey || out('circuit_0000.zkey');
  if (!fs.existsSync(zkey)) { console.error(`missing zkey ${zkey} (run genesis build first)`); process.exit(1); }
  console.log(`verify ${zkey} against ${o.r1cs} + ${ptau}…`);
  await timed('genesis zkey verification', () => verifyZkeyFromR1cs({ r1cs: o.r1cs, ptau, zkey, nodeOptions: process.env.GENESIS_NODE_OPTIONS || '--max-old-space-size=16384' }));
  console.log('genesis zkey verified');
  process.exit(0);
}

const started = process.hrtime.bigint();
fs.mkdirSync(outDir, { recursive: true });
await buildGenesis({ r1cs: o.r1cs, ptau, outDir, step: timed, logger: snarkLogger(console.log) });
console.log(`done in ${elapsedSeconds(started).toFixed(3)}s. genesis: ${out('circuit_0000.p2c')}`);
console.log(`  -> admin.js start-phase2 --genesis ${out('circuit_0000.p2c')}`);
