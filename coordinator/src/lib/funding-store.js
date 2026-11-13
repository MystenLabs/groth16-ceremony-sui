import fs from 'node:fs';
import path from 'node:path';

export class FundingError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

const queues = new Map();

function validPayoutRecord(record) {
  if (!record || !['prepared', 'funded', 'failed'].includes(record.status)) return false;
  if (typeof record.digest !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(record.digest)) return false;
  if (record.status !== 'prepared') return true;
  return [record.bytes, record.signature].every((value) => typeof value === 'string' && value.length > 0
    && Buffer.from(value, 'base64').toString('base64') === value);
}

// Plain JSON Lines: append and fsync each transition before proceeding. A partial
// last line after a crash is discarded; corruption in complete records fails closed.
function openStore(workdir) {
  const file = path.join(workdir, 'funding-payouts.jsonl');
  const fd = fs.openSync(file, 'a+', 0o600);
  fs.fchmodSync(fd, 0o600);
  const dir = fs.openSync(workdir, 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  const bytes = fs.readFileSync(fd);
  const end = bytes.lastIndexOf(10) + 1;
  if (end !== bytes.length) { fs.ftruncateSync(fd, end); fs.fsyncSync(fd); }
  const records = new Map();
  try {
    for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (typeof row.scope !== 'string' || !row.scope || typeof row.address !== 'string'
          || !/^0x[0-9a-f]{64}$/.test(row.address) || !validPayoutRecord(row.record)) {
        throw new Error('invalid funding payout history; restore it before funding');
      }
      records.set(`${row.scope}:${row.address}`, row.record);
    }
  } catch (e) { fs.closeSync(fd); throw e; }
  return {
    get(scope, address) { return records.get(`${scope}:${address}`) || null; },
    assertNoPendingExcept(resume) {
      for (const [key, record] of records) {
        if (record.status === 'prepared' && key !== (resume && `${resume.scope}:${resume.address}`)) {
          throw new FundingError(503, `resolve the pending payout ${key} (${record.digest}) by retrying its original request before using the coordinator wallet`);
        }
      }
    },
    put(scope, address, record) {
      if (!validPayoutRecord(record)) throw new Error('invalid funding payout record; refusing to persist it');
      fs.writeFileSync(fd, JSON.stringify({ scope, address, record }) + '\n');
      fs.fsyncSync(fd);
      records.set(`${scope}:${address}`, record);
    },
    close() { fs.closeSync(fd); },
  };
}

// Both admin funding and attestor transactions use this lock. Never remove a
// lock automatically: after an unclean shutdown, the operator must establish
// that its owner has stopped before removing it. This avoids stale-lock races.
export async function withRunLock(workdir, fn, { resume } = {}) {
  const key = path.resolve(workdir);
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    fs.mkdirSync(key, { recursive: true, mode: 0o700 });
    const lock = path.join(key, 'funding.lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (e) {
      if (e.code === 'EEXIST') throw new FundingError(503, 'coordinator wallet is busy; retry shortly (operator: check funding.lock after an unclean shutdown)');
      throw e;
    }
    let store, unresolved = false;
    const metadata = { pid: process.pid, startedAt: new Date().toISOString() };
    const guard = {
      // Keep the lock on an uncertain outcome, including process restart. Signed
      // bytes (when available) let an operator reconcile the exact transaction.
      block(operation) {
        unresolved = true;
        const bytes = Buffer.from(JSON.stringify({ ...metadata, unresolved: operation }) + '\n');
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, bytes, 0, bytes.length, 0);
        fs.fsyncSync(fd);
      },
      resolve() { unresolved = false; },
    };
    try {
      fs.writeFileSync(fd, JSON.stringify(metadata) + '\n');
      fs.fsyncSync(fd);
      store = openStore(key);
      // This check survives process exit: releasing the filesystem lock never
      // permits another transaction to consume an unresolved payout's coins.
      store.assertNoPendingExcept(resume);
      return await fn(store, guard);
    } finally {
      store?.close();
      fs.closeSync(fd);
      if (!unresolved) fs.unlinkSync(lock);
    }
  });
  queues.set(key, current);
  try { return await current; } finally { if (queues.get(key) === current) queues.delete(key); }
}

// External wallet tools can submit multiple transactions without exposing their
// signed bytes. Any error leaves the lock for operator reconciliation.
export function withWalletOperation(workdir, operation, fn) {
  if (!workdir) throw new Error('wallet operation requires a ceremony workdir');
  return withRunLock(workdir, async (_store, guard) => {
    guard.block(operation);
    const result = await fn();
    guard.resolve();
    return result;
  });
}

export function normalizeFundingAddress(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value) || BigInt(value) === 0n) {
    throw new FundingError(400, 'invalid contribution address');
  }
  return `0x${value.slice(2).toLowerCase().padStart(64, '0')}`;
}

// prepare must not broadcast. Its signed transaction is committed before send.
// An ambiguous send always retains that transaction, never builds a replacement.
export async function trackedPayout(store, scope, address, { prepare, send, lookup, beforeSend = () => {} }) {
  store.assertNoPendingExcept({ scope, address });
  let record = store.get(scope, address);
  let preparedHere = false;
  if (record?.status === 'funded') return record;
  if (record?.status === 'prepared') {
    let outcome;
    try { outcome = await lookup(record); } catch { /* unknown: resubmit identical bytes */ }
    if (outcome === 'funded' || outcome === 'failed') {
      record = { ...record, status: outcome };
      store.put(scope, address, record);
      if (outcome === 'funded') return record;
    }
  }
  if (!record || record.status === 'failed') {
    record = { ...await prepare(), status: 'prepared' };
    store.put(scope, address, record);
    preparedHere = true;
  }
  try { await beforeSend(); }
  catch (e) {
    // We know this freshly prepared transaction was never submitted. A record
    // recovered from an earlier request remains uncertain and must be retained.
    if (preparedHere) store.put(scope, address, { ...record, status: 'failed', reason: 'not_submitted' });
    throw e;
  }
  let outcome;
  try { outcome = await send(record); }
  catch { throw new FundingError(503, 'funding confirmation pending; retry the same address'); }
  if (outcome !== 'funded' && outcome !== 'failed') {
    throw new FundingError(503, 'funding confirmation pending; retry the same address');
  }
  record = { ...record, status: outcome };
  store.put(scope, address, record);
  if (outcome === 'failed') throw new FundingError(503, 'funding transaction failed; retry the same address');
  return record;
}
