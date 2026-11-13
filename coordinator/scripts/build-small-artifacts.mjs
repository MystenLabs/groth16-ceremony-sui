#!/usr/bin/env node
// Build tiny square-circuit artifacts for cheap end-to-end ceremony rehearsals.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as snarkjs from 'snarkjs';
import { writeR1cs } from 'r1csfile';
import { buildGenesis } from '../src/crypto/snarkjs.js';

const { values: o } = parseArgs({
  options: {
    out: { type: 'string', default: 'ceremony-runs/mock-artifacts/artifacts' },
    force: { type: 'boolean' },
  },
});

const snLog = { info: (m) => console.log(`  ${m}`), debug() {}, warn: (m) => console.log(`  ${m}`), error: (m) => console.log(`  ${m}`) };
const out = (name) => path.join(o.out, name);

function assertWritableOut() {
  fs.mkdirSync(o.out, { recursive: true });
  const generated = ['square.r1cs', 'raw.ptau', 'contributed.ptau', 'pot_final.ptau', 'circuit_0000.zkey', 'circuit_0000.p2u', 'circuit_0000.p2c'];
  const existing = generated.filter((name) => fs.existsSync(out(name)));
  if (existing.length && !o.force) {
    throw new Error(`refusing to overwrite existing artifacts in ${o.out}; pass --force`);
  }
  if (o.force) {
    for (const name of generated) fs.rmSync(out(name), { force: true });
  }
}

async function main() {
  assertWritableOut();
  const curve = await snarkjs.curves.getCurveFromName('bn128', { singleThread: true });
  try {
    const one = curve.Fr.e(1);
    await writeR1cs(out('square.r1cs'), {
      n8: curve.Fr.n8,
      prime: curve.r,
      curve,
      nVars: 3,
      nOutputs: 1,
      nPubInputs: 0,
      nPrvInputs: 1,
      nLabels: 3,
      constraints: [[{ 2: one }, { 2: one }, { 1: one }]],
      map: [0, 1, 2],
    });

    await snarkjs.powersOfTau.newAccumulator(curve, 2, out('raw.ptau'), snLog);
    await snarkjs.powersOfTau.contribute(out('raw.ptau'), out('contributed.ptau'), 'mock ptau participant', 'mock ptau entropy', snLog);
    await snarkjs.powersOfTau.preparePhase2(out('contributed.ptau'), out('pot_final.ptau'), snLog);

    await buildGenesis({ r1cs: out('square.r1cs'), ptau: out('pot_final.ptau'), outDir: o.out, logger: snLog });

    console.log(`small ceremony artifacts written to ${o.out}`);
    console.log(`  r1cs    ${out('square.r1cs')}`);
    console.log(`  ptau    ${out('pot_final.ptau')}`);
    console.log(`  zkey    ${out('circuit_0000.zkey')}`);
    console.log(`  genesis ${out('circuit_0000.p2c')}`);
  } finally {
    await curve.terminate();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e?.message || e);
    process.exit(1);
  },
);
