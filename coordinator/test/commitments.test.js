import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { b2sumFile, sha256File, resolvePhase1Digest } from '../src/crypto/commitments.js';

test('artifact file identities use standard SHA-256 and BLAKE2b-512', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-artifacts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'input.bin');
  fs.writeFileSync(file, 'abc');

  assert.equal(
    await sha256File(file),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    await b2sumFile(file),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
  );
});

test('phase-1 commitment resolution checks bytes and accepts normalized supplied hashes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-phase1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ptau = path.join(dir, 'phase1');
  fs.writeFileSync(ptau, 'phase1 bytes');
  const digest = await b2sumFile(ptau);
  assert.equal(await resolvePhase1Digest({ ptau }), digest);
  assert.equal(await resolvePhase1Digest({ ptau, suppliedDigest: digest.toUpperCase() }), digest);
  assert.equal(await resolvePhase1Digest({ suppliedDigest: digest }), digest);
  await assert.rejects(() => resolvePhase1Digest({ ptau, suppliedDigest: '00'.repeat(64) }), /digest mismatch/);
  await assert.rejects(() => resolvePhase1Digest({ suppliedDigest: 'abcd' }), /64-byte/);
  await assert.rejects(() => resolvePhase1Digest({}), /pass --ptau/);
});

test('streamed hashes cover multiple chunks and propagate missing-file errors', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-hash-stream-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'input.bin');
  fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024 + 13, 0xa5));
  // Independently computed with b2sum and shasum -a 256.
  assert.equal(await b2sumFile(file), '75d6aaeb747f3742080c66cd1cffd1abd230f3cfd6037790b3b6a7782a88631bdd9f3a220b1aa5022391e5e2c9a0021303f5e7193c4a9dcebaa3b5e242ef1195');
  assert.equal(await sha256File(file), '981e6ef993d1503b9b0ef847d827d3799dcfa25348be30857dd29054e41a7c49');
  await assert.rejects(b2sumFile(path.join(dir, 'missing')), { code: 'ENOENT' });
  await assert.rejects(sha256File(path.join(dir, 'missing')), { code: 'ENOENT' });
});
