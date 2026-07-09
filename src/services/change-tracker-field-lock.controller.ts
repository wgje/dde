import type { CategoryLogger } from './logger.service';
import {
  collectLockedTaskFields,
  collectProjectFieldLockKeys,
  collectTaskFieldLockKeys,
  createFieldLockData,
  makeFieldLockKey,
  resolveFieldLockState,
  type FieldLockValue,
} from './change-tracker-field-lock.helpers';

interface ChangeTrackerFieldLockControllerOptions {
  fieldLocks: Map<string, FieldLockValue>;
  logger: Pick<CategoryLogger, 'debug' | 'warn'>;
  persistFieldLocks: () => void;
  defaultLockTimeoutMs: number;
}

export class ChangeTrackerFieldLockController {
  constructor(private readonly options: ChangeTrackerFieldLockControllerOptions) {}

  lockTaskField(taskId: string, projectId: string, field: string, durationMs?: number): void {
    const key = makeFieldLockKey(projectId, taskId, field);
    const lockData = createFieldLockData(
      Date.now(),
      durationMs ?? this.options.defaultLockTimeoutMs,
    );
    this.options.fieldLocks.set(key, lockData);
    this.options.persistFieldLocks();
    this.options.logger.debug('锁定任务字段', { taskId, projectId, field, durationMs: lockData.duration });
  }

  unlockTaskField(taskId: string, projectId: string, field: string): void {
    const key = makeFieldLockKey(projectId, taskId, field);
    this.options.fieldLocks.delete(key);
    this.options.persistFieldLocks();
    this.options.logger.debug('解锁任务字段', { taskId, projectId, field });
  }

  unlockAllTaskFields(taskId: string, projectId: string): void {
    const keysToDelete = collectTaskFieldLockKeys(this.options.fieldLocks, projectId, taskId);
    for (const key of keysToDelete) {
      this.options.fieldLocks.delete(key);
    }
    if (keysToDelete.length > 0) {
      this.options.persistFieldLocks();
      this.options.logger.debug('解锁任务所有字段', { taskId, projectId, fieldCount: keysToDelete.length });
    }
  }

  isTaskFieldLocked(taskId: string, projectId: string, field: string): boolean {
    const key = makeFieldLockKey(projectId, taskId, field);
    const lockData = this.options.fieldLocks.get(key);
    if (!lockData) {
      return false;
    }

    const state = resolveFieldLockState(
      lockData,
      Date.now(),
      this.options.defaultLockTimeoutMs,
    );
    if (!state.locked) {
      this.options.fieldLocks.delete(key);
      this.options.persistFieldLocks();
      this.options.logger.warn('字段锁超时自动解锁', {
        taskId,
        projectId,
        field,
        elapsed: state.elapsed,
        duration: state.duration,
      });
      return false;
    }
    return true;
  }

  getLockedFields(taskId: string, projectId: string): string[] {
    const { expiredKeys, lockedFields } = collectLockedTaskFields(
      this.options.fieldLocks,
      projectId,
      taskId,
      Date.now(),
      this.options.defaultLockTimeoutMs,
    );
    for (const key of expiredKeys) {
      this.options.fieldLocks.delete(key);
    }
    if (expiredKeys.length > 0) {
      this.options.persistFieldLocks();
    }
    return lockedFields;
  }

  clearProjectFieldLocks(projectId: string): void {
    const keysToDelete = collectProjectFieldLockKeys(this.options.fieldLocks, projectId);
    for (const key of keysToDelete) {
      this.options.fieldLocks.delete(key);
    }
    if (keysToDelete.length > 0) {
      this.options.persistFieldLocks();
      this.options.logger.debug('清理项目字段锁', { projectId, lockCount: keysToDelete.length });
    }
  }
}
