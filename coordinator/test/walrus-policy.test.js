import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBlobIsDurable,
  currentEpochFromSystemState,
  parseWalrusStoreJson,
  parseWalrusBlobIdJson,
} from '../src/crypto/walrus.js';

test('checkBlobIsDurable enforces shared permanent unexpired storage window', () => {
  const base = {
    shared: true,
    certifiedEpoch: 100,
    deletable: false,
    endEpoch: 150,
    contentBlobId: 'abc',
  };

  assert.deepEqual(checkBlobIsDurable(base, 101), { ok: true });
  assert.match(checkBlobIsDurable({ ...base, shared: false }, 101).reason, /not shared/);
  assert.match(checkBlobIsDurable({ ...base, deletable: true }, 101).reason, /deletable/);
  assert.match(checkBlobIsDurable({ ...base, endEpoch: 149 }, 101).reason, /too short/);
  assert.match(checkBlobIsDurable(base, 150).reason, /expired/);
});

test('currentEpochFromSystemState follows the Walrus SDK systemState shape', () => {
  assert.equal(currentEpochFromSystemState({ committee: { epoch: 42 } }), 42);
  assert.equal(currentEpochFromSystemState({ epoch: 42 }), null);
});

test('Walrus CLI store JSON parser extracts content and SharedBlob ids', () => {
  const parsed = parseWalrusStoreJson(JSON.stringify([{
    blobStoreResult: {
      newlyCreated: {
        blobObject: {
          id: '0xblob',
          blobId: 'MZNjd35G_oOb5gKrOi5R3_5r3zEE5rVw5U3sS8_p7nM',
        },
        sharedBlobObject: '0x66a71141f70276ccfcdb3d25b9b8a44d59324b8600e63313bd099eb16cd255bf',
        transactionDigest: 'CAdTsfdZDUJ1pUzH3rdVMWmx24Vb2D2Ppt7m2xDMW4si',
      },
    },
    path: 'ceremony-runs/example/artifacts/final.zkey',
  }]));

  assert.equal(parsed.contentBlobId, 'MZNjd35G_oOb5gKrOi5R3_5r3zEE5rVw5U3sS8_p7nM');
  assert.equal(parsed.sharedBlobId, '0x66a71141f70276ccfcdb3d25b9b8a44d59324b8600e63313bd099eb16cd255bf');
  assert.equal(parsed.transactionDigest, 'CAdTsfdZDUJ1pUzH3rdVMWmx24Vb2D2Ppt7m2xDMW4si');
});

test('Walrus CLI blob-id JSON parser extracts the locally encoded content id', () => {
  assert.equal(
    parseWalrusBlobIdJson(JSON.stringify({
      blobId: 'NiXhL8fm2B9qP0FNzXz24rW2OzXUIXlouWgjaHmBeD0',
      file: 'circuit.r1cs',
      unencodedLength: 10693,
      encodingType: 'RS2',
    })),
    'NiXhL8fm2B9qP0FNzXz24rW2OzXUIXlouWgjaHmBeD0',
  );
  assert.throws(
    () => parseWalrusBlobIdJson('{}'),
    /did not include a content blob id/,
  );
});
