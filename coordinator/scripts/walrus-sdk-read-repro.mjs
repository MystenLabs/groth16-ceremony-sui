#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { WalrusClient } from '@mysten/walrus';
import { makeClient } from '../src/lib/chain.js';

const { values: o } = parseArgs({ options: {
  blob: { type: 'string' },
  network: { type: 'string', default: 'testnet' },
  out: { type: 'string' },
  timeout: { type: 'string', default: '120000' },
  'storage-node-url-scheme': { type: 'string', default: 'https' },
  log: { type: 'string' },
  'verbose-storage-errors': { type: 'boolean', default: false },
} });

if (!o.blob) {
  console.error('usage: node coordinator/scripts/walrus-sdk-read-repro.mjs --blob <blob-id> [--storage-node-url-scheme https|http] [--log file] [--out file]');
  process.exit(1);
}

if (o.log) {
  fs.mkdirSync(path.dirname(o.log), { recursive: true });
  const stream = fs.createWriteStream(o.log, { flags: 'w' });
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const fmt = (args) => args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    return JSON.stringify(a, (_, x) => typeof x === 'bigint' ? x.toString() : x);
  }).join(' ');
  console.log = (...args) => { origLog(...args); stream.write(`${fmt(args)}\n`); };
  console.error = (...args) => { origError(...args); stream.write(`${fmt(args)}\n`); };
  process.on('exit', () => stream.end());
  console.log(`log ${o.log}`);
}

const timeoutMs = Number(o.timeout);
const storageNodeUrlScheme = o['storage-node-url-scheme'];
if (!['http', 'https'].includes(storageNodeUrlScheme)) {
  console.error('--storage-node-url-scheme must be http or https');
  process.exit(1);
}

const storageErrors = new Map();
let storageErrorTotal = 0;
function errorKey(e) {
  let leaf = e;
  for (let c = e?.cause; c; c = c.cause) leaf = c;
  const code = e?.code || leaf?.code || e?.name || leaf?.name || 'NO_CODE';
  const message = leaf?.message || e?.message || String(e);
  return `${code} | ${message}`;
}
function describeError(e) {
  const parts = [];
  for (let x = e; x; x = x.cause) {
    const fields = [
      x.name || x.constructor?.name,
      x.code,
      x.message,
    ].filter(Boolean);
    parts.push(fields.join(' | '));
  }
  return parts.join(' <- caused by ');
}
function recordStorageError(e) {
  const key = errorKey(e);
  storageErrorTotal += 1;
  const prev = storageErrors.get(key);
  if (prev) {
    prev.count += 1;
  } else {
    storageErrors.set(key, { count: 1, sample: describeError(e) });
  }
  if (o['verbose-storage-errors']) console.error(`storage node error: ${describeError(e)}`);
}
function printStorageErrorSummary() {
  console.log(`storage node errors: ${storageErrorTotal} total`);
  if (storageErrors.size === 0) {
    console.log('  none');
    return;
  }
  for (const [key, { count, sample }] of [...storageErrors.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${count}x ${key}`);
    if (sample && sample !== key) console.log(`      sample: ${sample}`);
  }
}

const client = makeClient(o.network);
const walrus = new WalrusClient({
  network: o.network,
  suiClient: client,
  storageNodeUrlScheme,
  storageNodeClientOptions: { timeout: timeoutMs, onError: recordStorageError },
});

function jsonish(v) {
  return JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x).slice(0, 700);
}

function printError(e) {
  console.error(e?.stack || e);
  for (let c = e?.cause; c; c = c.cause) console.error('cause:', c?.stack || c);
}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    console.log(`${name}: OK in ${((Date.now() - t0) / 1000).toFixed(1)}s ${out == null ? '' : jsonish(out)}`);
    return out;
  } catch (e) {
    console.error(`${name}: ERROR in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    printError(e);
    printStorageErrorSummary();
    process.exitCode = 1;
    return null;
  }
}

console.log(`node ${process.version}`);
console.log(`network ${o.network}`);
console.log(`blob ${o.blob}`);
console.log(`storageNodeUrlScheme ${storageNodeUrlScheme}`);

await step('systemObject', () => walrus.systemObject());
await step('systemState', async () => {
  const s = await walrus.systemState();
  return { epoch: s.committee?.epoch, nShards: s.committee?.n_shards };
});
await step('getBlobMetadata', () => walrus.getBlobMetadata({
  blobId: o.blob,
  signal: AbortSignal.timeout(timeoutMs),
}));
await step('getSlivers', async () => {
  const slivers = await walrus.getSlivers({
    blobId: o.blob,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { count: slivers.length, firstBytes: slivers[0]?.length ?? null };
});
await step('readBlob', async () => {
  const bytes = await walrus.readBlob({
    blobId: o.blob,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (o.out) fs.writeFileSync(o.out, bytes);
  return { bytes: bytes.length, out: o.out || null };
});
printStorageErrorSummary();
