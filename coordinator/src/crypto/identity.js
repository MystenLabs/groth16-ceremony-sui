// Coordinator secret-key import, persistence, identity checks, and signing.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress } from '@mysten/sui/utils';

export const signTransaction = (keypair, bytes) => keypair.signTransaction(bytes);

function requireWorkdir(workdir) {
  if (!workdir) throw new Error('missing ceremony run directory; pass --run <name> or --workdir <dir>');
  return workdir;
}

export function coordinatorKeyPath(workdir) {
  return path.join(requireWorkdir(workdir), 'state.json');
}

function keypairFromSecretKey(secretKey, label = 'coordinator secret key') {
  try {
    return Ed25519Keypair.fromSecretKey(secretKey);
  } catch (e) {
    throw new Error(`invalid ${label}: ${e?.message || e}`);
  }
}

function sui(args, run = execFileSync) {
  try {
    return run('sui', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    const stderr = e.stderr?.toString().trim();
    throw new Error(`sui ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

export function activeSuiAddress({ exec = execFileSync } = {}) {
  return normalizeSuiAddress(sui(['client', 'active-address'], exec));
}

function exportSuiSecretKey(address, exec = execFileSync) {
  const raw = sui(['keytool', 'export', '--key-identity', address, '--json'], exec);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`could not parse sui keytool export JSON: ${e.message}`);
  }
  const secretKey = parsed.exportedPrivateKey || parsed.privateKey || parsed.secretKey;
  if (!secretKey) throw new Error('sui keytool export JSON did not contain exportedPrivateKey');
  return secretKey;
}

export function readCoordinatorKeyState(workdir) {
  const p = coordinatorKeyPath(workdir);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`could not read coordinator key state ${p}: ${e.message}`);
  }
}

function writeCoordinatorKeyState(workdir, { secretKey, source = 'sui-active', force = false } = {}) {
  if (!secretKey) throw new Error('missing coordinator secret key');
  const kp = keypairFromSecretKey(secretKey);
  const address = normalizeSuiAddress(kp.toSuiAddress());
  const p = coordinatorKeyPath(workdir);
  const existing = readCoordinatorKeyState(workdir);

  if (existing?.secretKey && !force) {
    const existingAddr = normalizeSuiAddress(keypairFromSecretKey(existing.secretKey, `coordinator key in ${p}`).toSuiAddress());
    if (existingAddr !== address) {
      throw new Error(`coordinator key already exists for ${existingAddr}; pass --force to replace it`);
    }
  }

  fs.mkdirSync(workdir, { recursive: true, mode: 0o700 });
  const state = {
    ...existing,
    secretKey: kp.getSecretKey(),
    address,
    source,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(p, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* best effort on non-posix filesystems */ }
  return { path: p, state };
}

export function initCoordinatorKeyState({ workdir, force = false, exec = execFileSync } = {}) {
  requireWorkdir(workdir);
  const activeAddress = activeSuiAddress({ exec });
  const secretKey = exportSuiSecretKey(activeAddress, exec);
  const saved = writeCoordinatorKeyState(workdir, { secretKey, source: 'sui-active', force });
  if (saved.state.address !== activeAddress) {
    throw new Error(`exported key address ${saved.state.address} did not match Sui active address ${activeAddress}`);
  }
  return saved;
}

export function missingCoordinatorKeyMessage(workdir) {
  return `missing coordinator key; run node coordinator/src/key.js init --run <name> after selecting the Sui CLI active address (state: ${coordinatorKeyPath(workdir)})`;
}

export function loadCoordinatorKeypair({ workdir, exec = execFileSync, checkActiveAddress = true } = {}) {
  requireWorkdir(workdir);
  const state = readCoordinatorKeyState(workdir);
  if (state?.secretKey) {
    const kp = keypairFromSecretKey(state.secretKey, `coordinator key in ${coordinatorKeyPath(workdir)}`);
    const keyAddress = normalizeSuiAddress(kp.toSuiAddress());
    if (state.address && normalizeSuiAddress(state.address) !== keyAddress) {
      throw new Error(`coordinator key state address ${state.address} does not match stored secret key address ${keyAddress}`);
    }
    if (checkActiveAddress) {
      const activeAddress = activeSuiAddress({ exec });
      if (activeAddress !== keyAddress) {
        throw new Error(`Sui active address is ${activeAddress}, but coordinator key is ${keyAddress}; switch the Sui active address or re-run node coordinator/src/key.js init --force`);
      }
    }
    return kp;
  }
  throw new Error(missingCoordinatorKeyMessage(workdir));
}
