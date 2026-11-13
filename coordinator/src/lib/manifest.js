import path from 'node:path';

const PACKAGE_PROVENANCE_KEYS = [
  'package_publication',
  'package_original_id',
  'package_version',
  'package_toolchain_version',
  'package_upgrade_capability',
  // Remove provenance written by the former deployments/<network>.json flow.
  'package_deployment',
  'package_publish_digest',
  'package_publish_mode',
  'package_publisher',
  'package_source_commit',
];

export function ceremonyManifestBase(existing = {}, { force = false } = {}) {
  if (force && existing.ceremony_id) return {};
  const base = { ...existing };
  for (const key of PACKAGE_PROVENANCE_KEYS) delete base[key];
  return base;
}

export function packagePublicationProvenance(publication, repoRoot) {
  return {
    package_publication: path.relative(repoRoot, publication.publishedPath),
    package_original_id: publication.originalId,
    package_version: publication.version,
    package_toolchain_version: publication.toolchainVersion,
    package_upgrade_capability: publication.upgradeCapability,
  };
}
