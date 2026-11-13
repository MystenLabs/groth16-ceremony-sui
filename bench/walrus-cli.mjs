#!/usr/bin/env node
// Bench coordinator Walrus CLI blob I/O against real files or existing
// SharedBlob ids.

import fs from 'node:fs';
import path from 'node:path';
import { randomFillSync } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { makeClient } from '../coordinator/src/lib/chain.js';
import { readBlob, writeBlob } from '../coordinator/src/crypto/walrus.js';

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    network: { type: 'string', default: 'testnet' },
    'out-dir': { type: 'string', default: './bench-work/walrus-cli' },
    size: { type: 'string' },
    'random-file': { type: 'string' },
    keep: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`usage:
  node bench/walrus-cli.mjs upload <file>
  node bench/walrus-cli.mjs upload --size 64MiB
  node bench/walrus-cli.mjs download <shared-blob-id> [more ids...]
  node bench/walrus-cli.mjs roundtrip --size 64MiB

options:
  --network testnet|mainnet      default testnet
  --out-dir <dir>                generated/downloaded files (default ./bench-work/walrus-cli)
  --keep                         keep generated/downloaded files after the bench`);
  process.exit(exitCode);
}

if (o.help) usage(0);

const command = positionals[0];
if (!['upload', 'download', 'roundtrip'].includes(command)) usage(1);

let client;
function suiClient() {
  client ||= makeClient(o.network);
  return client;
}

function mib(n) {
  return n / 1024 / 1024;
}

function elapsedSince(t0) {
  return (performance.now() - t0) / 1000;
}

function rate(size, sec) {
  return `${(mib(size) / sec).toFixed(1)} MiB/s`;
}

function parseSize(s) {
  const m = String(s || '').trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?i?b?|b)?$/i);
  if (!m) throw new Error(`invalid --size: ${s}`);
  const n = Number(m[1]);
  const unit = (m[2] || 'b').toLowerCase();
  const scale = {
    b: 1,
    k: 1024,
    kb: 1024,
    kib: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  }[unit];
  if (!Number.isFinite(n) || !scale) throw new Error(`invalid --size: ${s}`);
  return Math.floor(n * scale);
}

function writeRandomFile(file, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    for (let remaining = size; remaining > 0;) {
      const n = Math.min(chunk.length, remaining);
      randomFillSync(chunk, 0, n);
      fs.writeSync(fd, chunk, 0, n);
      remaining -= n;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function defaultRandomFile(size) {
  return path.join(o['out-dir'], `random-${size}-${Date.now()}.bin`);
}

function makeRandomInput() {
  if (!o.size) usage(1);
  const size = parseSize(o.size);
  const file = o['random-file'] || defaultRandomFile(size);
  console.log(`creating random file ${file} (${mib(size).toFixed(1)} MiB)`);
  const t0 = performance.now();
  writeRandomFile(file, size);
  console.log(`random file ready in ${elapsedSince(t0).toFixed(1)}s`);
  return { file, size, generated: true };
}

async function uploadFile(file) {
  if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);

  const size = fs.statSync(file).size;
  console.log(`network=${o.network} upload=cli file=${file} size=${mib(size).toFixed(1)} MiB`);
  const t0 = performance.now();
  const uploaded = await writeBlob(o.network, suiClient(), file, { label: path.basename(file) });
  const sec = elapsedSince(t0);
  console.log(`upload ${sec.toFixed(1)}s (${rate(size, sec)})`);
  console.log(`  content blob ${uploaded.contentBlobId}`);
  console.log(`  shared blob  ${uploaded.sharedBlobId}`);
  return { ...uploaded, size, uploadSec: sec };
}

async function benchUpload() {
  const input = o.size ? makeRandomInput() : { file: positionals[1], generated: false };
  if (!input.file) usage(1);
  await uploadFile(input.file);
  if (input.generated && !o.keep) {
    fs.rmSync(input.file, { force: true });
    console.log(`removed generated file ${input.file}`);
  }
}

async function downloadOne(sharedBlobId, index) {
  const t0 = performance.now();
  const read = await readBlob(o.network, suiClient(), sharedBlobId, {
    label: `bench blob ${index}`,
    cacheDir: o['out-dir'],
    suffix: `.bench-${index}.blob`,
    force: true,
  });
  const sec = elapsedSince(t0);
  console.log(`download ${sec.toFixed(1)}s (${rate(read.size, sec)})`);
  console.log(`  content blob ${read.contentBlobId}`);
  console.log(`  file ${read.file}`);
  return { outFile: read.file, size: read.size, downloadSec: sec };
}

async function benchDownload() {
  const sharedBlobIds = positionals.slice(1);
  if (!sharedBlobIds.length) usage(1);
  console.log(`network=${o.network} read=cli out=${o['out-dir']}`);
  for (let i = 0; i < sharedBlobIds.length; i++) {
    const sharedBlobId = sharedBlobIds[i];
    console.log(`\n[${i + 1}/${sharedBlobIds.length}] ${sharedBlobId}`);
    const { outFile } = await downloadOne(sharedBlobId, i + 1);
    if (!o.keep) {
      fs.rmSync(outFile, { force: true });
      console.log(`  removed ${outFile}`);
    }
  }
}

async function benchRoundtrip() {
  const input = makeRandomInput();
  try {
    const uploaded = await uploadFile(input.file);
    console.log('');
    const downloaded = await downloadOne(uploaded.sharedBlobId, 1);
    console.log(`roundtrip upload=${uploaded.uploadSec.toFixed(1)}s download=${downloaded.downloadSec.toFixed(1)}s size=${mib(uploaded.size).toFixed(1)} MiB`);
    if (!o.keep) {
      fs.rmSync(downloaded.outFile, { force: true });
      console.log(`removed downloaded file ${downloaded.outFile}`);
    }
  } finally {
    if (!o.keep) {
      fs.rmSync(input.file, { force: true });
      console.log(`removed generated file ${input.file}`);
    }
  }
}

if (command === 'upload') await benchUpload();
else if (command === 'download') await benchDownload();
else await benchRoundtrip();
