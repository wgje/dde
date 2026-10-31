import {
  createDataSafetyRestoreMarkerLease,
  hasSameDataSafetyRestoreMarkerIdentity,
  renewDataSafetyRestoreMarkerLeaseIdentity,
  type DataSafetyRestoreMarkerLeaseIdentity,
} from './data-safety-indexeddb-restore-marker-lease';
import {
  beginLocalBackupUiRestoreWriter,
  getLocalBackupUiRestoreQuiescenceSentinelStorageKey,
  readActiveLocalBackupUiRestoreWriters,
  runLocalBackupUiRestoreWriterContinuationSync,
  runWithLocalBackupUiRestoreWriterAuthorization,
  trackLocalBackupUiRestoreWriterPromise,
  type LocalBackupUiRestoreWriterSource,
} from './local-backup-ui-restore-writer-quiescence-tracker';
import { LOCAL_BACKUP_UI_RESTORE_MARKER_KIND } from './local-backup-ui-restore-journal';
import type { LocalBackupUiRestoreMarker } from './local-backup-ui-restore-types';

export {
  LocalBackupUiRestoreWriterPausedError,
  getLocalBackupUiRestoreQuiescenceSentinelStorageKey,
  type LocalBackupUiRestoreWriterSource,
} from './local-backup-ui-restore-writer-quiescence-tracker';

export const LOCAL_BACKUP_UI_RESTORE_QUIESCENCE_MARKER_KIND =
  'local-backup-ui-restore-quiescence' as const;

const JOURNAL_DB_NAME = 'nanoflow-data-safety-restore-journal';
const JOURNAL_STORE_NAME = 'restore_markers';
const SENTINEL_SCHEMA_VERSION = 2;
const MARKER_SCHEMA_VERSION = 1;
const DEFAULT_LEASE_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 10;

export interface LocalBackupUiRestoreQuiescenceMarker
  extends DataSafetyRestoreMarkerLeaseIdentity {
  schemaVersion: typeof MARKER_SCHEMA_VERSION;
  runId: string;
  leaseExpiresAt: string;
  state: 'pausing' | 'quiesced' | 'finalizing-completed' | 'finalizing-rolled-back';
}

export type LocalBackupUiRestoreQuiescenceFinalOutcome = 'completed' | 'rolled-back';

export interface PreparedLocalBackupUiRestoreWriterQuiescence {
  marker(): LocalBackupUiRestoreQuiescenceMarker;
  verifyOwnership(): Promise<boolean>;
  runMutation<T>(source: LocalBackupUiRestoreWriterSource, write: () => Promise<T>): Promise<T>;
  drainWriters(): Promise<void>;
  prepareFinalization(outcome: LocalBackupUiRestoreQuiescenceFinalOutcome): Promise<void>;
  releaseFinalized(): Promise<void>;
  abortBeforeMutation(): Promise<void>;
}

interface WriterQuiescenceOptions {
  leaseMs?: number;
  pollIntervalMs?: number;
}

interface JournalRecord {
  key: string;
  markerKind: typeof LOCAL_BACKUP_UI_RESTORE_QUIESCENCE_MARKER_KIND;
  ownerUserId: string;
  marker: LocalBackupUiRestoreQuiescenceMarker;
}

export class LocalBackupUiRestoreWriterQuiescenceService {
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: WriterQuiescenceOptions = {}) {
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  runSync<T>(
    ownerUserId: string,
    source: LocalBackupUiRestoreWriterSource,
    write: () => T,
  ): T {
    const active = beginLocalBackupUiRestoreWriter(ownerUserId, source, {
      leaseMs: this.leaseMs,
      heartbeat: false,
    });
    try {
      return write();
    } finally {
      active.release();
    }
  }

  async runAsync<T>(
    ownerUserId: string,
    source: LocalBackupUiRestoreWriterSource,
    write: () => Promise<T>,
  ): Promise<T> {
    const active = beginLocalBackupUiRestoreWriter(ownerUserId, source, { leaseMs: this.leaseMs });
    try {
      return await write();
    } finally {
      active.release();
    }
  }

  runContinuationSync<T>(ownerUserId: string, source: LocalBackupUiRestoreWriterSource, write: () => T): T {
    return runLocalBackupUiRestoreWriterContinuationSync(ownerUserId, source, write);
  }

  runContinuationAsync<T>(ownerUserId: string, source: LocalBackupUiRestoreWriterSource,
    write: () => Promise<T>): Promise<T> {
    return trackLocalBackupUiRestoreWriterPromise(ownerUserId, source, write, { continuation: true });
  }

  async prepare(ownerUserId: string): Promise<PreparedLocalBackupUiRestoreWriterQuiescence> {
    assertOwner(ownerUserId);
    this.assertSentinelAbsent(ownerUserId);
    const marker = await claimQuiescenceMarker(ownerUserId, this.leaseMs);
    const lease: LocalBackupUiRestoreQuiescenceLease = new LocalBackupUiRestoreQuiescenceLease(
      marker,
      this.leaseMs,
      source => this.runAsync(ownerUserId, source.source, source.write),
      (): Promise<void> => this.waitForActiveWriters(
        ownerUserId,
        (): boolean => lease.hasOwnershipLost(),
      ),
    );
    try {
      await this.waitForActiveWriters(ownerUserId, () => lease.hasOwnershipLost());
      await lease.markQuiesced();
    } catch (error) {
      await lease.cleanupAfterPrepareFailure();
      throw error;
    }
    return lease.toPreparedHandle();
  }

  async readStartupRecoveryEvidence(ownerUserId: string): Promise<LocalBackupUiRestoreQuiescenceMarker | null> {
    assertOwner(ownerUserId);
    const rawSentinel = requireLocalStorage().getItem(
      getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId),
    );
    const marker = await readMarker(ownerUserId);
    if (marker === null && rawSentinel === null) return null;
    const sentinel = parseSentinel(rawSentinel);
    if (!marker || !sentinel || !hasSameQuiescenceSnapshot(marker, sentinel)) {
      throw new Error('local backup UI restore quiescence startup evidence is inconsistent');
    }
    return marker;
  }

  async recoverExpiredPreMarkerQuiescence(ownerUserId: string) {
    assertOwner(ownerUserId);
    const storage = requireLocalStorage();
    const sentinelKey = getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId);
    const rawSentinel = storage.getItem(sentinelKey);
    const sentinel = parseSentinel(rawSentinel);
    const [mainRecord, rawRecord] = await readRecoveryRecords(ownerUserId);
    if (mainRecord !== undefined) return preMarkerBlocked('active-or-mutated');
    if (rawRecord === undefined && rawSentinel === null) return { status: 'none' } as const;
    const record = rawRecord === undefined ? null : normalizeJournalRecord(
      rawRecord, markerKey(ownerUserId), ownerUserId,
    );
    if (!sentinel || sentinel.ownerUserId !== ownerUserId
      || (rawRecord !== undefined && !record)
      || (record && !hasSameQuiescenceSnapshot(record.marker, sentinel))) {
      return preMarkerBlocked('invalid-evidence');
    }
    const active = readActiveLocalBackupUiRestoreWriters(ownerUserId).length > 0;
    const expired = Date.parse(sentinel.leaseExpiresAt) <= Date.now();
    const protectedOutcome = classifyPreMarkerEvidence(record, sentinel, active, expired);
    if (protectedOutcome) return protectedOutcome;
    if (!await clearPreMarkerRecoveryRecord(ownerUserId, record, rawSentinel!)) {
      return preMarkerBlocked('active-or-mutated');
    }
    if (!removeSentinel(sentinel, rawSentinel!)) return preMarkerBlocked('active-or-mutated');
    const [mainAfter, quiescenceAfter] = await readRecoveryRecords(ownerUserId);
    if (mainAfter !== undefined || quiescenceAfter !== undefined
      || storage.getItem(sentinelKey) !== null) return preMarkerBlocked('active-or-mutated');
    return { status: 'recovered' } as const;
  }

  async takeoverExpired(
    expected: LocalBackupUiRestoreQuiescenceMarker,
    claimedMarker: LocalBackupUiRestoreMarker,
  ): Promise<PreparedLocalBackupUiRestoreWriterQuiescence> {
    assertOwner(expected.ownerUserId);
    if (!hasCompatibleStartupRecoveryClaim(expected, claimedMarker)) {
      throw new Error('local backup UI restore quiescence startup recovery identity mismatched');
    }
    const current = await this.readStartupRecoveryEvidence(expected.ownerUserId);
    if (!current
      || !hasSameQuiescenceSnapshot(current, expected)
      || Date.parse(current.leaseExpiresAt) > Date.now()) {
      throw new Error('local backup UI restore quiescence ownership lost');
    }
    const adoptedMarker: LocalBackupUiRestoreQuiescenceMarker = {
      ...current,
      ownerUserId: claimedMarker.ownerUserId,
      runId: claimedMarker.runId,
      createdAt: claimedMarker.createdAt,
      leaseExpiresAt: claimedMarker.leaseExpiresAt,
    };
    if (!await replaceOwnedMarker(current, adoptedMarker)) {
      throw new Error('local backup UI restore quiescence ownership lost');
    }
    writeSentinel(adoptedMarker);
    await assertMarkerReadBack(adoptedMarker);
    const lease: LocalBackupUiRestoreQuiescenceLease = new LocalBackupUiRestoreQuiescenceLease(
      adoptedMarker,
      this.leaseMs,
      source => this.runAsync(expected.ownerUserId, source.source, source.write),
      (): Promise<void> => this.waitForActiveWriters(
        expected.ownerUserId,
        (): boolean => lease.hasOwnershipLost(),
      ),
    );
    return lease.toPreparedHandle();
  }

  async takeoverExpiredFinalization(expected: LocalBackupUiRestoreQuiescenceMarker):
  Promise<PreparedLocalBackupUiRestoreWriterQuiescence> {
    assertOwner(expected.ownerUserId);
    if (!isExpiredFinalizationMarker(expected)) {
      throw new Error('local backup UI restore quiescence ownership lost');
    }
    const current = await this.readStartupRecoveryEvidence(expected.ownerUserId);
    if (!current
      || !hasSameQuiescenceSnapshot(current, expected)
      || !isExpiredFinalizationMarker(current)) {
      throw new Error('local backup UI restore quiescence ownership lost');
    }
    const reclaimedMarker = renewDataSafetyRestoreMarkerLeaseIdentity(current, Date.now());
    if (!await replaceOwnedMarker(current, reclaimedMarker)) {
      throw new Error('local backup UI restore quiescence ownership lost');
    }
    writeSentinel(reclaimedMarker);
    await assertMarkerReadBack(reclaimedMarker);
    const lease: LocalBackupUiRestoreQuiescenceLease = new LocalBackupUiRestoreQuiescenceLease(
      reclaimedMarker,
      this.leaseMs,
      source => this.runAsync(expected.ownerUserId, source.source, source.write),
      (): Promise<void> => this.waitForActiveWriters(
        expected.ownerUserId,
        (): boolean => lease.hasOwnershipLost(),
      ),
    );
    return lease.toPreparedHandle();
  }

  private assertSentinelAbsent(ownerUserId: string): void {
    const raw = requireLocalStorage().getItem(
      getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId),
    );
    if (raw === null) return;
    throw new Error(parseSentinel(raw)
      ? 'local backup UI restore quiescence already exists'
      : 'local backup UI restore quiescence sentinel failed schema validation');
  }

  private async waitForActiveWriters(ownerUserId: string, ownershipLost: () => boolean): Promise<void> {
    while (true) {
      if (ownershipLost()) throw new Error('local backup UI restore quiescence ownership lost');
      const active = readActiveLocalBackupUiRestoreWriters(ownerUserId);
      if (active.length === 0) return;
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
    }
  }
}

class LocalBackupUiRestoreQuiescenceLease {
  private markerValue: LocalBackupUiRestoreQuiescenceMarker;
  private ownershipLost = false;
  private heartbeatInFlight: Promise<void> | null = null;
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor(
    marker: LocalBackupUiRestoreQuiescenceMarker,
    leaseMs: number,
    private readonly runAuthorizedWriter: <T>(input: {
      source: LocalBackupUiRestoreWriterSource;
      write: () => Promise<T>;
    }) => Promise<T>,
    private readonly drain: () => Promise<void>,
  ) {
    this.markerValue = marker;
    this.heartbeat = setInterval(
      () => void this.renew(),
      Math.max(1, Math.floor(leaseMs / 3)),
    );
  }

  hasOwnershipLost(): boolean {
    return this.ownershipLost;
  }

  async markQuiesced(): Promise<void> {
    if (this.ownershipLost) throw new Error('local backup UI restore quiescence ownership lost');
    const quiesced = { ...this.markerValue, state: 'quiesced' as const };
    if (!await replaceOwnedMarker(this.markerValue, quiesced)) {
      this.ownershipLost = true;
      throw new Error('local backup UI restore quiescence ownership lost');
    }
    this.markerValue = quiesced;
    writeSentinel(this.markerValue);
    await assertMarkerReadBack(this.markerValue);
  }

  async cleanupAfterPrepareFailure(): Promise<void> {
    await this.stopHeartbeat();
    if (this.ownershipLost) return;
    const cleared = await clearOwnedMarker(this.markerValue).catch(() => false);
    if (cleared) removeSentinel(this.markerValue);
  }

  toPreparedHandle(): PreparedLocalBackupUiRestoreWriterQuiescence {
    return {
      marker: () => ({ ...this.markerValue }),
      verifyOwnership: () => this.verifyOwnership(),
      runMutation: (source, write) => this.runMutation(source, write),
      drainWriters: () => this.drainWriters(),
      prepareFinalization: outcome => this.prepareFinalization(outcome),
      releaseFinalized: () => this.releaseFinalized(),
      abortBeforeMutation: () => this.abortBeforeMutation(),
    };
  }

  private runMutation<T>(
    source: LocalBackupUiRestoreWriterSource,
    write: () => Promise<T>,
  ): Promise<T> {
    if (this.markerValue.state !== 'quiesced') {
      throw new Error('local backup UI restore is not accepting stage mutations');
    }
    return runWithLocalBackupUiRestoreWriterAuthorization(
      this.markerValue.ownerUserId,
      this.markerValue.runId,
      source,
      () => this.runAuthorizedWriter({ source, write }),
    );
  }

  private async drainWriters(): Promise<void> {
    if (!await this.verifyOwnership()) {
      throw new Error('local backup UI restore quiescence ownership lost');
    }
    await this.drain();
    if (!await this.verifyOwnership()) {
      throw new Error('local backup UI restore quiescence ownership lost');
    }
  }

  private async prepareFinalization(
    outcome: LocalBackupUiRestoreQuiescenceFinalOutcome,
  ): Promise<void> {
    if (!await this.verifyOwnership()) {
      throw new Error('local backup UI restore quiescence ownership lost');
    }
    if (this.markerValue.state === `finalizing-${outcome}`) {
      await assertMarkerReadBack(this.markerValue);
      return;
    }
    if (this.markerValue.state !== 'quiesced') {
      throw new Error('local backup UI restore quiescence ownership lost');
    }
    const next = {
      ...this.markerValue,
      state: `finalizing-${outcome}` as const,
    };
    if (!await replaceOwnedMarker(this.markerValue, next)) {
      this.ownershipLost = true;
      throw new Error('local backup UI restore quiescence ownership lost');
    }
    this.markerValue = next;
    writeSentinel(next);
    await assertMarkerReadBack(next);
  }

  private async releaseFinalized(): Promise<void> {
    if (!this.markerValue.state.startsWith('finalizing-')
      || !await this.verifyOwnership()) {
      throw new Error('local backup UI restore quiescence ownership lost');
    }
    await this.stopHeartbeat();
    if (!await clearOwnedMarker(this.markerValue)
      || !removeSentinel(this.markerValue)) {
      this.ownershipLost = true;
      throw new Error('local backup UI restore quiescence clear failed');
    }
  }

  private renew(): Promise<void> {
    if (this.ownershipLost) return Promise.resolve();
    if (this.heartbeatInFlight) return this.heartbeatInFlight;
    const pending = this.renewMarker();
    this.heartbeatInFlight = pending.finally(() => {
      this.heartbeatInFlight = null;
    });
    return this.heartbeatInFlight;
  }

  private async renewMarker(): Promise<void> {
    const renewed = renewDataSafetyRestoreMarkerLeaseIdentity(this.markerValue, Date.now());
    if (!await replaceOwnedMarker(this.markerValue, renewed)) {
      this.ownershipLost = true;
      return;
    }
    this.markerValue = renewed;
    try {
      writeSentinel(this.markerValue);
    } catch {
      this.ownershipLost = true;
    }
  }

  private async verifyOwnership(): Promise<boolean> {
    if (this.ownershipLost) return false;
    await this.renew();
    return !this.ownershipLost
      && await ownsMarker(this.markerValue)
      && hasSentinelIdentity(this.markerValue);
  }

  private async abortBeforeMutation(): Promise<void> {
    if (this.markerValue.state !== 'quiesced'
      || this.ownershipLost
      || !await ownsMarker(this.markerValue)
      || !hasSentinelIdentity(this.markerValue)) {
      throw new Error('local backup UI restore quiescence ownership lost');
    }
    await this.stopHeartbeat();
    if (!await clearOwnedMarker(this.markerValue)
      || !removeSentinel(this.markerValue)) {
      this.ownershipLost = true;
      throw new Error('local backup UI restore quiescence clear failed');
    }
  }

  private async stopHeartbeat(): Promise<void> {
    clearInterval(this.heartbeat);
    await this.heartbeatInFlight;
  }
}

async function claimQuiescenceMarker(
  ownerUserId: string,
  leaseMs: number,
): Promise<LocalBackupUiRestoreQuiescenceMarker> {
  const marker = buildQuiescenceMarker(ownerUserId, leaseMs);
  await createMarker(marker);
  try {
    writeSentinel(marker);
    await assertMarkerReadBack(marker);
  } catch (error) {
    await clearOwnedMarker(marker).catch(() => false);
    throw error;
  }
  return marker;
}

function buildQuiescenceMarker(
  ownerUserId: string,
  leaseMs: number,
): LocalBackupUiRestoreQuiescenceMarker {
  const lease = createDataSafetyRestoreMarkerLease(ownerUserId);
  if (!lease.runId) throw new Error('local backup UI restore quiescence run identity is missing');
  return {
    schemaVersion: MARKER_SCHEMA_VERSION,
    ...lease,
    runId: lease.runId,
    leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
    state: 'pausing',
  };
}

function writeSentinel(marker: LocalBackupUiRestoreQuiescenceMarker): void {
  requireLocalStorage().setItem(
    getLocalBackupUiRestoreQuiescenceSentinelStorageKey(marker.ownerUserId),
    JSON.stringify({
      schemaVersion: SENTINEL_SCHEMA_VERSION,
      storage: 'indexeddb-journal',
      markerKind: LOCAL_BACKUP_UI_RESTORE_QUIESCENCE_MARKER_KIND,
      ownerUserId: marker.ownerUserId,
      runId: marker.runId,
      createdAt: marker.createdAt,
      leaseExpiresAt: marker.leaseExpiresAt,
      state: marker.state,
    }),
  );
}

function removeSentinel(marker: LocalBackupUiRestoreQuiescenceMarker, expectedRaw?: string): boolean {
  const storage = requireLocalStorage();
  const key = getLocalBackupUiRestoreQuiescenceSentinelStorageKey(marker.ownerUserId);
  const raw = storage.getItem(key);
  const sentinel = parseSentinel(raw);
  if (expectedRaw !== undefined ? raw !== expectedRaw
    : !sentinel || !hasSameQuiescenceSnapshot(sentinel, marker)) return false;
  storage.removeItem(key);
  return storage.getItem(key) === null;
}
function hasSentinelIdentity(marker: LocalBackupUiRestoreQuiescenceMarker): boolean {
  const sentinel = parseSentinel(requireLocalStorage().getItem(
    getLocalBackupUiRestoreQuiescenceSentinelStorageKey(marker.ownerUserId),
  ));
  return !!sentinel && hasSameQuiescenceSnapshot(sentinel, marker);
}

function hasSameQuiescenceSnapshot(
  first: LocalBackupUiRestoreQuiescenceMarker,
  second: LocalBackupUiRestoreQuiescenceMarker,
): boolean {
  return first.ownerUserId === second.ownerUserId
    && first.runId === second.runId
    && first.createdAt === second.createdAt
    && first.leaseExpiresAt === second.leaseExpiresAt
    && first.state === second.state;
}

function hasCompatibleStartupRecoveryClaim(
  quiescence: LocalBackupUiRestoreQuiescenceMarker,
  marker: LocalBackupUiRestoreMarker,
): boolean {
  return quiescence.ownerUserId === marker.ownerUserId
    && quiescence.createdAt === marker.createdAt
    && Date.parse(marker.leaseExpiresAt) > Date.now();
}

function isExpiredFinalizationMarker(marker: LocalBackupUiRestoreQuiescenceMarker): boolean {
  return marker.state.startsWith('finalizing-')
    && Date.parse(marker.leaseExpiresAt) <= Date.now();
}

function parseSentinel(raw: string | null): LocalBackupUiRestoreQuiescenceMarker | null {
  if (!raw) return null;
  const value = parseJsonObject(raw);
  if (!value) return null;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'createdAt,leaseExpiresAt,markerKind,ownerUserId,runId,schemaVersion,state,storage') return null;
  if (value['schemaVersion'] !== SENTINEL_SCHEMA_VERSION
    || value['storage'] !== 'indexeddb-journal'
    || value['markerKind'] !== LOCAL_BACKUP_UI_RESTORE_QUIESCENCE_MARKER_KIND
    || !isNonEmptyString(value['ownerUserId'])
    || !isNonEmptyString(value['runId'])
    || !isIsoTimestamp(value['createdAt'])
    || !isIsoTimestamp(value['leaseExpiresAt'])
    || !isQuiescenceState(value['state'])) return null;
  return { schemaVersion: MARKER_SCHEMA_VERSION, ...value } as unknown as LocalBackupUiRestoreQuiescenceMarker;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  let value: unknown = null;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function createMarker(marker: LocalBackupUiRestoreQuiescenceMarker): Promise<void> {
  const key = markerKey(marker.ownerUserId);
  await runJournalTransaction('readwrite', store => new Promise<void>((resolve, reject) => {
    const get = store.get(key);
    get.onerror = () => reject(get.error ?? new Error('quiescence marker read failed'));
    get.onsuccess = () => {
      if (get.result !== undefined) {
        reject(new Error('local backup UI restore quiescence marker already exists'));
        return;
      }
      const add = store.add(toJournalRecord(marker));
      add.onerror = () => reject(add.error ?? new Error('quiescence marker write failed'));
      add.onsuccess = () => resolve();
    };
  }));
}

async function readMarker(ownerUserId: string): Promise<LocalBackupUiRestoreQuiescenceMarker | null> {
  const key = markerKey(ownerUserId);
  return await runJournalTransaction('readonly', store => new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onerror = () => reject(request.error ?? new Error('quiescence marker read failed'));
    request.onsuccess = () => {
      if (request.result === undefined) {
        resolve(null);
        return;
      }
      const record = normalizeJournalRecord(request.result, key, ownerUserId);
      if (!record) {
        reject(new Error('quiescence marker failed schema validation'));
        return;
      }
      resolve(record.marker);
    };
  }));
}

async function replaceOwnedMarker(
  expected: LocalBackupUiRestoreQuiescenceMarker,
  replacement: LocalBackupUiRestoreQuiescenceMarker,
): Promise<boolean> {
  const key = markerKey(expected.ownerUserId);
  return await runJournalTransaction('readwrite', store => new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onerror = () => reject(request.error ?? new Error('quiescence marker read failed'));
    request.onsuccess = () => {
      const current = normalizeJournalRecord(request.result, key, expected.ownerUserId)?.marker;
      if (!current || !hasSameDataSafetyRestoreMarkerIdentity(current, expected)) {
        resolve(false);
        return;
      }
      const put = store.put(toJournalRecord(replacement));
      put.onerror = () => reject(put.error ?? new Error('quiescence marker update failed'));
      put.onsuccess = () => resolve(true);
    };
  }));
}

async function clearOwnedMarker(marker: LocalBackupUiRestoreQuiescenceMarker): Promise<boolean> {
  const key = markerKey(marker.ownerUserId);
  return await runJournalTransaction('readwrite', store => new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onerror = () => reject(request.error ?? new Error('quiescence marker read failed'));
    request.onsuccess = () => {
      const current = normalizeJournalRecord(request.result, key, marker.ownerUserId)?.marker;
      if (!current || !hasSameDataSafetyRestoreMarkerIdentity(current, marker)) {
        resolve(false);
        return;
      }
      const remove = store.delete(key);
      remove.onerror = () => reject(remove.error ?? new Error('quiescence marker clear failed'));
      remove.onsuccess = () => resolve(true);
    };
  }));
}

async function ownsMarker(marker: LocalBackupUiRestoreQuiescenceMarker): Promise<boolean> {
  const current = await readMarker(marker.ownerUserId);
  return !!current && hasSameDataSafetyRestoreMarkerIdentity(current, marker);
}

async function assertMarkerReadBack(marker: LocalBackupUiRestoreQuiescenceMarker): Promise<void> {
  const current = await readMarker(marker.ownerUserId);
  if (!current || JSON.stringify(current) !== JSON.stringify(marker) || !hasSentinelIdentity(marker)) {
    throw new Error('local backup UI restore quiescence durable read-back verification failed');
  }
}

function markerKey(ownerUserId: string): string {
  return `${LOCAL_BACKUP_UI_RESTORE_QUIESCENCE_MARKER_KIND}:${ownerUserId}`;
}

function toJournalRecord(marker: LocalBackupUiRestoreQuiescenceMarker): JournalRecord {
  return {
    key: markerKey(marker.ownerUserId),
    markerKind: LOCAL_BACKUP_UI_RESTORE_QUIESCENCE_MARKER_KIND,
    ownerUserId: marker.ownerUserId,
    marker,
  };
}

function normalizeJournalRecord(value: unknown, key: string, ownerUserId: string): JournalRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<JournalRecord>;
  const marker = normalizeMarker(record.marker, ownerUserId);
  if (Object.keys(record).sort().join(',') !== 'key,marker,markerKind,ownerUserId'
    || record.key !== key || record.markerKind !== LOCAL_BACKUP_UI_RESTORE_QUIESCENCE_MARKER_KIND
    || record.ownerUserId !== ownerUserId || !marker) return null;
  return { key, markerKind: LOCAL_BACKUP_UI_RESTORE_QUIESCENCE_MARKER_KIND, ownerUserId, marker };
}
async function clearPreMarkerRecoveryRecord(
  ownerUserId: string, expected: JournalRecord | null, rawSentinel: string,
): Promise<boolean> {
  return await runJournalTransaction('readwrite', async store => {
    const [mainRecord, rawRecord] = await readRecoveryRecordsFromStore(store, ownerUserId);
    const current = rawRecord === undefined ? null : normalizeJournalRecord(
      rawRecord, markerKey(ownerUserId), ownerUserId,
    );
    if (mainRecord !== undefined || (expected === null ? rawRecord !== undefined : !current
      || JSON.stringify(current) !== JSON.stringify(expected))
      || requireLocalStorage().getItem(getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId))
        !== rawSentinel
      || readActiveLocalBackupUiRestoreWriters(ownerUserId).length > 0) return false;
    if (rawRecord === undefined) return true;
    await requestResult(store.delete(markerKey(ownerUserId)), 'quiescence marker clear failed');
    return true;
  });
}
function readRecoveryRecords(ownerUserId: string): Promise<[unknown, unknown]> {
  return runJournalTransaction('readonly', store => readRecoveryRecordsFromStore(store, ownerUserId));
}
function readRecoveryRecordsFromStore(store: IDBObjectStore, ownerUserId: string): Promise<[unknown, unknown]> {
  return Promise.all([
    requestResult(store.get(`${LOCAL_BACKUP_UI_RESTORE_MARKER_KIND}:${ownerUserId}`), 'restore marker read failed'),
    requestResult(store.get(markerKey(ownerUserId)), 'quiescence marker read failed'),
  ]);
}
function requestResult<T>(request: IDBRequest<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error(message));
    request.onsuccess = () => resolve(request.result);
  });
}
function preMarkerBlocked(reason: 'active-or-mutated' | 'invalid-evidence') {
  return { status: 'blocked' as const, reason };
}
function classifyPreMarkerEvidence(record: JournalRecord | null,
  marker: LocalBackupUiRestoreQuiescenceMarker, active: boolean, expired: boolean) {
  if (marker.state.startsWith('finalizing-')) return record && expired && !active
    ? { status: 'finalization', evidence: record.marker } as const
    : preMarkerBlocked('active-or-mutated');
  if (marker.state !== 'quiesced') return preMarkerBlocked('invalid-evidence');
  return !expired || active ? preMarkerBlocked('active-or-mutated') : null;
}
function normalizeMarker(
  value: unknown,
  ownerUserId: string,
): LocalBackupUiRestoreQuiescenceMarker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const marker = value as Record<string, unknown>;
  if (Object.keys(marker).sort().join(',')
    !== 'createdAt,leaseExpiresAt,ownerUserId,runId,schemaVersion,state') return null;
  if (marker['schemaVersion'] !== MARKER_SCHEMA_VERSION
    || marker['ownerUserId'] !== ownerUserId
    || !isNonEmptyString(marker['runId'])
    || !isIsoTimestamp(marker['createdAt'])
    || !isIsoTimestamp(marker['leaseExpiresAt'])
    || !isQuiescenceState(marker['state'])) return null;
  return marker as unknown as LocalBackupUiRestoreQuiescenceMarker;
}

function isQuiescenceState(
  value: unknown,
): value is LocalBackupUiRestoreQuiescenceMarker['state'] {
  return value === 'pausing'
    || value === 'quiesced'
    || value === 'finalizing-completed'
    || value === 'finalizing-rolled-back';
}

async function runJournalTransaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openJournalDatabase();
  try {
    const transaction = db.transaction(JOURNAL_STORE_NAME, mode);
    const result = await run(transaction.objectStore(JOURNAL_STORE_NAME));
    await waitForTransaction(transaction);
    return result;
  } finally {
    db.close();
  }
}

function openJournalDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(JOURNAL_DB_NAME, 1);
    request.onerror = () => reject(request.error ?? new Error('quiescence journal open failed'));
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(JOURNAL_STORE_NAME)) {
        request.result.createObjectStore(JOURNAL_STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('quiescence transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('quiescence transaction aborted'));
  });
}

function requireLocalStorage(): Storage {
  if (typeof localStorage === 'undefined') {
    throw new Error('local backup UI restore quiescence requires localStorage');
  }
  return localStorage;
}

function assertOwner(ownerUserId: string): void {
  if (!isNonEmptyString(ownerUserId)) throw new Error('local backup UI restore owner is required');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export const localBackupUiRestoreWriterQuiescence =
  new LocalBackupUiRestoreWriterQuiescenceService();
