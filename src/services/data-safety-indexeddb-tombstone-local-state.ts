import type { DataSafetyExportPackage } from './data-safety-package';
import {
  readConnectionTombstones,
  readTaskTombstones,
} from './import-backup-data-safety-metadata.helpers';
import {
  CONNECTION_TOMBSTONES_STORAGE_KEY,
  TASK_TOMBSTONES_STORAGE_KEY,
  writeScopedConnectionTombstones,
  writeScopedTaskTombstones,
} from './data-safety-tombstone-storage.helpers';

type UnknownRecord = Record<string, unknown>;

export interface DataSafetyTombstoneLocalStateSnapshot {
  taskTombstonesLocalStorageValue?: string | null;
  connectionTombstonesLocalStorageValue?: string | null;
}

export function collectTombstoneRestoreValidationErrors(pkg: DataSafetyExportPackage): string[] {
  const visibleProjectIds = getRestoreProjectIds(pkg);
  const errors: string[] = [];
  try {
    readTaskTombstones(pkg.localState.taskTombstones, visibleProjectIds);
  } catch (error) {
    errors.push(formatRestoreError(error));
  }
  try {
    readConnectionTombstones(pkg.localState.connectionTombstones, visibleProjectIds);
  } catch (error) {
    errors.push(formatRestoreError(error));
  }
  return errors;
}

export function restoreTombstones(pkg: DataSafetyExportPackage): void {
  const visibleProjectIds = getRestoreProjectIds(pkg);
  const taskTombstones = readTaskTombstones(pkg.localState.taskTombstones, visibleProjectIds);
  const connectionTombstones = readConnectionTombstones(
    pkg.localState.connectionTombstones,
    visibleProjectIds,
  );
  writeScopedTaskTombstones(taskTombstones, visibleProjectIds);
  writeScopedConnectionTombstones(connectionTombstones, visibleProjectIds);
}

export function readTombstoneLocalStateSnapshot(): DataSafetyTombstoneLocalStateSnapshot {
  return {
    taskTombstonesLocalStorageValue: readLocalStorageValue(TASK_TOMBSTONES_STORAGE_KEY),
    connectionTombstonesLocalStorageValue: readLocalStorageValue(CONNECTION_TOMBSTONES_STORAGE_KEY),
  };
}

export async function restoreTombstoneLocalStateSnapshot(
  snapshot: DataSafetyTombstoneLocalStateSnapshot,
  errors: string[],
): Promise<void> {
  if (snapshot.taskTombstonesLocalStorageValue !== undefined) {
    await attemptTombstoneRollback(errors, 'task tombstones localStorage', () => {
      restoreLocalStorageValue(
        TASK_TOMBSTONES_STORAGE_KEY,
        snapshot.taskTombstonesLocalStorageValue ?? null,
      );
    });
  }
  if (snapshot.connectionTombstonesLocalStorageValue !== undefined) {
    await attemptTombstoneRollback(errors, 'connection tombstones localStorage', () => {
      restoreLocalStorageValue(
        CONNECTION_TOMBSTONES_STORAGE_KEY,
        snapshot.connectionTombstonesLocalStorageValue ?? null,
      );
    });
  }
}

export function normalizeMarkerTombstoneRestoreSnapshot(
  value: UnknownRecord,
): DataSafetyTombstoneLocalStateSnapshot | null {
  const taskValue = value['taskTombstonesLocalStorageValue'];
  const connectionValue = value['connectionTombstonesLocalStorageValue'];
  if (!isOptionalNullableString(taskValue) || !isOptionalNullableString(connectionValue)) {
    return null;
  }
  return {
    ...(taskValue === undefined ? {} : { taskTombstonesLocalStorageValue: taskValue }),
    ...(connectionValue === undefined
      ? {}
      : { connectionTombstonesLocalStorageValue: connectionValue }),
  };
}

function getRestoreProjectIds(pkg: DataSafetyExportPackage): Set<string> {
  return new Set(pkg.localData.projects.map(project => project.id));
}

function readLocalStorageValue(key: string): string | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }
  return localStorage.getItem(key);
}

function restoreLocalStorageValue(key: string, value: string | null): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  if (value === null) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, value);
}

async function attemptTombstoneRollback(
  errors: string[],
  label: string,
  action: () => void | Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(`${label}: ${formatRestoreError(error)}`);
  }
}

function formatRestoreError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || isNullableString(value);
}
