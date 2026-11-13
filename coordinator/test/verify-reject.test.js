// Contribution-error classification and pre-download size policy. Explicit
// failed checks and all wrapped snarkjs exceptions reject, including operational
// errors. Worker crashes/timeouts also reject.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as snarkjs from 'snarkjs';
import { writeR1cs } from 'r1csfile';
import {
  runVerifyStepsIsolated,
  checkSubmissionSize,
  MAX_SUBMISSION_BYTES,
} from '../src/lib/verify_contribution.js';

import { runVerifySteps } from '../src/crypto/verify_contribution.js';

const snLog = { info() {}, debug() {}, warn() {}, error() {} };

test('runVerifySteps requires a well-formed expected hash before reading files', async () => {
  for (const expectedHash of [undefined, null, '', 42, '00', 'gg'.repeat(64)]) {
    await assert.rejects(
      runVerifySteps({ expectedHash }),
      /expectedHash/,
    );
  }
});

test('runVerifySteps rejects malformed inputs and filesystem errors', { timeout: 90_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-verify-reject-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const curve = await snarkjs.curves.getCurveFromName('bn128', { singleThread: true });
  t.after(async () => { await curve.terminate(); });

  // Tiny square circuit + power-2 ptau, same fixture as the seal test.
  const r1cs = path.join(tmp, 'square.r1cs');
  const rawPtau = path.join(tmp, 'raw.ptau');
  const contributedPtau = path.join(tmp, 'contributed.ptau');
  const ptau = path.join(tmp, 'pot.ptau');
  const baseZkey = path.join(tmp, 'base.zkey');
  const genesisP2u = path.join(tmp, 'genesis.p2u');
  const headP2c = path.join(tmp, 'head.p2c');
  const contribP2u = path.join(tmp, 'contrib.p2u');
  const subP2c = path.join(tmp, 'sub.p2c');

  const one = curve.Fr.e(1);
  await writeR1cs(r1cs, {
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
  await snarkjs.powersOfTau.newAccumulator(curve, 2, rawPtau, snLog);
  await snarkjs.powersOfTau.contribute(rawPtau, contributedPtau, 'ptau participant', 'ptau entropy', snLog);
  await snarkjs.powersOfTau.preparePhase2(contributedPtau, ptau, snLog);
  await snarkjs.zKey.newZKey(r1cs, ptau, baseZkey, snLog);
  await snarkjs.zKey.extract(baseZkey, genesisP2u, snLog);
  await snarkjs.zKey.compressV2Params(genesisP2u, headP2c, snLog);
  const contributionHash = await snarkjs.zKey.contribute(genesisP2u, contribP2u, 'participant', 'participant entropy', snLog);
  await snarkjs.zKey.compressV2Params(contribP2u, subP2c, snLog);

  const args = { headPath: headP2c, baseZkey, ptau, workdir: tmp, expectedHash: Buffer.from(contributionHash).toString('hex') };

  await t.test('a valid contribution verifies', async () => {
    const r = await runVerifyStepsIsolated({ ...args, subPath: subP2c });
    assert.equal(r.ok, true);
  });

  await t.test('an uncoded parser exception rejects directly and through the worker', async () => {
    const junk = path.join(tmp, 'junk.p2c');
    fs.writeFileSync(junk, Buffer.from('not a params file, definitely long enough to read a magic from'));
    const direct = await runVerifySteps({ ...args, subPath: junk });
    assert.equal(direct.ok, false);
    assert.match(direct.reason, /verification failed \(extends:/);
    const isolated = await runVerifyStepsIsolated({ ...args, subPath: junk });
    assert.equal(isolated.ok, false);
    assert.match(isolated.reason, /verification failed \(extends:/);
  });

  await t.test('a truncated p2c rejects as malformed', async () => {
    const truncated = path.join(tmp, 'truncated.p2c');
    const bytes = fs.readFileSync(subP2c);
    fs.writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const result = await runVerifySteps({ ...args, subPath: truncated });
    assert.equal(result.ok, false);
    assert.match(result.reason, /verification failed/);
  });

  await t.test('corrupt compressed points reject through full verification', async () => {
    const corrupt = path.join(tmp, 'corrupt-points.p2c');
    const bytes = fs.readFileSync(subP2c);
    let offset = 12;
    while (offset < bytes.length) {
      const section = bytes.readUInt32LE(offset);
      const size = Number(bytes.readBigUInt64LE(offset + 4));
      if (section === 8) {
        bytes.fill(0xff, offset + 12, offset + 12 + size);
        break;
      }
      offset += 12 + size;
    }
    assert.ok(offset < bytes.length, 'fixture has a compressed L section');
    fs.writeFileSync(corrupt, bytes);

    const result = await runVerifySteps({ ...args, subPath: corrupt });
    assert.equal(result.ok, false);
    assert.match(result.reason, /verifyFromInit/);
  });

  await t.test('a missing local file rejects', async () => {
    const result = await runVerifySteps({ ...args, subPath: path.join(tmp, 'does-not-exist.p2c') });
    assert.equal(result.ok, false);
    assert.match(result.reason, /ENOENT/);
  });
});

test('checkSubmissionSize enforces a fixed upper bound', () => {
  // A real full p2c for the 2^21 circuit is ~120 MB; it must pass, so the limit
  // has to sit above it, not below.
  assert.equal(checkSubmissionSize(120 * 1024 * 1024).ok, true);
  assert.equal(checkSubmissionSize(MAX_SUBMISSION_BYTES).ok, true);
  const over = checkSubmissionSize(MAX_SUBMISSION_BYTES + 1);
  assert.equal(over.ok, false);
  assert.match(over.reason, /too large/);
  // No readable on-chain size is a reject, not a pass: the bound is the only
  // thing standing between the attestor and an arbitrarily large download.
  assert.equal(checkSubmissionSize(null).ok, false);
  assert.equal(checkSubmissionSize(undefined).ok, false);
});

// Exception propagation only covers failures that surface as catchable
// exceptions. A blob whose header declares an absurd
// section count drives the parser into an unbounded allocation, and a V8
// heap-OOM abort is process-fatal: no try/catch can see it.
test('runVerifyStepsIsolated survives a blob that kills the process it parses in', { timeout: 180_000 }, async (t) => {
  const prevCap = process.env.VERIFY_MAX_OLD_SPACE_MB;
  process.env.VERIFY_MAX_OLD_SPACE_MB = '128';
  t.after(() => { if (prevCap === undefined) delete process.env.VERIFY_MAX_OLD_SPACE_MB; else process.env.VERIFY_MAX_OLD_SPACE_MB = prevCap; });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-isolate-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const curve = await snarkjs.curves.getCurveFromName('bn128', { singleThread: true });
  t.after(async () => { await curve.terminate(); });

  const r1cs = path.join(tmp, 'square.r1cs');
  const rawPtau = path.join(tmp, 'raw.ptau');
  const contributedPtau = path.join(tmp, 'contributed.ptau');
  const ptau = path.join(tmp, 'pot.ptau');
  const baseZkey = path.join(tmp, 'base.zkey');
  const genesisP2u = path.join(tmp, 'genesis.p2u');
  const headP2c = path.join(tmp, 'head.p2c');

  const one = curve.Fr.e(1);
  await writeR1cs(r1cs, {
    n8: curve.Fr.n8, prime: curve.r, curve,
    nVars: 3, nOutputs: 1, nPubInputs: 0, nPrvInputs: 1, nLabels: 3,
    constraints: [[{ 2: one }, { 2: one }, { 1: one }]], map: [0, 1, 2],
  });
  await snarkjs.powersOfTau.newAccumulator(curve, 2, rawPtau, snLog);
  await snarkjs.powersOfTau.contribute(rawPtau, contributedPtau, 'p', 'e', snLog);
  await snarkjs.powersOfTau.preparePhase2(contributedPtau, ptau, snLog);
  await snarkjs.zKey.newZKey(r1cs, ptau, baseZkey, snLog);
  await snarkjs.zKey.extract(baseZkey, genesisP2u, snLog);
  await snarkjs.zKey.compressV2Params(genesisP2u, headP2c, snLog);

  const contribP2u = path.join(tmp, 'c.p2u');
  const subP2c = path.join(tmp, 'c.p2c');
  const contributionHash = await snarkjs.zKey.contribute(genesisP2u, contribP2u, 'alice', 'entropy', snLog);
  await snarkjs.zKey.compressV2Params(contribP2u, subP2c, snLog);
  const args = { headPath: headP2c, baseZkey, ptau, workdir: tmp, expectedHash: Buffer.from(contributionHash).toString('hex') };

  await t.test('an unbounded section count is a reject, not a coordinator death', async () => {
    // 'p2c\0' + version=1 + nSections=0xFFFFFFFF
    const evil = path.join(tmp, 'evil.p2c');
    fs.writeFileSync(evil, Buffer.from('70326300010000 00ffffffff'.replace(/ /g, ''), 'hex'));
    const r = await runVerifyStepsIsolated({ ...args, subPath: evil });
    assert.equal(r.ok, false);
    assert.match(r.reason, /malformed submission/);
  });

  await t.test('a local artifact problem rejects through the worker', async () => {
    const result = await runVerifyStepsIsolated({ ...args, baseZkey: path.join(tmp, 'absent.zkey'), subPath: subP2c });
    assert.equal(result.ok, false);
    assert.match(result.reason, /ENOENT/);
  });
});
