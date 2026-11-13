import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  prepareMovePackage,
  publicationFromToml,
  removePublicationFromToml,
} from '../src/lib/move-package.js';

const published = `# generated\n\n[published.mainnet]\npublished-at = "0xmain"\nversion = 2\n\n[published.testnet]\npublished-at = "0xtest"\noriginal-id = "0xoriginal"\nversion = 1\ntoolchain-version = "1.2.3"\nupgrade-capability = "0xcap"\n`;

test('reads one network from Published.toml', () => {
  assert.deepEqual(publicationFromToml(published, 'testnet'), {
    packageId: '0xtest',
    originalId: '0xoriginal',
    version: 1,
    toolchainVersion: '1.2.3',
    upgradeCapability: '0xcap',
  });
  assert.equal(publicationFromToml(published, 'devnet'), null);
});

test('removes only the selected publication section', () => {
  const stripped = removePublicationFromToml(published, 'testnet');
  assert.match(stripped, /\[published\.mainnet\]/);
  assert.doesNotMatch(stripped, /\[published\.testnet\]/);
});

test('compiles, verifies, and reuses a matching publication without prompting', async () => {
  const moveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-package-reuse-'));
  fs.writeFileSync(path.join(moveDir, 'Published.toml'), published);
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args.join(' ') === 'client active-env') return { status: 0, stdout: 'testnet\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

  const result = await prepareMovePackage({
    network: 'testnet', moveDir, run, confirm: () => assert.fail('unexpected prompt'), log: () => {},
  });
  assert.equal(result.packageId, '0xtest');
  assert.equal(result.newlyPublished, false);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].slice(0, 2), ['move', 'build']);
  assert.deepEqual(calls[2].slice(0, 2), ['client', 'verify-source']);
});

test('asks before a fresh publish and updates the canonical publication', async () => {
  const moveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-package-publish-'));
  fs.writeFileSync(path.join(moveDir, 'Published.toml'), published);
  let prompted = false;
  const run = (args) => {
    if (args.join(' ') === 'client active-env') return { status: 0, stdout: 'testnet\n', stderr: '' };
    if (args[0] === 'client' && args[1] === 'verify-source') {
      return { status: 1, stdout: '', stderr: 'Local dependency did not match its on-chain version' };
    }
    if (args[0] === 'client' && args[1] === 'publish') {
      assert.equal(args.includes('--build-env'), false, 'publish uses the verified active environment');
      const duringPublish = fs.readFileSync(path.join(moveDir, 'Published.toml'), 'utf8');
      assert.doesNotMatch(duringPublish, /\[published\.testnet\]/);
      fs.writeFileSync(path.join(moveDir, 'Published.toml'), `${duringPublish}\n[published.testnet]\npublished-at = "0xnew"\noriginal-id = "0xnew"\nversion = 1\n`);
    }
    return { status: 0, stdout: '{}', stderr: '' };
  };

  const result = await prepareMovePackage({
    network: 'testnet',
    moveDir,
    run,
    confirm: async () => { prompted = true; return true; },
    log: () => {},
  });
  assert.equal(prompted, true);
  assert.equal(result.packageId, '0xnew');
  assert.equal(result.newlyPublished, true);
  assert.equal(fs.existsSync(`${path.join(moveDir, 'Published.toml')}.prepublish-backup`), false);
});

test('restores Published.toml when fresh publication fails', async () => {
  const moveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-package-rollback-'));
  const publishedPath = path.join(moveDir, 'Published.toml');
  fs.writeFileSync(publishedPath, published);
  const run = (args) => {
    if (args.join(' ') === 'client active-env') return { status: 0, stdout: 'testnet\n', stderr: '' };
    if (args[0] === 'client' && args[1] === 'verify-source') {
      return { status: 1, stdout: '', stderr: 'source verification failed: module does not match' };
    }
    if (args[0] === 'client' && args[1] === 'publish') {
      return { status: 1, stdout: '', stderr: 'publish failed' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  await assert.rejects(
    prepareMovePackage({ network: 'testnet', moveDir, run, publish: true, log: () => {} }),
    /publish failed/,
  );
  assert.equal(fs.readFileSync(publishedPath, 'utf8'), published);
  assert.equal(fs.existsSync(`${publishedPath}.prepublish-backup`), false);
});

test('does not publish without confirmation', async () => {
  const moveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-package-denied-'));
  let publishCalled = false;
  const run = (args) => {
    if (args.join(' ') === 'client active-env') return { status: 0, stdout: 'testnet\n', stderr: '' };
    if (args[0] === 'client' && args[1] === 'publish') publishCalled = true;
    return { status: 0, stdout: '', stderr: '' };
  };

  await assert.rejects(
    prepareMovePackage({
      network: 'testnet', moveDir, run, confirm: async () => false, log: () => {},
    }),
    /publication was not authorized/,
  );
  assert.equal(publishCalled, false);
  assert.equal(fs.existsSync(path.join(moveDir, 'Published.toml')), false);
});

test('does not mistake a verifier infrastructure error for a source mismatch', async () => {
  const moveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'move-package-verify-error-'));
  fs.writeFileSync(path.join(moveDir, 'Published.toml'), published);
  let prompted = false;
  const run = (args) => {
    if (args.join(' ') === 'client active-env') return { status: 0, stdout: 'testnet\n', stderr: '' };
    if (args[0] === 'client' && args[1] === 'verify-source') {
      return { status: 1, stdout: '', stderr: 'network connection timed out' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  await assert.rejects(
    prepareMovePackage({
      network: 'testnet', moveDir, run, confirm: async () => { prompted = true; return true; }, log: () => {},
    }),
    /network connection timed out/,
  );
  assert.equal(prompted, false);
});
