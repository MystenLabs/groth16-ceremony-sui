// General file comparison; callers decide what a mismatch means.
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function sameFileBytes(a, b) {
  try {
    // Absolute paths cannot be mistaken for options or stdin's "-" operand.
    execFileSync('cmp', ['-s', path.resolve(a), path.resolve(b)]);
    return true;
  } catch (e) {
    if (e.status === 1) return false; // Different bytes; all other failures are errors.
    throw e;
  }
}
