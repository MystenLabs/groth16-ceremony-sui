import fs from 'node:fs';
import path from 'node:path';

const SUI_ID = /^0x[0-9a-fA-F]{64}$/;
const REQUEST_KIND = 'enroll-request';
const PENDING_STATUS = 'pending_manual_approval';

export function enrollmentRequestsPath(workdir) {
  return path.join(workdir, 'logs', 'enrollment-requests.jsonl');
}

function optionalString(v, max = 256) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

function requiredId(v, label) {
  if (typeof v !== 'string' || !SUI_ID.test(v)) throw new Error(`invalid ${label}`);
  return v.toLowerCase();
}

export function makeEnrollmentRequestRow(body, now = Date.now()) {
  const address = requiredId(body.address || body.ephemeral_addr || body.ephemeralAddr, 'address');
  const row = {
    ts: now,
    kind: REQUEST_KIND,
    status: PENDING_STATUS,
    address,
  };
  const ceremonyId = body.ceremonyId || body.ceremony_id;
  if (ceremonyId != null) row.ceremonyId = requiredId(ceremonyId, 'ceremonyId');
  for (const [out, from, max] of [
    ['network', body.network, 32],
    ['name', body.name, 128],
    ['discord', body.discord, 128],
    ['cliVersion', body.cliVersion, 32],
    ['useragent', body.useragent, 256],
  ]) {
    const s = optionalString(from, max);
    if (s) row[out] = s;
  }
  if (typeof body.permissioned === 'boolean') row.permissioned = body.permissioned;
  if (body.cli === true) row.cli = true;
  return row;
}

export function appendEnrollmentRequest(workdir, body) {
  const row = makeEnrollmentRequestRow(body);
  const requestsPath = enrollmentRequestsPath(workdir);
  fs.mkdirSync(path.dirname(requestsPath), { recursive: true });
  fs.appendFileSync(requestsPath, JSON.stringify(row) + '\n');
  return row;
}

export function readEnrollmentRequests(workdir, { ceremonyId, network } = {}) {
  const requestsPath = enrollmentRequestsPath(workdir);
  if (!fs.existsSync(requestsPath)) return { path: requestsPath, rows: [] };
  const latest = new Map();
  for (const line of fs.readFileSync(requestsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.kind !== REQUEST_KIND || typeof row.address !== 'string') continue;
    if (ceremonyId && row.ceremonyId && row.ceremonyId.toLowerCase() !== ceremonyId.toLowerCase()) continue;
    if (network && row.network && row.network !== network) continue;
    const addr = row.address.toLowerCase();
    const prev = latest.get(addr);
    latest.set(addr, { ...row, address: addr, requests: (prev?.requests || 0) + 1 });
  }
  return { path: requestsPath, rows: [...latest.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0)) };
}

export function summarizeEnrollmentRequests(rows, { permissioned, allowlist = [] }) {
  const allowed = permissioned ? new Set(allowlist.map((a) => a.toLowerCase())) : new Set();
  const pending = permissioned ? rows.filter((r) => !allowed.has(r.address)) : rows;
  return { rows, pending, permissioned, allowed };
}
