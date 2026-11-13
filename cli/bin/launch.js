// Start the contributor CLI from a repository checkout.
// Why it exists: Install pinned dependencies before loading the CLI.
// How it works:
// 1. Check the dependency fingerprint.
// 2. Install dependencies when the fingerprint or installed files differ.
// 3. Load the existing CLI in the same process.
// Assumptions: The shell wrapper checks the Node.js version (22, 24, or 26).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(root, 'cli');
const modules = path.join(cli, 'node_modules');
const marker = path.join(modules, '.ceremony-dependencies.json');
const manifest = fs.readFileSync(path.join(cli, 'package.json'));
const lock = fs.readFileSync(path.join(cli, 'package-lock.json'));
const fingerprint = JSON.stringify({
  manifest: JSON.parse(manifest), lock: JSON.parse(lock),
  nodeMajor: process.versions.node.split('.')[0], platform: process.platform, arch: process.arch,
});
const dependencies = Object.keys(JSON.parse(manifest).dependencies);
const installed = dependencies.every((name) => fs.existsSync(path.join(modules, name, 'package.json')));
const recorded = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';

if (!installed || recorded !== fingerprint) {
  console.log('Installing contributor dependencies. This can take a few minutes.');
  const env = { ...process.env };
  let count = Number(env.GIT_CONFIG_COUNT || 0);
  for (const prefix of ['ssh://git@github.com/', 'git@github.com:']) {
    env[`GIT_CONFIG_KEY_${count}`] = 'url.https://github.com/.insteadOf';
    env[`GIT_CONFIG_VALUE_${count}`] = prefix;
    count++;
  }
  env.GIT_CONFIG_COUNT = String(count);
  const install = spawnSync('npm', ['ci', '--prefix', cli, '--no-audit', '--no-fund'], { env, stdio: 'inherit' });
  if (install.error || install.status !== 0) {
    console.error('Dependency installation failed. Check npm and Git, then run this command again.');
    process.exit(install.status || 1);
  }
  fs.writeFileSync(marker, fingerprint + '\n');
}

const revision = spawnSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
const changes = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' });
process.env.CEREMONY_SOURCE_REVISION = revision.status === 0
  ? revision.stdout.trim() + (changes.stdout?.trim() ? ' (modified)' : '')
  : 'unknown';
await import('./ceremony.js');
