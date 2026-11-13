import test from 'node:test';
import assert from 'node:assert/strict';
import { formatQueueActivity, reportQueueActivity } from '../src/queue-activity.js';

test('activity messaging uses hours only above one hour and keeps running clients waiting', () => {
  assert.match(formatQueueActivity(6), /roughly 60 minutes/);
  assert.doesNotMatch(formatQueueActivity(6), /Try again/);
  assert.match(formatQueueActivity(7), /Try again in a few hours/);
  assert.doesNotMatch(formatQueueActivity(7, { running: true }), /leave this running/, 'the waiting checklist says this');
  assert.doesNotMatch(formatQueueActivity(7, { running: true }), /Try again/);
  assert.match(formatQueueActivity(4, { minutesPerContribution: 20 }), /busy/);
  assert.match(formatQueueActivity(0), /0 contributors are waiting/);
  for (const value of [-1, 0.5, '5', null, Infinity]) assert.equal(formatQueueActivity(value), null);
});

test('activity fetch handles unsupported coordinators and network failures without blocking', async (t) => {
  const messages = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url.pathname, '/queue');
    assert.equal(url.searchParams.get('ceremonyId'), '0x1');
    return { ok: true, json: async () => ({ waitingCount: 7 }) };
  });
  await reportQueueActivity('https://example.invalid', '0x1', (s) => messages.push(s));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /7 contributors are waiting/);
  globalThis.fetch = async () => ({ ok: false });
  await reportQueueActivity('https://example.invalid', '0x1', (s) => messages.push(s));
  globalThis.fetch = async () => { throw new Error('offline'); };
  await reportQueueActivity('https://example.invalid', '0x1', (s) => messages.push(s));
  assert.equal(messages.length, 1);
});

test('activity estimate uses the ceremony claim window when known', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ waitingCount: 3 }) }));
  const messages = [];
  await reportQueueActivity('https://example.invalid', '0x1', (s) => messages.push(s), { slotDurationMs: 15 * 60_000 });
  await reportQueueActivity('https://example.invalid', '0x1', (s) => messages.push(s));
  assert.match(messages[0], /roughly 45 minutes/);
  assert.match(messages[1], /roughly 30 minutes/); // older packages: 10-minute fallback
});
