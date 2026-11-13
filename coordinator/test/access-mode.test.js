import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERMISSIONED,
  PERMISSIONLESS,
  selectAccessMode,
} from '../src/lib/access-mode.js';

test('access mode must be selected explicitly', () => {
  assert.throws(
    () => selectAccessMode(),
    /exactly one of --permissionless or --permissioned/,
  );
  assert.throws(
    () => selectAccessMode({ permissionless: true, permissioned: true }),
    /exactly one of --permissionless or --permissioned/,
  );
});

test('permissionless and permissioned selections map to Move access modes', () => {
  assert.equal(selectAccessMode({ permissionless: true }), PERMISSIONLESS);
  assert.equal(selectAccessMode({ permissioned: true }), PERMISSIONED);
});

test('an allowlist requires an explicit permissioned selection', () => {
  assert.throws(
    () => selectAccessMode({ permissionless: true, allowlist: ['0x1'] }),
    /--allowlist requires --permissioned/,
  );
  assert.equal(
    selectAccessMode({ permissioned: true, allowlist: ['0x1'] }),
    PERMISSIONED,
  );
});
