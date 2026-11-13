// Optional coordinator HTTP server for private funding, telemetry, heartbeats,
// and legacy enrollment requests. Best-effort telemetry is observational: it records
// what contributors report; it never gates the chain (that's the attestor's
// verification). Enrollment requests are also append-only: they do not mutate
// the on-chain allowlist or spend funds. Appends rows to telemetry.jsonl and
// enrollment-requests.jsonl.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { QueueActivity, normalizeQueueId } from './lib/queue-activity.js';
import { log } from './lib/config.js';
import { appendEnrollmentRequest, enrollmentRequestsPath } from './lib/enrollment_requests.js';

const MAX_BODY_BYTES = 64 * 1024;
const monitorPage = fs.readFileSync(new URL('./status_page.html', import.meta.url));
const monitorScript = fs.readFileSync(new URL('./status_page.js', import.meta.url));

function writeJson(rs, status, body) {
  rs.writeHead(status, { 'Content-Type': 'application/json' });
  rs.end(JSON.stringify(body) + '\n');
}

function readBody(rq) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    rq.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; return; }
      body += c;
    });
    rq.on('end', () => {
      if (tooLarge) {
        const e = new Error('request body too large');
        e.statusCode = 413;
        reject(e);
      } else {
        resolve(body);
      }
    });
    rq.on('error', reject);
  });
}

export function startCoordinatorHttpServer(port, workdir, { funding, monitor, queueActivity = new QueueActivity() } = {}) {
  fs.mkdirSync(workdir, { recursive: true });
  const logsDir = path.join(workdir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, 'telemetry.jsonl');
  const enrollmentPath = enrollmentRequestsPath(workdir);
  const server = http.createServer((rq, rs) => {
    let url;
    try {
      url = new URL(rq.url, 'http://localhost');
    } catch {
      return writeJson(rs, 400, { ok: false, error: 'Invalid request URL' });
    }
    const pathname = url.pathname;
    if (rq.method === 'GET' && ['/status', '/status/', '/status.js', '/status.json'].includes(pathname)) {
      rs.setHeader('Cache-Control', 'no-store');
      rs.setHeader('X-Content-Type-Options', 'nosniff');
      rs.setHeader('Referrer-Policy', 'no-referrer');
      if (pathname === '/status.json') {
        if (!monitor) return writeJson(rs, 503, { ok: false, error: 'Attestor monitoring is not configured' });
        const status = monitor.snapshot();
        status.queue = queueActivity.snapshot(normalizeQueueId(status.ceremonyId));
        const slot = status.ceremony?.slot;
        // `name` holds only the on-chain name. A heartbeat name goes in `reportedName`.
        if (slot?.address && !slot.name) {
          const heartbeatName = queueActivity.reportedName(status.ceremonyId, slot.address);
          // Copy the slot. The monitor keeps the original object.
          if (heartbeatName) status.ceremony = { ...status.ceremony, slot: { ...slot, reportedName: heartbeatName } };
        }
        return writeJson(rs, status.ok ? 200 : 503, status);
      }
      if (pathname === '/status.js') {
        rs.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return rs.end(monitorScript);
      }
      rs.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
      rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return rs.end(monitorPage);
    }
    if (rq.method === 'GET' && pathname === '/queue') {
      rs.setHeader('Cache-Control', 'no-store');
      const ceremonyId = normalizeQueueId(url.searchParams.get('ceremonyId'));
      if (!ceremonyId) return writeJson(rs, 400, { ok: false, error: 'valid ceremonyId required' });
      return writeJson(rs, 200, queueActivity.snapshot(ceremonyId));
    }
    const fundingRoute = /^\/fund\/([^/]+)$/.exec(pathname);
    if (rq.method === 'POST' && fundingRoute && funding) {
      const secret = fundingRoute[1];
      rs.setHeader('Cache-Control', 'no-store');
      rs.setHeader('Referrer-Policy', 'no-referrer');
      const fail = (e) => writeJson(rs, e?.statusCode || 503, {
        ok: false, error: e?.statusCode ? e.message : 'funding temporarily unavailable; retry shortly',
      });
      try { funding.authorize(secret); } catch (e) { fail(e); return; }
      readBody(rq).then(async (body) => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { return writeJson(rs, 400, { ok: false, error: 'invalid JSON' }); }
        const result = await funding.request(secret, parsed);
        writeJson(rs, 200, result);
      }).catch(fail);
      return;
    }
    if (rq.method !== 'POST' || !['/telemetry', '/heartbeat', '/enroll-request'].includes(pathname)) {
      rs.writeHead(404); return rs.end();
    }

    readBody(rq).then((body) => {
      if (pathname === '/enroll-request') {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch { return writeJson(rs, 400, { ok: false, error: 'invalid JSON' }); }
        try {
          const row = appendEnrollmentRequest(workdir, parsed);
          log(`enroll request: ${row.name || '?'} ${row.address.slice(0, 12)}...`);
          return writeJson(rs, 202, { ok: true, status: 'pending_manual_approval' });
        } catch (e) {
          return writeJson(rs, 400, { ok: false, error: e?.message || 'invalid enrollment request' });
        }
      }

      try {
        const parsed = JSON.parse(body || '{}');
        if (pathname === '/heartbeat') queueActivity.record(parsed);
        const row = { ...parsed, ts: Date.now(), kind: pathname.slice(1) };
        fs.appendFileSync(logPath, JSON.stringify(row) + '\n');
        if (pathname === '/telemetry') log(`telemetry: ${row.name || '?'} ${row.status || ''} hash=${(row.hash || '').slice(0, 12)}...`);
      } catch { /* ignore bad body */ }
      writeJson(rs, 200, { ok: true });
    }).catch((e) => writeJson(rs, e?.statusCode || 500, { ok: false, error: e?.message || 'request failed' }));
  });
  server.listen(port, () => {
    const addr = server.address();
    const actualPort = addr && typeof addr === 'object' ? addr.port : port;
    log(`coordinator HTTP on :${actualPort} -> telemetry ${logPath}; enrollment requests ${enrollmentPath}`);
  });
  return server;
}
