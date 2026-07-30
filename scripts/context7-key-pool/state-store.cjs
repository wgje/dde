'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');

const policy = require('./policy.cjs');

const ENVELOPE_KEYS = ['schemaVersion', 'revision', 'checksumSha256', 'payload'];
const OWNER_KEYS = ['ownerId', 'pid', 'claimedAt'];
const CHECKSUM = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_EVENT_STRING = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RETRYABLE_REPLACE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const PRIMARY_NAME = 'state.json';
const BACKUP_NAME = 'state.backup.json';
const LOCK_NAME = 'state.lock';
const GUARD_NAME = 'state.lock.guard';
const OWNER_NAME = 'owner.json';
const EVENT_NAME = 'events.jsonl';

class StateStoreFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'Context7StateStoreError';
    this.code = code;
  }
}

function fail(code) {
  throw new StateStoreFailure(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function canonicalTree(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('state-canonical-invalid');
    return value;
  }
  if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)) {
    fail('state-canonical-invalid');
  }
  if (typeof value !== 'object' || seen.has(value)) fail('state-canonical-invalid');
  seen.add(value);
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key === 'symbol')) fail('state-canonical-invalid');
    if (Array.isArray(value)) {
      const extraKeys = ownKeys.filter(key => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key));
      if (extraKeys.length > 0) fail('state-canonical-invalid');
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('state-canonical-invalid');
        result.push(canonicalTree(descriptor.value, seen));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('state-canonical-invalid');
    const result = {};
    for (const key of ownKeys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail('state-canonical-invalid');
      }
      result[key] = canonicalTree(descriptor.value, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value) {
  return JSON.stringify(canonicalTree(value));
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function checksumFor(schemaVersion, revision, payload) {
  return crypto.createHash('sha256')
    .update(canonicalJson({ schemaVersion, revision, payload }))
    .digest('hex');
}

function makeEnvelope(payload, revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) fail('state-revision-invalid');
  policy.validateStatePayload(payload);
  const schemaVersion = 1;
  return {
    schemaVersion,
    revision,
    checksumSha256: checksumFor(schemaVersion, revision, payload),
    payload: cloneJson(payload),
  };
}

function validateEnvelope(value) {
  if (!hasExactKeys(value, ENVELOPE_KEYS)
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || typeof value.checksumSha256 !== 'string'
    || !CHECKSUM.test(value.checksumSha256)) {
    fail('state-envelope-invalid');
  }
  canonicalJson(value);
  policy.validateStatePayload(value.payload);
  const expected = checksumFor(value.schemaVersion, value.revision, value.payload);
  if (expected !== value.checksumSha256) fail('state-envelope-checksum-invalid');
  return value;
}

function observedRevision(value) {
  return isPlainObject(value) && Number.isSafeInteger(value.revision) && value.revision >= 0
    ? value.revision
    : null;
}

function fixedHealth(status, reason) {
  return reason === undefined ? { status } : { status, reason };
}

async function readReplica(filePath) {
  let serialized;
  try {
    serialized = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { kind: 'missing', filePath, observedRevision: null };
    return { kind: 'io-error', filePath, observedRevision: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return { kind: 'invalid', filePath, observedRevision: null };
  }
  const revision = observedRevision(parsed);
  try {
    validateEnvelope(parsed);
    return { kind: 'valid', filePath, envelope: parsed, observedRevision: revision };
  } catch {
    return { kind: 'invalid', filePath, observedRevision: revision };
  }
}

async function readReplicaSnapshot(primaryPath, backupPath) {
  const [primary, backup] = await Promise.all([
    readReplica(primaryPath),
    readReplica(backupPath),
  ]);
  if (primary.kind === 'io-error' || backup.kind === 'io-error') {
    return { kind: 'io-error', replicas: [primary, backup] };
  }
  if (primary.kind === 'missing' && backup.kind === 'missing') {
    return {
      kind: 'uninitialized',
      envelope: null,
      repairNeeded: false,
      health: fixedHealth('uninitialized'),
      replicas: [primary, backup],
    };
  }
  const valid = [primary, backup].filter(replica => replica.kind === 'valid');
  if (valid.length === 0) return { kind: 'corrupt', replicas: [primary, backup] };
  if (valid.length === 2 && valid[0].envelope.revision === valid[1].envelope.revision) {
    if (valid[0].envelope.checksumSha256 !== valid[1].envelope.checksumSha256) {
      return { kind: 'corrupt', replicas: [primary, backup] };
    }
    return {
      kind: 'selected',
      envelope: valid[0].envelope,
      repairNeeded: false,
      health: fixedHealth('healthy'),
      replicas: [primary, backup],
    };
  }
  const selected = valid.reduce((current, candidate) => (
    current === null || candidate.envelope.revision > current.envelope.revision ? candidate : current
  ), null);
  return {
    kind: 'selected',
    envelope: selected.envelope,
    repairNeeded: true,
    health: fixedHealth('recovered-replica'),
    replicas: [primary, backup],
  };
}

async function writeSyncedFile(filePath, serialized) {
  let handle;
  try {
    handle = await fs.open(filePath, 'wx');
    await handle.writeFile(serialized, 'utf8');
    // FileHandle.sync improves durability, but Node has no portable Windows parent-directory fsync.
    await handle.sync();
  } catch {
    fail('state-write-failed');
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        fail('state-write-failed');
      }
    }
  }
}

async function removeFileIfPresent(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

async function replacePreparedFile(tempPath, destinationPath, sleep) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      if (process.platform === 'win32') await removeFileIfPresent(destinationPath);
      await fs.rename(tempPath, destinationPath);
      return;
    } catch (error) {
      const retryable = error && RETRYABLE_REPLACE_CODES.has(error.code);
      if (!retryable || attempt === 5) fail('state-replace-failed');
      await sleep(Math.min(25, attempt * 5));
    }
  }
  fail('state-replace-failed');
}

async function removeUnusedTemp(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    // A prepared temp may already have been renamed or may never have been created.
  }
}

async function persistEnvelope(stateDir, primaryPath, backupPath, envelope, sleep) {
  const serialized = canonicalJson(envelope);
  const primaryTemp = path.join(stateDir, `.state.primary.tmp-${crypto.randomUUID()}`);
  const backupTemp = path.join(stateDir, `.state.backup.tmp-${crypto.randomUUID()}`);
  try {
    await writeSyncedFile(primaryTemp, serialized);
    await writeSyncedFile(backupTemp, serialized);
    await replacePreparedFile(backupTemp, backupPath, sleep);
    await replacePreparedFile(primaryTemp, primaryPath, sleep);
  } finally {
    await Promise.all([
      removeUnusedTemp(primaryTemp),
      removeUnusedTemp(backupTemp),
    ]);
  }
}

function parseOwnerMetadata(value) {
  if (!hasExactKeys(value, OWNER_KEYS)
    || typeof value.ownerId !== 'string'
    || !UUID.test(value.ownerId)
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 0
    || typeof value.claimedAt !== 'string') return null;
  const claimedAtMs = Date.parse(value.claimedAt);
  if (!Number.isFinite(claimedAtMs) || new Date(claimedAtMs).toISOString() !== value.claimedAt) return null;
  return { ownerId: value.ownerId, pid: value.pid, claimedAt: value.claimedAt };
}

function ownersEqual(left, right) {
  return left !== null
    && right !== null
    && left.ownerId === right.ownerId
    && left.pid === right.pid
    && left.claimedAt === right.claimedAt;
}

async function readOwnerMetadata(lockDir) {
  let serialized;
  try {
    serialized = await fs.readFile(path.join(lockDir, OWNER_NAME), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail('state-lock-read-failed');
  }
  try {
    return parseOwnerMetadata(JSON.parse(serialized));
  } catch {
    return null;
  }
}

function defaultProcessExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && error.code === 'ESRCH');
  }
}

async function directoryExists(directoryPath) {
  try {
    const metadata = await fs.stat(directoryPath);
    return metadata.isDirectory();
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    fail('state-lock-read-failed');
  }
}

async function removeQuarantinedDirectory(directoryPath, sleep) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await fs.rm(directoryPath, { recursive: true, force: false });
      return;
    } catch (error) {
      const retryable = error && RETRYABLE_REPLACE_CODES.has(error.code);
      if (!retryable || attempt === 5) fail('state-lock-cleanup-failed');
      await sleep(Math.min(25, attempt * 5));
    }
  }
  fail('state-lock-cleanup-failed');
}

function createLockManager({ stateDir, lockWaitMs, staleLockMs, sleep, processExists }) {
  const publishedPath = path.join(stateDir, LOCK_NAME);
  const guardPath = path.join(stateDir, GUARD_NAME);

  async function renamePathToQuarantine(sourcePath, quarantinePath, failureCode) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await fs.rename(sourcePath, quarantinePath);
        return true;
      } catch (error) {
        if (error && error.code === 'ENOENT') return false;
        const retryable = error && RETRYABLE_REPLACE_CODES.has(error.code);
        if (!retryable || attempt === 5) fail(failureCode);
        await sleep(Math.min(25, attempt * 5));
      }
    }
    fail(failureCode);
  }

  async function quarantinePublished(reason, expectedOwner) {
    const quarantinePath = path.join(
      stateDir,
      `.state.lock.quarantine-${reason}-${crypto.randomUUID()}`,
    );
    if (!await renamePathToQuarantine(
      publishedPath,
      quarantinePath,
      'state-lock-quarantine-failed',
    )) return false;
    const quarantinedOwner = await readOwnerMetadata(quarantinePath);
    if (!ownersEqual(quarantinedOwner, expectedOwner)) {
      try {
        await fs.rename(quarantinePath, publishedPath);
      } catch {
        // The acquisition guard remains the fail-closed fence until this operation unwinds.
      }
      fail('state-lock-quarantine-owner-mismatch');
    }
    await removeQuarantinedDirectory(quarantinePath, sleep);
    return true;
  }

  async function cleanStaleCandidates() {
    let entries;
    try {
      entries = await fs.readdir(stateDir, { withFileTypes: true });
    } catch {
      fail('state-lock-read-failed');
    }
    const candidatePrefix = '.state.lock.candidate-';
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(candidatePrefix)) continue;
      const ownerId = entry.name.slice(candidatePrefix.length);
      if (!UUID.test(ownerId)) continue;
      const candidatePath = path.join(stateDir, entry.name);
      const owner = await readOwnerMetadata(candidatePath);
      if (owner === null || owner.ownerId !== ownerId || !await ownerIsProvenDead(owner)) continue;
      const quarantinePath = path.join(
        stateDir,
        `.state.lock.quarantine-candidate-${owner.ownerId}-${crypto.randomUUID()}`,
      );
      if (!await renamePathToQuarantine(
        candidatePath,
        quarantinePath,
        'state-lock-quarantine-failed',
      )) continue;
      const quarantinedOwner = await readOwnerMetadata(quarantinePath);
      if (!ownersEqual(quarantinedOwner, owner)) {
        try {
          await fs.rename(quarantinePath, candidatePath);
        } catch {
          fail('state-lock-quarantine-failed');
        }
        continue;
      }
      await removeQuarantinedDirectory(quarantinePath, sleep);
    }
  }

  async function publishedOwnerOrFailure() {
    if (!await directoryExists(publishedPath)) return { kind: 'missing' };
    let owner = await readOwnerMetadata(publishedPath);
    if (owner === null) {
      // A holder may atomically rename the published directory between the stat and owner read.
      if (!await directoryExists(publishedPath)) return { kind: 'missing' };
      owner = await readOwnerMetadata(publishedPath);
      if (owner === null) {
        if (!await directoryExists(publishedPath)) return { kind: 'missing' };
        fail('state-lock-owner-invalid');
      }
    }
    return { kind: 'owned', owner };
  }

  async function ownerIsProvenDead(owner) {
    const ageMs = Math.max(0, Date.now() - Date.parse(owner.claimedAt));
    if (ageMs < staleLockMs) return false;
    try {
      return await processExists(owner.pid) === false;
    } catch {
      return false;
    }
  }

  async function createCandidate(owner) {
    const candidatePath = path.join(stateDir, `.state.lock.candidate-${owner.ownerId}`);
    try {
      await fs.mkdir(candidatePath);
    } catch {
      fail('state-lock-candidate-failed');
    }
    try {
      await writeSyncedFile(path.join(candidatePath, OWNER_NAME), canonicalJson(owner));
    } catch (error) {
      await removeQuarantinedDirectory(candidatePath, sleep).catch(() => {});
      throw error;
    }
    return candidatePath;
  }

  async function acquireGuard() {
    const deadline = Date.now() + lockWaitMs;
    while (true) {
      try {
        await fs.mkdir(guardPath);
        return;
      } catch (error) {
        const contention = error && [
          'EEXIST',
          'ENOTEMPTY',
          'EPERM',
          'EACCES',
          'EBUSY',
        ].includes(error.code);
        if (!contention) fail('state-lock-guard-acquire-failed');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) fail('state-lock-guard-timeout');
      await sleep(Math.min(25, remaining));
    }
  }

  async function releaseGuard() {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await fs.rmdir(guardPath);
        return;
      } catch (error) {
        const retryable = error && RETRYABLE_REPLACE_CODES.has(error.code);
        if (!retryable || attempt === 5) fail('state-lock-guard-release-failed');
        await sleep(Math.min(25, attempt * 5));
      }
    }
    fail('state-lock-guard-release-failed');
  }

  async function withGuard(callback) {
    await acquireGuard();
    let result;
    let operationError;
    try {
      result = await callback();
    } catch (error) {
      operationError = error;
    }
    try {
      await releaseGuard();
    } catch (releaseError) {
      if (!operationError) operationError = releaseError;
    }
    if (operationError) throw operationError;
    return result;
  }

  async function tryAcquireUnderGuard(owner) {
    await cleanStaleCandidates();
    const candidatePath = await createCandidate(owner);
    let publishError;
    try {
      await fs.rename(candidatePath, publishedPath);
      return true;
    } catch (error) {
      publishError = error;
    }

    const published = await publishedOwnerOrFailure();
    if (published.kind === 'owned' && await ownerIsProvenDead(published.owner)) {
      const confirmed = await publishedOwnerOrFailure();
      if (confirmed.kind === 'owned'
        && ownersEqual(confirmed.owner, published.owner)
        && await ownerIsProvenDead(confirmed.owner)) {
        await quarantinePublished('stale', confirmed.owner);
        try {
          await fs.rename(candidatePath, publishedPath);
          return true;
        } catch (error) {
          await removeQuarantinedDirectory(candidatePath, sleep).catch(() => {});
          if (error && RETRYABLE_REPLACE_CODES.has(error.code)) return false;
          fail('state-lock-publish-failed');
        }
      }
    }

    await removeQuarantinedDirectory(candidatePath, sleep).catch(() => {});
    if (published.kind === 'missing'
      && publishError
      && !['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'].includes(publishError.code)) {
      fail('state-lock-publish-failed');
    }
    return false;
  }

  async function acquire() {
    try {
      await fs.mkdir(stateDir, { recursive: true });
    } catch {
      fail('state-lock-directory-failed');
    }
    const deadline = Date.now() + lockWaitMs;
    const owner = {
      ownerId: crypto.randomUUID(),
      pid: process.pid,
      claimedAt: new Date().toISOString(),
    };

    while (true) {
      const observed = await publishedOwnerOrFailure();
      if (observed.kind === 'owned' && !await ownerIsProvenDead(observed.owner)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) fail('state-lock-timeout');
        await sleep(Math.min(25, remaining));
        continue;
      }
      if (await withGuard(() => tryAcquireUnderGuard(owner))) return owner;

      const remaining = deadline - Date.now();
      if (remaining <= 0) fail('state-lock-timeout');
      await sleep(Math.min(25, remaining));
    }
  }

  async function release(owner) {
    const published = await publishedOwnerOrFailure();
    if (published.kind === 'missing' || !ownersEqual(published.owner, owner)) return;
    const quarantinePath = path.join(
      stateDir,
      `.state.lock.quarantine-release-${owner.ownerId}-${crypto.randomUUID()}`,
    );
    if (!await renamePathToQuarantine(
      publishedPath,
      quarantinePath,
      'state-lock-release-failed',
    )) return;
    const quarantinedOwner = await readOwnerMetadata(quarantinePath);
    if (!ownersEqual(quarantinedOwner, owner)) {
      try {
        await fs.rename(quarantinePath, publishedPath);
      } catch {
        // Never delete a directory whose ownership changed; manual recovery remains possible.
      }
      return;
    }
    await removeQuarantinedDirectory(quarantinePath, sleep);
  }

  return { acquire, release };
}

async function persistRecoveredEnvelope(
  stateDir,
  primaryPath,
  backupPath,
  envelope,
  replicas,
  sleep,
) {
  const serialized = canonicalJson(envelope);
  const primaryTemp = path.join(stateDir, `.state.primary.tmp-${crypto.randomUUID()}`);
  const backupTemp = path.join(stateDir, `.state.backup.tmp-${crypto.randomUUID()}`);

  async function archiveThenInstall(replica, tempPath, destinationPath) {
    if (replica.kind !== 'missing') {
      const revisionSegment = replica.observedRevision === null
        ? 'unknown'
        : `rev-${replica.observedRevision}`;
      const archivePath = path.join(
        stateDir,
        `${path.basename(replica.filePath)}.corrupt.${revisionSegment}.at-${Date.now()}-${crypto.randomUUID()}`,
      );
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
          await fs.rename(replica.filePath, archivePath);
          break;
        } catch (error) {
          const retryable = error && RETRYABLE_REPLACE_CODES.has(error.code);
          if (!retryable || attempt === 5) fail('state-corrupt-archive-failed');
          await sleep(Math.min(25, attempt * 5));
        }
      }
    }
    await replacePreparedFile(tempPath, destinationPath, sleep);
  }

  try {
    await writeSyncedFile(primaryTemp, serialized);
    await writeSyncedFile(backupTemp, serialized);
    await archiveThenInstall(replicas[1], backupTemp, backupPath);
    await archiveThenInstall(replicas[0], primaryTemp, primaryPath);
  } finally {
    await Promise.all([
      removeUnusedTemp(primaryTemp),
      removeUnusedTemp(backupTemp),
    ]);
  }
}

function revisionFromCorruptArchiveName(fileName) {
  const canonicalName = [PRIMARY_NAME, BACKUP_NAME]
    .find(name => fileName.startsWith(`${name}.corrupt.`));
  if (canonicalName === undefined) return null;
  const suffix = fileName.slice(`${canonicalName}.corrupt.`.length);
  const match = /^rev-(0|[1-9]\d*)\.at-(0|[1-9]\d*)-(.+)$/.exec(suffix);
  if (match === null || !UUID.test(match[3])) return null;
  const revision = Number(match[1]);
  const timestamp = Number(match[2]);
  return Number.isSafeInteger(revision)
    && revision >= 0
    && Number.isSafeInteger(timestamp)
    && timestamp >= 0
    ? revision
    : null;
}

async function archivedRevisionFloor(stateDir) {
  let entries;
  try {
    entries = await fs.readdir(stateDir, { withFileTypes: true });
  } catch {
    fail('state-corrupt-archive-scan-failed');
  }
  let maximum = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const namedRevision = revisionFromCorruptArchiveName(entry.name);
    if (namedRevision === null) continue;
    const archivedReplica = await readReplica(path.join(stateDir, entry.name));
    if (archivedReplica.kind === 'io-error') fail('state-corrupt-archive-scan-failed');
    if (archivedReplica.kind === 'missing'
      || archivedReplica.observedRevision !== namedRevision) continue;
    if (maximum === null || namedRevision > maximum) maximum = namedRevision;
  }
  return maximum;
}

function nextRevisionAfter(revision) {
  if (revision === null) return 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) {
    fail('state-revision-overflow');
  }
  return revision + 1;
}

function settlementSet(record) {
  return new Set(record.settledAttempts.map(
    settlement => `${settlement.periodId}:${settlement.attemptOrdinal}`,
  ));
}

function validateTransition(previous, next, metadata) {
  policy.validateStatePayload(next);
  if (previous === null) return;
  policy.validateStatePayload(previous);
  const periodAdvanced = next.periodId > previous.periodId;
  if (next.periodId < previous.periodId || (periodAdvanced && metadata.periodAdvance !== true)) {
    fail('state-transition-invalid');
  }
  const controlledAdvance = periodAdvanced && metadata.periodAdvance === true;
  for (const [fingerprint, previousRecord] of Object.entries(previous.records)) {
    const nextRecord = next.records[fingerprint];
    if (!nextRecord) fail('state-transition-invalid');
    if (previousRecord.status === 'auth-invalid' && nextRecord.status !== 'auth-invalid') {
      fail('state-transition-invalid');
    }
    if (controlledAdvance) continue;
    if (nextRecord.attemptedCalls < previousRecord.attemptedCalls
      || nextRecord.successfulCalls < previousRecord.successfulCalls) {
      fail('state-transition-invalid');
    }
    const nextSettlements = settlementSet(nextRecord);
    for (const settlement of previousRecord.settledAttempts) {
      if (!nextSettlements.has(`${settlement.periodId}:${settlement.attemptOrdinal}`)) {
        fail('state-transition-invalid');
      }
    }
  }
}

function routesEqual(expected, current) {
  if (!isPlainObject(expected) || expected.kind !== current.kind) return false;
  if (current.kind === 'anonymous') {
    return expected.reason === current.reason;
  }
  return expected.periodId === current.periodId
    && expected.slot === current.slot
    && expected.fingerprintSha256 === current.fingerprintSha256;
}

function normalizedOptions(options) {
  if (options === undefined) return { excludeFingerprints: [] };
  if (!isPlainObject(options)
    || Object.keys(options).some(key => key !== 'excludeFingerprints')) {
    fail('invalid-state-store-options');
  }
  return { excludeFingerprints: options.excludeFingerprints ?? [] };
}

function normalizeStoreOptions(options) {
  if (!isPlainObject(options) || typeof options.stateDir !== 'string' || options.stateDir.length === 0) {
    fail('invalid-state-store-options');
  }
  const allowed = new Set([
    'stateDir',
    'now',
    'sleep',
    'lockWaitMs',
    'staleLockMs',
    'processExists',
    'maxEventBytes',
    'redact',
  ]);
  if (Object.keys(options).some(key => !allowed.has(key))) fail('invalid-state-store-options');
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const processExists = options.processExists ?? defaultProcessExists;
  const redact = options.redact ?? null;
  const lockWaitMs = options.lockWaitMs ?? 5_000;
  const staleLockMs = options.staleLockMs ?? 10_000;
  const maxEventBytes = options.maxEventBytes ?? (1024 * 1024);
  if (typeof now !== 'function'
    || typeof sleep !== 'function'
    || typeof processExists !== 'function'
    || (redact !== null && typeof redact !== 'function')
    || !Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0
    || !Number.isSafeInteger(staleLockMs) || staleLockMs < 0
    || !Number.isSafeInteger(maxEventBytes) || maxEventBytes <= 0) {
    fail('invalid-state-store-options');
  }
  return {
    stateDir: path.resolve(options.stateDir),
    now,
    sleep,
    processExists,
    redact,
    lockWaitMs,
    staleLockMs,
    maxEventBytes,
  };
}

function safeEventNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeEventString(value) {
  return typeof value === 'string' && SAFE_EVENT_STRING.test(value) ? value : null;
}

function projectEvent(redacted, txNow) {
  if (!isPlainObject(redacted)) fail('state-event-invalid');
  const projected = { timestamp: txNow.toISOString() };
  const stringFields = [
    'event',
    'eventName',
    'failureClass',
    'kind',
    'outcomeKind',
    'routeKind',
    'reason',
  ];
  const numberFields = ['slot', 'ordinal', 'attemptOrdinal', 'attemptCount'];
  for (const field of stringFields) {
    if (!Object.hasOwn(redacted, field)) continue;
    const value = safeEventString(redacted[field]);
    if (value === null) fail('state-event-invalid');
    projected[field] = value;
  }
  for (const field of numberFields) {
    if (!Object.hasOwn(redacted, field)) continue;
    const value = safeEventNumber(redacted[field]);
    if (value === null || (field === 'slot' && (value < 1 || value > 4))) fail('state-event-invalid');
    projected[field] = value;
  }
  if (Object.hasOwn(redacted, 'fingerprintSha256_12')) {
    if (typeof redacted.fingerprintSha256_12 !== 'string'
      || !/^[a-f0-9]{12}$/.test(redacted.fingerprintSha256_12)) fail('state-event-invalid');
    projected.fingerprintSha256_12 = redacted.fingerprintSha256_12;
  }
  if (!Object.hasOwn(projected, 'event') && !Object.hasOwn(projected, 'eventName')) {
    fail('state-event-invalid');
  }
  return projected;
}

function createStateStore(rawOptions) {
  const options = normalizeStoreOptions(rawOptions);
  const primaryPath = path.join(options.stateDir, PRIMARY_NAME);
  const backupPath = path.join(options.stateDir, BACKUP_NAME);
  const eventPath = path.join(options.stateDir, EVENT_NAME);
  const lock = createLockManager(options);

  function sampleNow() {
    const sampled = options.now();
    if (!(sampled instanceof Date) || Number.isNaN(sampled.getTime())) fail('state-time-invalid');
    return new Date(sampled.getTime());
  }

  async function withLock(callback) {
    const owner = await lock.acquire();
    let result;
    let operationError;
    try {
      result = await callback();
    } catch (error) {
      operationError = error;
    }
    try {
      await lock.release(owner);
    } catch (releaseError) {
      if (!operationError) operationError = releaseError;
    }
    if (operationError) throw operationError;
    return result;
  }

  async function recoverCorruption(snapshot, context, txNow) {
    const archivedFloor = await archivedRevisionFloor(options.stateDir);
    const observed = snapshot.replicas
      .map(replica => replica.observedRevision)
      .filter(revision => revision !== null);
    if (archivedFloor !== null) observed.push(archivedFloor);
    const maximumObserved = observed.length === 0 ? null : Math.max(...observed);
    const revision = nextRevisionAfter(maximumObserved);
    const state = policy.createFailClosedState({
      identities: context.identities,
      timeZone: context.timeZone,
      now: txNow,
    });
    const envelope = makeEnvelope(state, revision);
    await persistRecoveredEnvelope(
      options.stateDir,
      primaryPath,
      backupPath,
      envelope,
      snapshot.replicas,
      options.sleep,
    );
    return {
      envelope,
      repairNeeded: false,
      health: fixedHealth('fail-closed', 'state-corrupt-fail-closed'),
      alreadyReconciled: true,
    };
  }

  async function loadForTransaction(context, txNow) {
    const snapshot = await readReplicaSnapshot(primaryPath, backupPath);
    if (snapshot.kind === 'io-error') fail('state-read-failed');
    if (snapshot.kind === 'corrupt') return recoverCorruption(snapshot, context, txNow);
    return { ...snapshot, alreadyReconciled: false };
  }

  async function prepareTransaction(context, txNow) {
    const loaded = await loadForTransaction(context, txNow);
    const previous = loaded.envelope === null ? null : loaded.envelope.payload;
    const state = loaded.alreadyReconciled
      ? cloneJson(previous)
      : policy.reconcileState({
        state: previous === null ? null : cloneJson(previous),
        identities: context.identities,
        timeZone: context.timeZone,
        now: txNow,
      });
    return {
      baseEnvelope: loaded.envelope,
      previous,
      state,
      repairNeeded: loaded.repairNeeded,
      health: loaded.health,
      periodAdvance: previous !== null && state.periodId > previous.periodId,
    };
  }

  async function commitTransaction(prepared, nextState) {
    const previousPayload = prepared.baseEnvelope === null ? null : prepared.baseEnvelope.payload;
    const changed = previousPayload === null
      || canonicalJson(previousPayload) !== canonicalJson(nextState);
    let envelope = prepared.baseEnvelope;
    if (changed) {
      validateTransition(prepared.previous, nextState, { periodAdvance: prepared.periodAdvance });
      const revision = prepared.baseEnvelope === null
        ? 0
        : nextRevisionAfter(prepared.baseEnvelope.revision);
      envelope = makeEnvelope(nextState, revision);
      await persistEnvelope(options.stateDir, primaryPath, backupPath, envelope, options.sleep);
    } else if (prepared.repairNeeded) {
      await persistEnvelope(options.stateDir, primaryPath, backupPath, envelope, options.sleep);
    }
    const health = prepared.health.status === 'uninitialized'
      ? fixedHealth('healthy')
      : prepared.health;
    return {
      state: cloneJson(nextState),
      health: { ...health },
      stateRevision: envelope.revision,
    };
  }

  function unavailableSnapshot(context, sampledNow) {
    const state = policy.createFailClosedState({
      identities: context.identities,
      timeZone: context.timeZone,
      now: sampledNow,
    });
    return {
      state: cloneJson(state),
      health: fixedHealth('fail-closed', 'state-unavailable'),
      stateRevision: null,
    };
  }

  function unavailableAfter(error, context, txNow) {
    if (!(error instanceof StateStoreFailure)) throw error;
    if (error.code === 'state-time-invalid') throw error;
    return unavailableSnapshot(context, txNow ?? sampleNow());
  }

  async function preview(context, rawRouteOptions) {
    const routeOptions = normalizedOptions(rawRouteOptions);
    let txNow;
    try {
      return await withLock(async () => {
        txNow = sampleNow();
        const prepared = await prepareTransaction(context, txNow);
        const route = policy.selectRoute(prepared.state, txNow, routeOptions);
        const committed = await commitTransaction(prepared, prepared.state);
        return { route: cloneJson(route), ...committed };
      });
    } catch (error) {
      const unavailable = unavailableAfter(error, context, txNow);
      return {
        route: { kind: 'anonymous', reason: 'state-unavailable-fail-closed' },
        ...unavailable,
      };
    }
  }

  async function read(context) {
    let txNow;
    try {
      return await withLock(async () => {
        txNow = sampleNow();
        const prepared = await prepareTransaction(context, txNow);
        return commitTransaction(prepared, prepared.state);
      });
    } catch (error) {
      return unavailableAfter(error, context, txNow);
    }
  }

  async function reserveExpected(context, expectedRoute, rawRouteOptions) {
    const routeOptions = normalizedOptions(rawRouteOptions);
    let txNow;
    try {
      return await withLock(async () => {
        txNow = sampleNow();
        const prepared = await prepareTransaction(context, txNow);
        const currentRoute = policy.selectRoute(prepared.state, txNow, routeOptions);
        if (!routesEqual(expectedRoute, currentRoute)) {
          const committed = await commitTransaction(prepared, prepared.state);
          return { kind: 'retry', route: cloneJson(currentRoute), ...committed };
        }
        if (currentRoute.kind === 'anonymous') {
          const anonymousState = policy.markAnonymous({
            state: prepared.state,
            reason: currentRoute.reason,
            now: txNow,
          });
          const committed = await commitTransaction(prepared, anonymousState);
          return {
            kind: 'anonymous',
            route: cloneJson(currentRoute),
            token: null,
            ...committed,
          };
        }
        const reserved = policy.reserveRoute({
          state: prepared.state,
          route: currentRoute,
          now: txNow,
        });
        const committed = await commitTransaction(prepared, reserved.state);
        const token = { ...reserved.reservation, stateRevision: committed.stateRevision };
        return {
          kind: 'keyed',
          route: cloneJson(currentRoute),
          token,
          ...committed,
        };
      });
    } catch (error) {
      const unavailable = unavailableAfter(error, context, txNow);
      return {
        kind: 'anonymous',
        route: { kind: 'anonymous', reason: 'state-unavailable-fail-closed' },
        token: null,
        ...unavailable,
      };
    }
  }

  async function recordOutcome(context, token, outcome) {
    let txNow;
    try {
      return await withLock(async () => {
        txNow = sampleNow();
        const prepared = await prepareTransaction(context, txNow);
        const nextState = policy.applyOutcome({
          state: prepared.state,
          token,
          outcome,
          now: txNow,
        });
        return commitTransaction(prepared, nextState);
      });
    } catch (error) {
      if (error instanceof StateStoreFailure) fail('state-store-unavailable');
      throw error;
    }
  }

  async function inspectStored() {
    const snapshot = await readReplicaSnapshot(primaryPath, backupPath);
    if (snapshot.kind === 'uninitialized') {
      return {
        state: null,
        health: fixedHealth('uninitialized'),
        stateRevision: null,
        reconciliation: 'not-applied',
      };
    }
    if (snapshot.kind === 'io-error') {
      return {
        state: null,
        health: fixedHealth('fail-closed', 'state-read-failed'),
        stateRevision: null,
        reconciliation: 'not-applied',
      };
    }
    if (snapshot.kind === 'corrupt') {
      return {
        state: null,
        health: fixedHealth('fail-closed', 'state-corrupt'),
        stateRevision: null,
        reconciliation: 'not-applied',
      };
    }
    return {
      state: cloneJson(snapshot.envelope.payload),
      health: { ...snapshot.health },
      stateRevision: snapshot.envelope.revision,
      reconciliation: 'not-applied',
    };
  }

  async function appendEvent(allowlistedEvent) {
    try {
      await withLock(async () => {
        const txNow = sampleNow();
        if (options.redact === null) fail('state-event-redactor-required');
        let redacted;
        try {
          redacted = options.redact(allowlistedEvent);
        } catch {
          fail('state-event-redaction-failed');
        }
        const projected = projectEvent(redacted, txNow);
        const line = `${canonicalJson(projected)}\n`;
        const lineBytes = Buffer.byteLength(line);
        if (lineBytes > options.maxEventBytes) fail('state-event-too-large');
        let currentBytes = 0;
        try {
          currentBytes = (await fs.stat(eventPath)).size;
        } catch (error) {
          if (!error || error.code !== 'ENOENT') fail('state-event-read-failed');
        }
        if (currentBytes > 0 && currentBytes + lineBytes > options.maxEventBytes) {
          const timestamp = txNow.toISOString().replace(/[:.]/g, '-');
          const rotatedPath = path.join(
            options.stateDir,
            `events.${timestamp}-${crypto.randomUUID()}.jsonl`,
          );
          for (let attempt = 1; attempt <= 5; attempt += 1) {
            try {
              await fs.rename(eventPath, rotatedPath);
              break;
            } catch (error) {
              const retryable = error && RETRYABLE_REPLACE_CODES.has(error.code);
              if (!retryable || attempt === 5) fail('state-event-rotate-failed');
              await options.sleep(Math.min(25, attempt * 5));
            }
          }
        }
        let handle;
        try {
          handle = await fs.open(eventPath, 'a');
          await handle.writeFile(line, 'utf8');
          await handle.sync();
        } catch {
          fail('state-event-write-failed');
        } finally {
          if (handle) {
            try {
              await handle.close();
            } catch {
              fail('state-event-write-failed');
            }
          }
        }
      });
    } catch (error) {
      if (error instanceof StateStoreFailure) fail('state-store-unavailable');
      throw error;
    }
  }

  return {
    preview,
    reserveExpected,
    recordOutcome,
    read,
    inspectStored,
    appendEvent,
  };
}

module.exports = { createStateStore };
