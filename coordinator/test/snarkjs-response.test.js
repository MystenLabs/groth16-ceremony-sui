import assert from 'node:assert/strict';
import test from 'node:test';
import { runContributionStepOrReject } from '../src/crypto/snarkjs.js';

test('runContributionStepOrReject applies the contribution-error policy', async (t) => {
  await t.test('preserves a successful value', async () => {
    assert.deepEqual(
      await runContributionStepOrReject('read', async () => ({ hash: 'abc' })),
      { ok: true, value: { hash: 'abc' } },
    );
  });

  await t.test('turns an explicit verification failure into a rejection', async () => {
    assert.deepEqual(
      await runContributionStepOrReject('verifyFromInit', async () => false),
      { ok: false, reason: 'invalid chain (verifyFromInit)' },
    );
  });

  await t.test('turns an uncoded parser exception into a rejection', async () => {
    assert.deepEqual(
      await runContributionStepOrReject('decompress', async () => {
        throw new Error('invalid file magic');
      }),
      { ok: false, reason: 'verification failed (decompress: invalid file magic)' },
    );
  });

  await t.test('rejects a coded operational error', async () => {
    const error = Object.assign(new Error('file missing'), { code: 'ENOENT' });
    assert.deepEqual(
      await runContributionStepOrReject('decompress', async () => { throw error; }),
      { ok: false, reason: 'verification failed (decompress: file missing)' },
    );
  });

  await t.test('rejects a coded parsing error', async () => {
    const error = Object.assign(new RangeError('offset out of range'), { code: 'ERR_OUT_OF_RANGE' });
    assert.deepEqual(
      await runContributionStepOrReject('read', async () => { throw error; }),
      { ok: false, reason: 'verification failed (read: offset out of range)' },
    );
  });
});
