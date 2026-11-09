/**
 * ActionQueueProcessorsService 的「队列重试错误 / no-op 分类」纯函数模块。
 *
 * 从 ActionQueueProcessorsService「下切」出的无状态错误塑形与分类工具：把队列动作的
 * 各类失败结果包装成统一的 QueueRetryError / Error 形态，并识别可静默跳过的 no-op 终态
 * 与「浏览器网络挂起」延后类错误。
 *
 * 职责单一、纯函数（无 `this`、无副作用）：
 * - resolveActionSourceUserId：从多个候选里取首个非空 userId
 * - buildOperationErrorMessage / buildOperationError：OperationError → 带 code/details 的 Error
 * - buildPartialRetryHandoffError / buildAuthPendingRetryError：部分回放交接 / 认证未就绪重试错误
 * - buildTaskSyncRetryError / buildTaskProcessorRetryError：任务同步 / 处理器失败重试错误
 * - buildProjectSyncRetryError / buildProjectProcessorRetryError：项目同步 / 处理器失败重试错误
 * - isDeferredQueueError：识别「浏览器网络挂起」等应延后而非失败的错误
 * - isTaskTombstoneNoOp / isTaskRemoteConflictNoOp / isStaleTaskUpsertNoOp：可静默跳过的任务 tombstone 终态
 *
 * 为什么抽离：AGENTS.md §12 单文件 ≤ 800 行硬线；ActionQueueProcessorsService 长期越界，
 * 这些纯错误塑形/分类工具自洽且零依赖服务态，适合先行下切。
 */
import { Project } from '../models';
import type { QueueRetryError } from './action-queue-storage.service';
import { isPermanentFailureError } from '../utils/permanent-failure-error';

/** 项目同步结果形态（pushProjectWithResult 的返回契约）。 */
export type ProjectSyncResult = {
  success: boolean;
  conflict?: boolean;
  remoteData?: Project;
  newVersion?: number;
  projectPushed?: boolean;
  failedTaskIds?: string[];
  failedConnectionIds?: string[];
  retryEnqueued?: string[];
  failureReason?: string;
  terminal?: boolean;
  partialRetryHandoff?: boolean;
};

export function resolveActionSourceUserId(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  return null;
}

export function buildOperationErrorMessage(error: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): string {
  const parts = [error.code, error.message];
  const errorType = typeof error.details?.['errorType'] === 'string'
    ? String(error.details['errorType'])
    : null;
  const errorCode = error.details?.['errorCode'];

  if (errorType || errorCode) {
    parts.push(`[${[errorType, errorCode].filter(Boolean).join(':')}]`);
  }

  return parts.filter(part => typeof part === 'string' && part.length > 0).join(' | ');
}

export function buildOperationError(error: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): Error & { code: string; details?: Record<string, unknown> } {
  const queueError = new Error(buildOperationErrorMessage(error)) as Error & {
    code: string;
    details?: Record<string, unknown>;
  };
  queueError.code = error.code;
  queueError.details = error.details;
  return queueError;
}

export function buildPartialRetryHandoffError(result: ProjectSyncResult): {
  code: string;
  message: string;
  details: Record<string, unknown>;
} {
  return {
    code: 'SYNC_RETRY_HANDOFF_PENDING',
    message: result.failureReason ?? '项目部分同步结果仍需由 ActionQueue 下一轮回放收口',
    details: {
      reason: 'partial-retry-handoff',
      projectPushed: result.projectPushed ?? null,
      failedTaskCount: result.failedTaskIds?.length ?? 0,
      failedConnectionCount: result.failedConnectionIds?.length ?? 0,
    },
  };
}

export function buildAuthPendingRetryError(actionType: string, entityId: string): QueueRetryError {
  return {
    code: 'SYNC_AUTH_PENDING',
    message: '认证状态尚未就绪，请稍后重试',
    details: {
      reason: 'auth-pending',
      actionType,
      entityId,
      ...(actionType.startsWith('project:') ? { projectId: entityId } : { taskId: entityId }),
    },
  };
}

export function buildTaskSyncRetryError(
  actionType: 'task:create' | 'task:update' | 'task:delete',
  taskId: string,
  projectId: string,
): QueueRetryError {
  return {
    code: 'SYNC_TASK_WRITE_FAILED',
    message: `${actionType} 未完成，且未发现 RetryQueue 接管项`,
    details: {
      reason: 'task-sync-failed',
      actionType,
      taskId,
      projectId,
    },
  };
}

export function buildTaskProcessorRetryError(
  error: unknown,
  actionType: 'task:create' | 'task:update' | 'task:delete',
  taskId: string,
  projectId: string,
): QueueRetryError {
  const maybeError = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown; details?: unknown }
    : null;
  const details = maybeError?.details && typeof maybeError.details === 'object'
    ? maybeError.details as Record<string, unknown>
    : {};

  return {
    code: typeof maybeError?.code === 'string' ? maybeError.code : undefined,
    message: error instanceof Error
      ? error.message
      : typeof maybeError?.message === 'string'
        ? maybeError.message
        : String(error ?? `${actionType} 未提供失败原因`),
    details: {
      ...details,
      reason: details['reason'] ?? 'task-processor-failed',
      actionType,
      taskId,
      projectId,
    },
  };
}

export function buildProjectSyncRetryError(
  result: ProjectSyncResult,
  actionType: 'project:create' | 'project:update',
  projectId: string,
): QueueRetryError {
  return {
    code: 'SYNC_PROJECT_WRITE_FAILED',
    message: result.failureReason?.trim() || `${actionType} 未提供失败原因`,
    details: {
      reason: 'project-sync-failed',
      actionType,
      projectId,
      projectPushed: result.projectPushed ?? null,
      failedTaskIds: result.failedTaskIds ?? [],
      failedConnectionIds: result.failedConnectionIds ?? [],
      retryEnqueued: result.retryEnqueued ?? [],
    },
  };
}

export function buildProjectProcessorRetryError(
  error: unknown,
  actionType: 'project:create' | 'project:update',
  projectId: string,
): QueueRetryError {
  const maybeError = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown; details?: unknown }
    : null;
  const details = maybeError?.details && typeof maybeError.details === 'object'
    ? maybeError.details as Record<string, unknown>
    : {};

  return {
    code: typeof maybeError?.code === 'string' ? maybeError.code : undefined,
    message: error instanceof Error
      ? error.message
      : typeof maybeError?.message === 'string'
        ? maybeError.message
        : String(error ?? `${actionType} 未提供失败原因`),
    details: {
      ...details,
      reason: details['reason'] ?? 'project-processor-failed',
      actionType,
      projectId,
    },
  };
}

export function isDeferredQueueError(error: unknown): boolean {
  const details = (error as { details?: Record<string, unknown> } | null)?.details;
  if (details?.['reason'] === 'browser-network-suspended') {
    return true;
  }

  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error
    ? error.message
    : String((error as { message?: unknown } | null)?.message ?? error ?? '');
  const normalized = `${String(code ?? '')} ${message}`.toLowerCase();

  return normalized.includes('browser-network-suspended')
    || normalized.includes('browsernetworksuspendederror')
    || normalized.includes('network io suspended')
    || (String(code ?? '') === 'SYNC_OFFLINE' && message.includes('浏览器恢复连接中'))
    || normalized.includes('sync_offline') && message.includes('浏览器恢复连接中');
}

export function isTaskTombstoneNoOp(error: unknown): boolean {
  return isPermanentFailureError(error)
    && error.context?.['operation'] === 'pushTaskTombstone';
}

export function isTaskRemoteConflictNoOp(error: unknown): boolean {
  if (!isPermanentFailureError(error) || error.context?.['operation'] !== 'pushTask') {
    return false;
  }

  const originalError = error.originalError as (Error & {
    code?: unknown;
    errorType?: unknown;
  }) | undefined;
  return originalError?.code === 'TASK_REMOTE_TOMBSTONE_NEWER';
}

export function isStaleTaskUpsertNoOp(error: unknown): boolean {
  return isTaskTombstoneNoOp(error) || isTaskRemoteConflictNoOp(error);
}
