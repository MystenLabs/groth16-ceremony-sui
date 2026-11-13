import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as snarkjs from 'snarkjs';
import { writeR1cs } from 'r1csfile';
import { buildFinalBeaconP2c } from '../src/crypto/seal.js';
import { buildGenesis, readContributionInfo } from '../src/crypto/snarkjs.js';
import { b2sumFile } from '../src/crypto/commitments.js';
import { runVerifySteps, verifyBaseCircuit } from '../src/crypto/verify_contribution.js';
import { runVerifyStepsIsolated } from '../src/lib/verify_contribution.js';
import { verifyFinalArtifacts } from '../src/crypto/audit.js';
import { contribute, compress, decompress } from '../../cli/src/crypto.js';

const BEACON = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const snLog = { info() {}, debug() {}, warn() {}, error() {} };

test('offline ceremony: genesis, CLI contribution, isolated verification, beacon, and final audit', { timeout: 180_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-seal-e2e-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const curve = await snarkjs.curves.getCurveFromName('bn128', { singleThread: true });
  t.after(async () => { await curve.terminate(); });

  const r1cs = path.join(tmp, 'square.r1cs');
  const rawPtau = path.join(tmp, 'raw.ptau');
  const contributedPtau = path.join(tmp, 'contributed.ptau');
  const ptau = path.join(tmp, 'pot.ptau');

  const headP2c = path.join(tmp, 'head.p2c');

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

  const { fullZkey: baseZkey, p2c: genesisP2c } = await buildGenesis({ r1cs, ptau, outDir: tmp, logger: snLog });
  const input = await decompress(new Uint8Array(fs.readFileSync(genesisP2c)), snLog);
  const contributed = await contribute(input, 'participant', 'participant entropy', snLog);
  fs.writeFileSync(headP2c, await compress(contributed.bytes, snLog));
  await verifyBaseCircuit(baseZkey, headP2c);
  const verifyArgs = { headPath: genesisP2c, subPath: headP2c, baseZkey, ptau, workdir: tmp };
  const verified = await runVerifyStepsIsolated({ ...verifyArgs, expectedHash: contributed.hashHex });
  assert.deepEqual(Object.keys(verified.timings), ['load', 'extends', 'decompress', 'assemble', 'verifyFromInit', 'hash']);
  for (const seconds of Object.values(verified.timings)) assert.ok(Number.isFinite(seconds) && seconds >= 0);
  assert.equal(verified.ok, true);
  await t.test('a failed verifyFromInit result rejects explicitly', async () => {
    const fullPath = path.join(tmp, `full-${path.basename(headP2c).slice(0, 12)}.zkey`);
    const result = await runVerifySteps({
      ...verifyArgs,
      expectedHash: contributed.hashHex,
      step: async (key, fn) => {
        const value = await fn();
        if (key === 'assemble') {
          const bytes = fs.readFileSync(fullPath);
          let offset = 12;
          while (offset < bytes.length) {
            const section = bytes.readUInt32LE(offset);
            const size = Number(bytes.readBigUInt64LE(offset + 4));
            if (section === 10) {
              // Change the circuit hash that seeds the contribution transcript.
              // The file remains parseable, so verifyFromInit returns false.
              bytes[offset + 12] ^= 1;
              break;
            }
            offset += 12 + size;
          }
          assert.ok(offset < bytes.length, 'assembled fixture has an MPC section');
          fs.writeFileSync(fullPath, bytes);
        }
        return value;
      },
    });
    assert.deepEqual(result, { ok: false, reason: 'invalid chain (verifyFromInit)' });
  });
  const wrongHash = await runVerifyStepsIsolated({ ...verifyArgs, expectedHash: '00'.repeat(64) });
  assert.equal(wrongHash.ok, false);
  assert.match(wrongHash.reason, /contribution hash mismatch/);
  const rejected = await runVerifyStepsIsolated({ ...verifyArgs, headPath: headP2c, expectedHash: contributed.hashHex });
  assert.deepEqual(Object.keys(rejected.timings), ['load', 'extends']);
  const oldHead = rejected;
  assert.equal(oldHead.ok, false);
  assert.match(oldHead.reason, /does not extend head/);

  await t.test('omitting the expected hash is a caller error through the worker too', async () => {
    await assert.rejects(
      runVerifyStepsIsolated(verifyArgs),
      (e) => e.code === 'EVERIFYCHILD' && /expectedHash/.test(e.message),
    );
  });

  await t.test('parent timeout rejects even without a final worker response', async () => {
    const previous = process.env.VERIFY_TIMEOUT_MS;
    process.env.VERIFY_TIMEOUT_MS = '1'; // Deliberately insufficient even for worker startup.
    try {
      const timedOut = await runVerifyStepsIsolated({ ...verifyArgs, expectedHash: contributed.hashHex });
      assert.equal(timedOut.ok, false);
      assert.match(timedOut.reason, /verify exceeded/);
      assert.equal(timedOut.timings, undefined);
    } finally {
      if (previous === undefined) delete process.env.VERIFY_TIMEOUT_MS;
      else process.env.VERIFY_TIMEOUT_MS = previous;
    }
  });

  const sealed = await buildFinalBeaconP2c({
    headP2c,
    beaconHex: BEACON,
    name: 'final-beacon',
    baseZkey,
    ptau,
    workdir: tmp,
    beaconExp: 10,
  });

  assert.equal(sealed.sealedP2c, path.join(tmp, 'final.p2c'));
  assert.equal(sealed.fullSealedZkey, path.join(tmp, 'final.zkey'));
  assert.equal(sealed.verificationKey, path.join(tmp, 'final.vkey.json'));
  assert.equal(await snarkjs.zKey.v2paramsExtends(headP2c, sealed.sealedP2c), true);
  const finalBytes = new Uint8Array(fs.readFileSync(sealed.sealedP2c));
  assert.equal(String.fromCharCode(...finalBytes.subarray(0, 4)), 'p2c\0');
  assert.equal(sealed.hashHex.length, 128);
  assert.equal(sealed.beaconExp, 10);
  assert.deepEqual(sealed.sealedBytes, finalBytes);
  assert.deepEqual(sealed.vkeyBytes, fs.readFileSync(sealed.verificationKey));

  const { contributions } = await readContributionInfo(sealed.fullSealedZkey);
  assert.equal(contributions.length, 2);
  assert.deepEqual(contributions.at(-1), {
    type: 1,
    name: 'final-beacon',
    numIterationsExp: 10,
    beaconHash: BEACON,
  });

  const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64');
  const ceremony = {
    phase: { '@variant': 'Closed' },
    head_blob_id: 'final-blob',
    final_beacon: b64(BEACON),
    phase1_digest: b64(await b2sumFile(ptau)),
    chain: [
      { blob_id: 'participant-blob', contribution_hash: b64(contributed.hashHex), name: 'participant' },
      { blob_id: 'final-blob', contribution_hash: b64(sealed.hashHex), name: 'final-beacon' },
    ],
  };
  const auditArgs = {
    ceremony, r1cs, localR1cs: r1cs, ptau,
    // Offline test supplies the transport's blob-id result. The live mock
    // exercises actual Walrus content-id computation and downloads.
    expectedR1csBlobId: 'r1cs-content', actualR1csBlobId: 'r1cs-content',
    finalZkey: sealed.fullSealedZkey, finalVkey: sealed.verificationKey,
    contributions: [
      { sharedBlobId: 'participant-blob', file: headP2c },
      { sharedBlobId: 'final-blob', file: sealed.sealedP2c },
    ],
    workdir: tmp,
  };
  await t.test('the complete final audit passes with one participant and the final beacon', async () => {
    assert.deepEqual(await verifyFinalArtifacts(auditArgs), { contributionCount: 2 });
  });
  await t.test('audit rejects a valid beacon-only transcript with no participant contribution', async () => {
    const beaconOnlyZkey = path.join(tmp, 'beacon-only.zkey');
    const hash = await snarkjs.zKey.beacon(baseZkey, beaconOnlyZkey, 'final-beacon', BEACON, 10, snLog);
    const info = await readContributionInfo(beaconOnlyZkey);
    assert.deepEqual(info.contributions.map((entry) => entry.type), [1]);
    await assert.rejects(verifyFinalArtifacts({
      ...auditArgs,
      ceremony: {
        ...ceremony,
        chain: [{ blob_id: 'final-blob', contribution_hash: Buffer.from(hash).toString('base64'), name: 'final-beacon' }],
      },
      finalZkey: beaconOnlyZkey,
      // Rejection must happen before reading params or the verification key.
      finalVkey: path.join(tmp, 'unused.vkey.json'),
      contributions: [{ sharedBlobId: 'final-blob', file: path.join(tmp, 'unused.p2c') }],
    }), /closed ceremony has no accepted non-beacon contribution/);
  });
  for (const [name, change, error] of [
    ['phase-1 commitment', (j) => { j.phase1_digest = b64('00'.repeat(64)); }, /phase-1 digest mismatch/],
    ['beacon', (j) => { j.final_beacon = b64('00'.repeat(32)); }, /beacon does not match/],
    ['accepted hash', (j) => { j.chain[0].contribution_hash = b64('00'.repeat(64)); }, /contribution hash does not match/],
    ['final head', (j) => { j.head_blob_id = 'another-blob'; }, /head_blob_id does not match/],
    ['contribution count', (j) => { j.chain.shift(); }, /final zkey has 2 contributions/],
  ]) {
    await t.test(`audit rejects a changed ${name}`, async () => {
      const changed = structuredClone(ceremony);
      change(changed);
      await assert.rejects(verifyFinalArtifacts({ ...auditArgs, ceremony: changed }), error);
    });
  }
  await t.test('audit rejects a mismatched R1CS content id', async () => {
    await assert.rejects(verifyFinalArtifacts({ ...auditArgs, actualR1csBlobId: 'wrong-content' }), /r1cs Walrus blob id mismatch/);
  });
  await t.test('audit propagates file comparison errors instead of treating them as mismatches', async () => {
    await assert.rejects(
      verifyFinalArtifacts({ ...auditArgs, localR1cs: path.join(tmp, 'missing.r1cs') }),
      (error) => error.status > 1,
    );
  });
  await t.test('audit rejects a changed verification key', async () => {
    const badVkey = path.join(tmp, 'bad.vkey.json');
    fs.writeFileSync(badVkey, '{}');
    await assert.rejects(verifyFinalArtifacts({ ...auditArgs, finalVkey: badVkey }), /vkey does not match/);
  });
  await t.test('audit rejects changed final params even when the transcript matches', async () => {
    const badParams = path.join(tmp, 'bad-final.p2c');
    const bytes = fs.readFileSync(sealed.sealedP2c);
    // Section 8 contains L points, independent of the section-10 transcript.
    // Mutate its last byte without touching lengths or contribution records.
    let offset = 12;
    while (offset < bytes.length) {
      const section = bytes.readUInt32LE(offset);
      const size = Number(bytes.readBigUInt64LE(offset + 4));
      if (section === 8) { bytes[offset + 12 + size - 1] ^= 1; break; }
      offset += 12 + size;
    }
    assert.ok(offset < bytes.length, 'fixture has an L section');
    fs.writeFileSync(badParams, bytes);
    assert.deepEqual((await readContributionInfo(badParams)).hashes, (await readContributionInfo(sealed.sealedP2c)).hashes);
    await assert.rejects(verifyFinalArtifacts({
      ...auditArgs,
      contributions: [auditArgs.contributions[0], { sharedBlobId: 'final-blob', file: badParams }],
    }), /does not derive the final params blob/);
  });

});
