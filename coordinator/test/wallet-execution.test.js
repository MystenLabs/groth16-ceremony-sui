import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { initCoordinatorKeyState } from '../src/crypto/identity.js';
import { loadKeypair, exec } from '../src/lib/chain.js';
import { withRunLock } from '../src/lib/funding-store.js';

function setup(t) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-execution-'));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
  const original = Ed25519Keypair.generate();
  const fakeSui = (_cmd, args) => args[0] === 'client'
    ? original.toSuiAddress()
    : JSON.stringify({ exportedPrivateKey: original.getSecretKey() });
  initCoordinatorKeyState({ workdir, exec: fakeSui });
  const kp = loadKeypair({ workdir, exec: fakeSui });
  const tx = new Transaction();
  tx.setGasBudget(10000000);
  tx.setGasPrice(1000);
  tx.setGasPayment([{ objectId: '0x1', version: '1', digest: '11111111111111111111111111111111' }]);
  tx.transferObjects([tx.splitCoins(tx.gas, [1])[0]], kp.toSuiAddress());
  return { workdir, kp, tx };
}

test('executor persists the exact signed transaction before RPC timeout and blocks the next operation', async (t) => {
  const { workdir, kp, tx } = setup(t);
  const client = { core: { executeTransaction: async ({ transaction, signatures }) => {
    const pending = JSON.parse(fs.readFileSync(path.join(workdir, 'funding.lock'))).unresolved;
    assert.equal(pending.bytes, Buffer.from(transaction).toString('base64'));
    assert.equal(pending.signature, signatures[0]);
    assert.equal(pending.digest, await Transaction.from(transaction).getDigest());
    throw new Error('RPC timeout');
  } } };
  await assert.rejects(exec(client, kp, tx), /RPC timeout/);
  await assert.rejects(withRunLock(workdir, () => assert.fail('must stay blocked')), /wallet is busy/);
});

test('executor releases the lock after confirmed success or failure', async (t) => {
  for (const success of [true, false]) {
    const { workdir, kp, tx } = setup(t);
    let confirmed = false;
    const client = { core: {
      executeTransaction: async ({ transaction }) => ({ Transaction: {
        digest: await Transaction.from(transaction).getDigest(), status: { success, error: 'Move abort' },
      } }),
      waitForTransaction: async () => { confirmed = true; },
    } };
    if (success) await exec(client, kp, tx);
    else await assert.rejects(exec(client, kp, tx), /Move abort/);
    assert.equal(confirmed, true);
    await withRunLock(workdir, () => {});
  }
});
