import fs from 'node:fs';
import path from 'node:path';
import { readBlob } from '../crypto/walrus.js';
import { buildFinalBeaconP2c } from '../crypto/seal.js';

// Production adapter around the local seal pipeline. This is the only part of
// final sealing that knows how to resolve/fetch the current on-chain head.
export async function buildFinalBeaconContribution({
  network,
  client,
  headSharedBlobId,
  beaconHex,
  name,
  baseZkey,
  ptau,
  workdir,
  beaconExp,
  log = () => {},
}) {
  fs.mkdirSync(workdir, { recursive: true });
  const head = await readBlob(network, client, headSharedBlobId, { label: 'current head', cacheDir: path.join(workdir, 'blobs') });
  log(`sealing on head ${head.contentBlobId} with beacon ${beaconHex.slice(0, 16)}...`);

  const sealed = await buildFinalBeaconP2c({
    headP2c: head.file,
    beaconHex,
    name,
    baseZkey,
    ptau,
    workdir,
    beaconExp,
    log,
  });

  return { ...sealed, headBlob: head.contentBlobId };
}
