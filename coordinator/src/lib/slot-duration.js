// Match the on-chain MAX_SLOT_DURATION_MS limit.
const MAX_SLOT_DURATION_SECS = 60n * 60n;

// Keep the organizer CLI default here; Move stores an explicit duration per ceremony.
export function parseSlotDurationMs(seconds = '900') {
  if (typeof seconds !== 'string' || !/^[0-9]+$/.test(seconds) || BigInt(seconds) === 0n) {
    throw new Error('--slot-duration-secs must be a positive whole number of seconds');
  }
  if (BigInt(seconds) > MAX_SLOT_DURATION_SECS) {
    throw new Error(`--slot-duration-secs must be at most ${MAX_SLOT_DURATION_SECS} seconds (one hour)`);
  }
  return BigInt(seconds) * 1000n;
}
