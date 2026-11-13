// Walrus dependency boundary for the ceremony contributor. Review SharedBlob
// resolution, aggregator downloads, and upload/storage policy here.
// Callers supply network configuration and own contribution orchestration.
// Aggregator bytes are checked against the content ID resolved from chain.
import { Transaction } from '@mysten/sui/transactions';
import { WalrusClient, blobIdFromInt } from '@mysten/walrus';
import { signTransaction } from './crypto.js';

// Download a blob. A try stops when no data arrives for `stallMs`, because the turn continues during a stall.
export async function fetchBlob(suiClient, networkName, net, blobId, { tries = 3, stallMs = 60_000, waitMs = 2000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await fetchBlobOnce(suiClient, networkName, net, blobId, stallMs); }
    catch (e) {
      if (attempt >= tries) throw e;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function fetchBlobOnce(suiClient, networkName, net, blobId, stallMs) {
  const controller = new AbortController();
  let timer;
  // Start the stall timer again. A slow download that still moves has no time limit.
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`aggregator sent no data for ${stallMs / 1000} seconds`)), stallMs);
  };
  let bytes;
  arm();
  try {
    const res = await fetch(`${net.aggregator}/v1/blobs/${blobId}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`aggregator ${blobId}: HTTP ${res.status}`);
    const chunks = [];
    for await (const chunk of res.body) { chunks.push(chunk); arm(); }
    const all = Buffer.concat(chunks);
    bytes = new Uint8Array(all.buffer, all.byteOffset, all.length);
  } finally {
    clearTimeout(timer);
  }
  const walrusClient = new WalrusClient({ network: networkName, suiClient });
  const { blobId: actualBlobId } = await walrusClient.computeBlobMetadata({ bytes });
  if (actualBlobId !== blobId) throw new Error(`aggregator returned wrong blob for ${blobId}`);
  return bytes;
}

// A contribution becomes the head the next contributor downloads, and the whole
// chain must stay auditable for the ceremony's life — so blobs are persistent
// (non-deletable) and stored for many epochs, not the 1-epoch bench default.
const CONTRIB_EPOCHS = 53; // Walrus caps reservations at 53 epochs (~2y); clears the contract REQUIRED_EPOCHS (50)

export async function uploadToWalrus(suiClient, keypair, networkName, net, bytes, log = () => {}) {
  const walrusClient = new WalrusClient({
    network: networkName,
    suiClient,
    uploadRelay: { host: net.relay, sendTip: { max: 1_000_000_000 }, timeout: 600_000 },
  });
  const res = await walrusClient.writeBlob({
    blob: bytes,
    deletable: false,
    epochs: CONTRIB_EPOCHS,
    signer: keypair,
    onStep: (s) => log(`  walrus: ${s?.step ?? s}`),
  });
  const contentBlobId = res?.blobId || res?.blobObject?.blob_id;
  const blobObjectId = res?.blobObject?.id;
  if (!contentBlobId || !blobObjectId) throw new Error('walrus upload returned no blob id / object id');

  // Wrap the owned Blob in a SharedBlob (anyone can later fund/extend it); the
  // ceremony contract stores that SharedBlob's object id. The walrus package id is
  // read from the system object — nothing hardcoded.
  const walPkg = (await walrusClient.systemObject()).package_id;
  const tx = new Transaction();
  tx.moveCall({ target: `${walPkg}::shared_blob::new`, arguments: [tx.object(blobObjectId)] });
  tx.setSender(keypair.toSuiAddress());
  const built = await tx.build({ client: suiClient });
  const { signature } = await signTransaction(keypair, built);
  const out = await suiClient.core.executeTransaction({
    transaction: built, signatures: [signature],
    include: { effects: true, objectTypes: true },
  });
  const t = out.Transaction || out.FailedTransaction;
  if (out.FailedTransaction || t?.status?.success === false) {
    throw new Error(`shared_blob::new failed: ${JSON.stringify(t?.status?.error || out)}`);
  }
  let sharedBlobId = null;
  for (const c of t.effects.changedObjects) {
    if (c.idOperation !== 'Created') continue;
    if ((t.objectTypes?.[c.objectId] || '').endsWith('::shared_blob::SharedBlob')) sharedBlobId = c.objectId;
  }
  if (!sharedBlobId) throw new Error('could not find created SharedBlob in tx effects');
  // Wait for settlement so the on-chain submit builds against the bumped gas coin.
  await suiClient.core.waitForTransaction({ digest: t.digest });
  return { sharedBlobId, contentBlobId };
}

// Resolve a SharedBlob object id to the Walrus content blob id it wraps (for reads).
export async function resolveSharedBlobContent(suiClient, sharedBlobId) {
  const { object } = await suiClient.core.getObject({ objectId: sharedBlobId, include: { json: true } });
  const blob = object.json?.blob?.fields ?? object.json?.blob ?? {};
  if (blob.blob_id == null) throw new Error(`SharedBlob ${sharedBlobId} has no wrapped blob id`);
  return blobIdFromInt(BigInt(blob.blob_id));
}
