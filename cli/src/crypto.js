// All cryptographic operations of the ceremony CLI live in this one file so
// our crypto calls are reviewable in one place: Ed25519 key generation, restore,
// export and signing; fallback entropy; and snarkjs phase-2 operations
// (contribute, p2u <-> p2c conversion). Callers still own secret-key storage,
// user entropy input, transaction contents, downloads, and checkpoint recovery.
// Walrus uses the SDK keypair directly as its signer.
//
// Contribution randomness: snarkjs seeds ChaCha from blake2b(64 OS-random
// bytes || entropy string) — see snarkjs misc.getRandomRng. The user string
// adds independence; OS entropy is always mixed in.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import * as snarkjs from 'snarkjs';

export const randomEntropy = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
export const exportSecretKey = (keypair) => keypair.getSecretKey();
export const signTransaction = (keypair, bytes) => keypair.signTransaction(bytes);

export const generateKey = () => Ed25519Keypair.generate();
export const restoreKey = (secretKey) => Ed25519Keypair.fromSecretKey(secretKey);

export async function contribute(inputBytes, name, entropy, logger) {
  const out = { type: 'mem' };
  const hash = await snarkjs.zKey.contribute({ type: 'mem', data: inputBytes }, out, name, entropy, logger);
  return { bytes: out.data, hashHex: Buffer.from(hash).toString('hex') };
}

export async function compress(p2uBytes, logger) {
  const out = { type: 'mem' };
  await snarkjs.zKey.compressV2Params({ type: 'mem', data: p2uBytes }, out, logger);
  return out.data;
}

export async function decompress(p2cBytes, logger) {
  const out = { type: 'mem' };
  await snarkjs.zKey.decompressV2Params({ type: 'mem', data: p2cBytes }, out, logger);
  return out.data;
}
