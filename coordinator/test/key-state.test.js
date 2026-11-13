import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  coordinatorKeyPath,
  initCoordinatorKeyState,
  loadCoordinatorKeypair,
} from '../src/crypto/identity.js';

function fakeSuiExec({ active, exports = {} }) {
  return (cmd, args) => {
    assert.equal(cmd, 'sui');
    if (args.join(' ') === 'client active-address') return `${active}\n`;
    if (args[0] === 'keytool' && args[1] === 'export' && args[2] === '--key-identity' && args[4] === '--json') {
      const secretKey = exports[args[3]];
      if (!secretKey) throw new Error(`no fake export for ${args[3]}`);
      return JSON.stringify({ exportedPrivateKey: secretKey });
    }
    throw new Error(`unexpected sui command: ${args.join(' ')}`);
  };
}

test('coordinator key init exports the Sui active key and load verifies it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-key-'));
  try {
    const kp = Ed25519Keypair.generate();
    const address = kp.toSuiAddress();
    const exec = fakeSuiExec({ active: address, exports: { [address]: kp.getSecretKey() } });
    const saved = initCoordinatorKeyState({ workdir: dir, exec });

    assert.equal(saved.path, coordinatorKeyPath(dir));
    assert.equal(saved.state.address, address);
    assert.equal(saved.state.source, 'sui-active');
    assert.equal(loadCoordinatorKeypair({ workdir: dir, exec }).toSuiAddress(), address);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coordinator key init creates a missing fresh-clone run path recursively', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-fresh-clone-'));
  const workdir = path.join(root, 'ceremony-runs', 'fresh-run');
  try {
    assert.equal(fs.existsSync(workdir), false);
    const kp = Ed25519Keypair.generate();
    const address = kp.toSuiAddress();
    const exec = fakeSuiExec({ active: address, exports: { [address]: kp.getSecretKey() } });

    const saved = initCoordinatorKeyState({ workdir, exec });

    assert.equal(saved.path, path.join(workdir, 'state.json'));
    assert.equal(fs.existsSync(saved.path), true);
    assert.equal(loadCoordinatorKeypair({ workdir, exec }).toSuiAddress(), address);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coordinator key load rejects Sui active address drift', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-key-'));
  try {
    const stored = Ed25519Keypair.generate();
    const other = Ed25519Keypair.generate();
    const storedAddress = stored.toSuiAddress();
    const initExec = fakeSuiExec({ active: storedAddress, exports: { [storedAddress]: stored.getSecretKey() } });
    initCoordinatorKeyState({ workdir: dir, exec: initExec });

    assert.throws(
      () => loadCoordinatorKeypair({ workdir: dir, exec: fakeSuiExec({ active: other.toSuiAddress() }) }),
      /Sui active address .* coordinator key/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coordinator key init refuses accidental replacement without force', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-key-'));
  try {
    const first = Ed25519Keypair.generate();
    const second = Ed25519Keypair.generate();
    const firstAddress = first.toSuiAddress();
    const secondAddress = second.toSuiAddress();
    initCoordinatorKeyState({
      workdir: dir,
      exec: fakeSuiExec({ active: firstAddress, exports: { [firstAddress]: first.getSecretKey() } }),
    });

    assert.throws(
      () => initCoordinatorKeyState({
        workdir: dir,
        exec: fakeSuiExec({ active: secondAddress, exports: { [secondAddress]: second.getSecretKey() } }),
      }),
      /already exists/,
    );

    const replaced = initCoordinatorKeyState({
      workdir: dir,
      force: true,
      exec: fakeSuiExec({ active: secondAddress, exports: { [secondAddress]: second.getSecretKey() } }),
    });
    assert.equal(replaced.state.address, secondAddress);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
