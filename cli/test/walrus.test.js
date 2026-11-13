import test from 'node:test';
import assert from 'node:assert/strict';
import { WalrusClient } from '@mysten/walrus';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { fetchBlob } from '../src/walrus.js';

test('aggregator downloads verify content before returning bytes', async (t) => {
  // Stub network I/O; use the real SDK/WASM content-ID computation.
  const numShards = 10;
  const suiClient = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://sui.example' });
  const client = new WalrusClient({ network: 'testnet', suiClient });
  const bytes = new TextEncoder().encode('ceremony predecessor params');
  const { blobId } = await client.computeBlobMetadata({ bytes, numShards });
  t.mock.method(WalrusClient.prototype, 'systemState', async () => ({ committee: { n_shards: numShards } }));
  const net = { aggregator: 'https://aggregator.example' };
  let responseBytes = bytes;
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, `${net.aggregator}/v1/blobs/${blobId}`);
    return new Response(responseBytes, { status });
  });

  assert.deepEqual(await fetchBlob(suiClient, 'testnet', net, blobId), bytes);

  responseBytes = bytes.slice();
  responseBytes[0] ^= 1;
  await assert.rejects(fetchBlob(suiClient, 'testnet', net, blobId), /aggregator returned wrong blob/);

  responseBytes = bytes.subarray(0, bytes.length - 1);
  await assert.rejects(fetchBlob(suiClient, 'testnet', net, blobId), /aggregator returned wrong blob/);

  status = 503;
  await assert.rejects(fetchBlob(suiClient, 'testnet', net, blobId), /HTTP 503/);
});
