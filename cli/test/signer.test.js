import test from 'node:test';
import assert from 'node:assert/strict';
import { Transaction } from '@mysten/sui/transactions';
import { generateKey, signTransaction } from '../src/crypto.js';

test('SDK keypair signs the Walrus transaction shape without a custom adapter', async () => {
  const keypair = generateKey();
  const address = keypair.toSuiAddress();
  for (const senderAlreadySet of [false, true]) {
    const tx = new Transaction();
    if (senderAlreadySet) tx.setSenderIfNotSet(address); // Walrus sets this before calling the signer.
    tx.setGasBudget(1_000_000);
    tx.setGasPrice(1);
    tx.setGasPayment([{ objectId: '0x1', version: '1', digest: '11111111111111111111111111111111' }]);
    tx.transferObjects([tx.gas], address);

    let submitted;
    const result = { Transaction: { digest: 'offline-test', effects: {} } };
    const client = { core: { async executeTransaction(input) { submitted = input; return result; } } };
    assert.equal(await keypair.signAndExecuteTransaction({ transaction: tx, client }), result);
    assert.equal(Transaction.from(submitted.transaction).getData().sender, address);
    assert.equal(await keypair.getPublicKey().verifyTransaction(submitted.transaction, submitted.signatures[0]), true);
    assert.equal(submitted.signatures[0], (await signTransaction(keypair, submitted.transaction)).signature);
    assert.equal(submitted.include.effects, true); // Walrus reads execution effects.
  }
});
