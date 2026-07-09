import type { ActionQueueOwnerStorageRuntime } from './action-queue-owner-storage.types';
import type { CategoryLogger } from './logger.service';
import type { QueueBackupService } from './queue-backup.service';
import type { ToastService } from './toast.service';

export interface ActionQueueOwnerStorageWriteFailureDeps {
  queueBackup: Pick<QueueBackupService, 'backupQueue'>;
  logger: Pick<CategoryLogger, 'warn'>;
  toast: Pick<ToastService, 'warning'>;
  getCurrentOwnerUserId: () => string;
  invalidateLocalQueueSnapshot: (ownerUserId?: string) => void;
}

export function handleOwnerQueueQuotaExceeded(
  runtime: ActionQueueOwnerStorageRuntime,
  deps: ActionQueueOwnerStorageWriteFailureDeps,
): void {
  const currentQueue = runtime.pendingActions();
  const ownerUserId = deps.getCurrentOwnerUserId();
  warnSafely(deps.logger, 'LocalStorage 配额不足，启用队列冻结保护');
  runtime.freezeQueueWrites('quota_exceeded');
  void deps.queueBackup.backupQueue(currentQueue, ownerUserId).then(success => {
    if (success) {
      runBackupSuccessSideEffect(deps, ownerUserId, 'invalidate-local-queue-snapshot', () => {
        deps.invalidateLocalQueueSnapshot(ownerUserId);
      });
      runBackupSuccessSideEffect(deps, ownerUserId, 'quota-warning-toast', () => {
        deps.toast.warning('存储空间不足', '同步队列已冻结。请释放浏览器存储后继续写入。', {
          duration: 10000,
        });
      });
      return;
    }

    enterQueueBackupFailedMode(runtime);
  }).catch((error: unknown) => {
    warnSafely(deps.logger, 'IndexedDB 队列备份失败，进入存储逃生模式', {
      ownerUserId,
      error,
    });
    enterQueueBackupFailedMode(runtime);
  });
}

export function handleOwnerQueueLocalStorageWriteFailure(
  runtime: ActionQueueOwnerStorageRuntime,
  error: unknown,
  deps: ActionQueueOwnerStorageWriteFailureDeps,
): void {
  const ownerUserId = deps.getCurrentOwnerUserId();
  const currentQueue = runtime.pendingActions();
  void deps.queueBackup.backupQueue(currentQueue, ownerUserId).then(success => {
    if (success) {
      runBackupSuccessSideEffect(deps, ownerUserId, 'invalidate-local-queue-snapshot', () => {
        deps.invalidateLocalQueueSnapshot(ownerUserId);
      });
      return;
    }

    enterQueueBackupFailedMode(runtime);
  }).catch((backupError: unknown) => {
    warnSafely(deps.logger, 'localStorage 队列写入失败且 IndexedDB 队列备份失败，进入存储逃生模式', {
      ownerUserId,
      error,
      backupError,
    });
    enterQueueBackupFailedMode(runtime);
  });
}

function runBackupSuccessSideEffect(
  deps: ActionQueueOwnerStorageWriteFailureDeps,
  ownerUserId: string,
  step: string,
  run: () => void,
): void {
  try {
    run();
  } catch (error) {
    warnSafely(deps.logger, 'owner-scoped 队列备份成功后的后续处理失败，已保留备份成功状态', {
      ownerUserId,
      step,
      error,
    });
  }
}

function enterQueueBackupFailedMode(runtime: ActionQueueOwnerStorageRuntime): void {
  runtime.freezeQueueWrites('backup_failed');
  runtime.triggerStorageFailureEscapeMode();
}

function warnSafely(
  logger: Pick<CategoryLogger, 'warn'>,
  message: string,
  data?: unknown,
): void {
  try {
    logger.warn(message, data);
  } catch {
    // Logging failures must not convert a successful queue backup into storage escape mode.
  }
}
