import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveWorkdir, startRunLog, recordRunLog, readCeremonyConfig, redact } from '../src/run-context.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const ceremony = '0x' + 'a'.repeat(64);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-launcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'cli/bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools'));
  fs.copyFileSync(path.join(repo, 'ceremony'), path.join(root, 'ceremony'));
  fs.chmodSync(path.join(root, 'ceremony'), 0o755);
  fs.copyFileSync(path.join(repo, 'cli/bin/launch.js'), path.join(root, 'cli/bin/launch.js'));
  fs.writeFileSync(path.join(root, 'cli/package.json'), JSON.stringify({ type: 'module', dependencies: { example: '1.0.0' } }));
  fs.writeFileSync(path.join(root, 'cli/package-lock.json'), '{}');
  fs.writeFileSync(path.join(root, 'cli/bin/ceremony.js'), `
    console.log(JSON.stringify({ args: process.argv.slice(2), revision: process.env.CEREMONY_SOURCE_REVISION }));
    process.exit(Number(process.env.TEST_EXIT || 0));
  `);
  fs.writeFileSync(path.join(root, 'tools/npm'), `#!/usr/bin/env node
    const fs = require('node:fs');
    const path = require('node:path');
    const config = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('GIT_CONFIG_')));
    fs.appendFileSync(process.env.TEST_INSTALLS, JSON.stringify(config) + '\\n');
    if (process.env.TEST_INSTALL_FAIL) process.exit(7);
    const cli = process.argv[process.argv.indexOf('--prefix') + 1];
    fs.mkdirSync(path.join(cli, 'node_modules/example'), { recursive: true });
    fs.writeFileSync(path.join(cli, 'node_modules/example/package.json'), '{}');
  `, { mode: 0o755 });
  const installs = path.join(root, 'installs.jsonl');
  return {
    root, installs,
    run(extra = {}) {
      return spawnSync(path.join(root, 'ceremony'), ['contribute', '--ceremony', ceremony, '--name', 'A name with spaces'], {
        cwd: os.tmpdir(), encoding: 'utf8',
        env: { ...process.env, PATH: path.join(root, 'tools') + path.delimiter + process.env.PATH, TEST_INSTALLS: installs, ...extra },
      });
    },
  };
}

test('first launch installs through HTTPS; retries reuse dependencies and preserve arguments', (t) => {
  const f = fixture(t);
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout.trim().split('\n').at(-1));
  assert.deepEqual(result.args, ['contribute', '--ceremony', ceremony, '--name', 'A name with spaces']);
  assert.equal(typeof result.revision, 'string');
  const env = JSON.parse(fs.readFileSync(f.installs, 'utf8').trim());
  const values = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
  assert.ok(values.some(([k, v]) => k === 'url.https://github.com/.insteadOf' && v === 'ssh://git@github.com/'));
  assert.equal(f.run({ TEST_EXIT: '23' }).status, 23);
  assert.equal(fs.readFileSync(f.installs, 'utf8').trim().split('\n').length, 1);
});

test('a changed lockfile or missing dependency triggers installation again', (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  fs.writeFileSync(path.join(f.root, 'cli/package-lock.json'), '{"changed":true}');
  assert.equal(f.run().status, 0);
  fs.rmSync(path.join(f.root, 'cli/node_modules/example'), { recursive: true });
  assert.equal(f.run().status, 0);
  assert.equal(fs.readFileSync(f.installs, 'utf8').trim().split('\n').length, 3);
});

test('failed installation stops before the CLI and can be retried', (t) => {
  const f = fixture(t);
  const failed = f.run({ TEST_INSTALL_FAIL: '1' });
  assert.equal(failed.status, 7);
  assert.doesNotMatch(failed.stdout, /"args"/);
  assert.equal(fs.existsSync(path.join(f.root, 'cli/node_modules/.ceremony-dependencies.json')), false);
  assert.equal(f.run().status, 0);
});

test('an unsupported Node version stops before installation with a clear message', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'tools/node'), '#!/bin/sh\nprintf "25\\n"\n', { mode: 0o755 });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /supports Node.js 22, 24, or 26\. You have Node.js 25\./);
  assert.match(result.stderr, /nvm use 24/);
  assert.equal(fs.existsSync(f.installs), false);
});

test('default workspaces separate ceremonies and networks; explicit paths retain their meaning', () => {
  const options = { network: 'testnet' };
  const expected = path.join(repo, 'ceremony-work/testnet', ceremony);
  assert.equal(resolveWorkdir(options, ceremony, repo), expected);
  assert.equal(resolveWorkdir(options, ceremony.toUpperCase().replace('0X', '0x'), repo), expected);
  assert.notEqual(resolveWorkdir({ network: 'mainnet' }, ceremony, repo), expected);
  assert.notEqual(resolveWorkdir(options, '0x' + 'b'.repeat(64), repo), expected);
  assert.equal(resolveWorkdir({ ...options, workdir: './existing-key' }, ceremony, repo), './existing-key');
  assert.equal(resolveWorkdir(options, null, repo), path.join(repo, 'ceremony-work/testnet/default'));
});

test('ceremony.json names the default ceremony and rejects malformed files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(readCeremonyConfig(root), null);
  const file = path.join(root, 'ceremony.json');
  fs.writeFileSync(file, JSON.stringify({ ceremonyId: ceremony.toUpperCase().replace('0X', '0x'), network: 'testnet', title: ' zkLogin ' }));
  assert.deepEqual(readCeremonyConfig(root), { ceremonyId: ceremony, network: 'testnet', title: 'zkLogin' });
  for (const bad of ['{', '{"ceremonyId":"0x1","network":"testnet"}', JSON.stringify({ ceremonyId: ceremony, network: 'devnet' })]) {
    fs.writeFileSync(file, bad);
    assert.throws(() => readCeremonyConfig(root), /ceremony\.json/);
  }
});

test('the repository ceremony.json is valid', () => {
  const config = readCeremonyConfig(repo);
  assert.ok(config, 'ceremony.json is missing');
});

test('progress logs append with UTC dates and redact the private funding URL', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceremony-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const url = 'https://example.com/fund/' + 'c'.repeat(64);
  const log = startRunLog(root, [url]);
  recordRunLog('request failed: ' + url);
  recordRunLog('rerun the same command');
  redact('typed-later-secret');
  recordRunLog('pasted typed-later-secret');
  const text = fs.readFileSync(log, 'utf8');
  assert.doesNotMatch(text, /https:\/\/example.com|c{64}/);
  assert.match(text, /^\[\d{4}-\d{2}-\d{2}T.*Z\] request failed: \[redacted\]/);
  assert.doesNotMatch(text, /typed-later-secret/);
  assert.equal(text.trim().split('\n').length, 3);
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
});
