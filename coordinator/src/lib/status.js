import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

// Remove control and bidi characters. A bidi character can reverse the "(reported)" label.
export const cleanName = (value) => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 128) : '';

// Heartbeats provide a display name before the contribution is submitted.
// These names are unauthenticated hints; the on-chain address stays visible.
export async function readContributorNames(workdir, { ceremonyId, network }) {
  const names = new Map();
  const file = path.join(workdir, 'logs', 'telemetry.jsonl');
  if (!fs.existsSync(file)) return names;
  const lines = createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || !['heartbeat', 'telemetry'].includes(row.kind)) continue;
    const ceremony = row.ceremonyId || row.ceremony_id;
    if (typeof ceremony !== 'string' || ceremony.toLowerCase() !== ceremonyId.toLowerCase()) continue;
    if (row.network && row.network !== network) continue;
    const address = row.ephemeralAddr || row.ephemeral_addr;
    const name = cleanName(row.name);
    if (typeof address === 'string' && /^0x[0-9a-fA-F]{64}$/.test(address) && name) {
      names.set(address.toLowerCase(), name);
    }
  }
  return names;
}

export function slotLabel(j, enrollmentSummary, names = new Map()) {
  const phase = j.phase?.['@variant'] || 'Setup';
  if (phase === 'Setup') return 'Inactive (phase 2 not started)';
  if (phase === 'Phase2Beacon') return 'Inactive (contributions frozen)';
  if (phase === 'Closed') return 'Inactive (ceremony closed)';
  const s = j.slot || {};
  const variant = s['@variant'] || 'Open';
  if (variant === 'Open') return 'Open';
  const address = s.who || '';
  const lower = address.toLowerCase();
  const enrolled = enrollmentSummary?.rows?.find((r) => r.address === lower);
  const previous = j.chain?.find((c) => c.contributor?.toLowerCase() === lower);
  // A submitted name takes priority over off-chain reports.
  const name = cleanName(s.name) || names.get(lower) || cleanName(enrolled?.name) || cleanName(previous?.name);
  const who = name && address ? `${address} (${name})` : address;
  if (variant === 'Claimed' && s.until_ms != null) return `Claimed by ${who} until ${new Date(Number(s.until_ms)).toISOString()}`;
  const hash = s.contribution_hash ? Buffer.from(s.contribution_hash, 'base64').toString('hex') : '';
  if (variant === 'Pending') return `Pending by ${who}${s.blob_id ? ` blob ${s.blob_id}` : ''}${hash ? ` hash ${hash.slice(0, 16)}…` : ''}`;
  return `${variant}${who ? ` by ${who}` : ''}`;
}
