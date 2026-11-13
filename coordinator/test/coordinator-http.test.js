import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { QueueActivity } from '../src/lib/queue-activity.js';
import { startCoordinatorHttpServer } from '../src/coordinator_http.js';
import { AttestorStatus } from '../src/lib/attestor_status.js';
import { cleanName } from '../src/lib/status.js';

const addr = (ch) => `0x${ch.repeat(64)}`;

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

test('malformed request URLs return 400 and leave the server available', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-http-'));
  const server = startCoordinatorHttpServer(0, dir);
  t.after(async () => {
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const port = server.address().port;

  // Use a raw request path: fetch would parse the malformed URL before sending it.
  const bad = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '//%5coast.me' }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
      response.on('error', reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error('HTTP response timed out')));
    request.on('error', reject);
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(JSON.parse(bad.body), { ok: false, error: 'Invalid request URL' });

  const good = await fetch(`http://127.0.0.1:${port}/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'after-malformed-url' }),
  });
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { ok: true });
});

test('status page and API report a stopped or stale loop as unhealthy even while HTTP is serving', async (t) => {
  let now = 100_000;
  const monitor = new AttestorStatus({ network: 'testnet', ceremonyId: addr('b'), pollMs: 5000, now: () => now });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-status-http-'));
  const server = startCoordinatorHttpServer(0, dir, { monitor });
  t.after(async () => { await closeServer(server); fs.rmSync(dir, { recursive: true, force: true }); });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/status.json`)).status, 503);
  monitor.observe({ phase: { '@variant': 'Phase2Contribute' }, chain: [], slot: { '@variant': 'Open' } });
  const healthy = await fetch(`${base}/status.json`);
  assert.equal(healthy.status, 200);
  assert.equal(healthy.headers.get('cache-control'), 'no-store');
  assert.equal((await healthy.json()).queue.waitingCount, 0);
  now += 30_000;
  assert.equal((await fetch(`${base}/status.json`)).status, 503);
  monitor.fail('Operator review needed', { stopped: true });
  const stopped = await fetch(`${base}/status.json`);
  assert.equal(stopped.status, 503);
  assert.equal((await stopped.json()).attestor.state, 'stopped');
  for (const route of ['/status', '/status/']) {
    const page = await fetch(`${base}${route}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await page.text(), /Ceremony monitor/);
  }
  const script = await fetch(`${base}/status.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${base}/status.json`, { method: 'POST' })).status, 404);
  assert.equal(fs.existsSync(path.join(dir, 'logs/telemetry.jsonl')), false);
});

test('coordinator HTTP server records valid enrollment requests and rejects bad addresses', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-http-'));
  const server = startCoordinatorHttpServer(0, dir);
  t.after(async () => {
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const good = await fetch(`${base}/enroll-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cli: true,
      ceremonyId: addr('b'),
      network: 'testnet',
      address: addr('a'),
      name: 'Alice',
      permissioned: true,
      cliVersion: '0.1.0',
    }),
  });
  assert.equal(good.status, 202);
  assert.deepEqual(await good.json(), { ok: true, status: 'pending_manual_approval' });

  const logPath = path.join(dir, 'logs', 'enrollment-requests.jsonl');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.deepEqual(row, {
    ts: row.ts,
    kind: 'enroll-request',
    status: 'pending_manual_approval',
    address: addr('a'),
    ceremonyId: addr('b'),
    network: 'testnet',
    name: 'Alice',
    cliVersion: '0.1.0',
    permissioned: true,
    cli: true,
  });

  const bad = await fetch(`${base}/enroll-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: '0x2' }),
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /invalid address/);
  assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 1);
});


test('queue endpoint counts fresh distinct waiters by ceremony and removes inactive clients', async (t) => {
  let now = Date.parse('2026-09-11T15:00:00Z');
  const queueActivity = new QueueActivity({ now: () => now });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-queue-'));
  const server = startCoordinatorHttpServer(0, dir, { queueActivity });
  t.after(async () => {
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const heartbeat = async (ephemeralAddr, phase = 'waiting_for_slot', ceremonyId = '0x1', extra = {}) => {
    const response = await fetch(`${base}/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ceremonyId, ephemeralAddr, phase, ...extra }),
    });
    assert.equal(response.status, 200);
    await response.json();
  };
  const snapshot = async () => {
    const response = await fetch(`${base}/queue?ceremonyId=0x1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  };
  assert.deepEqual(await snapshot(), { waitingCount: 0, asOf: new Date(now).toISOString() });
  await heartbeat('0xa');
  await heartbeat(`0x${'A'.padStart(64, '0')}`); // same contributor, normalized
  await heartbeat('0xb');
  await heartbeat('0xc', 'funding');
  await heartbeat('0xd', 'running');
  await heartbeat('0xe', 'waiting_for_slot', '0x2');
  await heartbeat('invalid');
  await heartbeat('0xf', 'waiting'); // legacy delayed clients are not slot waiters
  assert.equal((await snapshot()).waitingCount, 2);
  await heartbeat('0xa', 'running');
  assert.equal((await snapshot()).waitingCount, 1);
  now += 89_999;
  assert.equal((await snapshot()).waitingCount, 1);
  now += 1;
  assert.equal((await snapshot()).waitingCount, 0);
  await heartbeat('0xb', 'waiting_for_slot', '0x1', { ts: 0 });
  assert.equal((await snapshot()).waitingCount, 1); // server time, not client time
  await heartbeat('0xb', 'stopped');
  assert.equal((await snapshot()).waitingCount, 0);
  for (const suffix of ['', '?ceremonyId=invalid']) {
    const response = await fetch(`${base}/queue${suffix}`);
    assert.equal(response.status, 400);
    await response.json();
  }
  assert.equal((await fetch(`${base}/queue?ceremonyId=0x1`, { method: 'POST' })).status, 404);
});

test('status shows a heartbeat name for the active contributor before submission', async (t) => {
  let now = 100_000;
  const ceremonyId = addr('b');
  const who = addr('c');
  const monitor = new AttestorStatus({ network: 'testnet', ceremonyId, pollMs: 5000, now: () => now });
  const queueActivity = new QueueActivity({ now: () => now });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-status-name-'));
  const server = startCoordinatorHttpServer(0, dir, { monitor, queueActivity });
  t.after(async () => { await closeServer(server); fs.rmSync(dir, { recursive: true, force: true }); });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const slot = async () => (await (await fetch(`${base}/status.json`)).json()).ceremony.slot;
  const earlier = { contributor: who, name: 'Earlier Alice', ts_ms: '1', blob_id: '0x1' };
  monitor.observe({ phase: { '@variant': 'Phase2Contribute' }, chain: [earlier], slot: { '@variant': 'Claimed', who, until_ms: '200000' } });
  assert.equal((await slot()).reportedName, 'Earlier Alice');

  await fetch(`${base}/heartbeat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ceremonyId, ephemeralAddr: who.toUpperCase().replace('0X', '0x'), phase: 'running', name: ' Alice\u0007 ' }),
  });
  const claimed = await slot();
  assert.equal(claimed.name, '');
  assert.equal(claimed.reportedName, 'Alice');

  // An expired heartbeat name falls back to the earlier chain name.
  now += 90_000;
  assert.equal((await slot()).reportedName, 'Earlier Alice');

  // The on-chain name wins after submission, even with a fresh heartbeat and an earlier chain name.
  await fetch(`${base}/heartbeat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ceremonyId, ephemeralAddr: who, phase: 'running', name: 'Alice' }),
  });
  monitor.observe({ phase: { '@variant': 'Phase2Contribute' }, chain: [earlier], slot: { '@variant': 'Pending', who, blob_id: '0x2', contribution_hash: '', name: 'Alice on chain' } });
  const pending = await slot();
  assert.equal(pending.name, 'Alice on chain');
  assert.equal(pending.reportedName, '');
});

test('reported names drop bidi controls', () => {
  assert.equal(cleanName('Eve\u202E\u2066x\u200F'), 'Evex');
});
