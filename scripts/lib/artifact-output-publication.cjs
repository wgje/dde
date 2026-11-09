'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const {
  artifactIdentity,
  sameArtifactIdentity,
  sameArtifactDirectoryIdentity,
  sameArtifactMovedIdentity,
  scanArtifactResidue,
  contained,
  canonicalDigest,
} = require('./artifact-stats-evidence.cjs');
function fail(code) {
  throw Object.assign(new Error(code), { code });
}
function realPath(fsImpl, filePath, code) {
  try {
    return (fsImpl.realpathSync.native ?? fsImpl.realpathSync)(filePath);
  } catch {
    fail(code);
  }
}
function regular(stat, code) {
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
    || !Number.isSafeInteger(stat.size) || stat.size < 0) fail(code);
  artifactIdentity(stat, code);
}
function observe(fsImpl, filePath, rootReal, code) {
  let stat;
  try { stat = fsImpl.lstatSync(filePath); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail(code);
  }
  regular(stat, code);
  const real = realPath(fsImpl, filePath, code);
  if (rootReal) contained(rootReal, real, code);
  return { stat, realPath: real };
}
function observeDirectory(fsImpl, directory, rootReal, expected, code) {
  let stat;
  try { stat = fsImpl.lstatSync(directory); } catch { fail(code); }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) fail(code);
  artifactIdentity(stat, code);
  if (expected && !sameArtifactDirectoryIdentity(stat, expected.stat ?? expected)) fail(code);
  const real = realPath(fsImpl, directory, code);
  contained(rootReal, real, code);
  if (expected?.realPath && expected.realPath !== real) fail(code);
  return { stat, realPath: real };
}

function validateOutput(fsImpl, outputPath, rootReal) {
  const lexical = path.resolve(outputPath);
  contained(rootReal, lexical, 'artifact-evidence-output');
  const parent = path.dirname(lexical);
  const parentObservation = observeDirectory(fsImpl, parent, rootReal, null, 'artifact-evidence-output');
  let output;
  try { output = fsImpl.lstatSync(lexical); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('artifact-evidence-output');
  }
  regular(output, 'artifact-evidence-output');
  const outputReal = realPath(fsImpl, lexical, 'artifact-evidence-output');
  contained(rootReal, outputReal, 'artifact-evidence-output');
  return { stat: output, realPath: outputReal, parent: parentObservation };
}

function sameObservation(left, right) {
  return Boolean(left && right && left.realPath === right.realPath
    && sameArtifactIdentity(left.stat, right.stat));
}

const STABLE_SNAPSHOT_FIELDS = Object.freeze([
  'realPath',
  'dev',
  'ino',
  'size',
  'mtimeMs',
  'ctimeMs',
  'birthtimeMs',
]);

function stableSnapshotBody(observation, code) {
  if (!observation || typeof observation.realPath !== 'string') fail(code);
  const identity = artifactIdentity(observation.stat, code);
  return Object.freeze({
    realPath: observation.realPath,
    ...identity,
  });
}

function stableSnapshotDigest(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
}

function readerSnapshot(observation, readerReceiptId, code) {
  if (!/^SRC-[AB]$/.test(readerReceiptId)) fail(code);
  const body = stableSnapshotBody(observation, code);
  return Object.freeze({
    readerReceiptId,
    stable: true,
    snapshotDigest: stableSnapshotDigest(body),
    ...body,
  });
}

function sameStableSnapshotBody(left, right) {
  return STABLE_SNAPSHOT_FIELDS.every(field => left?.[field] === right?.[field]);
}

function fsyncFile(fsImpl, filePath, code) {
  let fd;
  try {
    fd = fsImpl.openSync(filePath, fsImpl.constants.O_RDWR | (fsImpl.constants.O_NOFOLLOW || 0));
    const stat = fsImpl.fstatSync(fd);
    regular(stat, code);
    fsImpl.fsyncSync(fd);
  } catch { fail(code); }
  finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { fail(code); }
    }
  }
}

const UNSUPPORTED_DIRECTORY_ERRORS = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM']);

function unsupportedDirectoryError(error) {
  return UNSUPPORTED_DIRECTORY_ERRORS.has(error?.code);
}

function fsyncDirectory(fsImpl, directory, rootReal, expected, code) {
  const observed = observeDirectory(fsImpl, directory, rootReal, expected, code);
  let failure;
  let closeFailure;
  let fd;
  if (typeof fsImpl.fsyncDirectorySync === 'function') {
    try { fsImpl.fsyncDirectorySync(directory); } catch (error) { failure = error; }
  } else {
    try {
      fd = fsImpl.openSync(directory, fsImpl.constants.O_RDONLY | (fsImpl.constants.O_DIRECTORY || 0));
      fsImpl.fsyncSync(fd);
    } catch (error) { failure = error; }
    finally {
      if (fd !== undefined) try { fsImpl.closeSync(fd); } catch (error) { closeFailure = error; }
    }
  }
  if (closeFailure || (failure && !unsupportedDirectoryError(failure))) fail(code);
  const after = observeDirectory(fsImpl, directory, rootReal, observed, code);
  return {
    observed: after,
    directoryDurability: failure
      ? 'file-flushed-no-directory-durability'
      : 'directory-durability-verified',
  };
}

function proveCapabilities(fsImpl, parent, rootReal, expectedParent, processImpl) {
  const requiredMethods = [
    'openSync', 'closeSync', 'readFileSync', 'writeFileSync', 'renameSync', 'unlinkSync',
    'statSync', 'lstatSync', 'realpathSync', 'fsyncSync', 'fstatSync', 'readdirSync',
    'mkdtempSync', 'rmSync',
  ];
  const constants = fsImpl.constants;
  if (requiredMethods.some((name) => typeof fsImpl[name] !== 'function')
    || !constants || typeof constants.O_RDONLY !== 'number' || typeof constants.O_RDWR !== 'number'
    || typeof processImpl?.kill !== 'function') {
    fail('artifact-evidence-output-durability');
  }
  observeDirectory(fsImpl, parent, rootReal, expectedParent, 'artifact-evidence-output-drift');
  return fsyncDirectory(fsImpl, parent, rootReal, expectedParent, 'artifact-evidence-output-durability');
}

function lockMetadata(ownerToken, processImpl) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const pid = Number.isSafeInteger(processImpl?.pid) ? processImpl.pid : process.pid;
  const argv0 = processImpl?.argv?.[0] ?? process.argv[0];
  const cwd = typeof processImpl?.cwd === 'function' ? processImpl.cwd() : process.cwd();
  return {
    ownerToken,
    nonce,
    pid,
    createdAt: new Date().toISOString(),
    createdProcessIdentity: `${pid}:${argv0}:${cwd}`,
  };
}

function readLock(fsImpl, lockPath, rootReal) {
  const observed = observe(fsImpl, lockPath, rootReal, 'artifact-evidence-output-lock');
  if (!observed) return null;
  let metadata;
  try { metadata = JSON.parse(fsImpl.readFileSync(lockPath, 'utf8')); } catch { fail('artifact-evidence-output-lock'); }
  if (!metadata || typeof metadata.ownerToken !== 'string' || !/^[a-f0-9]{32}$/.test(metadata.ownerToken)
    || !Number.isSafeInteger(metadata.pid) || metadata.pid <= 0
    || typeof metadata.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(metadata.nonce)
    || typeof metadata.createdProcessIdentity !== 'string') fail('artifact-evidence-output-lock');
  return { observed, metadata };
}

function sameLockMetadata(left, right) {
  return left.ownerToken === right.ownerToken && left.nonce === right.nonce
    && left.pid === right.pid && left.createdProcessIdentity === right.createdProcessIdentity;
}

function processIsDead(processImpl, pid) {
  try { processImpl.kill(pid, 0); return false; }
  catch (error) {
    if (error?.code !== 'ESRCH') return false;
    try { processImpl.kill(pid, 0); return false; }
    catch (probe) { return probe?.code === 'ESRCH'; }
  }
}

function renameCanary(fsImpl, rootPath) {
  let directory;
  let primary;
  try {
    directory = fsImpl.mkdtempSync(path.join(path.dirname(rootPath), '.artifact-output-canary-'));
    const source = path.join(directory, 'source.tmp');
    const target = path.join(directory, 'target.json');
    fsImpl.writeFileSync(source, 'canary\n', { flag: 'wx', mode: 0o600 });
    fsImpl.writeFileSync(target, 'old\n', { flag: 'wx', mode: 0o600 });
    fsyncFile(fsImpl, source, 'artifact-evidence-output-canary');
    try { fsImpl.renameSync(source, target); } catch { fail('artifact-evidence-output-canary'); }
    const stat = fsImpl.lstatSync(target);
    regular(stat, 'artifact-evidence-output-canary');
    const bytes = Buffer.from(fsImpl.readFileSync(target));
    const expectedHash = crypto.createHash('sha256').update('canary\n').digest('hex');
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
      fail('artifact-evidence-output-canary');
    }
  } catch (error) {
    primary = String(error?.code).startsWith('artifact-evidence-')
      ? error : Object.assign(new Error('artifact-evidence-output-canary'), {
        code: 'artifact-evidence-output-canary', cause: error,
      });
  }
  let cleanup;
  if (directory) try { fsImpl.rmSync(directory, { recursive: true, force: true }); }
  catch (error) { cleanup = error; }
  if (primary) throw primary;
  if (cleanup) fail('artifact-evidence-output-canary');
}

function removeKnown(fsImpl, filePath, observation, rootReal, code) {
  const current = observe(fsImpl, filePath, rootReal, code);
  if (!sameObservation(observation, current)) fail(code);
  fsImpl.unlinkSync(filePath);
  if (observe(fsImpl, filePath, rootReal, code)) fail(code);
}

function acquireLock(fsImpl, lockPath, rootReal, ownerToken, processImpl) {
  let existing = readLock(fsImpl, lockPath, rootReal);
  const recoveredTokens = [];
  if (existing) {
    if (!processIsDead(processImpl, existing.metadata.pid)) fail('artifact-evidence-output-lock');
    const confirmed = readLock(fsImpl, lockPath, rootReal);
    if (!confirmed || !sameLockMetadata(existing.metadata, confirmed.metadata)
      || !sameObservation(existing.observed, confirmed.observed)) fail('artifact-evidence-output-lock');
    recoveredTokens.push(confirmed.metadata.ownerToken);
    removeKnown(fsImpl, lockPath, confirmed.observed, rootReal, 'artifact-evidence-output-lock');
    existing = null;
  }
  const metadata = lockMetadata(ownerToken, processImpl);
  try { fsImpl.writeFileSync(lockPath, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 }); }
  catch { fail('artifact-evidence-output-lock'); }
  const observed = observe(fsImpl, lockPath, rootReal, 'artifact-evidence-output-lock');
  if (!observed) fail('artifact-evidence-output-lock');
  const readback = readLock(fsImpl, lockPath, rootReal);
  if (!readback || !sameLockMetadata(metadata, readback.metadata)
    || !sameObservation(observed, readback.observed)) {
    fail('artifact-evidence-output-lock');
  }
  return { path: lockPath, metadata, observed, recoveredTokens };
}

function assertLock(fsImpl, lock, rootReal) {
  const current = readLock(fsImpl, lock.path, rootReal);
  if (!current || !sameLockMetadata(lock.metadata, current.metadata)
    || !sameObservation(lock.observed, current.observed)) fail('artifact-evidence-output-lock');
}

function releaseLock(fsImpl, lock, rootReal) {
  assertLock(fsImpl, lock, rootReal);
  removeKnown(fsImpl, lock.path, lock.observed, rootReal, 'artifact-evidence-output-lock');
}

function residueKind(base, name) {
  if (name === `${base}.lock`) return { kind: 'lock' };
  if (!name.startsWith(`${base}.`)) return null;
  const parts = name.slice(base.length + 1).split('.');
  if (parts.length === 4 && /^\d+$/.test(parts[0]) && /^[a-f0-9]{32}$/.test(parts[1])
    && /^[a-f0-9]{32}$/.test(parts[2]) && /^(?:tmp|bak)$/.test(parts[3])) {
    return { kind: 'known', ownerToken: parts[1] };
  }
  if (/\.(?:tmp|bak|quarantine)(?:\.|$)/.test(name)) return { kind: 'unknown' };
  return null;
}

function preflightResidue(fsImpl, rootPath, outputPath, rootReal) {
  const parent = path.dirname(path.resolve(outputPath));
  const lockPath = `${outputPath}.lock`;
  const existing = readLock(fsImpl, lockPath, rootReal);
  const base = path.basename(outputPath);
  for (const residue of scanArtifactResidue(fsImpl, rootPath)) {
    if (residue.path === lockPath) continue;
    const kind = residueKind(base, residue.name);
    if (path.dirname(residue.path) !== parent || kind?.kind !== 'known'
      || !existing || kind.ownerToken !== existing.metadata.ownerToken) {
      fail('artifact-evidence-output-residue');
    }
  }
  return existing;
}

function quarantineResidue(fsImpl, parent, outputPath, rootReal, rootPath, ownerTokens) {
  const base = path.basename(outputPath);
  let count = 0;
  let quarantineRoot;
  const entries = fsImpl.readdirSync(parent, { withFileTypes: true });
  if (entries.some((entry) => {
    const kind = residueKind(base, entry.name);
    return kind && kind.kind !== 'lock' && (kind.kind !== 'known' || !ownerTokens.includes(kind.ownerToken));
  })) fail('artifact-evidence-output-residue');
  for (const entry of entries) {
    const kind = residueKind(base, entry.name);
    if (!kind || kind.kind === 'lock') continue;
    const source = path.join(parent, entry.name);
    const sourceObservation = observe(fsImpl, source, rootReal, 'artifact-evidence-output-residue');
    quarantineRoot ??= fsImpl.mkdtempSync(`${rootPath}.artifact-quarantine-`);
    const quarantine = path.join(quarantineRoot, entry.name);
    if (observe(fsImpl, quarantine, null, 'artifact-evidence-output-residue')) {
      fail('artifact-evidence-output-residue');
    }
    try { fsImpl.renameSync(source, quarantine); } catch { fail('artifact-evidence-output-residue'); }
    const quarantined = observe(fsImpl, quarantine, null, 'artifact-evidence-output-residue');
    if (!quarantined || !sameArtifactMovedIdentity(sourceObservation.stat, quarantined.stat)) fail('artifact-evidence-output-residue');
    count += 1;
  }
  return count;
}

function readStableOutputBytes(fsImpl, outputPath, expected, rootReal, code) {
  const before = validateOutput(fsImpl, outputPath, rootReal);
  if (!sameObservation(expected, before)) fail(code);
  let bytes;
  try { bytes = Buffer.from(fsImpl.readFileSync(outputPath)); }
  catch { fail(code); }
  const after = validateOutput(fsImpl, outputPath, rootReal);
  if (!sameObservation(before, after)) fail(code);
  return bytes;
}

function finalOutput(fsImpl, outputPath, rootReal, expected, expectedBytes, expectedHash) {
  const first = validateOutput(fsImpl, outputPath, rootReal);
  if (!sameObservation(expected, first)) fail('artifact-evidence-output-drift');
  let bytes;
  try { bytes = Buffer.from(fsImpl.readFileSync(outputPath)); }
  catch { fail('artifact-evidence-output-readback'); }
  if (!bytes.equals(expectedBytes)
    || crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
    fail('artifact-evidence-output-readback');
  }
  const final = validateOutput(fsImpl, outputPath, rootReal);
  if (!sameObservation(first, final)) fail('artifact-evidence-output-drift');
  const firstSnapshot = readerSnapshot(first, 'SRC-A', 'artifact-evidence-output-reader');
  const finalSnapshot = readerSnapshot(final, 'SRC-B', 'artifact-evidence-output-reader');
  if (!sameStableSnapshotBody(firstSnapshot, finalSnapshot)
    || firstSnapshot.snapshotDigest !== finalSnapshot.snapshotDigest) {
    fail('artifact-evidence-output-drift');
  }
  return {
    observation: final,
    readerReceiptId: finalSnapshot.readerReceiptId,
    stable: true,
    snapshotDigest: finalSnapshot.snapshotDigest,
    snapshot: finalSnapshot,
    readerSnapshots: Object.freeze([firstSnapshot, finalSnapshot]),
  };
}

function rollbackAfterRename(
  fsImpl,
  outputPath,
  rootReal,
  parent,
  parentState,
  replacement,
  original,
  originalBytes,
  lock,
) {
  const current = validateOutput(fsImpl, outputPath, rootReal);
  if (!sameObservation(replacement, current)) {
    fail('artifact-evidence-output-rollback');
  }
  if (original === null) {
    removeKnown(fsImpl, outputPath, current, rootReal, 'artifact-evidence-output-rollback');
    fsyncDirectory(fsImpl, parent, rootReal, parentState, 'artifact-evidence-output-rollback');
    if (validateOutput(fsImpl, outputPath, rootReal) !== null) {
      fail('artifact-evidence-output-rollback');
    }
    return;
  }

  const rollbackPath = `${outputPath}.${process.pid}.${crypto.randomBytes(16).toString('hex')}.rollback.tmp`;
  let rollbackTemp;
  try {
    try {
      fsImpl.writeFileSync(rollbackPath, originalBytes, { flag: 'wx', mode: 0o600 });
    } catch { fail('artifact-evidence-output-rollback'); }
    rollbackTemp = validateOutput(fsImpl, rollbackPath, rootReal);
    if (!rollbackTemp || rollbackTemp.stat.size !== originalBytes.length) {
      fail('artifact-evidence-output-rollback');
    }
    fsyncFile(fsImpl, rollbackPath, 'artifact-evidence-output-rollback');
    assertLock(fsImpl, lock, rootReal);
    const beforeRestore = validateOutput(fsImpl, outputPath, rootReal);
    if (!sameObservation(replacement, beforeRestore)) {
      fail('artifact-evidence-output-rollback');
    }
    try { fsImpl.renameSync(rollbackPath, outputPath); }
    catch { fail('artifact-evidence-output-rollback'); }
    rollbackTemp = null;
    fsyncDirectory(fsImpl, parent, rootReal, parentState, 'artifact-evidence-output-rollback');
    const restored = validateOutput(fsImpl, outputPath, rootReal);
    if (!restored) fail('artifact-evidence-output-rollback');
    let readback;
    try { readback = Buffer.from(fsImpl.readFileSync(outputPath)); }
    catch { fail('artifact-evidence-output-rollback'); }
    if (!readback.equals(originalBytes)) fail('artifact-evidence-output-rollback');
  } finally {
    if (rollbackTemp) {
      try {
        removeKnown(
          fsImpl,
          rollbackPath,
          rollbackTemp,
          rootReal,
          'artifact-evidence-output-rollback',
        );
      } catch (error) {
        throw error;
      }
    }
  }
}

function publishOutput(fsImpl, outputPath, serialized, rootReal, outputState, rootPath, rootState) {
  const original = outputState;
  const parent = path.dirname(path.resolve(outputPath));
  const parentState = observeDirectory(fsImpl, parent, rootReal, null, 'artifact-evidence-output-drift');
  const lockPath = `${outputPath}.lock`;
  const ownerToken = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  const tempPath = `${outputPath}.${process.pid}.${ownerToken}.${nonce}.tmp`;
  const processImpl = fsImpl.process ?? process;
  const expectedBytes = Buffer.from(serialized);
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest('hex');
  let lock;
  let temp;
  let primary;
  let cleanup;
  let durability;
  let receipt;
  let originalBytes;
  let replacement;
  let renamed = false;
  const stable = () => {
    observeDirectory(fsImpl, rootPath, rootReal, { stat: rootState }, 'artifact-evidence-output-drift');
    observeDirectory(fsImpl, parent, rootReal, parentState, 'artifact-evidence-output-drift');
    const current = validateOutput(fsImpl, outputPath, rootReal);
    if ((original === null) !== (current === null) || (original && !sameObservation(original, current))) {
      fail('artifact-evidence-output-drift');
    }
  };
  try {
    durability = proveCapabilities(fsImpl, parent, rootReal, parentState, processImpl);
    renameCanary(fsImpl, rootPath);
    stable();
    preflightResidue(fsImpl, rootPath, outputPath, rootReal);
    lock = acquireLock(fsImpl, lockPath, rootReal, ownerToken, processImpl);
    if (quarantineResidue(fsImpl, parent, outputPath, rootReal, rootPath, lock.recoveredTokens) > 0) {
      durability = fsyncDirectory(
        fsImpl,
        parent,
        rootReal,
        parentState,
        'artifact-evidence-output-residue',
      );
    }
    stable();
    try { fsImpl.writeFileSync(tempPath, serialized, { flag: 'wx', mode: 0o600 }); }
    catch { fail('artifact-evidence-output-temp'); }
    temp = validateOutput(fsImpl, tempPath, rootReal);
    if (!temp || temp.stat.size !== Buffer.byteLength(serialized)) fail('artifact-evidence-output-temp');
    fsyncFile(fsImpl, tempPath, 'artifact-evidence-output-temp');
    assertLock(fsImpl, lock, rootReal);
    stable();
    assertLock(fsImpl, lock, rootReal);
    observeDirectory(fsImpl, rootPath, rootReal, { stat: rootState }, 'artifact-evidence-output-drift');
    observeDirectory(fsImpl, parent, rootReal, parentState, 'artifact-evidence-output-drift');
    const beforeReplace = validateOutput(fsImpl, outputPath, rootReal);
    if ((original === null) !== (beforeReplace === null)
      || (original && !sameObservation(original, beforeReplace))) fail('artifact-evidence-output-drift');
    originalBytes = original === null
      ? null
      : readStableOutputBytes(
        fsImpl,
        outputPath,
        beforeReplace,
        rootReal,
        'artifact-evidence-output-drift',
      );
    if (!sameObservation(temp, validateOutput(fsImpl, tempPath, rootReal))) fail('artifact-evidence-output-temp');
    try { fsImpl.renameSync(tempPath, outputPath); }
    catch { fail('artifact-evidence-output-replace'); }
    renamed = true;
    temp = null;
    const published = validateOutput(fsImpl, outputPath, rootReal);
    if (!published) fail('artifact-evidence-output-readback');
    replacement = published;
    const postDurability = fsyncDirectory(
      fsImpl,
      parent,
      rootReal,
      parentState,
      'artifact-evidence-output-publish',
    );
    const finalReceipt = finalOutput(
      fsImpl,
      outputPath,
      rootReal,
      published,
      expectedBytes,
      expectedHash,
    );
    const final = finalReceipt.observation;
    const directoryDurability = durability.directoryDurability === 'directory-durability-verified'
      && postDurability.directoryDurability === 'directory-durability-verified'
      ? 'directory-durability-verified'
      : 'file-flushed-no-directory-durability';
    receipt = Object.freeze({
      atomicReplace: 'same-directory-rename-replace-existing',
      directoryDurability,
      fileFlush: 'verified',
      outputPath,
      sha256: expectedHash,
      bytes: expectedBytes.length,
      identity: final,
      readerReceiptId: finalReceipt.readerReceiptId,
      stable: finalReceipt.stable,
      snapshotDigest: finalReceipt.snapshotDigest,
      snapshot: finalReceipt.snapshot,
      readerSnapshots: finalReceipt.readerSnapshots,
    });
  } catch (error) {
    primary = String(error?.code).startsWith('artifact-evidence-')
      ? error : Object.assign(error, { code: 'artifact-evidence-output' });
    if (renamed) {
      try {
        rollbackAfterRename(
          fsImpl,
          outputPath,
          rootReal,
          parent,
          parentState,
          replacement,
          original,
          originalBytes,
          lock,
        );
      } catch (rollbackError) {
        primary = Object.assign(rollbackError, {
          code: rollbackError?.code || 'artifact-evidence-output-rollback',
          cause: primary,
        });
      }
    }
  }
  if (temp) {
    try { removeKnown(fsImpl, tempPath, temp, rootReal, 'artifact-evidence-output-cleanup'); }
    catch (error) { cleanup = error; }
  }
  if (lock) {
    try { releaseLock(fsImpl, lock, rootReal); } catch (error) { cleanup ??= error; }
  }
  if (primary) {
    if (cleanup) primary.cleanupCode = cleanup.code || 'artifact-evidence-output-cleanup';
    throw primary;
  }
  if (cleanup) throw cleanup;
  return receipt;
}
module.exports = { publishOutput, validateOutput, sameIdentity: sameArtifactIdentity };
