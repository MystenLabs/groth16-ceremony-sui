#!/usr/bin/env node
// Coordinator identity helper. Stores the current Sui CLI active key in a
// ceremony run's state.json. Coordinator commands refuse to use it unless
// `sui client active-address` still matches the stored key address.
//
//   node coordinator/src/key.js init --run <name>
//   node coordinator/src/key.js address --run <name>

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveCeremonyPaths } from './lib/config.js';
import { initCoordinatorKeyState, loadCoordinatorKeypair } from './crypto/identity.js';

const CMDS = ['init', 'address'];

function usage() {
  console.error(`usage: key.js <${CMDS.join('|')}> (--run <name> | --workdir <dir>)`);
  console.error('  key.js init [--force]');
  console.error('  key.js address');
  process.exit(1);
}

function runCli(argv = process.argv.slice(2)) {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      run: { type: 'string' },
      workdir: { type: 'string' },
      force: { type: 'boolean' },
    },
  });
  const cmd = positionals[0];
  const workdir = o.run
    ? resolveCeremonyPaths({ run: o.run, workdir: o.workdir }).workdir
    : (o.workdir || process.env.WORKDIR);
  if (!workdir) throw new Error('missing ceremony run directory; pass --run <name> or --workdir <dir>');

  if (cmd === 'init') {
    const saved = initCoordinatorKeyState({ workdir, force: o.force });
    console.log(`coordinator key ${saved.state.address} stored in ${saved.path}`);
  } else if (cmd === 'address') {
    const kp = loadCoordinatorKeypair({ workdir });
    console.log(kp.toSuiAddress());
  } else {
    usage();
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  try {
    runCli();
  } catch (e) {
    console.error(e?.message || e);
    process.exit(1);
  }
}
