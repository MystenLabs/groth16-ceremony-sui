import { randomBytes, timingSafeEqual } from 'node:crypto';

const FUNDING_SECRET = /^[a-f0-9]{64}$/;

export function generateFundingSecret() {
  return randomBytes(32).toString('hex');
}

export function fundingSecretMatches(candidate, expected) {
  if (!FUNDING_SECRET.test(candidate) || !FUNDING_SECRET.test(expected)) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}
