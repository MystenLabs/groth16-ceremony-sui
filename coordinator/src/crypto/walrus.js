// Walrus dependency boundary: blob identities, storage checks, and transfers.
// Transfers use the Walrus CLI so operators exercise the same path manually
// and in automation. The SDK supplies system state and SharedBlob inspection.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import {
  WalrusClient,
  blobIdFromInt,
  MAINNET_WALRUS_PACKAGE_CONFIG,
  TESTNET_WALRUS_PACKAGE_CONFIG,
} from '@mysten/walrus';
import { log } from '../lib/config.js';
import { withWalletOperation } from '../lib/funding-store.js';

export const CONTRIB_EPOCHS = 53; // Walrus caps reservations at 53 epochs (~2y at 14-day epochs); clears REQUIRED_EPOCHS (50)
export const REQUIRED_EPOCHS = 50; // min storage epochs past certification a ceremony blob must hold (verifier-enforced off-chain)

const WALRUS_CLI_MAX_BUFFER = 16 * 1024 * 1024;
const DURABILITY_RETRIES = 5;
const DURABILITY_RETRY_MS = 2000;
const TRANSIENT_DURABILITY_REASONS = new Set([
  'object not found',
  'blob not certified',
  'could not read blob storage end epoch',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mib(n) {
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function execWalrusCli(args, { captureStdout = true } = {}) {
  try {
    return execFileSync('walrus', args, {
      encoding: 'utf8',
      maxBuffer: WALRUS_CLI_MAX_BUFFER,
      stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'inherit'],
    }) || '';
  } catch (e) {
    if (e?.code === 'ENOENT') {
      throw new Error('walrus CLI not found on PATH; install it with suiup and configure its Sui wallet before coordinator blob I/O');
    }
    throw e;
  }
}

function findStringByKey(value, keys) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKey(item, keys);
      if (found) return found;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value)) {
    if (keys.has(k) && typeof v === 'string') return v;
    const found = findStringByKey(v, keys);
    if (found) return found;
  }
  return null;
}

export function parseWalrusStoreJson(output) {
  let parsed;
  try {
    parsed = JSON.parse(String(output));
  } catch (e) {
    throw new Error(`could not parse walrus store JSON output: ${e.message}`);
  }
  const contentBlobId = findStringByKey(parsed, new Set(['blobId']));
  const sharedBlobId = findStringByKey(parsed, new Set(['sharedBlobObject', 'sharedBlobObjectId', 'sharedBlobId']));
  const transactionDigest = findStringByKey(parsed, new Set(['transactionDigest', 'txDigest', 'digest']));
  // Sanity check the CLI output shape before callers rely on its ids.
  if (!contentBlobId) throw new Error('walrus store JSON output did not include a content blob id');
  if (!sharedBlobId) throw new Error('walrus store JSON output did not include a shared blob object id');
  return { contentBlobId, sharedBlobId, transactionDigest, raw: parsed };
}

// Walrus content-id computation is local encoding, not a blob download.
export function parseWalrusBlobIdJson(output) {
  let parsed;
  try {
    parsed = JSON.parse(String(output));
  } catch (e) {
    throw new Error(`could not parse walrus blob-id JSON output: ${e.message}`);
  }
  if (typeof parsed?.blobId !== 'string' || !parsed.blobId) {
    throw new Error('walrus blob-id JSON output did not include a content blob id');
  }
  return parsed.blobId;
}

export function blobIdForFile(network, file, { label = 'blob', log: logger = () => {} } = {}) {
  if (!fs.existsSync(file)) throw new Error(`${label} file not found: ${file}`);
  logger(`  walrus cli: computing ${label} content blob id`);
  const output = execWalrusCli([
    '--context', network,
    '--json',
    'blob-id',
    file,
  ]);
  return parseWalrusBlobIdJson(output);
}

export function verifyBlobId(actual, expected, label = 'r1cs') {
  if (!actual || actual !== expected) {
    throw new Error(`${label} Walrus blob id mismatch: object ${expected}, downloaded file ${actual}`);
  }
}

const sharedBlobTypeCache = new Map();

function optionalFiniteNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function currentEpochFromSystemState(state) {
  return optionalFiniteNumber(state?.committee?.epoch);
}

function walrusPackageConfig(network) {
  if (network === 'mainnet') return MAINNET_WALRUS_PACKAGE_CONFIG;
  if (network === 'testnet') return TESTNET_WALRUS_PACKAGE_CONFIG;
  throw new Error(`unsupported Walrus network ${network}`);
}

function sharedBlobTypeForPackage(packageId) {
  return `${normalizeSuiAddress(packageId)}::shared_blob::SharedBlob`;
}

// Stable package id used in object type tags. Sui object types keep the package
// address that defines the type; the Walrus SDK derives blob types this same way
// from the system object's type, not from systemObject().package_id.
async function walrusDefiningPackageId(network, client) {
  const { object } = await client.core.getObject({ objectId: walrusPackageConfig(network).systemObjectId });
  const sep = object?.type?.indexOf('::') ?? -1;
  if (sep < 0) throw new Error(`could not read Walrus system object type for ${network}`);
  return normalizeSuiAddress(object.type.slice(0, sep));
}

async function sharedBlobType(network, client) {
  if (!sharedBlobTypeCache.has(network)) {
    sharedBlobTypeCache.set(network, sharedBlobTypeForPackage(await walrusDefiningPackageId(network, client)));
  }
  return sharedBlobTypeCache.get(network);
}

export function checkBlobIsDurable(b, currentEpoch) {
  if (!b.shared) return { ok: false, reason: 'blob object is not shared' };
  if (b.certifiedEpoch == null) return { ok: false, reason: 'blob not certified' };
  if (b.deletable) return { ok: false, reason: 'blob is deletable (must be permanent)' };
  if (b.endEpoch == null) return { ok: false, reason: 'could not read blob storage end epoch' };
  if (currentEpoch == null) return { ok: false, reason: 'could not read current Walrus epoch' };
  if (currentEpoch >= b.endEpoch) return { ok: false, reason: `blob expired (end ${b.endEpoch} <= current epoch ${currentEpoch})` };
  if (b.endEpoch < b.certifiedEpoch + REQUIRED_EPOCHS) {
    return { ok: false, reason: `blob storage too short (end ${b.endEpoch} < ${b.certifiedEpoch}+${REQUIRED_EPOCHS})` };
  }
  if (!b.contentBlobId) return { ok: false, reason: 'could not read content blob id' };
  return { ok: true };
}

async function readContentBlobToFile(network, contentBlobId, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp-${process.pid}-${Date.now()}`;
  const short = contentBlobId.slice(0, 10);
  try {
    log(`  walrus cli read ${short}… downloading`);
    execWalrusCli(['--context', network, 'read', contentBlobId, '--out', tmp], { captureStdout: false });

    fs.renameSync(tmp, outFile);
    const size = fs.statSync(outFile).size;
    log(`  walrus cli read ${short}… read OK`);
    return size;
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// Cache a content blob by content id. The public read path below accepts a
// SharedBlob id and hides this content-id detail from callers.
async function cacheContentBlob(network, contentBlobId, { force = false, cacheDir = defaultCacheDir(), suffix = '.p2c' } = {}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const p = path.join(cacheDir, `${contentBlobId}${suffix}`);
  const short = contentBlobId.slice(0, 10);
  if (!force && fs.existsSync(p)) {
    log(`  blob ${short}… cache hit (${path.basename(p)})`);
    return p;
  }
  log(`  blob ${short}… fetching via walrus cli`);
  const size = await readContentBlobToFile(network, contentBlobId, p);
  log(`  blob ${short}… fetch OK (${mib(size)})`);
  return p;
}

// Live WAL cost (base units) to store `size` bytes for `epochs`, from the current
// on-chain price. Used to size contributor funding off the real number.
export async function storageCost(network, client, size, epochs) {
  const walrus = new WalrusClient({ network, suiClient: client });
  return walrus.storageCost(size, epochs);
}

export async function writeBlob(network, client, file, { label = 'blob', workdir } = {}) {
  if (!fs.existsSync(file)) throw new Error(`${label} file not found: ${file}`);
  return withWalletOperation(workdir, { kind: 'walrus-store', network, file: path.resolve(file), label },
    () => storeBlob(network, client, file, label));
}

async function storeBlob(network, client, file, label) {
  const size = fs.statSync(file).size;
  log(`  walrus cli: storing ${label} (${mib(size)})`);
  const output = execWalrusCli([
    '--context', network,
    'store',
    '--epochs', String(CONTRIB_EPOCHS),
    '--permanent',
    '--share',
    // The ceremony contract stores SharedBlob object ids. Without --force,
    // repeated content can return alreadyCertified JSON with no SharedBlob id.
    '--force',
    '--json',
    file,
  ]);
  const { contentBlobId, sharedBlobId, transactionDigest } = parseWalrusStoreJson(output);
  log(`  walrus cli: ${label} content blob ${contentBlobId}`);

  // Settlement barrier for the CLI wallet mutation. This prevents the next
  // coordinator tx from racing a stale gas-coin version after `walrus store`.
  if (transactionDigest) await client.core.waitForTransaction({ digest: transactionDigest });

  // Sanity check the CLI's JSON output against the created on-chain SharedBlob.
  // This also waits until the coordinator's fullnode can see the SharedBlob.
  const durable = await requireBlobIsDurable(network, client, sharedBlobId, label);
  if (durable.contentBlobId !== contentBlobId) {
    throw new Error(`walrus CLI SharedBlob ${sharedBlobId} wraps ${durable.contentBlobId}, expected ${contentBlobId}`);
  }
  log(`  walrus cli: ${label} SharedBlob ${sharedBlobId} sanity check OK`);
  return { sharedBlobId, contentBlobId };
}

// Read a SharedBlob object and return the durability facts the verifier checks:
// whether it's shared, plus the wrapped Blob's content id, certified epoch,
// deletability, and storage end epoch. Returns ok=false for deterministic policy
// failures; throws for Sui/Walrus read failures. Retries a few times, since a
// freshly created object can briefly read as not-found while the fullnode indexes it.
async function readSharedBlob(network, client, sharedBlobId) {
  let object;
  for (let i = 0; ; i++) {
    try { ({ object } = await client.core.getObject({ objectId: sharedBlobId, include: { json: true, owner: true } })); break; }
    catch (e) { if (i >= DURABILITY_RETRIES) throw e; await sleep(DURABILITY_RETRY_MS); }
  }
  const expectedType = await sharedBlobType(network, client);
  if (!object) return { ok: false, reason: 'object not found' };
  const actualType = object.type ? normalizeStructTag(object.type) : '';
  if (actualType !== expectedType) {
    return { ok: false, reason: `object is ${object.type || 'unknown type'}, expected ${expectedType}` };
  }
  const j = object.json || {};
  const blob = j.blob?.fields ?? j.blob ?? {};
  const storage = blob.storage?.fields ?? blob.storage ?? {};
  const certified = blob.certified_epoch;
  const ownerKind = object.owner?.['$kind'] || object.owner?.kind || null;
  let contentBlobId = null;
  try {
    contentBlobId = blob.blob_id != null ? blobIdFromInt(BigInt(blob.blob_id)) : null;
  } catch {
    return { ok: false, reason: 'SharedBlob has an invalid content blob id' };
  }
  return {
    ok: true,
    shared: ownerKind === 'Shared' || ownerKind === 'ConsensusAddressOwner' || object.owner?.Shared != null,
    contentBlobId,
    // Unencoded content size from the on-chain Blob. The content blob id
    // commits to it, so once certified it's a trustworthy pre-download bound.
    declaredSize: optionalFiniteNumber(blob.size),
    certifiedEpoch: optionalFiniteNumber(certified),
    deletable: !!blob.deletable,
    endEpoch: optionalFiniteNumber(storage.end_epoch),
  };
}

// Resolve a SharedBlob pointer and enforce the durable blob policy. Returns
// ok=false for inspected objects that fail the policy; throws when Sui/Walrus
// cannot be queried reliably.
export async function resolveBlob(network, client, sharedBlobId, { retries = DURABILITY_RETRIES, retryMs = DURABILITY_RETRY_MS } = {}) {
  for (let i = 0; ; i++) {
    const blob = await readSharedBlob(network, client, sharedBlobId);
    if (blob.ok) {
      const state = await new WalrusClient({ network, suiClient: client }).systemState();
      const currentEpoch = currentEpochFromSystemState(state);
      const durable = checkBlobIsDurable(blob, currentEpoch);
      if (durable.ok) return blob;
      if (i >= retries || !TRANSIENT_DURABILITY_REASONS.has(durable.reason)) return durable;
    } else if (i >= retries || !TRANSIENT_DURABILITY_REASONS.has(blob.reason)) {
      return blob;
    }
    await sleep(retryMs);
  }
}

export async function requireBlobIsDurable(network, client, sharedBlobId, label = 'blob') {
  const blob = await resolveBlob(network, client, sharedBlobId);
  if (!blob.ok) throw new Error(`${label} failed durable blob policy: ${blob.reason}`);
  return blob;
}

export async function readBlob(network, client, sharedBlobId, { label = 'blob', force = false, cacheDir, suffix = '.p2c' } = {}) {
  if (!cacheDir) throw new Error(`missing cacheDir while reading ${label}; select a ceremony run or pass an explicit cache directory`);
  const blob = await requireBlobIsDurable(network, client, sharedBlobId, label);
  const file = await cacheContentBlob(network, blob.contentBlobId, { force, cacheDir, suffix });
  const size = fs.statSync(file).size;
  return { ...blob, sharedBlobId, file, size };
}
