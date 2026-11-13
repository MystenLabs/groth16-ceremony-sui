export const PERMISSIONLESS = 0;
export const PERMISSIONED = 1;

export function selectAccessMode({ permissionless, permissioned, allowlist = [] } = {}) {
  const selected = Number(Boolean(permissionless)) + Number(Boolean(permissioned));
  if (selected !== 1) {
    throw new Error('pass exactly one of --permissionless or --permissioned');
  }
  if (allowlist.length > 0 && !permissioned) {
    throw new Error('--allowlist requires --permissioned');
  }
  return permissioned ? PERMISSIONED : PERMISSIONLESS;
}
