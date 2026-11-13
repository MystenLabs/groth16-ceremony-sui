// An architectural guard: production crypto imports and direct key/RNG calls
// belong to the documented audit files. Fixtures and benchmarks are separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : file.endsWith('.js') ? [file] : [];
  });
}

test('production cryptographic operations stay inside the audit boundary', () => {
  const violations = [];
  for (const relative of ['coordinator/src', 'cli/src', 'cli/bin']) {
    for (const file of sourceFiles(path.join(root, relative))) {
      const name = path.relative(root, file);
      const source = fs.readFileSync(file, 'utf8');
      const inside = name.startsWith('coordinator/src/crypto/') || name === 'cli/src/crypto.js' || name === 'cli/src/walrus.js';
      // Include package imports, internal imports, and the CLI entrypoint path.
      // Local imports of our own './snarkjs.js' adapter remain allowed.
      const referencesSnarkjs = /['"](?:snarkjs(?:\/[^'"]*)?|[^'"]*node_modules\/snarkjs\/[^'"]*|@iden3\/binfileutils)['"]/.test(source);
      const importsSnarkjsInternals = /['"][^'"]*node_modules\/snarkjs\/src\//.test(source);
      if (importsSnarkjsInternals) violations.push(`${name}: imports snarkjs internals`);
      if (name.startsWith('coordinator/') && name !== 'coordinator/src/crypto/snarkjs.js' && referencesSnarkjs) {
        violations.push(`${name}: bypasses snarkjs adapter`);
      }
      const referencesWalrus = /['"]@mysten\/walrus(?:\/[^'"]*)?['"]|execFileSync\(\s*['"]walrus['"]/.test(source);
      if (name.startsWith('coordinator/') && name !== 'coordinator/src/crypto/walrus.js' && referencesWalrus) {
        violations.push(`${name}: bypasses Walrus adapter`);
      }
      if (name.startsWith('cli/') && name !== 'cli/src/walrus.js' && referencesWalrus) {
        violations.push(`${name}: bypasses Walrus adapter`);
      }
      if (!inside) {
        const importsCrypto = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](?:node:crypto|crypto|snarkjs(?:\/|['"])|@noble\/|@iden3\/binfileutils|@mysten\/sui\/keypairs)/.test(source);
        const callsCrypto = /\.(?:signTransaction|signPersonalMessage|signData|sign|generate|fromSecretKey|getRandomValues|randomBytes|createHash|getSecretKey)\s*\(/.test(source);
        if (importsCrypto || callsCrypto) violations.push(name);
      } else if (name.startsWith('coordinator/')) {
        // Workflows may use file/JSON utilities. The Walrus adapter also uses
        // shared logging/configuration and owns the Walrus SDK dependency.
        const libImports = [...source.matchAll(/(?:from\s*|import\s*\(\s*)['"]\.\.\/lib\/([^'"]+)['"]/g)];
        const allowedLibs = name === 'coordinator/src/crypto/walrus.js'
          ? ['config.js', 'funding-store.js'] : ['files.js', 'json.js'];
        for (const [, imported] of libImports) {
          if (!allowedLibs.includes(imported)) violations.push(`${name}: imports lib/${imported}`);
        }
        if (/(?:from\s*|import\s*\(\s*)['"]@mysten\/sui\/(?:grpc|transactions)/.test(source)) {
          violations.push(`${name}: imports transport`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});
