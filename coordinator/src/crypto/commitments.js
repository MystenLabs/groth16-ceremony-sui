// File hashes and bindings to the ceremony's phase-1 commitment.
import { createHash } from 'node:crypto';
import fs from 'node:fs';

async function hashFile(file, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export const b2sumFile = (file) => hashFile(file, 'blake2b512');
export const sha256File = (file) => hashFile(file, 'sha256');

// Bind locally supplied phase-1 bytes to a recorded commitment.
export async function verifyPhase1Digest(ptau, expectedDigest) {
  const digest = await b2sumFile(ptau);
  if (digest !== expectedDigest) throw new Error(`phase-1 digest mismatch: object ${expectedDigest}, local ${digest}`);
  return digest;
}

export async function resolvePhase1Digest({ ptau, suppliedDigest = '' }) {
  if (suppliedDigest && !/^[0-9a-fA-F]{128}$/.test(suppliedDigest)) {
    throw new Error('--phase1-hash must be a 64-byte hexadecimal BLAKE2b digest');
  }
  const expected = suppliedDigest.toLowerCase();
  const digest = ptau ? await (expected ? verifyPhase1Digest(ptau, expected) : b2sumFile(ptau)) : expected;
  if (!digest) throw new Error('pass --ptau <pot_final.ptau> or --phase1-hash <hex>');
  return digest;
}
