// Choose the ceremony and its work directory, and record progress logs.
//
// Why it exists: Retries must find the same key from any current directory.
// Contributors must not need to type the ceremony ID.
//
// How it works:
// - `ceremony.json` at the repository root names the default ceremony.
// - The work directory is `<repository>/ceremony-work/<network>/<ceremony-id>`
//   unless the user gives `--workdir`.
// - The progress log removes private values, such as the funding link.
import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export const CEREMONY_ID = /^0x[0-9a-fA-F]{64}$/;
const NETWORKS = ['testnet', 'mainnet'];

let logFile;
let secrets = [];

export function readCeremonyConfig(root) {
  const file = path.join(root, 'ceremony.json');
  if (!fs.existsSync(file)) return null;
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`${file} is not valid JSON`); }
  if (!CEREMONY_ID.test(config?.ceremonyId || '') || !NETWORKS.includes(config.network)) {
    throw new Error(`${file} must set "ceremonyId" (0x and 64 hex characters) and "network" (testnet or mainnet)`);
  }
  const title = typeof config.title === 'string' && config.title.trim() ? config.title.trim() : null;
  return { ceremonyId: config.ceremonyId.toLowerCase(), network: config.network, title };
}

export function resolveWorkdir(options, ceremonyId, root) {
  if (options.workdir) return options.workdir;
  if (!NETWORKS.includes(options.network)) throw new Error(`unknown network "${options.network}"`);
  const key = CEREMONY_ID.test(ceremonyId || '') ? ceremonyId.toLowerCase() : 'default';
  return path.join(root, 'ceremony-work', options.network, key);
}

export function startRunLog(workdir, privateValues = []) {
  const dir = path.join(workdir, 'logs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  logFile = path.join(dir, 'contributor.log');
  fs.closeSync(fs.openSync(logFile, 'a', 0o600));
  secrets = [];
  for (const value of privateValues) redact(value);
  return logFile;
}

// Remove this value from all later log lines.
export function redact(value) {
  if (typeof value === 'string' && value.length > 0) secrets.push(value);
}

export function recordRunLog(message) {
  if (!logFile) return;
  let text = stripVTControlCharacters(String(message));
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${text}\n`);
  } catch {
    console.error('Could not write the contribution log. Check available disk space.');
    logFile = undefined;
  }
}
