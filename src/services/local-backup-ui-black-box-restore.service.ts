import { Injectable, inject } from '@angular/core';

import type { BlackBoxEntry } from '../models/focus';
import type { BackupData } from '../../supabase/functions/_shared/backup-utils';
import { setBlackBoxEntries } from '../state/focus-stores';
import { canonicalizePersistedValue } from './action-queue-identity.helpers';
import { createSyncOperationId } from '../utils/sync-operation-id';
import { BlackBoxSyncService } from './black-box-sync.service';
import type {
  LocalBackupUiBlackBoxPersistedEntry,
  LocalBackupUiBlackBoxRestoreDependencies,
  LocalBackupUiBlackBoxRestoreSnapshot,
} from './local-backup-ui-black-box-restore.types';

export interface PrepareLocalBackupUiBlackBoxRestoreInput {
  ownerUserId: string;
  sourceDigest: string;
  backup: BackupData;
}

@Injectable({ providedIn: 'root' })
export class LocalBackupUiBlackBoxRestoreService {
  private readonly sync = inject(BlackBoxSyncService);
  private readonly dependencies: LocalBackupUiBlackBoxRestoreDependencies = {
    createGeneration: createSyncOperationId,
    withDatabase: operation => this.sync.withLocalRestoreDatabase(operation),
    publish: setBlackBoxEntries,
  };

  prepare(input: PrepareLocalBackupUiBlackBoxRestoreInput): Promise<LocalBackupUiBlackBoxRestoreSnapshot> {
    return prepareLocalBackupUiBlackBoxRestore(input, this.dependencies);
  }

  decode(value: unknown, ownerUserId: string, sourceDigest: string): LocalBackupUiBlackBoxRestoreSnapshot {
    return decodeLocalBackupUiBlackBoxRestoreSnapshot(value, ownerUserId, sourceDigest);
  }

  apply(
    snapshot: LocalBackupUiBlackBoxRestoreSnapshot,
    checkpoint: () => Promise<void>,
  ): Promise<number> {
    return applyLocalBackupUiBlackBoxRestore(snapshot, this.dependencies, checkpoint);
  }

  read(ownerUserId: string): Promise<LocalBackupUiBlackBoxPersistedEntry[]> {
    return readLocalBackupUiBlackBoxRestoreOwnerState(ownerUserId, this.dependencies);
  }

  rollback(
    snapshot: LocalBackupUiBlackBoxRestoreSnapshot,
    checkpoint: () => Promise<void>,
  ): Promise<void> {
    return rollbackLocalBackupUiBlackBoxRestore(snapshot, this.dependencies, checkpoint);
  }
}

export async function prepareLocalBackupUiBlackBoxRestore(
  input: PrepareLocalBackupUiBlackBoxRestoreInput,
  dependencies: LocalBackupUiBlackBoxRestoreDependencies,
): Promise<LocalBackupUiBlackBoxRestoreSnapshot> {
  requireOwnerAndDigest(input.ownerUserId, input.sourceDigest);
  const restored = validateBackupEntries(input.backup, input.ownerUserId);
  const allRows = await readAllRows(dependencies);
  const before = ownerRows(allRows, input.ownerUserId);
  const foreignIds = new Set(allRows.filter(row => row.userId !== input.ownerUserId).map(row => row.id));
  if (restored.some(entry => foreignIds.has(entry.id))) {
    throw new Error('Black Box restore entry collides with a foreign-owner row');
  }
  const targetById = new Map<string, LocalBackupUiBlackBoxPersistedEntry>(
    before.map(entry => [entry.id, entry]),
  );
  for (const entry of restored) {
    const generation = dependencies.createGeneration();
    if (!isUuid(generation)) throw new Error('Black Box restore generation authority returned an invalid value');
    targetById.set(entry.id, { ...entry, _localVersion: generation });
  }
  return {
    schemaVersion: 1,
    ownerUserId: input.ownerUserId,
    sourceDigest: input.sourceDigest,
    before,
    target: sortRows([...targetById.values()]),
  };
}

export async function applyLocalBackupUiBlackBoxRestore(
  snapshot: LocalBackupUiBlackBoxRestoreSnapshot,
  dependencies: LocalBackupUiBlackBoxRestoreDependencies,
  checkpoint: () => Promise<void>,
): Promise<number> {
  const validated = decodeLocalBackupUiBlackBoxRestoreSnapshot(
    snapshot,
    snapshot.ownerUserId,
    snapshot.sourceDigest,
  );
  await checkpoint();
  await mutateExactOwnerState(validated, dependencies, 'apply');
  const readBack = await readLocalBackupUiBlackBoxRestoreOwnerState(
    validated.ownerUserId,
    dependencies,
  );
  if (!sameRows(readBack, validated.target)) {
    throw new Error('Black Box restore durable readback mismatch');
  }
  await checkpoint();
  dependencies.publish(stripLocalVersions(readBack));
  return validated.target.filter(target => (
    !validated.before.some(before => before.id === target.id && sameValue(before, target))
  )).length;
}

export async function readLocalBackupUiBlackBoxRestoreOwnerState(
  ownerUserId: string,
  dependencies: LocalBackupUiBlackBoxRestoreDependencies,
): Promise<LocalBackupUiBlackBoxRestoreSnapshot['before']> {
  if (!ownerUserId) throw new Error('Black Box restore owner is required');
  return ownerRows(await readAllRows(dependencies), ownerUserId);
}

export async function rollbackLocalBackupUiBlackBoxRestore(
  snapshot: LocalBackupUiBlackBoxRestoreSnapshot,
  dependencies: LocalBackupUiBlackBoxRestoreDependencies,
  checkpoint: () => Promise<void>,
): Promise<void> {
  const validated = decodeLocalBackupUiBlackBoxRestoreSnapshot(
    snapshot,
    snapshot.ownerUserId,
    snapshot.sourceDigest,
  );
  await checkpoint();
  await mutateExactOwnerState(validated, dependencies, 'rollback');
  const readBack = await readLocalBackupUiBlackBoxRestoreOwnerState(
    validated.ownerUserId,
    dependencies,
  );
  if (!sameRows(readBack, validated.before)) {
    throw new Error('Black Box restore rollback readback mismatch');
  }
  await checkpoint();
  dependencies.publish(stripLocalVersions(readBack));
}

export function decodeLocalBackupUiBlackBoxRestoreSnapshot(
  value: unknown,
  ownerUserId: string,
  sourceDigest: string,
): LocalBackupUiBlackBoxRestoreSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'ownerUserId', 'sourceDigest', 'before', 'target',
  ]) || value['schemaVersion'] !== 1 || value['ownerUserId'] !== ownerUserId
    || value['sourceDigest'] !== sourceDigest) {
    throw new Error('Black Box restore snapshot is invalid');
  }
  const beforeValue = value['before'];
  const targetValue = value['target'];
  if (!Array.isArray(beforeValue) || !Array.isArray(targetValue)
    || !beforeValue.every(isPersistedEntry) || !targetValue.every(isPersistedEntry)) {
    throw new Error('Black Box restore snapshot is invalid');
  }
  const before = sortRows(beforeValue);
  const target = sortRows(targetValue);
  if (!rowsBelongToOwner(before, ownerUserId) || !rowsBelongToOwner(target, ownerUserId)
    || !uniqueIds(before) || !uniqueIds(target)) {
    throw new Error('Black Box restore snapshot owner or identity is invalid');
  }
  return { schemaVersion: 1, ownerUserId, sourceDigest, before, target };
}

async function mutateExactOwnerState(
  snapshot: LocalBackupUiBlackBoxRestoreSnapshot,
  dependencies: LocalBackupUiBlackBoxRestoreDependencies,
  mode: 'apply' | 'rollback',
): Promise<void> {
  await dependencies.withDatabase((db, storeName) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    let failure: unknown = null;
    request.onerror = () => { failure = request.error; tx.abort(); };
    request.onsuccess = () => {
      try {
        const rows = normalizePersistedRows(request.result);
        const current = ownerRows(rows, snapshot.ownerUserId);
        if (mode === 'apply' && !sameRows(current, snapshot.before)) {
          throw new Error('Black Box restore preimage changed before commit');
        }
        if (mode === 'rollback' && sameRows(current, snapshot.before)) return;
        if (mode === 'rollback' && !sameRows(current, snapshot.target)) {
          throw new Error('Black Box restore successor prevents rollback');
        }
        const replacement = mode === 'apply' ? snapshot.target : snapshot.before;
        const foreignIds = new Set(rows.filter(row => row.userId !== snapshot.ownerUserId).map(row => row.id));
        if (replacement.some(row => foreignIds.has(row.id))) {
          throw new Error('Black Box restore foreign-owner collision');
        }
        for (const row of current) store.delete(row.id);
        for (const row of replacement) store.put(row);
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(failure ?? tx.error ?? new Error('Black Box restore transaction failed'));
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('Black Box restore transaction aborted'));
  }));
}

function readAllRows(
  dependencies: LocalBackupUiBlackBoxRestoreDependencies,
): Promise<LocalBackupUiBlackBoxPersistedEntry[]> {
  return dependencies.withDatabase((db, storeName) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    let rows: LocalBackupUiBlackBoxPersistedEntry[] | null = null;
    request.onsuccess = () => { rows = normalizePersistedRows(request.result); };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => rows === null
      ? reject(new Error('Black Box restore read completed without rows'))
      : resolve(rows);
    tx.onerror = () => reject(tx.error ?? request.error);
    tx.onabort = () => reject(tx.error ?? request.error ?? new Error('Black Box restore read aborted'));
  }));
}

function validateBackupEntries(backup: BackupData, ownerUserId: string): LocalBackupUiBlackBoxPersistedEntry[] {
  const candidateEntries: unknown = backup?.blackBoxEntries;
  if (!Array.isArray(candidateEntries)
    || backup.tableCounts?.blackBoxEntries !== candidateEntries.length) {
    throw new Error('Black Box restore table count is invalid');
  }
  const entries = candidateEntries.map(entry => mapBackupEntry(entry, ownerUserId));
  if (!uniqueIds(entries)) throw new Error('Black Box restore entry IDs must be unique');
  return sortRows(entries);
}

function mapBackupEntry(
  entry: unknown,
  ownerUserId: string,
): LocalBackupUiBlackBoxPersistedEntry {
  if (!isRecord(entry) || !isUuid(entry.id) || entry.userId !== ownerUserId
    || !(entry.projectId === null || isUuid(entry.projectId)) || typeof entry.content !== 'string'
    || !isDate(entry.date) || !isTimestamp(entry.createdAt) || !isTimestamp(entry.updatedAt)
    || typeof entry.isRead !== 'boolean' || typeof entry.isCompleted !== 'boolean'
    || typeof entry.isArchived !== 'boolean'
    || !(entry.deletedAt === null || isTimestamp(entry.deletedAt))
    || !(entry.completedAt === undefined || entry.completedAt === null || isTimestamp(entry.completedAt))
    || !(entry.snoozeUntil === undefined || entry.snoozeUntil === null || isDate(entry.snoozeUntil))
    || !isOptionalNonnegativeInteger(entry.snoozeCount)
    || !(entry.focusMeta === undefined || isJsonValue(entry.focusMeta))) {
    throw new Error('Black Box restore contains a malformed entry');
  }
  const mapped: LocalBackupUiBlackBoxPersistedEntry = {
    id: entry.id, projectId: entry.projectId, userId: ownerUserId, content: entry.content,
    date: entry.date, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
    isRead: entry.isRead, isCompleted: entry.isCompleted, isArchived: entry.isArchived,
    deletedAt: entry.deletedAt,
  };
  copyDefined(mapped, entry, [
    'completedAt', 'snoozeUntil', 'snoozeCount', 'focusMeta',
  ]);
  return mapped;
}

function normalizePersistedRows(value: unknown): LocalBackupUiBlackBoxPersistedEntry[] {
  if (!Array.isArray(value) || !value.every(isPersistedEntry)) {
    throw new Error('Black Box restore durable rows are invalid');
  }
  return sortRows(value.map(row => dropUndefined(row)));
}

function isPersistedEntry(value: unknown): value is LocalBackupUiBlackBoxPersistedEntry {
  return isRecord(value) && isUuid(value['id'])
    && (value['projectId'] === null || isUuid(value['projectId']))
    && typeof value['userId'] === 'string' && value['userId'].length > 0
    && typeof value['content'] === 'string' && isDate(value['date'])
    && isTimestamp(value['createdAt']) && isTimestamp(value['updatedAt'])
    && typeof value['isRead'] === 'boolean' && typeof value['isCompleted'] === 'boolean'
    && typeof value['isArchived'] === 'boolean'
    && (value['deletedAt'] === null || isTimestamp(value['deletedAt']))
    && (value['_localVersion'] === undefined
      || isUuid(value['_localVersion'])
      || Number.isInteger(value['_localVersion']) && (value['_localVersion'] as number) >= 0);
}

function ownerRows(
  rows: LocalBackupUiBlackBoxPersistedEntry[],
  ownerUserId: string,
): LocalBackupUiBlackBoxPersistedEntry[] {
  return sortRows(rows.filter(row => row.userId === ownerUserId));
}
function sortRows(
  rows: LocalBackupUiBlackBoxPersistedEntry[],
): LocalBackupUiBlackBoxPersistedEntry[] {
  return [...rows].map(dropUndefined).sort((left, right) => left.id.localeCompare(right.id));
}
function stripLocalVersions(rows: LocalBackupUiBlackBoxPersistedEntry[]): BlackBoxEntry[] {
  return rows.map(({ _localVersion: _ignored, ...entry }) => entry);
}
function rowsBelongToOwner(rows: LocalBackupUiBlackBoxPersistedEntry[], ownerUserId: string) {
  return rows.every(row => row.userId === ownerUserId);
}
function uniqueIds(rows: LocalBackupUiBlackBoxPersistedEntry[]) {
  return new Set(rows.map(row => row.id)).size === rows.length;
}
function sameRows(left: LocalBackupUiBlackBoxPersistedEntry[], right: LocalBackupUiBlackBoxPersistedEntry[]) {
  return sameValue(sortRows(left), sortRows(right));
}
function sameValue(left: unknown, right: unknown) {
  return canonicalizePersistedValue(left) === canonicalizePersistedValue(right);
}
function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
function copyDefined(target: object, source: object, keys: string[]): void {
  const targetRecord = target as Record<string, unknown>;
  const sourceRecord = source as Record<string, unknown>;
  for (const key of keys) if (sourceRecord[key] !== undefined) targetRecord[key] = sourceRecord[key];
}
function requireOwnerAndDigest(ownerUserId: string, sourceDigest: string): void {
  if (!ownerUserId || !/^sha256:[a-f0-9]{64}$/.test(sourceDigest)) {
    throw new Error('Black Box restore owner or source digest is invalid');
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}
function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value);
}
function isOptionalNonnegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
function isJsonValue(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)
    || Array.isArray(value) && value.every(isJsonValue)
    || isRecord(value) && Object.values(value).every(isJsonValue);
}
