import { type FieldLockData } from './change-tracker.types';

export type FieldLockValue = FieldLockData | number;

export interface FieldLockState {
  duration: number;
  elapsed: number;
  locked: boolean;
}

export interface LockedTaskFieldsResult {
  expiredKeys: string[];
  lockedFields: string[];
}

export function makeFieldLockKey(projectId: string, taskId: string, field: string): string {
  return `${projectId}:${taskId}:${field}`;
}

export function createFieldLockData(timestamp: number, duration: number): FieldLockData {
  return { timestamp, duration };
}

export function resolveFieldLockState(
  lockData: FieldLockValue,
  now: number,
  defaultDuration: number,
): FieldLockState {
  const timestamp = typeof lockData === 'number' ? lockData : lockData.timestamp;
  const duration = typeof lockData === 'number' ? defaultDuration : lockData.duration;
  const elapsed = now - timestamp;
  return {
    duration,
    elapsed,
    locked: elapsed <= duration,
  };
}

export function collectLockedTaskFields(
  locks: Map<string, FieldLockValue>,
  projectId: string,
  taskId: string,
  now: number,
  defaultDuration: number,
): LockedTaskFieldsResult {
  const prefix = makeTaskFieldLockPrefix(projectId, taskId);
  const lockedFields: string[] = [];
  const expiredKeys: string[] = [];

  locks.forEach((lockData, key) => {
    if (!key.startsWith(prefix)) return;
    const state = resolveFieldLockState(lockData, now, defaultDuration);
    if (state.locked) {
      lockedFields.push(key.substring(prefix.length));
    } else {
      expiredKeys.push(key);
    }
  });

  return { expiredKeys, lockedFields };
}

export function collectTaskFieldLockKeys(
  locks: Map<string, FieldLockValue>,
  projectId: string,
  taskId: string,
): string[] {
  return collectFieldLockKeysByPrefix(locks, makeTaskFieldLockPrefix(projectId, taskId));
}

export function collectProjectFieldLockKeys(
  locks: Map<string, FieldLockValue>,
  projectId: string,
): string[] {
  return collectFieldLockKeysByPrefix(locks, `${projectId}:`);
}

function makeTaskFieldLockPrefix(projectId: string, taskId: string): string {
  return `${projectId}:${taskId}:`;
}

function collectFieldLockKeysByPrefix(
  locks: Map<string, FieldLockValue>,
  prefix: string,
): string[] {
  const keys: string[] = [];
  locks.forEach((_lockData, key) => {
    if (key.startsWith(prefix)) {
      keys.push(key);
    }
  });
  return keys;
}
