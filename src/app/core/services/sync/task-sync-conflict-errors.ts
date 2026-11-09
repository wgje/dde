/**
 * TaskSyncOperationsService 的「任务同步冲突错误」纯函数模块。
 *
 * 从 TaskSyncOperationsService「下切」出的无状态错误构建器：把任务 CAS / sync-RPC
 * 拒绝场景包装成带 errorType/code/isRetryable 元数据的 EnhancedError。
 *
 * 职责单一、纯函数（无 `this`、无副作用）：
 * - createRemoteNewerConflictError：远端版本更新 / 远端 tombstone 更新 → 不可重试版本冲突
 * - createMissingTaskTimestampConflictError：本地缺 updatedAt 被拒 → 不可重试版本冲突
 * - createClockUncertainError：时间基线不可确认 → 可重试延后
 * - isMissingTaskTimestampRejection：识别 sync-RPC「缺任务时间戳」拒绝
 *
 * 为什么抽离：AGENTS.md §12 单文件 ≤ 800 行硬线；TaskSyncOperationsService 长期越界，
 * 这些纯错误构建器自洽且零依赖服务态，适合先行下切。
 */
import { EnhancedError } from '../../../../utils/supabase-error';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';

/** sync-RPC「任务缺少本地更新时间」拒绝原因标记。 */
export const MISSING_TASK_TIMESTAMP_REASON = 'missing_task_timestamp';

export function createRemoteNewerConflictError(
  taskId: string,
  projectId: string,
  remoteUpdatedAt: string | null,
  reason: 'remote-newer' | 'remote-tombstone',
): EnhancedError {
  return Object.assign(
    new Error('版本冲突：数据已被修改，请刷新后重试'),
    {
      name: 'VersionConflictError',
      errorType: 'VersionConflictError',
      code: reason === 'remote-tombstone' ? 'TASK_REMOTE_TOMBSTONE_NEWER' : 'TASK_REMOTE_NEWER',
      isRetryable: false,
      details: `taskId=${taskId}, projectId=${projectId}, remoteUpdatedAt=${remoteUpdatedAt ?? 'unknown'}`,
    },
  ) as EnhancedError;
}

export function createMissingTaskTimestampConflictError(
  taskId: string,
  projectId: string,
  remoteUpdatedAt: string | null,
): EnhancedError {
  return Object.assign(
    new Error('任务缺少本地更新时间，已放弃旧写入并等待远端权威数据覆盖'),
    {
      name: 'VersionConflictError',
      errorType: 'VersionConflictError',
      code: 'TASK_REMOTE_NEWER',
      isRetryable: false,
      details: `taskId=${taskId}, projectId=${projectId}, remoteUpdatedAt=${remoteUpdatedAt ?? 'unknown'}, reason=${MISSING_TASK_TIMESTAMP_REASON}`,
    },
  ) as EnhancedError;
}

export function isMissingTaskTimestampRejection(result: SyncRpcResult): boolean {
  return result.status === 'remote-newer' && result.reason === MISSING_TASK_TIMESTAMP_REASON;
}

export function createClockUncertainError(
  taskId: string,
  projectId: string,
  localUpdatedAt: string | null,
  remoteUpdatedAt: string | null,
): EnhancedError {
  return Object.assign(
    new Error('无法确认本地时间基线，已延后同步以避免覆盖远端更新'),
    {
      name: 'ClockSyncUncertainError',
      errorType: 'ClockSyncUncertainError',
      code: 'TASK_CLOCK_SYNC_UNCERTAIN',
      isRetryable: true,
      details: `taskId=${taskId}, projectId=${projectId}, localUpdatedAt=${localUpdatedAt ?? 'unknown'}, remoteUpdatedAt=${remoteUpdatedAt ?? 'unknown'}`,
    },
  ) as EnhancedError;
}
