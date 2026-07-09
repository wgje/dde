import type { EnqueueParams } from './action-queue.types';

interface ActionQueueFrozenWarningDeps {
  action: EnqueueParams;
  isQueueFrozen: () => boolean;
  getFreezeReason: () => unknown;
  warn: (message: string, context: Record<string, unknown>) => void;
  notifyQueuePressureOnce: (title: string, message: string) => void;
}

export function warnIfActionQueueFrozen({
  action,
  isQueueFrozen,
  getFreezeReason,
  warn,
  notifyQueuePressureOnce,
}: ActionQueueFrozenWarningDeps): void {
  if (!isQueueFrozen()) {
    return;
  }

  safeWarn(warn, '队列处于冻结状态，拒绝未持久化写入', {
    type: action.type,
    entityType: action.entityType,
    entityId: action.entityId,
    reason: getFreezeReason(),
  });
  safeNotifyQueuePressureOnce(
    notifyQueuePressureOnce,
    '同步队列已暂停',
    '当前浏览器存储不可用，本次操作未写入本地队列。请先导出或释放存储空间。',
  );
}

function safeWarn(
  warn: ActionQueueFrozenWarningDeps['warn'],
  message: string,
  context: Record<string, unknown>,
): void {
  try {
    warn(message, context);
  } catch {
    // Queue freeze handling must still reject unsafe writes when logging fails.
  }
}

function safeNotifyQueuePressureOnce(
  notifyQueuePressureOnce: ActionQueueFrozenWarningDeps['notifyQueuePressureOnce'],
  title: string,
  message: string,
): void {
  try {
    notifyQueuePressureOnce(title, message);
  } catch {
    // Toast failures must not turn a frozen-queue rejection into an exception.
  }
}
