// Shared config + small helpers for the coordinator tools.
// Network endpoints, well-known object ids, logging, and deployment-id loading.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NETWORKS = {
  testnet: {
    fullnode: 'https://fullnode.testnet.sui.io:443',
    walCoinType: '0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL',
  },
  mainnet: {
    fullnode: 'https://fullnode.mainnet.sui.io:443',
    walCoinType: '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL',
  },
};

export const CLOCK = '0x6';
export const RANDOM = '0x8';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const CEREMONY_RUNS_ROOT = path.join(REPO_ROOT, 'ceremony-runs');
const ARTIFACTS = path.join(REPO_ROOT, 'coordinator', 'artifacts');

export const ts = () => new Date().toISOString();
export const log = (m) => console.log(`[${ts()}] ${m}`);
export function req(name, v) { if (!v) { console.error(`missing ${name}`); process.exit(1); } return v; }

export function net(network) {
  const n = NETWORKS[network];
  if (!n) { console.error(`unknown network ${network}`); process.exit(1); }
  return n;
}

export function validateRunName(run) {
  if (!run || typeof run !== 'string') throw new Error('missing --run <name>');
  if (run.length > 80 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(run) || run.includes('..')) {
    throw new Error(`invalid run name ${JSON.stringify(run)} (use letters, digits, '.', '_' or '-', without path segments)`);
  }
  return run;
}

export function ceremonyRunPaths(run) {
  validateRunName(run);
  const runDir = path.join(CEREMONY_RUNS_ROOT, run);
  return {
    run,
    runDir,
    manifest: path.join(runDir, 'manifest.json'),
    state: path.join(runDir, 'state.json'),
    artifacts: path.join(runDir, 'artifacts'),
    blobs: path.join(runDir, 'blobs'),
    logs: path.join(runDir, 'logs'),
    audit: path.join(runDir, 'audit'),
  };
}

export function standaloneAuditPaths(ceremonyId, workdir) {
  const shortId = String(ceremonyId).replace(/^0x/, '').slice(0, 12);
  const baseDir = workdir
    ? path.resolve(workdir, shortId)
    : path.join(CEREMONY_RUNS_ROOT, `audit-${shortId}`);
  return {
    audit: path.join(baseDir, 'audit'),
    blobs: path.join(baseDir, 'blobs'),
  };
}

// Resolve one ceremony's private/runtime paths. --out and --deployments remain
// temporary aliases for --manifest so old operator commands keep working.
export function resolveCeremonyPaths({ run, manifest, deployments, out, workdir } = {}) {
  const explicit = [manifest, deployments, out].filter(Boolean).map((p) => path.resolve(p));
  if (new Set(explicit).size > 1) throw new Error('pass only one of --manifest, --deployments, or --out');

  const derived = run ? ceremonyRunPaths(run) : null;
  if (derived && explicit[0] && explicit[0] !== derived.manifest) {
    throw new Error('--run cannot be combined with a different explicit manifest path');
  }
  if (!derived && !explicit[0]) {
    throw new Error('pass --run <name> (recommended) or an explicit --manifest <file>');
  }

  const manifestPath = explicit[0] || derived.manifest;
  const runDir = derived?.runDir || path.dirname(manifestPath);
  return {
    run: run || null,
    runDir,
    manifest: manifestPath,
    state: path.join(runDir, 'state.json'),
    artifacts: path.join(runDir, 'artifacts'),
    blobs: path.join(runDir, 'blobs'),
    logs: path.join(runDir, 'logs'),
    audit: path.join(runDir, 'audit'),
    workdir: workdir ? path.resolve(workdir) : runDir,
  };
}

export function resolveBaseArtifacts(env = process.env, { artifactsDir = ARTIFACTS } = {}) {
  return {
    baseZkey: env.BASE_ZKEY || path.join(artifactsDir, 'circuit_0000.zkey'),
    basePtau: env.BASE_PTAU || path.join(artifactsDir, 'pot_final.ptau'),
  };
}

// Resolve ids from a ceremony manifest with env overrides. `required` ids abort if absent.
export function loadIds(network, manifestPath, { required = [] } = {}) {
  const p = manifestPath && path.resolve(manifestPath);
  if (!p) throw new Error('missing ceremony manifest path');
  const dep = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  if (dep.network && dep.network !== network) throw new Error(`ceremony manifest ${p} is for ${dep.network}, not ${network}`);
  const ids = {
    packageId: process.env.PACKAGE_ID || dep.package_id,
    ceremonyId: process.env.CEREMONY_ID || dep.ceremony_id,
    organizerCapId: process.env.ORGANIZER_CAP_ID || dep.organizer_cap_id,
  };
  const names = { packageId: 'package id', ceremonyId: 'ceremony id', organizerCapId: 'organizer cap id' };
  for (const k of required) req(names[k], ids[k]);
  return { ...ids, dep, path: p };
}
