import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAttestorHealthy } from '../src/health.js';

const url = 'https://example.com';
const healthy = { ok: true, network: 'testnet', ceremonyId: '0x1', attestor: { state: 'waiting', stale: false } };
const check = (fetchFn) => requireAttestorHealthy(url, '0x' + '1'.padStart(64, '0'), 'testnet', { fetchFn });

test('health checks use a bounded, uncached GET and permit active verification', async () => {
  for (const state of ['waiting', 'polling', 'verifying', 'accepting', 'rejecting']) {
    await check(async (target, options) => {
      assert.equal(String(target), url + '/status.json');
      assert.equal(options.method, 'GET');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ ...healthy, attestor: { state, stale: false } });
    });
  }
});

test('unreachable, unsupported and unhealthy attestors stop with same-workdir guidance', async () => {
  for (const status of [404, 502, 503, 504]) {
    await assert.rejects(check(async () => new Response('private server error', { status })), new RegExp(`HTTP ${status}.*same workdir`));
  }
  await assert.rejects(check(async () => { throw new Error('secret transport details'); }), (error) => {
    assert.match(error.message, /connection failed or timed out.*same workdir/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  await assert.rejects(check(async () => new Response('not JSON')), /invalid response.*same workdir/);
  for (const status of [null, {}, { ok: true }, { ...healthy, ok: false }, { ...healthy, attestor: { state: 'stopped', stale: false } }, { ...healthy, attestor: { state: 'waiting', stale: true } }]) {
    await assert.rejects(check(async () => Response.json(status)), /healthy loop.*same workdir/);
  }
});

test('health must belong to the selected ceremony and network, and needs a public coordinator URL', async () => {
  for (const change of [{ ceremonyId: '0x2' }, { ceremonyId: null }, { network: 'mainnet' }]) {
    await assert.rejects(check(async () => Response.json({ ...healthy, ...change })), /different ceremony or network/);
  }
  await assert.rejects(requireAttestorHealthy(null, '0x1', 'testnet'), /no coordinator URL/);
  await assert.rejects(requireAttestorHealthy(url + '/fund/' + 'a'.repeat(64), '0x1', 'testnet'), /must be public/);
});
