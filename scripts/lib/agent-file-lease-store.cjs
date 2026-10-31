'use strict';

const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LEASE_PATH = path.join('tmp', 'agent-file-leases.json');
const LEGACY_OWNER_LOCK_SCHEMA = 2;
const OWNER_LOCK_SCHEMA = 3;
const HEARTBEAT_SCHEMA = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_STALE_AFTER_MS = 120_000;
const PROCESS_START_MATCH_TOLERANCE_MS = 2_000;
const COMMIT_PRE_RENAME_TEST_PAUSE_POINT = 'after-registry-temp-fsync-before-rename';
const PROVISIONAL_HELPER_TEST_PAUSE_POINT = 'after-owner-helper-created-before-publication';
const OWNER_LOCK_TEST_PAUSE_POINT = 'after-owner-lock-acquired';
const RELEASE_UNLINK_TEST_FAULT = 'replace-canonical-with-directory-before-unlink';
const RELEASE_UNLINK_THROW_TEST_FAULT = 'throw-on-canonical-unlink';
const RELEASE_QUARANTINE_UNLINK_THROW_TEST_FAULT = 'throw-on-quarantine-unlink';
const RELEASE_QUARANTINE_SUCCESSOR_TEST_FAULT = 'replace-quarantine-with-successor-before-readback';
const HEARTBEAT_TEST_PAUSE_POINT = 'heartbeat-protocol';
const STALE_TEST_PAUSE_POINT = 'stale-protocol';
const HEARTBEAT_PRE_FSYNC_THROW_FAULT = 'throw-before-temp-fsync';
const HEARTBEAT_PRE_RENAME_EXIT_FAULT = 'exit-after-temp-fsync-before-rename';
const HEARTBEAT_RENAME_THROW_FAULT = 'throw-on-heartbeat-rename';
const LEASE_TEST_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const BARRIER_STATES = new Set(['OPEN', 'CLOSING', 'WAITING', 'HELD', 'RELEASED']);
const BARRIER_TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const BARRIER_TOKEN_FINGERPRINT_PATTERN = /^[a-f0-9]{12}$/;
const RESOURCE_LEASE_KINDS = new Set(['read', 'build']);
const RESOURCE_LEASE_STATES = new Set(['ACTIVE', 'RELEASED']);
const RESOURCE_ID_MAX_LENGTH = 256;
const OWNER_MAX_LENGTH = 256;
const LEASE_REGISTRY_FIELDS = new Set([
  'version',
  'workspaceEpoch',
  'fencingCounter',
  'barrier',
  'leases',
  'resourceLeases',
]);
const BARRIER_FIELDS = new Set([
  'state',
  'owner',
  'tokenHash',
  'tokenFingerprint',
  'acquiredAt',
  'heartbeatAt',
  'heartbeatSequence',
  'heldEpoch',
  'fence',
  'releasedAt',
  'transitions',
]);
const BARRIER_TRANSITION_FIELDS = new Set(['state', 'at', 'sequence']);
const RESOURCE_LEASE_FIELDS = new Set([
  'kind',
  'resourceId',
  'owner',
  'tokenHash',
  'tokenFingerprint',
  'state',
  'acquiredAt',
  'heartbeatAt',
  'heartbeatSequence',
  'expiresAt',
  'expiresAtMs',
  'releasedAt',
  'barrierOwner',
  'barrierTokenFingerprint',
  'fence',
  'heldEpoch',
]);
const RESOURCE_LEASE_REQUIRED_FIELDS = new Set([
  'kind',
  'resourceId',
  'owner',
  'tokenHash',
  'tokenFingerprint',
  'state',
  'acquiredAt',
  'heartbeatAt',
  'heartbeatSequence',
  'expiresAt',
  'expiresAtMs',
  'releasedAt',
]);
const RESOURCE_LEASE_BARRIER_BINDING_FIELDS = new Set([
  'barrierOwner',
  'barrierTokenFingerprint',
  'fence',
  'heldEpoch',
]);
const ownerLockStates = new WeakMap();

function leasePath(root) {
  return path.join(root, DEFAULT_LEASE_PATH);
}

function ownerLockPath(root) {
  return `${leasePath(root)}.lock`;
}

function canonicalLeaseStatePaths(root) {
  const rootPath = fs.realpathSync(root);
  const transactionDirectoryPath = path.join(rootPath, path.dirname(DEFAULT_LEASE_PATH));
  const registryPath = path.join(transactionDirectoryPath, path.basename(DEFAULT_LEASE_PATH));
  return {
    rootPath,
    transactionDirectoryPath,
    registryPath,
    canonicalPath: `${registryPath}.lock`,
  };
}

function readSelfProcessStartIdentity() {
  const value = globalThis.performance.timeOrigin;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('unable to establish the current process start identity');
  }
  return {
    kind: 'node-performance-time-origin',
    unit: 'unix-ms',
    value,
  };
}

function strictLeaseTestContext(rootPath, allowedPausePoints) {
  const runId = process.env.NANOFLOW_LEASE_TEST_RUN_ID;
  const configuredRoot = process.env.NANOFLOW_LEASE_TEST_ROOT;
  const canonicalRoot = fs.realpathSync(rootPath);
  const canonicalTmp = fs.realpathSync(require('node:os').tmpdir());
  const relativeToTmp = path.relative(canonicalTmp, canonicalRoot);
  const outsideTmp = relativeToTmp === ''
    || relativeToTmp === '..'
    || relativeToTmp.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToTmp);
  const allowedStages = Array.isArray(allowedPausePoints)
    ? allowedPausePoints
    : [allowedPausePoints];
  if (typeof process.send !== 'function'
    || process.connected !== true
    || typeof runId !== 'string'
    || runId.length === 0
    || !LEASE_TEST_RUN_ID_PATTERN.test(runId)
    || typeof configuredRoot !== 'string'
    || configuredRoot !== canonicalRoot
    || path.resolve(configuredRoot) !== canonicalRoot
    || path.resolve(rootPath) !== canonicalRoot
    || !allowedStages.includes(process.env.NANOFLOW_LEASE_TEST_PAUSE_POINT)
    || outsideTmp
    || !path.basename(canonicalRoot).startsWith('nanoflow-agent-file-lease-')) {
    throw new Error('lease test seam requires IPC, runId, exact stage, and canonical NanoFlow temp root');
  }
  return { canonicalRoot, runId };
}

function heartbeatIntervalMs(rootPath) {
  const configured = process.env.NANOFLOW_LEASE_TEST_HEARTBEAT_INTERVAL_MS;
  if (configured === undefined || configured === '') return DEFAULT_HEARTBEAT_INTERVAL_MS;
  strictLeaseTestContext(rootPath, [
    OWNER_LOCK_TEST_PAUSE_POINT,
    HEARTBEAT_TEST_PAUSE_POINT,
    STALE_TEST_PAUSE_POINT,
  ]);
  if (!/^\d+$/.test(configured)) {
    throw new Error('heartbeat test interval must be a positive integer');
  }
  const intervalMs = Number(configured);
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > 1_000) {
    throw new Error('heartbeat test interval must be between 1 and 1000ms');
  }
  return intervalMs;
}

function staleAfterMs(rootPath) {
  const configured = process.env.NANOFLOW_LEASE_TEST_STALE_AFTER_MS;
  if (configured === undefined || configured === '') return DEFAULT_STALE_AFTER_MS;
  strictLeaseTestContext(rootPath, STALE_TEST_PAUSE_POINT);
  if (!/^\d+$/.test(configured)) {
    throw new Error('stale test age must be a positive integer');
  }
  const ageMs = Number(configured);
  if (!Number.isSafeInteger(ageMs) || ageMs <= 0 || ageMs > 10_000) {
    throw new Error('stale test age must be between 1 and 10000ms');
  }
  return ageMs;
}

function runProvisionalHelperTestFault(root, ownerPath) {
  const faultMode = process.env.NANOFLOW_LEASE_TEST_PROVISIONAL_HELPER_FAULT_MODE;
  if (faultMode === undefined || faultMode === '') return;
  const canonicalRoot = fs.realpathSync(root);
  strictLeaseTestContext(canonicalRoot, PROVISIONAL_HELPER_TEST_PAUSE_POINT);
  if (faultMode === 'replace-helper') {
    fs.unlinkSync(ownerPath);
    fs.writeFileSync(ownerPath, 'provisional-helper-successor', { flag: 'wx' });
  } else if (faultMode !== 'throw') {
    throw new Error(`unsupported provisional helper test fault mode: ${faultMode}`);
  }
  throw new Error('provisional owner helper test fault');
}

function stableRegularFileIdentity(stat, filePath) {
  if (!stat.isFile()) {
    throw leaseStateProtocolError(
      `lease state identity path is not a regular file: ${filePath}`,
      'non-regular-file',
    );
  }
  if (typeof stat.dev !== 'bigint'
    || typeof stat.ino !== 'bigint'
    || stat.dev === 0n
    || stat.ino === 0n) {
    throw new Error(`stable file identity is unavailable: ${filePath}`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

function readStableFileIdentity(filePath) {
  return stableRegularFileIdentity(fs.lstatSync(filePath, { bigint: true }), filePath);
}

function stableDirectoryIdentity(stat, directoryPath) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw leaseStateProtocolError(
      `lease state transaction directory is a symlink, reparse point, or non-directory: ${directoryPath}`,
      'unsafe-transaction-directory',
    );
  }
  if (typeof stat.dev !== 'bigint'
    || typeof stat.ino !== 'bigint'
    || stat.dev === 0n
    || stat.ino === 0n) {
    throw new Error(`stable directory identity is unavailable: ${directoryPath}`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

function readStableDirectoryIdentity(directoryPath) {
  return stableDirectoryIdentity(
    fs.lstatSync(directoryPath, { bigint: true }),
    directoryPath,
  );
}

function bindLeaseStateTransactionDirectory(boundPaths) {
  const directoryPath = boundPaths.transactionDirectoryPath;
  const identityBeforeRealpath = readStableDirectoryIdentity(directoryPath);
  const realPath = fs.realpathSync(directoryPath);
  const identityAfterRealpath = readStableDirectoryIdentity(directoryPath);
  if (!sameFileIdentity(identityBeforeRealpath, identityAfterRealpath)) {
    throw leaseStateProtocolError(
      `lease state transaction directory changed while binding: ${directoryPath}`,
      'transaction-directory-changed',
    );
  }
  if (realPath !== directoryPath) {
    throw leaseStateProtocolError(
      `lease state transaction directory escapes its canonical root: ${directoryPath} -> ${realPath}`,
      'unsafe-transaction-directory',
    );
  }
  return {
    path: directoryPath,
    realPath,
    identity: identityAfterRealpath,
  };
}

function verifyLeaseStateTransactionDirectory(state) {
  const identityBeforeRealpath = readStableDirectoryIdentity(state.transactionDirectoryPath);
  const realPath = fs.realpathSync(state.transactionDirectoryPath);
  const identityAfterRealpath = readStableDirectoryIdentity(state.transactionDirectoryPath);
  if (!sameFileIdentity(identityBeforeRealpath, identityAfterRealpath)
    || !sameFileIdentity(identityAfterRealpath, state.transactionDirectoryIdentity)) {
    throw leaseStateProtocolError(
      `lease state transaction directory ownership changed: ${state.transactionDirectoryPath}`,
      'transaction-directory-changed',
    );
  }
  if (realPath !== state.transactionDirectoryRealPath
    || realPath !== state.transactionDirectoryPath) {
    throw leaseStateProtocolError(
      `lease state transaction directory canonical path changed: ${state.transactionDirectoryPath} -> ${realPath}`,
      'unsafe-transaction-directory',
    );
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function leaseStateProtocolError(message, failure) {
  const error = new Error(message);
  Object.defineProperty(error, 'leaseStateFailure', {
    configurable: true,
    value: failure,
  });
  return error;
}

function existingReclaimAnchorError(observed, qOwner) {
  const diagnostic = Object.freeze({
    ok: false,
    failure: 'repair-required',
    reason: 'existing-reclaim-anchor',
    qPath: observed.qPath,
    canonicalToken: observed.owner.token,
    qToken: qOwner.token,
  });
  const error = leaseStateProtocolError(
    `lease state repair-required for existing reclaim anchor: ${observed.qPath}`,
    'repair-required',
  );
  Object.defineProperty(error, 'leaseStateDiagnostic', {
    configurable: true,
    value: diagnostic,
  });
  return error;
}

function attachSecondaryError(primaryError, secondaryError, property = 'cleanupError') {
  if (!(primaryError instanceof Error) || !secondaryError) return;
  try {
    if (primaryError.cause === undefined) {
      Object.defineProperty(primaryError, 'cause', {
        configurable: true,
        value: secondaryError,
      });
    } else if (primaryError[property] === undefined) {
      Object.defineProperty(primaryError, property, {
        configurable: true,
        value: secondaryError,
      });
    }
  } catch {
    // A frozen primary error still wins; cleanup failure remains secondary.
  }
}

function removePublishedOwnerLinkIfStillOurs(state) {
  try {
    const canonicalIdentity = readStableFileIdentity(state.canonicalPath);
    if (sameFileIdentity(canonicalIdentity, state.identity)) {
      fs.unlinkSync(state.canonicalPath);
    }
  } catch {
    // Fail closed: never remove a canonical path whose identity cannot be proven.
  }
}

function removeOwnerHelperIfStillOurs(state) {
  let helperIdentity;
  try {
    helperIdentity = readStableFileIdentity(state.ownerPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!sameFileIdentity(helperIdentity, state.identity)) {
    throw leaseStateProtocolError(
      `owner helper ownership changed before cleanup: ${state.ownerPath}`,
      'owner-helper-changed',
    );
  }
  fs.unlinkSync(state.ownerPath);
}

function verifyOwnerHelperState(state) {
  const identityBeforeRead = readStableFileIdentity(state.ownerPath);
  if (!sameFileIdentity(identityBeforeRead, state.identity)) {
    throw leaseStateProtocolError(
      `lease state owner helper ownership changed: ${state.ownerPath}`,
      'owner-helper-changed',
    );
  }
  const helperBytes = fs.readFileSync(state.ownerPath);
  const identityAfterRead = readStableFileIdentity(state.ownerPath);
  if (!sameFileIdentity(identityAfterRead, state.identity)) {
    throw leaseStateProtocolError(
      `lease state owner helper ownership changed during read: ${state.ownerPath}`,
      'owner-helper-changed',
    );
  }
  const helperDigest = createHash('sha256').update(helperBytes).digest('hex');
  if (!helperBytes.equals(state.metadataBytes) || helperDigest !== state.metadataDigest) {
    throw leaseStateProtocolError(
      `lease state owner helper metadata changed: ${state.ownerPath}`,
      'owner-helper-metadata-changed',
    );
  }
}

function verifyHeartbeatState(state) {
  const identityBeforeRead = readStableFileIdentity(state.heartbeatPath);
  if (!state.heartbeatIdentity || !sameFileIdentity(identityBeforeRead, state.heartbeatIdentity)) {
    throw leaseStateProtocolError(
      `lease state heartbeat ownership changed: ${state.heartbeatPath}`,
      'heartbeat-ownership-changed',
    );
  }
  const heartbeatBytes = fs.readFileSync(state.heartbeatPath);
  const identityAfterRead = readStableFileIdentity(state.heartbeatPath);
  if (!sameFileIdentity(identityAfterRead, state.heartbeatIdentity)) {
    throw leaseStateProtocolError(
      `lease state heartbeat ownership changed during read: ${state.heartbeatPath}`,
      'heartbeat-ownership-changed',
    );
  }
  let heartbeat;
  try {
    heartbeat = JSON.parse(heartbeatBytes.toString('utf8'));
  } catch {
    throw leaseStateProtocolError(
      `lease state heartbeat metadata changed: ${state.heartbeatPath}`,
      'heartbeat-metadata-changed',
    );
  }
  if (!state.heartbeatBytes
    || !heartbeatBytes.equals(state.heartbeatBytes)
    || heartbeat?.schema !== HEARTBEAT_SCHEMA
    || heartbeat?.token !== state.token
    || heartbeat?.pid !== process.pid
    || heartbeat?.processStartIdentity?.kind !== state.processStartIdentity.kind
    || heartbeat?.processStartIdentity?.unit !== state.processStartIdentity.unit
    || heartbeat?.processStartIdentity?.value !== state.processStartIdentity.value) {
    throw leaseStateProtocolError(
      `lease state heartbeat metadata changed: ${state.heartbeatPath}`,
      'heartbeat-metadata-changed',
    );
  }
  return heartbeat;
}

function runHeartbeatPreRenameTestFault(state) {
  if (process.env.NANOFLOW_LEASE_TEST_HEARTBEAT_FAULT !== HEARTBEAT_PRE_RENAME_EXIT_FAULT) return;
  strictLeaseTestContext(state.rootPath, [
    OWNER_LOCK_TEST_PAUSE_POINT,
    HEARTBEAT_TEST_PAUSE_POINT,
    STALE_TEST_PAUSE_POINT,
  ]);
  process.exit(86);
}

function runHeartbeatEioTestFault(state, expectedFault) {
  if (process.env.NANOFLOW_LEASE_TEST_HEARTBEAT_FAULT !== expectedFault) return;
  strictLeaseTestContext(state.rootPath, [
    OWNER_LOCK_TEST_PAUSE_POINT,
    HEARTBEAT_TEST_PAUSE_POINT,
    STALE_TEST_PAUSE_POINT,
  ]);
  const error = new Error(`injected heartbeat syscall failure: ${expectedFault}`);
  error.code = 'EIO';
  throw error;
}

function writeOwnerHeartbeat(state) {
  verifyCanonicalOwnerState(state);
  if (state.heartbeatIdentity) verifyHeartbeatState(state);
  const sequence = (state.heartbeatSequence || 0) + 1;
  const updatedAtMs = Math.max(Date.now(), (state.heartbeatUpdatedAtMs || 0) + 1);
  const heartbeat = {
    schema: HEARTBEAT_SCHEMA,
    token: state.token,
    pid: process.pid,
    processStartIdentity: state.processStartIdentity,
    sequence,
    updatedAtMs,
  };
  const heartbeatBytes = Buffer.from(JSON.stringify(heartbeat), 'utf8');
  const tempPath = `${state.heartbeatPath}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  let tempFd;
  let tempIdentity;
  let renamed = false;
  try {
    tempFd = fs.openSync(tempPath, 'wx', 0o600);
    tempIdentity = stableRegularFileIdentity(
      fs.fstatSync(tempFd, { bigint: true }),
      tempPath,
    );
    fs.writeFileSync(tempFd, heartbeatBytes);
    runHeartbeatEioTestFault(state, HEARTBEAT_PRE_FSYNC_THROW_FAULT);
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;

    const tempPathIdentity = readStableFileIdentity(tempPath);
    if (!sameFileIdentity(tempIdentity, tempPathIdentity)) {
      throw leaseStateProtocolError(
        `lease state heartbeat temp ownership changed: ${tempPath}`,
        'heartbeat-temp-ownership-changed',
      );
    }
    verifyCanonicalOwnerState(state);
    runHeartbeatPreRenameTestFault(state);
    runHeartbeatEioTestFault(state, HEARTBEAT_RENAME_THROW_FAULT);
    fs.renameSync(tempPath, state.heartbeatPath);
    renamed = true;
    fsyncParentDirectory(state.heartbeatPath);

    const publishedIdentity = readStableFileIdentity(state.heartbeatPath);
    if (!sameFileIdentity(tempIdentity, publishedIdentity)) {
      throw leaseStateProtocolError(
        `lease state heartbeat ownership changed after rename: ${state.heartbeatPath}`,
        'heartbeat-ownership-changed',
      );
    }
    const readback = fs.readFileSync(state.heartbeatPath);
    const readbackIdentity = readStableFileIdentity(state.heartbeatPath);
    if (!sameFileIdentity(tempIdentity, readbackIdentity) || !readback.equals(heartbeatBytes)) {
      throw leaseStateProtocolError(
        `lease state heartbeat readback verification failed: ${state.heartbeatPath}`,
        'heartbeat-readback-failed',
      );
    }
    state.heartbeatIdentity = readbackIdentity;
    state.heartbeatBytes = heartbeatBytes;
    state.heartbeatSequence = sequence;
    state.heartbeatUpdatedAtMs = updatedAtMs;
    verifyCanonicalOwnerState(state);
  } finally {
    if (tempFd !== undefined) {
      try {
        fs.closeSync(tempFd);
      } catch {
        // The primary heartbeat failure remains authoritative.
      }
    }
    if (!renamed) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // A unique temp file is diagnostic residue; never mask the primary failure.
      }
    }
  }
}

function startOwnerHeartbeat(state) {
  if (state.heartbeatTimer) return;
  const timer = setInterval(() => {
    if ((state.status !== 'held' && state.status !== 'retryable') || state.heartbeatError) return;
    try {
      writeOwnerHeartbeat(state);
    } catch (error) {
      state.heartbeatError = error;
      clearInterval(timer);
      state.heartbeatTimer = undefined;
    }
  }, heartbeatIntervalMs(state.rootPath));
  timer.unref();
  state.heartbeatTimer = timer;
}

function restoreOwnerHeartbeatAfterRetryableReleaseFailure(state, primaryError, previousHeartbeatError) {
  let heartbeatReestablished = false;
  let heartbeatRestoreError;
  try {
    verifyCanonicalOwnerState(state);
    writeOwnerHeartbeat(state);
    heartbeatReestablished = true;
    state.heartbeatError = undefined;
    startOwnerHeartbeat(state);
  } catch (error) {
    heartbeatRestoreError = error;
    if (heartbeatReestablished) state.heartbeatError = error;
  }
  attachSecondaryError(primaryError, previousHeartbeatError, 'heartbeatError');
  attachSecondaryError(primaryError, heartbeatRestoreError, 'heartbeatRestoreError');
}

function stopOwnerHeartbeat(state) {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = undefined;
  }
  return state.heartbeatError;
}

function removeHeartbeatIfStillOurs(state) {
  if (!state.heartbeatIdentity) return;
  try {
    verifyHeartbeatState(state);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  fs.unlinkSync(state.heartbeatPath);
  state.heartbeatIdentity = undefined;
  state.heartbeatBytes = undefined;
}

function readObservedRegularFile(filePath) {
  const identityBeforeRead = readStableFileIdentity(filePath);
  const bytes = fs.readFileSync(filePath);
  const identityAfterRead = readStableFileIdentity(filePath);
  if (!sameFileIdentity(identityBeforeRead, identityAfterRead)) {
    throw leaseStateProtocolError(
      `lease state path changed during observation: ${filePath}`,
      'observed-file-changed',
    );
  }
  return { path: filePath, identity: identityAfterRead, bytes };
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length
    && expectedKeys.every(key => hasOwn(value, key));
}

function parseObservedOwner(observed) {
  let owner;
  try {
    owner = JSON.parse(observed.bytes.toString('utf8'));
  } catch {
    return null;
  }
  const start = owner?.processStartIdentity;
  const currentSchema = owner?.schema === OWNER_LOCK_SCHEMA;
  if (!isPlainObject(owner)
    || (!currentSchema && owner.schema !== LEGACY_OWNER_LOCK_SCHEMA)
    || typeof owner.token !== 'string'
    || !/^[a-f0-9]{64}$/.test(owner.token)
    || !isValidOwner(owner.owner)
    || !Number.isSafeInteger(owner.pid)
    || owner.pid <= 0
    || owner.pid > 0x7fffffff
    || !isPlainObject(start)
    || start.kind !== 'node-performance-time-origin'
    || start.unit !== 'unix-ms'
    || !Number.isFinite(start.value)
    || start.value <= 0
    || typeof owner.createdAt !== 'string'
    || !Number.isFinite(Date.parse(owner.createdAt))) {
    return null;
  }
  if (currentSchema) {
    const createdAtMs = Date.parse(owner.createdAt);
    const initial = owner.initialHeartbeat;
    const initialStart = initial?.processStartIdentity;
    if (!hasExactKeys(owner, [
      'schema',
      'token',
      'owner',
      'pid',
      'processStartIdentity',
      'createdAt',
      'initialHeartbeat',
    ])
      || !hasExactKeys(start, ['kind', 'unit', 'value'])
      || !hasExactKeys(initial, [
        'schema',
        'token',
        'pid',
        'processStartIdentity',
        'sequence',
        'heartbeatAtMs',
      ])
      || !hasExactKeys(initialStart, ['kind', 'unit', 'value'])
      || !Number.isSafeInteger(createdAtMs)
      || createdAtMs <= 0
      || new Date(createdAtMs).toISOString() !== owner.createdAt
      || initial.schema !== HEARTBEAT_SCHEMA
      || initial.token !== owner.token
      || initial.pid !== owner.pid
      || !sameProcessStartIdentity(initialStart, start)
      || initial.sequence !== 0
      || !Number.isSafeInteger(initial.heartbeatAtMs)
      || initial.heartbeatAtMs !== createdAtMs) {
      return null;
    }
  }
  return owner;
}

function sameProcessStartIdentity(left, right) {
  return left?.kind === right?.kind
    && left?.unit === right?.unit
    && left?.value === right?.value;
}

function parseObservedHeartbeat(observed, owner) {
  let heartbeat;
  try {
    heartbeat = JSON.parse(observed.bytes.toString('utf8'));
  } catch {
    return null;
  }
  const start = heartbeat?.processStartIdentity;
  if (!hasExactKeys(heartbeat, [
    'schema',
    'token',
    'pid',
    'processStartIdentity',
    'sequence',
    'updatedAtMs',
  ])
    || !hasExactKeys(start, ['kind', 'unit', 'value'])
    || heartbeat.schema !== HEARTBEAT_SCHEMA
    || heartbeat.token !== owner.token
    || heartbeat.pid !== owner.pid
    || !sameProcessStartIdentity(start, owner.processStartIdentity)
    || !Number.isSafeInteger(heartbeat.sequence)
    || heartbeat.sequence < 1
    || !Number.isSafeInteger(heartbeat.updatedAtMs)
    || heartbeat.updatedAtMs <= owner.initialHeartbeat.heartbeatAtMs) {
    return null;
  }
  return heartbeat;
}

function processProbeTestMode(rootPath) {
  const mode = process.env.NANOFLOW_LEASE_TEST_PROCESS_PROBE_MODE;
  if (mode === undefined || mode === '') return null;
  strictLeaseTestContext(rootPath, STALE_TEST_PAUSE_POINT);
  if (mode !== 'eperm' && mode !== 'unobserved') {
    throw new Error(`unsupported process probe test mode: ${mode}`);
  }
  return mode;
}

function normalizedWindowsPath(filePath) {
  return path.win32.normalize(filePath).toLowerCase();
}

function validatedWindowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot;
  const winDir = process.env.windir;
  if (typeof systemRoot !== 'string'
    || typeof winDir !== 'string'
    || !/^[a-z]:\\/i.test(systemRoot)
    || !/^[a-z]:\\/i.test(winDir)
    || normalizedWindowsPath(systemRoot) !== normalizedWindowsPath(winDir)) {
    throw new Error('Windows system root is unavailable or inconsistent');
  }
  const realSystemRoot = fs.realpathSync(systemRoot);
  const systemRootStat = fs.lstatSync(realSystemRoot);
  if (systemRootStat.isSymbolicLink() || !systemRootStat.isDirectory()) {
    throw new Error('Windows system root is not a canonical directory');
  }
  const expectedRelative = path.join('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const candidate = path.join(realSystemRoot, expectedRelative);
  const candidateStat = fs.lstatSync(candidate);
  if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
    throw new Error('Windows PowerShell executable is not a regular system file');
  }
  const realCandidate = fs.realpathSync(candidate);
  if (normalizedWindowsPath(path.relative(realSystemRoot, realCandidate))
    !== normalizedWindowsPath(expectedRelative)) {
    throw new Error('Windows PowerShell executable escaped the canonical system root');
  }
  return realCandidate;
}

function probeWindowsProcessStart(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^\d+$/.test(String(pid))) {
    return { kind: 'ambiguous' };
  }
  let executable;
  try {
    executable = validatedWindowsPowerShellPath();
  } catch {
    return { kind: 'ambiguous' };
  }
  if (process.env.NANOFLOW_LEASE_TEST_PAUSE_POINT === STALE_TEST_PAUSE_POINT) {
    const { runId } = strictLeaseTestContext(
      fs.realpathSync(process.env.NANOFLOW_LEASE_TEST_ROOT),
      STALE_TEST_PAUSE_POINT,
    );
    process.send({
      type: 'NANOFLOW_LEASE_TEST_PROCESS_START_PROBE_SPAWN',
      runId,
      pausePoint: STALE_TEST_PAUSE_POINT,
      pid,
    });
  }
  const script = `$ErrorActionPreference='Stop';`
    + '[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);'
    + `try{$p=[Diagnostics.Process]::GetProcessById(${pid});$ms=[DateTimeOffset]::new($p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();[Console]::Out.Write(('ALIVE|{0}|{1}' -f $p.Id,$ms));exit 0}`
    + "catch [ArgumentException]{[Console]::Out.Write('ABSENT');exit 3}"
    + 'catch{exit 4}';
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(executable, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    maxBuffer: 1024,
    shell: false,
    timeout: 2_000,
    windowsHide: true,
  });
  if (result.error || result.signal !== null || result.stderr !== '') return { kind: 'ambiguous' };
  if (result.status === 3 && result.stdout === 'ABSENT') return { kind: 'dead' };
  if (result.status !== 0) return { kind: 'ambiguous' };
  const match = /^ALIVE\|(\d+)\|(\d+)$/.exec(result.stdout);
  if (!match || Number(match[1]) !== pid) return { kind: 'ambiguous' };
  const startTimeMs = Number(match[2]);
  if (!Number.isSafeInteger(startTimeMs) || startTimeMs <= 0) return { kind: 'ambiguous' };
  return { kind: 'alive', startTimeMs };
}

function determineOwnerProcessState(rootPath, owner) {
  const testMode = processProbeTestMode(rootPath);
  if (testMode === 'eperm') return { kind: 'ambiguous' };
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return { kind: 'dead' };
    return { kind: 'ambiguous' };
  }
  if (testMode === 'unobserved' || process.platform !== 'win32') {
    return { kind: 'ambiguous' };
  }
  const observed = probeWindowsProcessStart(owner.pid);
  if (observed.kind !== 'alive') return observed;
  const claimedStartMs = owner.processStartIdentity.value;
  const deltaMs = observed.startTimeMs - claimedStartMs;
  if (Math.abs(deltaMs) <= PROCESS_START_MATCH_TOLERANCE_MS) {
    return { kind: 'matching' };
  }
  const createdAtMs = Date.parse(owner.createdAt);
  if (deltaMs > PROCESS_START_MATCH_TOLERANCE_MS
    && observed.startTimeMs > createdAtMs + PROCESS_START_MATCH_TOLERANCE_MS) {
    return { kind: 'mismatch' };
  }
  return { kind: 'ambiguous' };
}

function observeStaleOwnerCandidate(boundPaths, knownTerminalProcessState) {
  const canonical = readObservedRegularFile(boundPaths.canonicalPath);
  const owner = parseObservedOwner(canonical);
  if (!owner || owner.schema !== OWNER_LOCK_SCHEMA) return null;
  const ownerPath = path.join(
    boundPaths.transactionDirectoryPath,
    `${path.basename(boundPaths.canonicalPath)}.owner.${owner.pid}.${owner.token}`,
  );
  const ownerHelper = readObservedRegularFile(ownerPath);
  if (!sameFileIdentity(ownerHelper.identity, canonical.identity)
    || !ownerHelper.bytes.equals(canonical.bytes)) return null;
  const heartbeatPath = `${boundPaths.canonicalPath}.heartbeat.${owner.token}`;
  let heartbeatFile;
  try {
    heartbeatFile = readObservedRegularFile(heartbeatPath);
  } catch (error) {
    if (error?.code !== 'ENOENT' || owner.schema !== OWNER_LOCK_SCHEMA) throw error;
    verifyObservedFile(canonical);
    verifyObservedFile(ownerHelper);
    try {
      heartbeatFile = readObservedRegularFile(heartbeatPath);
    } catch (secondError) {
      if (secondError?.code !== 'ENOENT') throw secondError;
    }
  }
  const heartbeat = heartbeatFile
    ? parseObservedHeartbeat(heartbeatFile, owner)
    : {
        schema: HEARTBEAT_SCHEMA,
        token: owner.initialHeartbeat.token,
        pid: owner.initialHeartbeat.pid,
        processStartIdentity: owner.initialHeartbeat.processStartIdentity,
        sequence: owner.initialHeartbeat.sequence,
        updatedAtMs: owner.initialHeartbeat.heartbeatAtMs,
      };
  if (!heartbeat) return null;
  const now = Date.now();
  if (heartbeat.updatedAtMs > now
    || now - heartbeat.updatedAtMs < staleAfterMs(boundPaths.rootPath)) return null;
  const processState = knownTerminalProcessState
    ?? determineOwnerProcessState(boundPaths.rootPath, owner);
  if (processState.kind !== 'dead' && processState.kind !== 'mismatch') return null;
  return {
    canonical,
    owner,
    ownerHelper,
    heartbeat,
    heartbeatFile,
    processState,
    qPath: `${boundPaths.canonicalPath}.reclaim.${owner.token}`,
  };
}

function sameObservedFile(left, right) {
  return sameFileIdentity(left.identity, right.identity) && left.bytes.equals(right.bytes);
}

function sameOptionalObservedFile(left, right) {
  if (!left || !right) return left === right;
  return sameObservedFile(left, right);
}

function verifyObservedFile(observed) {
  const current = readObservedRegularFile(observed.path);
  if (!sameObservedFile(current, observed)) {
    throw leaseStateProtocolError(
      `lease state observed file changed before unlink: ${observed.path}`,
      'observed-file-changed',
    );
  }
  return current;
}

function unlinkObservedFile(observed) {
  verifyObservedFile(observed);
  fs.unlinkSync(observed.path);
}

function removeReclaimAnchorIfSame(qPath, canonical) {
  try {
    const q = readObservedRegularFile(qPath);
    if (sameObservedFile(q, canonical)) fs.unlinkSync(qPath);
  } catch {
    // Preserve a foreign/corrupt anchor and fail closed at the caller.
  }
}

function reclaimTestFault(boundPaths, point, observed) {
  const fault = process.env.NANOFLOW_LEASE_TEST_RECLAIM_FAULT;
  if (fault === undefined || fault === '') return;
  strictLeaseTestContext(boundPaths.rootPath, STALE_TEST_PAUSE_POINT);
  const allowed = new Set([
    'advance-heartbeat-after-q-link',
    'fail-mismatched-q-cleanup',
    'replace-canonical-successor-before-q-link',
    'replace-canonical-successor-after-q-link',
    'replace-canonical-same-token-new-inode-after-q-link',
    'replace-mismatched-q-before-cleanup',
    'exit-after-q-link',
    'exit-after-canonical-unlink',
    'exit-after-heartbeat-cleanup',
    'fail-q-link',
    'fail-canonical-unlink',
    'fail-post-unlink-fsync',
    'fail-heartbeat-unlink',
    'fail-owner-unlink',
    'fail-q-unlink',
  ]);
  if (!allowed.has(fault)) throw new Error(`unsupported reclaim test fault: ${fault}`);

  if (point === 'before-q-link'
    && (fault === 'fail-mismatched-q-cleanup'
      || fault === 'replace-canonical-successor-before-q-link'
      || fault === 'replace-mismatched-q-before-cleanup')) {
    fs.unlinkSync(boundPaths.canonicalPath);
    fs.writeFileSync(boundPaths.canonicalPath, JSON.stringify({
      ...observed.owner,
      token: 'e'.repeat(64),
      owner: 'reclaim-test-successor',
    }), { flag: 'wx' });
    return;
  }

  if (point === 'before-mismatched-q-cleanup') {
    if (fault === 'fail-mismatched-q-cleanup') {
      const error = new Error('injected mismatched q cleanup failure');
      error.code = 'EIO';
      throw error;
    }
    if (fault === 'replace-mismatched-q-before-cleanup') {
      fs.unlinkSync(observed.q.path);
      fs.writeFileSync(observed.q.path, 'foreign-mismatched-q', { flag: 'wx' });
      return;
    }
  }

  if ((point === 'before-q-link' && fault === 'fail-q-link')
    || (point === 'before-canonical-unlink' && fault === 'fail-canonical-unlink')
    || (point === 'after-post-unlink-fsync' && fault === 'fail-post-unlink-fsync')
    || (point === 'before-heartbeat-unlink' && fault === 'fail-heartbeat-unlink')
    || (point === 'before-owner-unlink' && fault === 'fail-owner-unlink')
    || (point === 'before-q-unlink' && fault === 'fail-q-unlink')) {
    const error = new Error(`injected reclaim failure at ${point}`);
    error.code = 'EIO';
    throw error;
  }

  if (point === 'after-q-link') {
    if (fault === 'advance-heartbeat-after-q-link') {
      const heartbeat = {
        ...observed.heartbeat,
        sequence: observed.heartbeat.sequence + 1,
        updatedAtMs: Date.now(),
      };
      fs.writeFileSync(observed.heartbeatFile.path, JSON.stringify(heartbeat));
    } else if (fault === 'replace-canonical-successor-after-q-link') {
      fs.unlinkSync(boundPaths.canonicalPath);
      fs.writeFileSync(boundPaths.canonicalPath, JSON.stringify({
        ...observed.owner,
        token: 'e'.repeat(64),
        owner: 'reclaim-test-successor',
      }), { flag: 'wx' });
    } else if (fault === 'replace-canonical-same-token-new-inode-after-q-link') {
      fs.unlinkSync(boundPaths.canonicalPath);
      fs.writeFileSync(boundPaths.canonicalPath, observed.canonical.bytes, { flag: 'wx' });
    } else if (fault === 'exit-after-q-link') {
      process.exit(87);
    }
  } else if (point === 'after-canonical-unlink' && fault === 'exit-after-canonical-unlink') {
    process.exit(88);
  } else if (point === 'after-heartbeat-cleanup' && fault === 'exit-after-heartbeat-cleanup') {
    process.exit(89);
  }
}

function canonicalPathIsAbsent(canonicalPath) {
  try {
    fs.lstatSync(canonicalPath);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

function recoverDetachedReclaimAnchors(boundPaths) {
  if (!canonicalPathIsAbsent(boundPaths.canonicalPath)) return;
  const prefix = `${path.basename(boundPaths.canonicalPath)}.reclaim.`;
  const candidates = fs.readdirSync(boundPaths.transactionDirectoryPath)
    .filter(name => name.startsWith(prefix))
    .sort();
  for (const name of candidates) {
    if (!canonicalPathIsAbsent(boundPaths.canonicalPath)) return;
    const token = name.slice(prefix.length);
    if (!/^[a-f0-9]{64}$/.test(token)) continue;
    const qPath = path.join(boundPaths.transactionDirectoryPath, name);
    let q;
    try {
      q = readObservedRegularFile(qPath);
    } catch {
      continue;
    }
    const owner = parseObservedOwner(q);
    if (!owner || owner.schema !== OWNER_LOCK_SCHEMA || owner.token !== token) continue;
    const ownerPath = path.join(
      boundPaths.transactionDirectoryPath,
      `${path.basename(boundPaths.canonicalPath)}.owner.${owner.pid}.${owner.token}`,
    );
    const heartbeatPath = `${boundPaths.canonicalPath}.heartbeat.${owner.token}`;
    let ownerHelper;
    let heartbeatFile;
    try {
      ownerHelper = readObservedRegularFile(ownerPath);
      if (!sameObservedFile(ownerHelper, q)) continue;
    } catch (error) {
      if (error?.code !== 'ENOENT') continue;
    }
    try {
      heartbeatFile = readObservedRegularFile(heartbeatPath);
      if (!parseObservedHeartbeat(heartbeatFile, owner)) continue;
    } catch (error) {
      if (error?.code !== 'ENOENT') continue;
    }
    if (heartbeatFile && !ownerHelper) continue;

    if (heartbeatFile) {
      if (!canonicalPathIsAbsent(boundPaths.canonicalPath)) return;
      try {
        unlinkObservedFile(heartbeatFile);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    if (ownerHelper) {
      if (!canonicalPathIsAbsent(boundPaths.canonicalPath)) return;
      try {
        unlinkObservedFile(ownerHelper);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    if (!canonicalPathIsAbsent(boundPaths.canonicalPath)) return;
    try {
      unlinkObservedFile(q);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    fsyncParentDirectory(boundPaths.canonicalPath);
  }
}

function tryReclaimStaleOwner(boundPaths) {
  let observed;
  try {
    observed = observeStaleOwnerCandidate(boundPaths);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
  if (!observed) return false;

  let qLinkedByThisAttempt = false;
  try {
    reclaimTestFault(boundPaths, 'before-q-link', observed);
    fs.linkSync(boundPaths.canonicalPath, observed.qPath);
    qLinkedByThisAttempt = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    try {
      const q = readObservedRegularFile(observed.qPath);
      const qOwner = sameObservedFile(q, observed.canonical)
        ? parseObservedOwner(q)
        : null;
      if (qOwner
        && qOwner.schema === OWNER_LOCK_SCHEMA
        && qOwner.token === observed.owner.token) {
        throw existingReclaimAnchorError(observed, qOwner);
      }
    } catch (qError) {
      if (qError?.leaseStateFailure === 'repair-required') throw qError;
    }
    return false;
  }

  let q;
  try {
    q = readObservedRegularFile(observed.qPath);
    if (!sameObservedFile(q, observed.canonical)) {
      if (qLinkedByThisAttempt) {
        try {
          reclaimTestFault(boundPaths, 'before-mismatched-q-cleanup', { ...observed, q });
          unlinkObservedFile(q);
        } catch {
          // Preserve an unverified or unremovable q anchor and fail closed.
        }
      }
      return false;
    }
    const qOwner = parseObservedOwner(q);
    if (!qOwner
      || qOwner.schema !== OWNER_LOCK_SCHEMA
      || qOwner.token !== observed.owner.token) return false;

    reclaimTestFault(boundPaths, 'after-q-link', observed);

    let confirmed;
    try {
      confirmed = observeStaleOwnerCandidate(boundPaths, observed.processState);
    } catch {
      if (qLinkedByThisAttempt) removeReclaimAnchorIfSame(observed.qPath, observed.canonical);
      return false;
    }
    if (!confirmed
      || confirmed.owner.token !== observed.owner.token
      || !sameObservedFile(confirmed.canonical, observed.canonical)
      || !sameOptionalObservedFile(confirmed.heartbeatFile, observed.heartbeatFile)
      || !sameObservedFile(confirmed.ownerHelper, observed.ownerHelper)) {
      if (qLinkedByThisAttempt) removeReclaimAnchorIfSame(observed.qPath, observed.canonical);
      return false;
    }

    const canonicalImmediatelyBeforeUnlink = verifyObservedFile(confirmed.canonical);
    const qImmediatelyBeforeUnlink = verifyObservedFile(q);
    if (!sameObservedFile(canonicalImmediatelyBeforeUnlink, qImmediatelyBeforeUnlink)) return false;
    reclaimTestFault(boundPaths, 'before-canonical-unlink', confirmed);
    fs.unlinkSync(boundPaths.canonicalPath);
    fsyncParentDirectory(boundPaths.canonicalPath);
    reclaimTestFault(boundPaths, 'after-post-unlink-fsync', confirmed);
    reclaimTestFault(boundPaths, 'after-canonical-unlink', confirmed);

    reclaimTestFault(boundPaths, 'before-heartbeat-unlink', confirmed);
    if (confirmed.heartbeatFile) unlinkObservedFile(confirmed.heartbeatFile);
    reclaimTestFault(boundPaths, 'after-heartbeat-cleanup', confirmed);
    reclaimTestFault(boundPaths, 'before-owner-unlink', confirmed);
    unlinkObservedFile(confirmed.ownerHelper);
    reclaimTestFault(boundPaths, 'before-q-unlink', confirmed);
    unlinkObservedFile(qImmediatelyBeforeUnlink);
    fsyncParentDirectory(boundPaths.canonicalPath);
    return true;
  } catch (error) {
    if (qLinkedByThisAttempt && fs.existsSync(boundPaths.canonicalPath)) {
      removeReclaimAnchorIfSame(observed.qPath, observed.canonical);
    }
    throw error;
  }
}

function acquireLeaseStateLock(root, owner) {
  if (!isValidOwner(owner)) {
    throw new Error('lease state lock owner must be a non-empty trimmed string without control characters and at most 256 characters');
  }
  const boundPaths = canonicalLeaseStatePaths(root);
  const { canonicalPath } = boundPaths;
  const directory = boundPaths.transactionDirectoryPath;
  fs.mkdirSync(directory, { recursive: true });
  const transactionDirectory = bindLeaseStateTransactionDirectory(boundPaths);
  recoverDetachedReclaimAnchors(boundPaths);
  const preReclaimAttempted = !canonicalPathIsAbsent(canonicalPath);
  if (preReclaimAttempted) {
    tryReclaimStaleOwner(boundPaths);
  }

  const token = randomBytes(32).toString('hex');
  const processStartIdentity = readSelfProcessStartIdentity();
  const createdAtMs = Date.now();
  const createdAt = new Date(createdAtMs).toISOString();
  const metadata = {
    schema: OWNER_LOCK_SCHEMA,
    token,
    owner,
    pid: process.pid,
    processStartIdentity,
    createdAt,
    initialHeartbeat: {
      schema: HEARTBEAT_SCHEMA,
      token,
      pid: process.pid,
      processStartIdentity,
      sequence: 0,
      heartbeatAtMs: createdAtMs,
    },
  };
  const metadataBytes = Buffer.from(JSON.stringify(metadata), 'utf8');
  const metadataDigest = createHash('sha256').update(metadataBytes).digest('hex');
  const ownerPath = path.join(
    directory,
    `${path.basename(canonicalPath)}.owner.${process.pid}.${token}`,
  );
  let ownerFd;
  let ownerCreated = false;
  let provisionalIdentity;
  let state;

  try {
    ownerFd = fs.openSync(ownerPath, 'wx', 0o600);
    ownerCreated = true;
    provisionalIdentity = stableRegularFileIdentity(
      fs.fstatSync(ownerFd, { bigint: true }),
      ownerPath,
    );
    runProvisionalHelperTestFault(boundPaths.rootPath, ownerPath);
    fs.writeFileSync(ownerFd, metadataBytes);
    fs.fsyncSync(ownerFd);
    fs.closeSync(ownerFd);
    ownerFd = undefined;

    const identity = readStableFileIdentity(ownerPath);
    if (!sameFileIdentity(identity, provisionalIdentity)) {
      throw new Error(`owner helper ownership changed before publication: ${ownerPath}`);
    }
    state = {
      status: 'held',
      rootPath: boundPaths.rootPath,
      transactionDirectoryPath: transactionDirectory.path,
      transactionDirectoryRealPath: transactionDirectory.realPath,
      transactionDirectoryIdentity: transactionDirectory.identity,
      registryPath: boundPaths.registryPath,
      canonicalPath,
      ownerPath,
      heartbeatPath: `${canonicalPath}.heartbeat.${token}`,
      token,
      processStartIdentity,
      metadataBytes,
      metadataDigest,
      identity,
      heartbeatSequence: 0,
      heartbeatUpdatedAtMs: createdAtMs,
    };

    try {
      fs.linkSync(ownerPath, canonicalPath);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        let reclaimed = false;
        if (!preReclaimAttempted) {
          try {
            reclaimed = tryReclaimStaleOwner(boundPaths);
          } catch (reclaimError) {
            throw new Error(`lease state stale reclaim failed: ${canonicalPath}`, { cause: reclaimError });
          }
        }
        if (reclaimed) {
          try {
            fs.linkSync(ownerPath, canonicalPath);
          } catch (retryError) {
            if (retryError?.code === 'EEXIST') {
              throw new Error(`lease state is locked: ${canonicalPath}`, { cause: retryError });
            }
            throw retryError;
          }
        } else {
          throw new Error(`lease state is locked: ${canonicalPath}`, { cause: error });
        }
      }
      if (error?.code !== 'EEXIST') throw error;
    }

    const canonicalIdentity = readStableFileIdentity(canonicalPath);
    if (!sameFileIdentity(identity, canonicalIdentity)) {
      throw new Error(`owner/canonical file identity mismatch: ${canonicalPath}`);
    }
    const canonicalBytes = fs.readFileSync(canonicalPath);
    if (!canonicalBytes.equals(metadataBytes)) {
      throw new Error(`owner/canonical metadata mismatch: ${canonicalPath}`);
    }

    startOwnerHeartbeat(state);

    const ownerRef = Object.freeze(Object.create(null));
    ownerLockStates.set(ownerRef, state);
    return ownerRef;
  } catch (error) {
    let cleanupError;
    if (ownerFd !== undefined) {
      try {
        fs.closeSync(ownerFd);
      } catch (closeError) {
        cleanupError = closeError;
      }
    }
    if (state) {
      stopOwnerHeartbeat(state);
      try {
        removeHeartbeatIfStillOurs(state);
      } catch (heartbeatCleanupError) {
        cleanupError ||= heartbeatCleanupError;
      }
      removePublishedOwnerLinkIfStillOurs(state);
    }
    if (state || ownerCreated) {
      try {
        if (state) {
          removeOwnerHelperIfStillOurs(state);
        } else if (provisionalIdentity) {
          removeOwnerHelperIfStillOurs({ ownerPath, identity: provisionalIdentity });
        } else {
          fs.unlinkSync(ownerPath);
        }
      } catch (ownerCleanupError) {
        cleanupError ||= ownerCleanupError;
      }
    }
    attachSecondaryError(error, cleanupError);
    throw error;
  }
}

function requireOwnerLockState(ownerRef) {
  const state = ownerLockStates.get(ownerRef);
  if (!state) {
    throw new Error('invalid lease state lock OwnerRef');
  }
  return state;
}

function verifyCanonicalOwnerState(state) {
  verifyLeaseStateTransactionDirectory(state);
  const identityBeforeRead = readStableFileIdentity(state.canonicalPath);
  if (!sameFileIdentity(identityBeforeRead, state.identity)) {
    throw leaseStateProtocolError(
      `lease state lock ownership changed before release: ${state.canonicalPath}`,
      'ownership-changed',
    );
  }
  const canonicalBytes = fs.readFileSync(state.canonicalPath);
  const identityAfterRead = readStableFileIdentity(state.canonicalPath);
  if (!sameFileIdentity(identityAfterRead, state.identity)) {
    throw leaseStateProtocolError(
      `lease state lock ownership changed before release: ${state.canonicalPath}`,
      'ownership-changed',
    );
  }
  const canonicalDigest = createHash('sha256').update(canonicalBytes).digest('hex');
  let canonicalMetadata;
  try {
    canonicalMetadata = JSON.parse(canonicalBytes.toString('utf8'));
  } catch {
    throw leaseStateProtocolError(
      `lease state lock metadata changed before release: ${state.canonicalPath}`,
      'metadata-changed',
    );
  }
  if (!canonicalBytes.equals(state.metadataBytes)
    || canonicalDigest !== state.metadataDigest
    || canonicalMetadata?.token !== state.token) {
    throw leaseStateProtocolError(
      `lease state lock metadata changed before release: ${state.canonicalPath}`,
      'metadata-changed',
    );
  }
}

function verifyOwnerPublicationState(state) {
  verifyCanonicalOwnerState(state);
  verifyOwnerHelperState(state);
  verifyHeartbeatState(state);
}

function prepareHeartbeatForCommit(state) {
  if (state.heartbeatIdentity) {
    verifyHeartbeatState(state);
    return;
  }
  writeOwnerHeartbeat(state);
}

function assertLeaseStateLock(ownerRef) {
  const state = requireOwnerLockState(ownerRef);
  if (state.status !== 'held') {
    throw new Error(`lease state lock OwnerRef is already ${state.status}`);
  }
  if (state.heartbeatError) throw state.heartbeatError;
  verifyCanonicalOwnerState(state);
}

function assertLeaseStateRootBinding(ownerRef, root) {
  const state = requireOwnerLockState(ownerRef);
  if (state.status !== 'held') {
    throw new Error(`lease state lock OwnerRef is already ${state.status}`);
  }
  if (state.heartbeatError) throw state.heartbeatError;
  const candidatePaths = canonicalLeaseStatePaths(root);
  if (candidatePaths.rootPath !== state.rootPath
    || candidatePaths.transactionDirectoryPath !== state.transactionDirectoryPath
    || candidatePaths.registryPath !== state.registryPath
    || candidatePaths.canonicalPath !== state.canonicalPath) {
    throw new Error(`lease state lock OwnerRef root does not match transaction root: ${candidatePaths.rootPath}`);
  }
  verifyLeaseStateTransactionDirectory(state);
  return state;
}

function assertLeaseStateLockRoot(ownerRef, root) {
  const state = assertLeaseStateRootBinding(ownerRef, root);
  verifyCanonicalOwnerState(state);
  return state;
}

function releaseLeaseStateLock(ownerRef) {
  const state = requireOwnerLockState(ownerRef);
  if (state.status !== 'held' && state.status !== 'retryable') {
    throw new Error(`lease state lock OwnerRef is already ${state.status}`);
  }

  state.status = 'releasing';
  const heartbeatError = stopOwnerHeartbeat(state);
  let primaryError;
  let canonicalDisposition;
  try {
    verifyCanonicalOwnerState(state);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      canonicalDisposition = 'absent';
    } else if (error?.leaseStateFailure === 'ownership-changed') {
      primaryError = error;
      canonicalDisposition = 'successor';
    } else {
      state.status = error?.leaseStateFailure === 'metadata-changed'
        || error?.leaseStateFailure === 'non-regular-file'
        ? 'repair-required'
        : 'retryable';
      if (state.status === 'retryable') {
        restoreOwnerHeartbeatAfterRetryableReleaseFailure(state, error, heartbeatError);
      } else {
        attachSecondaryError(error, heartbeatError, 'heartbeatError');
      }
      throw error;
    }
  }

  if (!canonicalDisposition) {
    try {
      const releaseFault = process.env.NANOFLOW_LEASE_TEST_RELEASE_FAULT;
      if ((releaseFault === RELEASE_UNLINK_TEST_FAULT
          || releaseFault === RELEASE_UNLINK_THROW_TEST_FAULT)
        && state.testReleaseFaultInjected !== true) {
        strictLeaseTestContext(state.rootPath, OWNER_LOCK_TEST_PAUSE_POINT);
        state.testReleaseFaultInjected = true;
        if (releaseFault === RELEASE_UNLINK_THROW_TEST_FAULT) {
          const error = new Error('injected canonical unlink failure');
          error.code = 'EIO';
          throw error;
        }
        fs.unlinkSync(state.canonicalPath);
        fs.mkdirSync(state.canonicalPath);
      }
      const canonicalStat = fs.lstatSync(state.canonicalPath);
      if (!canonicalStat.isFile() || canonicalStat.isSymbolicLink()) {
        // Preserve fail-closed diagnostics for a non-regular replacement;
        // quarantine is only safe for the regular owner namespace.
        fs.unlinkSync(state.canonicalPath);
      }
      const quarantinePath = `${state.canonicalPath}.release.${state.token}`;
      let quarantined = false;
      try {
        fs.renameSync(state.canonicalPath, quarantinePath);
        quarantined = true;
      } catch (error) {
        if (error?.code === 'ENOENT') {
          canonicalDisposition = 'absent';
        } else {
          throw error;
        }
      }
      if (quarantined) {
        let quarantineIdentity;
        try {
          if (releaseFault === RELEASE_QUARANTINE_SUCCESSOR_TEST_FAULT
            && state.testReleaseFaultInjected !== true) {
            strictLeaseTestContext(state.rootPath, OWNER_LOCK_TEST_PAUSE_POINT);
            state.testReleaseFaultInjected = true;
            fs.unlinkSync(quarantinePath);
            fs.writeFileSync(
              quarantinePath,
              '{"schema":2,"token":"release-quarantine-successor"}',
              { flag: 'wx' },
            );
          }
          quarantineIdentity = readStableFileIdentity(quarantinePath);
          const quarantineBytes = fs.readFileSync(quarantinePath);
          if (!sameFileIdentity(quarantineIdentity, state.identity)
            || !quarantineBytes.equals(state.metadataBytes)) {
            // A successor was moved instead of our lock. Never delete it;
            // restore only when the canonical namespace is still absent.
            if (canonicalPathIsAbsent(state.canonicalPath)) {
              fs.renameSync(quarantinePath, state.canonicalPath);
            }
            throw leaseStateProtocolError(
              `lease state lock ownership changed during release: ${state.canonicalPath}`,
              'ownership-changed',
            );
          }
          if (releaseFault === RELEASE_QUARANTINE_UNLINK_THROW_TEST_FAULT
            && state.testReleaseFaultInjected !== true) {
            strictLeaseTestContext(state.rootPath, OWNER_LOCK_TEST_PAUSE_POINT);
            state.testReleaseFaultInjected = true;
            const error = new Error('injected release quarantine unlink failure');
            error.code = 'EIO';
            throw error;
          }
          fs.unlinkSync(quarantinePath);
          canonicalDisposition = 'deleted';
        } catch (error) {
          if (error?.leaseStateFailure === 'ownership-changed') throw error;
          if (error?.code === 'ENOENT') {
            canonicalDisposition = 'absent';
          } else {
            try {
              if (canonicalPathIsAbsent(state.canonicalPath)
                && fs.existsSync(quarantinePath)) {
                fs.renameSync(quarantinePath, state.canonicalPath);
              }
            } catch (restoreError) {
              attachSecondaryError(error, restoreError, 'restoreError');
            }
            throw error;
          }
        }
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        canonicalDisposition = 'absent';
      } else {
        state.status = 'retryable';
        restoreOwnerHeartbeatAfterRetryableReleaseFailure(state, error, heartbeatError);
        throw error;
      }
    }
  }

  let cleanupError;
  try {
    removeHeartbeatIfStillOurs(state);
  } catch (error) {
    cleanupError = error;
  }
  try {
    removeOwnerHelperIfStillOurs(state);
  } catch (error) {
    if (cleanupError) attachSecondaryError(cleanupError, error);
    else cleanupError = error;
  }

  if (cleanupError) {
    state.status = cleanupError?.leaseStateFailure === 'owner-helper-changed'
      || cleanupError?.leaseStateFailure === 'non-regular-file'
      ? 'repair-required'
      : 'retryable';
  } else {
    state.status = 'released';
  }

  if (primaryError) {
    attachSecondaryError(primaryError, heartbeatError, 'heartbeatError');
    attachSecondaryError(primaryError, cleanupError);
    throw primaryError;
  }
  if (heartbeatError) {
    attachSecondaryError(heartbeatError, cleanupError);
    throw heartbeatError;
  }
  if (cleanupError) throw cleanupError;
}

async function withLeaseStateLock(root, owner, callback) {
  const ownerRef = acquireLeaseStateLock(root, owner);
  let callbackResult;
  let callbackError;
  let callbackFailed = false;
  try {
    callbackResult = await callback(ownerRef);
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  }

  let releaseError;
  try {
    releaseLeaseStateLock(ownerRef);
  } catch (error) {
    releaseError = error;
  }

  if (callbackFailed) {
    if (releaseError && callbackError instanceof Error) {
      try {
        if (callbackError.cause === undefined) {
          Object.defineProperty(callbackError, 'cause', {
            configurable: true,
            value: releaseError,
          });
        } else if (callbackError.releaseError === undefined) {
          Object.defineProperty(callbackError, 'releaseError', {
            configurable: true,
            value: releaseError,
          });
        }
      } catch {
        // A frozen primary error still wins; release failure remains secondary.
      }
    }
    throw callbackError;
  }
  if (releaseError) throw releaseError;
  return callbackResult;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, property) {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function createLeaseDictionary(entries = []) {
  const leases = Object.create(null);
  for (const [file, lease] of entries) {
    Object.defineProperty(leases, file, {
      configurable: true,
      enumerable: true,
      value: lease,
      writable: true,
    });
  }
  return leases;
}

function validateLeaseRecord(file, lease) {
  if (!isPlainObject(lease)) {
    throw new Error(`lease registry entry must be a plain object: ${file}`);
  }
  for (const field of ['owner', 'claimedAt', 'expiresAt', 'expiresAtMs']) {
    if (!hasOwn(lease, field)) {
      throw new Error(`lease registry entry is missing ${field}: ${file}`);
    }
  }
  if (!isValidOwner(lease.owner)) {
    throw new Error(`lease registry entry owner must be a non-empty string: ${file}`);
  }
  if (typeof lease.claimedAt !== 'string' || !Number.isFinite(Date.parse(lease.claimedAt))) {
    throw new Error(`lease registry entry claimedAt must be a parseable date string: ${file}`);
  }
  const parsedExpiresAtMs = typeof lease.expiresAt === 'string'
    ? Date.parse(lease.expiresAt)
    : Number.NaN;
  if (!Number.isFinite(parsedExpiresAtMs)) {
    throw new Error(`lease registry entry expiresAt must be a parseable date string: ${file}`);
  }
  if (!Number.isFinite(lease.expiresAtMs)) {
    throw new Error(`lease registry entry expiresAtMs must be a finite number: ${file}`);
  }
  if (parsedExpiresAtMs !== lease.expiresAtMs) {
    throw new Error(`lease registry entry expiresAt and expiresAtMs must match: ${file}`);
  }
}

function isValidOwner(owner) {
  return typeof owner === 'string'
    && owner.length > 0
    && owner.length <= OWNER_MAX_LENGTH
    && owner === owner.trim()
    && !/[\u0000-\u001f\u007f]/u.test(owner);
}

function assertKnownFields(value, allowedFields, label) {
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      throw new Error(`${label} contains an unsupported field`);
    }
  }
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a canonical timestamp string`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical timestamp string`);
  }
  return parsed;
}

function validateResourceId(value, label) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > RESOURCE_ID_MAX_LENGTH
    || value === '.'
    || value === '..'
    || /[\u0000-\u001f\u007f/\\]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function validateResourceLeaseRecord(dictionaryKey, lease) {
  if (!isPlainObject(lease)) {
    throw new Error(`lease registry resource lease must be a plain object: ${dictionaryKey}`);
  }
  assertKnownFields(lease, RESOURCE_LEASE_FIELDS, 'lease registry resource lease');
  for (const field of RESOURCE_LEASE_REQUIRED_FIELDS) {
    if (!hasOwn(lease, field)) {
      throw new Error(`lease registry resource lease is missing ${field}: ${dictionaryKey}`);
    }
  }
  if (!RESOURCE_LEASE_KINDS.has(lease.kind)) {
    throw new Error('lease registry resource lease kind must be read or build');
  }
  validateResourceId(lease.resourceId, 'lease registry resource lease resourceId');
  if (!isValidOwner(lease.owner)) {
    throw new Error('lease registry resource lease owner must be a non-empty string');
  }
  if (typeof lease.tokenHash !== 'string'
    || !BARRIER_TOKEN_HASH_PATTERN.test(lease.tokenHash)
    || dictionaryKey !== lease.tokenHash) {
    throw new Error('lease registry resource lease token hash is invalid');
  }
  if (typeof lease.tokenFingerprint !== 'string'
    || !BARRIER_TOKEN_FINGERPRINT_PATTERN.test(lease.tokenFingerprint)
    || lease.tokenFingerprint !== lease.tokenHash.slice(0, 12)) {
    throw new Error('lease registry resource lease token fingerprint is invalid');
  }
  if (lease.kind === 'read') {
    for (const field of RESOURCE_LEASE_BARRIER_BINDING_FIELDS) {
      if (hasOwn(lease, field) && lease[field] !== null) {
        throw new Error(`lease registry READ resource lease ${field} must be null`);
      }
    }
  } else {
    for (const field of RESOURCE_LEASE_BARRIER_BINDING_FIELDS) {
      if (!hasOwn(lease, field)) {
        throw new Error(`lease registry BUILD resource lease is missing ${field}`);
      }
    }
    if (typeof lease.barrierOwner !== 'string'
      || lease.barrierOwner.length === 0
      || lease.barrierOwner !== lease.owner) {
      throw new Error('lease registry BUILD resource lease barrierOwner is invalid');
    }
    if (typeof lease.barrierTokenFingerprint !== 'string'
      || !BARRIER_TOKEN_FINGERPRINT_PATTERN.test(lease.barrierTokenFingerprint)
      || lease.barrierTokenFingerprint !== lease.tokenFingerprint) {
      throw new Error('lease registry BUILD resource lease barrierTokenFingerprint is invalid');
    }
    if (!Number.isSafeInteger(lease.fence) || lease.fence < 1) {
      throw new Error('lease registry BUILD resource lease fence must be a positive safe integer');
    }
    if (!Number.isSafeInteger(lease.heldEpoch) || lease.heldEpoch < 0) {
      throw new Error('lease registry BUILD resource lease heldEpoch must be a nonnegative safe integer');
    }
  }
  if (!RESOURCE_LEASE_STATES.has(lease.state)) {
    throw new Error('lease registry resource lease state is invalid');
  }
  const acquiredAtMs = canonicalTimestamp(
    lease.acquiredAt,
    'lease registry resource lease acquiredAt',
  );
  const heartbeatAtMs = canonicalTimestamp(
    lease.heartbeatAt,
    'lease registry resource lease heartbeatAt',
  );
  if (heartbeatAtMs < acquiredAtMs) {
    throw new Error('lease registry resource lease heartbeatAt must not precede acquiredAt');
  }
  if (!Number.isSafeInteger(lease.heartbeatSequence)
    || lease.heartbeatSequence < 1) {
    throw new Error('lease registry resource lease heartbeatSequence must be a positive safe integer');
  }
  const expiresAtMs = canonicalTimestamp(
    lease.expiresAt,
    'lease registry resource lease expiresAt',
  );
  if (!Number.isSafeInteger(lease.expiresAtMs)
    || lease.expiresAtMs !== expiresAtMs
    || expiresAtMs <= heartbeatAtMs) {
    throw new Error('lease registry resource lease expiry is invalid');
  }
  if (lease.state === 'ACTIVE') {
    if (lease.releasedAt !== null) {
      throw new Error('lease registry ACTIVE resource lease releasedAt must be null');
    }
    return lease;
  }
  const releasedAtMs = canonicalTimestamp(
    lease.releasedAt,
    'lease registry resource lease releasedAt',
  );
  if (releasedAtMs < heartbeatAtMs) {
    throw new Error('lease registry RELEASED resource lease releasedAt must not precede heartbeatAt');
  }
  return lease;
}

function validateBarrierTransitions(barrier) {
  if (!Array.isArray(barrier.transitions)) {
    throw new Error('lease registry barrier transitions must be an array');
  }
  const states = [];
  let previousAtMs = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < barrier.transitions.length; index += 1) {
    const transition = barrier.transitions[index];
    if (!isPlainObject(transition)) {
      throw new Error('lease registry barrier transition must be a plain object');
    }
    assertKnownFields(transition, BARRIER_TRANSITION_FIELDS, 'lease registry barrier transition');
    for (const field of BARRIER_TRANSITION_FIELDS) {
      if (!hasOwn(transition, field)) {
        throw new Error(`lease registry barrier transition is missing ${field}`);
      }
    }
    if (!BARRIER_STATES.has(transition.state) || transition.state === 'OPEN') {
      throw new Error('lease registry barrier transition state is invalid');
    }
    if (!Number.isSafeInteger(transition.sequence)
      || transition.sequence !== index + 1) {
      throw new Error('lease registry barrier transition sequence must be consecutive safe integers');
    }
    const atMs = canonicalTimestamp(transition.at, 'lease registry barrier transition at');
    if (atMs < previousAtMs) {
      throw new Error('lease registry barrier transition timestamps must be monotonic');
    }
    previousAtMs = atMs;
    states.push(transition.state);
  }

  const transitionPath = states.join('>');
  const validPath = barrier.state === 'OPEN'
    ? transitionPath === ''
    : barrier.state === 'CLOSING'
      ? transitionPath === 'CLOSING'
      : barrier.state === 'WAITING'
        ? transitionPath === 'CLOSING>WAITING'
        : barrier.state === 'HELD'
          ? transitionPath === 'CLOSING>WAITING>HELD'
          : new Set([
            'CLOSING>RELEASED',
            'CLOSING>WAITING>RELEASED',
            'CLOSING>WAITING>HELD>RELEASED',
          ]).has(transitionPath);
  if (!validPath) {
    throw new Error('lease registry barrier transition path is invalid');
  }
}

function validateBarrier(barrier, workspaceEpoch, fencingCounter, leases) {
  if (!isPlainObject(barrier)) {
    throw new Error('lease registry barrier must be a plain object');
  }
  assertKnownFields(barrier, BARRIER_FIELDS, 'lease registry barrier');
  for (const field of BARRIER_FIELDS) {
    if (!hasOwn(barrier, field)) {
      throw new Error(`lease registry barrier is missing ${field}`);
    }
  }
  if (!BARRIER_STATES.has(barrier.state)) {
    throw new Error('lease registry barrier state is invalid');
  }
  validateBarrierTransitions(barrier);

  if (barrier.state === 'OPEN') {
    if (barrier.owner !== null
      || barrier.tokenHash !== null
      || barrier.tokenFingerprint !== null
      || barrier.acquiredAt !== null
      || barrier.heartbeatAt !== null
      || barrier.heartbeatSequence !== 0
      || barrier.heldEpoch !== null
      || barrier.fence !== null
      || barrier.releasedAt !== null) {
      throw new Error('lease registry OPEN barrier fields must be empty');
    }
    return barrier;
  }

  if (!isValidOwner(barrier.owner)) {
    throw new Error('lease registry barrier owner must be a non-empty string');
  }
  if (typeof barrier.tokenHash !== 'string'
    || !BARRIER_TOKEN_HASH_PATTERN.test(barrier.tokenHash)) {
    throw new Error('lease registry barrier token hash is invalid');
  }
  if (typeof barrier.tokenFingerprint !== 'string'
    || !BARRIER_TOKEN_FINGERPRINT_PATTERN.test(barrier.tokenFingerprint)
    || barrier.tokenFingerprint !== barrier.tokenHash.slice(0, 12)) {
    throw new Error('lease registry barrier token fingerprint is invalid');
  }
  const acquiredAtMs = canonicalTimestamp(
    barrier.acquiredAt,
    'lease registry barrier acquiredAt',
  );
  const heartbeatAtMs = canonicalTimestamp(
    barrier.heartbeatAt,
    'lease registry barrier heartbeatAt',
  );
  if (heartbeatAtMs < acquiredAtMs) {
    throw new Error('lease registry barrier heartbeatAt must not precede acquiredAt');
  }
  if (!Number.isSafeInteger(barrier.heartbeatSequence)
    || barrier.heartbeatSequence < 1) {
    throw new Error('lease registry barrier heartbeatSequence must be a positive safe integer');
  }
  if (barrier.transitions[0].at !== barrier.acquiredAt) {
    throw new Error('lease registry barrier acquiredAt must match its first transition');
  }

  if (barrier.state === 'CLOSING' || barrier.state === 'WAITING') {
    if (barrier.heldEpoch !== null || barrier.fence !== null || barrier.releasedAt !== null) {
      throw new Error('lease registry non-held barrier cannot carry held or released fields');
    }
    return barrier;
  }

  if (barrier.state === 'HELD') {
    if (!Number.isSafeInteger(barrier.heldEpoch)
      || barrier.heldEpoch < 0
      || barrier.heldEpoch !== workspaceEpoch) {
      throw new Error('lease registry HELD barrier heldEpoch must equal workspaceEpoch');
    }
    if (!Number.isSafeInteger(barrier.fence)
      || barrier.fence < 1
      || barrier.fence !== fencingCounter) {
      throw new Error('lease registry HELD barrier fence must equal the fencing counter');
    }
    if (barrier.releasedAt !== null) {
      throw new Error('lease registry HELD barrier releasedAt must be null');
    }
    const hasActiveWriteLease = Object.values(leases)
      .some(lease => lease.expiresAtMs > Date.now());
    if (hasActiveWriteLease) {
      throw new Error('lease registry HELD barrier cannot coexist with active write leases');
    }
    return barrier;
  }

  const passedThroughHeld = barrier.transitions.some(transition => transition.state === 'HELD');
  const heldFieldsAreNull = barrier.heldEpoch === null && barrier.fence === null;
  const heldFieldsAreValid = Number.isSafeInteger(barrier.heldEpoch)
    && barrier.heldEpoch >= 0
    && barrier.heldEpoch <= workspaceEpoch
    && Number.isSafeInteger(barrier.fence)
    && barrier.fence >= 1
    && barrier.fence === fencingCounter;
  if ((passedThroughHeld && !heldFieldsAreValid)
    || (!passedThroughHeld && !heldFieldsAreNull)) {
    throw new Error('lease registry RELEASED barrier held fields must match its transition history');
  }
  const releasedAtMs = canonicalTimestamp(
    barrier.releasedAt,
    'lease registry barrier releasedAt',
  );
  if (releasedAtMs < heartbeatAtMs
    || barrier.transitions.at(-1).at !== barrier.releasedAt) {
    throw new Error('lease registry barrier releasedAt must finish its transition history');
  }
  return barrier;
}

function validateLeaseRegistry(parsed) {
  if (!isPlainObject(parsed)) {
    throw new Error('lease registry must be a plain object');
  }
  assertKnownFields(parsed, LEASE_REGISTRY_FIELDS, 'lease registry top-level');
  if (hasOwn(parsed, 'version') && parsed.version !== 1) {
    throw new Error('lease registry version must be 1 when present');
  }
  const workspaceEpoch = hasOwn(parsed, 'workspaceEpoch') ? parsed.workspaceEpoch : 0;
  if (!Number.isSafeInteger(workspaceEpoch) || workspaceEpoch < 0) {
    throw new Error('lease registry workspaceEpoch must be a nonnegative safe integer when present');
  }
  const fencingCounter = hasOwn(parsed, 'fencingCounter') ? parsed.fencingCounter : 0;
  if (!Number.isSafeInteger(fencingCounter) || fencingCounter < 0) {
    throw new Error('lease registry fencingCounter must be a nonnegative safe integer when present');
  }
  if (!isPlainObject(parsed.leases)) {
    throw new Error('lease registry leases must be a plain object');
  }
  const leases = createLeaseDictionary();
  for (const [file, lease] of Object.entries(parsed.leases)) {
    validateLeaseRecord(file, lease);
    Object.defineProperty(leases, file, {
      configurable: true,
      enumerable: true,
      value: lease,
      writable: true,
    });
  }
  let resourceLeases;
  if (hasOwn(parsed, 'resourceLeases')) {
    if (!isPlainObject(parsed.resourceLeases)) {
      throw new Error('lease registry resourceLeases must be a plain object');
    }
    resourceLeases = createLeaseDictionary();
    for (const [tokenHash, resourceLease] of Object.entries(parsed.resourceLeases)) {
      validateResourceLeaseRecord(tokenHash, resourceLease);
      Object.defineProperty(resourceLeases, tokenHash, {
        configurable: true,
        enumerable: true,
        value: resourceLease,
        writable: true,
      });
    }
  }
  const normalized = {
    version: 1,
    workspaceEpoch,
    leases,
  };
  if (resourceLeases) normalized.resourceLeases = resourceLeases;
  if (hasOwn(parsed, 'fencingCounter')) normalized.fencingCounter = fencingCounter;
  if (hasOwn(parsed, 'barrier')) {
    normalized.barrier = validateBarrier(
      parsed.barrier,
      workspaceEpoch,
      fencingCounter,
      leases,
    );
  }
  return normalized;
}

function readLeaseState(root, ownerRef) {
  const ownerState = assertLeaseStateLockRoot(ownerRef, root);
  const filePath = ownerState.registryPath;
  const snapshot = readLeaseRegistrySnapshot(filePath);
  if (snapshot.kind === 'missing') {
    assertLeaseStateLockRoot(ownerRef, root);
    return {
      state: { version: 1, workspaceEpoch: 0, leases: createLeaseDictionary() },
      registryObservation: { kind: 'missing' },
    };
  }
  assertLeaseStateLockRoot(ownerRef, root);
  const parsed = JSON.parse(snapshot.bytes.toString('utf8'));
  return {
    state: validateLeaseRegistry(parsed),
    registryObservation: {
      kind: 'present',
      identity: snapshot.identity,
      digest: snapshot.digest,
    },
  };
}

function registryChangedWhileReadingError(filePath, cause) {
  const error = leaseStateProtocolError(
    `lease registry ownership changed while reading: ${filePath}`,
    cause?.leaseStateFailure || 'registry-ownership-changed',
  );
  if (cause) {
    Object.defineProperty(error, 'cause', {
      configurable: true,
      value: cause,
    });
  }
  return error;
}

function readLeaseRegistrySnapshot(filePath) {
  let pathIdentityBeforeOpen;
  try {
    pathIdentityBeforeOpen = readStableFileIdentity(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const fdIdentityBeforeRead = stableRegularFileIdentity(
      fs.fstatSync(fd, { bigint: true }),
      filePath,
    );
    if (!sameFileIdentity(pathIdentityBeforeOpen, fdIdentityBeforeRead)) {
      throw registryChangedWhileReadingError(filePath);
    }

    const bytes = fs.readFileSync(fd);
    const fdIdentityAfterRead = stableRegularFileIdentity(
      fs.fstatSync(fd, { bigint: true }),
      filePath,
    );
    if (!sameFileIdentity(fdIdentityBeforeRead, fdIdentityAfterRead)) {
      throw registryChangedWhileReadingError(filePath);
    }

    let pathIdentityAfterRead;
    try {
      pathIdentityAfterRead = readStableFileIdentity(filePath);
    } catch (error) {
      throw registryChangedWhileReadingError(filePath, error);
    }
    if (!sameFileIdentity(fdIdentityAfterRead, pathIdentityAfterRead)) {
      throw registryChangedWhileReadingError(filePath);
    }

    return {
      kind: 'present',
      bytes,
      identity: pathIdentityAfterRead,
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncParentDirectory(filePath) {
  if (process.platform === 'win32') return;
  const directoryFd = fs.openSync(path.dirname(filePath), 'r');
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

function runCommitPreRenameTestFault(root, ownerState) {
  if (process.env.NANOFLOW_LEASE_TEST_PAUSE_POINT !== COMMIT_PRE_RENAME_TEST_PAUSE_POINT) {
    return;
  }

  const { runId } = strictLeaseTestContext(root, COMMIT_PRE_RENAME_TEST_PAUSE_POINT);
  const crashMode = process.env.NANOFLOW_LEASE_TEST_COMMIT_CRASH_MODE;
  if (crashMode !== undefined && crashMode !== '' && crashMode !== 'pause-before-rename') {
    throw new Error(`unsupported commit crash test mode: ${crashMode}`);
  }
  const checkpoint = {
    type: 'NANOFLOW_LEASE_TEST_CHECKPOINT',
    runId,
    pausePoint: COMMIT_PRE_RENAME_TEST_PAUSE_POINT,
  };
  if (crashMode === 'pause-before-rename') {
    process.send(checkpoint);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error('commit crash test pause resumed unexpectedly');
  }

  fs.unlinkSync(ownerState.canonicalPath);
  fs.writeFileSync(
    ownerState.canonicalPath,
    Buffer.from('{"schema":2,"token":"pre-rename-successor"}', 'utf8'),
    { flag: 'wx' },
  );
  process.send(checkpoint);
}

function registryObservationChangedError(filePath, cause) {
  const error = leaseStateProtocolError(
    `lease registry namespace changed after read: ${filePath}`,
    cause?.leaseStateFailure || 'registry-ownership-changed',
  );
  if (cause) {
    Object.defineProperty(error, 'cause', {
      configurable: true,
      value: cause,
    });
  }
  return error;
}

function assertRegistryObservationCurrent(filePath, observation) {
  let current;
  try {
    current = readLeaseRegistrySnapshot(filePath);
  } catch (error) {
    throw registryObservationChangedError(filePath, error);
  }

  if (observation.kind === 'missing') {
    if (current.kind === 'missing') return;
    throw registryObservationChangedError(filePath);
  }
  if (current.kind !== 'present'
    || !sameFileIdentity(observation.identity, current.identity)
    || observation.digest !== current.digest) {
    throw registryObservationChangedError(filePath);
  }
}

function commitLeaseState(root, state, registryObservation, ownerRef) {
  const ownerState = assertLeaseStateLockRoot(ownerRef, root);
  verifyOwnerHelperState(ownerState);
  const filePath = ownerState.registryPath;
  const directory = path.dirname(filePath);
  const payload = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
  assertLeaseStateLockRoot(ownerRef, root);

  const tempPath = path.join(
    directory,
    `${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let renamed = false;
  try {
    const tempFd = fs.openSync(tempPath, 'wx');
    let tempIdentity;
    try {
      tempIdentity = stableRegularFileIdentity(
        fs.fstatSync(tempFd, { bigint: true }),
        tempPath,
      );
      fs.writeFileSync(tempFd, payload);
      fs.fsyncSync(tempFd);
    } finally {
      fs.closeSync(tempFd);
    }

    const tempPathIdentity = readStableFileIdentity(tempPath);
    if (!sameFileIdentity(tempIdentity, tempPathIdentity)) {
      throw leaseStateProtocolError(
        `lease registry temp ownership changed before rename: ${tempPath}`,
        'temp-ownership-changed',
      );
    }

    assertLeaseStateRootBinding(ownerRef, root);
    runCommitPreRenameTestFault(root, ownerState);
    // Node has no inode-conditional rename/unlink. Protocol participants are
    // fail-closed at this ownership/content checkpoint; an external mutation
    // after the snapshot check remains a best-effort boundary.
    assertLeaseStateLockRoot(ownerRef, root);
    assertRegistryObservationCurrent(filePath, registryObservation);
    prepareHeartbeatForCommit(ownerState);
    verifyOwnerPublicationState(ownerState);
    fs.renameSync(tempPath, filePath);
    renamed = true;
    fsyncParentDirectory(filePath);

    const identityBeforeReadback = readStableFileIdentity(filePath);
    if (!sameFileIdentity(tempIdentity, identityBeforeReadback)) {
      throw leaseStateProtocolError(
        `lease registry ownership changed after rename: ${filePath}`,
        'registry-ownership-changed',
      );
    }
    const readback = fs.readFileSync(filePath);
    const identityAfterReadback = readStableFileIdentity(filePath);
    if (!sameFileIdentity(tempIdentity, identityAfterReadback)) {
      throw leaseStateProtocolError(
        `lease registry ownership changed during readback: ${filePath}`,
        'registry-ownership-changed',
      );
    }
    if (!readback.equals(payload)) {
      throw new Error('lease registry readback verification failed after rename');
    }
    assertLeaseStateLockRoot(ownerRef, root);
  } finally {
    if (!renamed) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Preserve the original commit failure; a unique temp file can be diagnosed separately.
      }
    }
  }
}

function transactionFenceSnapshot(state) {
  const barrier = state.barrier;
  return {
    workspaceEpoch: state.workspaceEpoch,
    fencingCounter: state.fencingCounter ?? 0,
    barrier: barrier
      ? {
          state: barrier.state,
          tokenHash: barrier.tokenHash,
          transitions: barrier.transitions.map(transition => ({
            state: transition.state,
            at: transition.at,
            sequence: transition.sequence,
          })),
        }
      : null,
  };
}

function sameBarrierTransition(left, right) {
  return left.state === right.state
    && left.at === right.at
    && left.sequence === right.sequence;
}

function assertTransactionFence(snapshot, candidate) {
  if (candidate.workspaceEpoch < snapshot.workspaceEpoch) {
    throw new Error('lease registry workspaceEpoch must not decrease within a transaction');
  }
  if ((candidate.fencingCounter ?? 0) < snapshot.fencingCounter) {
    throw new Error('lease registry fencingCounter must not decrease within a transaction');
  }
  if (!snapshot.barrier) return;
  if (!candidate.barrier) {
    throw new Error('lease registry barrier transition prefix must be immutable within a transaction');
  }

  const sameGeneration = snapshot.barrier.tokenHash === candidate.barrier.tokenHash;
  if (!sameGeneration) {
    if (snapshot.barrier.state !== 'RELEASED' || candidate.barrier.state === 'OPEN') {
      throw new Error('lease registry barrier generation cannot change before release');
    }
    return;
  }

  const candidateTransitions = candidate.barrier.transitions;
  if (candidateTransitions.length < snapshot.barrier.transitions.length
    || snapshot.barrier.transitions.some((transition, index) => (
      !sameBarrierTransition(transition, candidateTransitions[index])
    ))) {
    throw new Error('lease registry barrier transition prefix must be immutable within a transaction');
  }
}

async function withLeaseStateTransaction(root, callback, ownerRef) {
  const { state, registryObservation } = readLeaseState(root, ownerRef);
  const fenceSnapshot = transactionFenceSnapshot(state);
  const result = await callback(state);
  if (!isPlainObject(result)
    || typeof result.stateChanged !== 'boolean'
    || (result.stateChanged && (!isPlainObject(result.state) || result.state !== state))) {
    throw new Error('lease registry transaction candidate must be a plain object with boolean stateChanged and the callback state');
  }
  assertLeaseStateLockRoot(ownerRef, root);
  if (result.stateChanged) {
    const candidate = validateLeaseRegistry(result.state);
    assertTransactionFence(fenceSnapshot, candidate);
    commitLeaseState(root, candidate, registryObservation, ownerRef);
  }
  return result;
}

module.exports = {
  acquireLeaseStateLock,
  assertLeaseStateLock,
  leasePath,
  releaseLeaseStateLock,
  withLeaseStateLock,
  withLeaseStateTransaction,
};
