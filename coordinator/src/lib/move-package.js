import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';

function sectionBounds(contents, network) {
  const escaped = network.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\[published\\.${escaped}\\][ \\t]*(?:\\r?\\n|$)`, 'm');
  const match = header.exec(contents);
  if (!match) return null;
  const nextHeader = /^\[/m.exec(contents.slice(match.index + match[0].length));
  return {
    start: match.index,
    end: nextHeader ? match.index + match[0].length + nextHeader.index : contents.length,
  };
}

function tomlValue(block, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escaped}[ \\t]*=[ \\t]*(?:"([^"]*)"|([^#\\r\\n]+))`, 'm').exec(block);
  return match ? (match[1] ?? match[2].trim()) : undefined;
}

export function publicationFromToml(contents, network) {
  const bounds = sectionBounds(contents, network);
  if (!bounds) return null;
  const block = contents.slice(bounds.start, bounds.end);
  const packageId = tomlValue(block, 'published-at');
  if (!packageId) throw new Error(`[published.${network}] has no published-at value`);
  const version = tomlValue(block, 'version');
  return {
    packageId,
    originalId: tomlValue(block, 'original-id'),
    version: version == null ? undefined : Number(version),
    toolchainVersion: tomlValue(block, 'toolchain-version'),
    upgradeCapability: tomlValue(block, 'upgrade-capability'),
  };
}

export function removePublicationFromToml(contents, network) {
  const bounds = sectionBounds(contents, network);
  if (!bounds) return contents;
  return contents.slice(0, bounds.start) + contents.slice(bounds.end);
}

function defaultRun(args, { cwd }) {
  return spawnSync('sui', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function commandText(args) {
  return `sui ${args.join(' ')}`;
}

function resultText(result) {
  return `${result.stdout || ''}${result.stderr || ''}`.trim();
}

function checked(result, args) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = resultText(result);
    throw new Error(`${commandText(args)} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function isSourceMismatch(result) {
  const detail = resultText(result);
  return /did not match|does not match|source verification failed|package object .*not (?:found|exist)/i.test(detail);
}

function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, file);
}

async function confirmFreshPublish(message) {
  if (!process.stdin.isTTY) {
    throw new Error(`${message} Rerun interactively or pass --publish-package to authorize it.`);
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(`${message} [y/N] `);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export async function prepareMovePackage({
  network,
  moveDir,
  gasBudget = '200000000',
  publish = false,
  noPublish = false,
  run = defaultRun,
  confirm = confirmFreshPublish,
  publishOperation = (fn) => fn(),
  log = console.error,
} = {}) {
  if (publish && noPublish) throw new Error('pass only one of --publish-package or --no-publish-package');
  const resolvedMoveDir = path.resolve(moveDir);
  const publishedPath = path.join(resolvedMoveDir, 'Published.toml');
  const hadPublishedFile = fs.existsSync(publishedPath);
  const originalPublished = hadPublishedFile ? fs.readFileSync(publishedPath, 'utf8') : '';
  const existing = publicationFromToml(originalPublished, network);

  const buildArgs = ['move', 'build', '--path', resolvedMoveDir, '--build-env', network];
  log(`compiling Move package in ${resolvedMoveDir} for ${network}…`);
  checked(run(buildArgs, { cwd: resolvedMoveDir }), buildArgs);

  const activeEnvArgs = ['client', 'active-env'];
  const activeEnv = checked(run(activeEnvArgs, { cwd: resolvedMoveDir }), activeEnvArgs).stdout.trim();
  if (activeEnv !== network) {
    throw new Error(`Sui active environment is ${activeEnv}, expected ${network}`);
  }

  let mismatch = false;
  if (existing) {
    const verifyArgs = ['client', 'verify-source', resolvedMoveDir, '--build-env', network];
    log(`verifying compiled source against ${existing.packageId}…`);
    const verification = run(verifyArgs, { cwd: resolvedMoveDir });
    if (verification.status === 0) {
      log(`reusing verified Move package ${existing.packageId}`);
      return { ...existing, publishedPath, newlyPublished: false };
    }
    if (verification.error) throw verification.error;
    if (!isSourceMismatch(verification)) checked(verification, verifyArgs);
    mismatch = true;
    log(`compiled source does not match ${existing.packageId}`);
  }

  const reason = mismatch
    ? `The compiled Move package differs from ${existing.packageId} in [published.${network}].`
    : `Published.toml has no package for ${network}.`;
  const question = `${reason} Publish it as a fresh package and update Published.toml?`;
  if (noPublish) throw new Error(`${question} Publishing was disabled by --no-publish-package.`);
  if (!publish && !await confirm(question)) throw new Error('Move package publication was not authorized');

  return publishOperation(async () => {
    const backupPath = `${publishedPath}.prepublish-backup`;
    if (fs.existsSync(backupPath)) {
      throw new Error(`refusing to publish while recovery file exists: ${backupPath}`);
    }
    fs.writeFileSync(backupPath, originalPublished);
    writeAtomic(publishedPath, removePublicationFromToml(originalPublished, network));

    const publishArgs = [
      'client', 'publish', resolvedMoveDir,
      '--gas-budget', String(gasBudget),
      '--json',
    ];
    log(`publishing fresh Move package to ${network}…`);
    const publication = run(publishArgs, { cwd: resolvedMoveDir });
    if (publication.error || publication.status !== 0) {
      if (hadPublishedFile) writeAtomic(publishedPath, originalPublished);
      else if (fs.existsSync(publishedPath)) fs.unlinkSync(publishedPath);
      fs.unlinkSync(backupPath);
      checked(publication, publishArgs);
    }

    const updatedContents = fs.readFileSync(publishedPath, 'utf8');
    const updated = publicationFromToml(updatedContents, network);
    if (!updated) {
      throw new Error(
        `publish succeeded but ${publishedPath} was not updated; publication output: ${resultText(publication)}`,
      );
    }
    fs.unlinkSync(backupPath);
    log(`published Move package ${updated.packageId}`);
    return { ...updated, publishedPath, newlyPublished: true };
  });
}
