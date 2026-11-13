// Observational only: clients report readiness; no ordering or chain authority.
import { cleanName } from './status.js';

export const WAITING_TTL_MS = 90_000;

export function normalizeQueueId(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value)
    ? `0x${value.slice(2).toLowerCase().padStart(64, '0')}` : null;
}

export class QueueActivity {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.waiters = new Map();
    // Latest heartbeat name for each active contributor. The names are not verified.
    this.names = new Map();
  }

  prune(now) {
    for (const [key, entry] of this.waiters) {
      if (now - entry.seenAt >= WAITING_TTL_MS) this.waiters.delete(key);
    }
    for (const [key, entry] of this.names) {
      if (now - entry.seenAt >= WAITING_TTL_MS) this.names.delete(key);
    }
  }

  record(report) {
    const now = this.now();
    this.prune(now);
    const ceremonyId = normalizeQueueId(report?.ceremonyId);
    const address = normalizeQueueId(report?.ephemeralAddr);
    if (!ceremonyId || !address) return;
    const key = `${ceremonyId}:${address}`;
    const name = cleanName(report.name);
    if (name) this.names.set(key, { name, seenAt: now });
    if (typeof report.phase !== 'string') return;
    if (report.phase === 'waiting_for_slot') this.waiters.set(key, { ceremonyId, seenAt: now });
    else this.waiters.delete(key);
  }

  reportedName(ceremonyId, address) {
    this.prune(this.now());
    const ceremony = normalizeQueueId(ceremonyId);
    const who = normalizeQueueId(address);
    return (ceremony && who && this.names.get(`${ceremony}:${who}`)?.name) || '';
  }

  snapshot(ceremonyId) {
    const now = this.now();
    this.prune(now);
    let waitingCount = 0;
    for (const entry of this.waiters.values()) {
      if (entry.ceremonyId === ceremonyId) waitingCount++;
    }
    return { waitingCount, asOf: new Date(now).toISOString() };
  }
}
