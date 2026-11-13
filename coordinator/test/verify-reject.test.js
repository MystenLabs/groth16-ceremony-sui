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
import { contribute, compress, decompress } from '../../cli/src/crypto.js';

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

  await t.test('the attestor and the CLI agree on an honest, an inflated, and a padded blob', async () => {
    // Run the CLI steps of the next contributor. Return the error message, or null.
    const cliExtendError = async (bytes) => {
      try {
        const p2u = await decompress(new Uint8Array(bytes), snLog);
        const next = await contribute(p2u, 'next participant', 'next entropy', snLog);
        await compress(next.bytes, snLog);
        return null;
      } catch (error) {
        return error?.message || String(error);
      }
    };
    const honest = fs.readFileSync(subP2c);
    // The header declares one section more than the file contains.
    const inflated = Buffer.from(honest);
    inflated.writeUInt32LE(inflated.readUInt32LE(8) + 1, 8);
    const padded = Buffer.concat([honest, Buffer.alloc(16)]);

    const cases = [['honest', honest, true], ['inflated-count', inflated, false], ['trailing-bytes', padded, true]];
    for (const [label, bytes, expected] of cases) {
      const file = path.join(tmp, `${label}.p2c`);
      fs.writeFileSync(file, bytes);
      const verdict = await runVerifySteps({ ...args, subPath: file });
      const cliError = await cliExtendError(bytes);
      assert.equal(verdict.ok, expected, `attestor verdict for ${label}: ${verdict.reason}`);
      if (expected) {
        assert.equal(cliError, null, `CLI result for ${label}`);
      } else {
        assert.match(verdict.reason, /Reading out of bounds/);
        assert.match(cliError, /Reading out of bounds/);
      }
    }
  });

  await t.test('a beacon entry in a submission rejects before the slow steps', async () => {
    // Add a beacon entry to the honest contribution, as the seal step does.
    const fullZkey = path.join(tmp, 'full.zkey');
    const beaconZkey = path.join(tmp, 'beacon.zkey');
    const beaconP2u = path.join(tmp, 'beacon.p2u');
    const beaconP2c = path.join(tmp, 'beacon.p2c');
    await snarkjs.zKey.assemble(baseZkey, contribP2u, fullZkey, snLog);
    const beaconHash = await snarkjs.zKey.beacon(fullZkey, beaconZkey, 'beacon', 'ab'.repeat(32), 10, snLog);
    await snarkjs.zKey.extract(beaconZkey, beaconP2u, snLog);
    await snarkjs.zKey.compressV2Params(beaconP2u, beaconP2c, snLog);
    // Add a plain contribution after the beacon entry.
    const laterP2u = path.join(tmp, 'later.p2u');
    const laterP2c = path.join(tmp, 'later.p2c');
    const laterHash = await snarkjs.zKey.contribute(beaconP2u, laterP2u, 'later participant', 'later entropy', snLog);
    await snarkjs.zKey.compressV2Params(laterP2u, laterP2c, snLog);

    // Add a plain contribution to the honest head. Then change entry 1 to a beacon type.
    // The entry hash does not include the type, so the extends check passes.
    const secondP2u = path.join(tmp, 'second.p2u');
    const secondP2c = path.join(tmp, 'second.p2c');
    const forgedP2c = path.join(tmp, 'forged-type.p2c');
    const secondHash = await snarkjs.zKey.contribute(contribP2u, secondP2u, 'second', 'second entropy', snLog);
    await snarkjs.zKey.compressV2Params(secondP2u, secondP2c, snLog);
    const second = fs.readFileSync(secondP2c);
    const parts = [second.subarray(0, 12)];
    for (let offset = 12; offset < second.length;) {
      const end = offset + 12 + Number(second.readBigUInt64LE(offset + 4));
      let body = second.subarray(offset + 12, end);
      if (second.readUInt32LE(offset) === 10) {
        // Entry 1 ends with: type (u32), parameter length (u32), then [1, 11, 'participant'].
        const name = body.indexOf(Buffer.from('participant'));
        const fields = Buffer.alloc(8);
        fields.writeUInt32LE(1, 0);
        fields.writeUInt32LE(13 + 36, 4);
        const beacon = Buffer.concat([Buffer.from([2, 63, 3, 32]), Buffer.alloc(32, 0xab)]);
        body = Buffer.concat([body.subarray(0, name - 10), fields, body.subarray(name - 2, name + 11), beacon, body.subarray(name + 11)]);
      }
      const header = Buffer.from(second.subarray(offset, offset + 12));
      header.writeBigUInt64LE(BigInt(body.length), 4);
      parts.push(header, body);
      offset = end;
    }
    fs.writeFileSync(forgedP2c, Buffer.concat(parts));

    const cases = [
      ['the new entry is a beacon entry', subP2c, beaconP2c, beaconHash],
      ['an earlier entry is a beacon entry', beaconP2c, laterP2c, laterHash],
      ['an earlier plain entry is changed to a beacon type', subP2c, forgedP2c, secondHash],
    ];
    for (const [label, headPath, subPath, hash] of cases) {
      const steps = [];
      const result = await runVerifySteps({
        ...args,
        headPath,
        subPath,
        expectedHash: Buffer.from(hash).toString('hex'),
        step: (key, fn) => { steps.push(key); return fn(); },
      });
      assert.deepEqual(result, { ok: false, reason: 'submission contains an entry that is not a plain contribution' }, label);
      assert.deepEqual(steps, ['load', 'extends', 'transcript'], label);
    }
  });

  await t.test('a section that declares more bytes than the file contains rejects', async () => {
    const bytes = fs.readFileSync(subP2c);
    const header = bytes.subarray(0, 12);
    const sections = [];
    for (let offset = 12; offset < bytes.length;) {
      const end = offset + 12 + Number(bytes.readBigUInt64LE(offset + 4));
      sections.push({ id: bytes.readUInt32LE(offset), bytes: bytes.subarray(offset, end) });
      offset = end;
    }
    // Put section 8 last. Then only its body goes past the end of the file.
    const last = Buffer.from(sections.find((section) => section.id === 8).bytes);
    last.writeBigUInt64LE(2n ** 30n, 4);
    const others = sections.filter((section) => section.id !== 8).map((section) => section.bytes);
    const oversized = path.join(tmp, 'oversized-section.p2c');
    fs.writeFileSync(oversized, Buffer.concat([header, ...others, last]));

    const result = await runVerifySteps({ ...args, subPath: oversized });
    assert.equal(result.ok, false);
    assert.match(result.reason, /verification failed \(decompress:/);
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

// Exception handling covers only the failures that code can catch. A V8
// heap-OOM abort kills the process. One subtest fills a small worker heap to
// cause that abort.
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

  await t.test('an unbounded section count is a reject, and the worker stays alive', async () => {
    // 'p2c\0' + version=1 + nSections=0xFFFFFFFF, with no sections after the header.
    const evil = path.join(tmp, 'evil-count.p2c');
    fs.writeFileSync(evil, Buffer.from('70326300010000 00ffffffff'.replace(/ /g, ''), 'hex'));
    const r = await runVerifyStepsIsolated({ ...args, subPath: evil });
    assert.equal(r.ok, false);
    assert.match(r.reason, /verification failed \(extends: Reading out of bounds\)/);
    assert.deepEqual(Object.keys(r.timings), ['load', 'extends']);
  });

  await t.test('a blob that fills the worker heap is a reject, not a coordinator death', async () => {
    // 'p2c\0' + version=1 + 3,000,000 empty sections that the file does contain.
    const count = 3_000_000;
    const bytes = Buffer.alloc(12 + 12 * count);
    bytes.write('p2c\0', 0, 'latin1');
    bytes.writeUInt32LE(1, 4);
    bytes.writeUInt32LE(count, 8);
    for (let i = 0; i < count; i++) bytes.writeUInt32LE(1, 12 + 12 * i);
    const evil = path.join(tmp, 'evil-heap.p2c');
    fs.writeFileSync(evil, bytes);
    const r = await runVerifyStepsIsolated({ ...args, subPath: evil });
    assert.equal(r.ok, false);
    assert.match(r.reason, /malformed submission \(verify process died/);
  });

  await t.test('a local artifact problem rejects through the worker', async () => {
    const result = await runVerifyStepsIsolated({ ...args, baseZkey: path.join(tmp, 'absent.zkey'), subPath: subP2c });
    assert.equal(result.ok, false);
    assert.match(result.reason, /ENOENT/);
  });
});
