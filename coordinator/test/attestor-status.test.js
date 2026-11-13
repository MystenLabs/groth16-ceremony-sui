import test from 'node:test';
import assert from 'node:assert/strict';
import { AttestorStatus } from '../src/lib/attestor_status.js';

const head = { phase: { '@variant': 'Phase2Contribute' }, permissioned: true, head_blob_id: '0xabc', chain: [], slot: { '@variant': 'Open' } };

test('health follows actual loop activity, including stalled reads, failures, recovery and a stopped loop', () => {
  let now = 100_000;
  const status = new AttestorStatus({ network: 'testnet', ceremonyId: '0x1', pollMs: 5000, now: () => now });
  assert.equal(status.snapshot().ok, false);
  status.observe(head);
  assert.equal(status.snapshot().ok, true);
  status.activity('polling', 'Reading ceremony from Sui');
  now += 30_000;
  assert.equal(status.snapshot().ok, false);
  assert.equal(status.snapshot().attestor.stale, true);
  status.observe(head);
  assert.equal(status.snapshot().ok, true);
  status.fail('RPC unavailable');
  status.activity('polling', 'Retrying');
  assert.equal(status.snapshot().ok, false); // A retry is not proof of recovery.
  status.observe(head);
  assert.equal(status.snapshot().ok, true);
  status.fail('Verification stopped', { stopped: true });
  assert.equal(status.snapshot().ok, false);
  assert.equal(status.snapshot().attestor.state, 'stopped');
});

test('long verification uses its activity deadline rather than the short polling allowance', () => {
  let now = 100_000;
  const status = new AttestorStatus({ network: 'testnet', ceremonyId: '0x1', pollMs: 5000, now: () => now });
  status.observe(head);
  status.activity('verifying', 'Checking cryptography', 660_000);
  now += 120_000;
  assert.equal(status.snapshot().ok, true);
  assert.equal(status.snapshot().attestor.lastChainReadAt, 100_000);
  now += 540_000;
  assert.equal(status.snapshot().ok, false);
});

test('public status projects only ceremony fields and caps recent entries', () => {
  const status = new AttestorStatus({ network: 'testnet', ceremonyId: '0x1', pollMs: 5000 });
  status.observe({ ...head, secret: 'must-not-leak', coordinator_url: 'must-not-leak',
    slot: { '@variant': 'Claimed', who: '0xa', until_ms: '123456' },
    chain: Array.from({ length: 25 }, (_, i) => ({ name: `contributor-${i}`, contributor: '0xa', ts_ms: String(i), blob_id: '0xb', private: 'must-not-leak' })),
  });
  const result = status.snapshot();
  assert.equal(result.ceremony.chainLength, 25);
  assert.equal(result.ceremony.recent.length, 20);
  assert.equal(result.ceremony.recent[0].name, 'contributor-24');
  assert.equal(result.ceremony.recent[0].index, 25);
  assert.equal(result.ceremony.slot.until, 123456);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
});
