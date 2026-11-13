import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ceremonyManifestBase, packagePublicationProvenance } from '../src/lib/manifest.js';

test('package provenance comes from the verified Published.toml entry', () => {
  const repoRoot = path.resolve('/repo');
  const publication = {
    publishedPath: path.join(repoRoot, 'move', 'Published.toml'),
    packageId: '0x2',
    originalId: '0x1',
    version: 3,
    toolchainVersion: '1.74.1',
    upgradeCapability: '0xcap',
  };

  assert.deepEqual(packagePublicationProvenance(publication, repoRoot), {
    package_publication: path.join('move', 'Published.toml'),
    package_original_id: '0x1',
    package_version: 3,
    package_toolchain_version: '1.74.1',
    package_upgrade_capability: '0xcap',
  });
});

test('force-recreating a ceremony does not retain lifecycle state', () => {
  const existing = {
    ceremony_id: '0x1',
    genesis: { shared_blob_id: '0x2' },
    finalize_digest: 'old-finalize',
    final: { seal_digest: 'old-seal' },
    r1cs_approvals: [{ digest: 'old-approval' }],
  };
  assert.deepEqual(ceremonyManifestBase(existing, { force: true }), {});
});

test('partial manifests retain safe fields but refresh package provenance', () => {
  const base = ceremonyManifestBase({
    run: 'resume-me',
    coordinator_url: 'https://example.test',
    package_publication: 'move/Published.toml',
    package_original_id: '0xold',
    package_deployment: 'deployments/old.json',
    package_publish_digest: 'old-publish',
  });
  assert.deepEqual(base, {
    run: 'resume-me',
    coordinator_url: 'https://example.test',
  });
});
