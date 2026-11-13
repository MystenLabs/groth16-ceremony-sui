import fs from 'node:fs';
import path from 'node:path';
import { generateFundingSecret } from '../crypto/funding_secret.js';

export function fundingConfigPath(workdir) { return path.join(workdir, 'funding-secret.json'); }

export function readFundingConfig(workdir, network, ceremonyId) {
  let config;
  try { config = JSON.parse(fs.readFileSync(fundingConfigPath(workdir), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (config.network !== network || config.ceremonyId !== ceremonyId.toLowerCase()) return null;
  if (!/^[a-f0-9]{64}$/.test(config.secret) || typeof config.enabled !== 'boolean') {
    throw new Error('invalid funding configuration');
  }
  return config;
}

// Write and fsync before rename so readers see either complete configuration.
export function updateFundingConfig(workdir, network, ceremonyId, action = 'ensure') {
  const previous = readFundingConfig(workdir, network, ceremonyId);
  const config = previous || { network, ceremonyId: ceremonyId.toLowerCase(), secret: generateFundingSecret(), enabled: true };
  if (action === 'rotate') config.secret = generateFundingSecret();
  if (action === 'enable' || action === 'disable') config.enabled = action === 'enable';
  fs.mkdirSync(workdir, { recursive: true, mode: 0o700 });
  const destination = fundingConfigPath(workdir);
  const temp = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, destination);
  const dir = fs.openSync(workdir, 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  return config;
}

export function privateFundingUrl(base, secret) {
  let url;
  try { url = new URL(base); } catch { throw new Error('configure a public coordinator URL first with set-url'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('funding requires HTTPS (HTTP is allowed only on localhost)');
  }
  if (url.username || url.password || url.search || url.hash || /\/fund(?:\/|$)/.test(url.pathname)) {
    throw new Error('coordinator URL must be public and contain no funding credential');
  }
  return new URL(`/fund/${secret}`, url).href;
}

export function requirePublicCoordinatorUrl(value) {
  if (!value) return;
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid public coordinator URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /\/fund(?:\/|$)/.test(decodeURIComponent(url.pathname))) {
    throw new Error('use a public coordinator base URL; never publish the private funding URL on-chain');
  }
}
