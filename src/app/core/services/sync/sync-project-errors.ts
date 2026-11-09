/**
 * sync-project-errors
 *
 * 从 SimpleSyncService「下切」出的项目同步错误工厂（纯函数）。
 *
 * 背景：SimpleSyncService 文件头明确要求只做「下切」——把可独立的私有方法移出门面。
 * 这些 createProjectXxxError 原本是门面里的纯构造方法（不依赖任何 `this` 状态），
 * 迁出后可独立单测，门面仅保留同名薄 delegate 维持调用点不变。
 */
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';

/** 直连推送路径下的版本冲突错误（远端更新 / 远端墓碑更新）。 */
export function createProjectDirectConflictError(
  projectId: string,
  remoteUpdatedAt: string | null,
  reason: 'remote-newer' | 'remote-tombstone',
): Error {
  return Object.assign(
    new Error('版本冲突：数据已被修改，请刷新后重试'),
    {
      name: 'VersionConflictError',
      errorType: 'VersionConflictError',
      code: reason === 'remote-tombstone' ? 'PROJECT_REMOTE_TOMBSTONE_NEWER' : 'PROJECT_REMOTE_NEWER',
      isRetryable: false,
      details: `projectId=${projectId}, remoteUpdatedAt=${remoteUpdatedAt ?? 'unknown'}`,
    },
  );
}

/** 本地时间基线不可确认时延后同步的可重试错误。 */
export function createProjectClockUncertainError(
  projectId: string,
  localUpdatedAt: string | null,
  remoteUpdatedAt: string | null,
): Error {
  return Object.assign(
    new Error('无法确认本地时间基线，已延后同步以避免覆盖远端更新'),
    {
      name: 'ClockSyncUncertainError',
      errorType: 'ClockSyncUncertainError',
      code: 'PROJECT_CLOCK_SYNC_UNCERTAIN',
      isRetryable: true,
      details: `projectId=${projectId}, localUpdatedAt=${localUpdatedAt ?? 'unknown'}, remoteUpdatedAt=${remoteUpdatedAt ?? 'unknown'}`,
    },
  );
}

/** RPC 推送路径下的版本冲突（远端更新）终态失败。 */
export function createProjectRpcConflictError(
  projectId: string,
  result: SyncRpcResult,
): PermanentFailureError {
  const originalError = Object.assign(
    new Error('版本冲突：数据已被修改，请刷新后重试'),
    {
      name: 'VersionConflictError',
      errorType: 'VersionConflictError',
      code: 'SYNC_RPC_REMOTE_NEWER',
    },
  );

  return new PermanentFailureError('Version conflict', originalError, {
    operation: 'pushProject',
    projectId,
    status: result.status,
    remoteUpdatedAt: result.remoteUpdatedAt,
    reason: result.reason,
  });
}

/** RPC 推送路径下的未授权 / 协议拒绝终态失败。 */
export function createProjectRpcTerminalError(
  projectId: string,
  result: SyncRpcResult,
  message: string,
): PermanentFailureError {
  const isPermissionDenied = result.status === 'unauthorized';
  const originalError = Object.assign(
    new Error(message),
    {
      name: isPermissionDenied ? 'PermissionError' : 'BusinessRuleError',
      errorType: isPermissionDenied ? 'PermissionError' : 'BusinessRuleError',
      code: isPermissionDenied ? 'SYNC_RPC_UNAUTHORIZED' : 'SYNC_RPC_PROTOCOL_REJECTED',
    },
  );

  return new PermanentFailureError(
    isPermissionDenied ? 'Project sync unauthorized' : 'Project sync protocol rejected',
    originalError,
    {
      operation: 'pushProject',
      projectId,
      status: result.status,
      reason: result.reason,
      minProtocolVersion: result.minProtocolVersion,
    },
  );
}

/** 项目持久化阶段的终态失败（默认业务规则错误）。 */
export function createProjectPersistenceTerminalError(
  projectId: string,
  message: string,
  errorType: 'PermissionError' | 'BusinessRuleError' = 'BusinessRuleError',
  code = 'SYNC_PROJECT_PERSISTENCE_FAILED',
): PermanentFailureError {
  const originalError = Object.assign(
    new Error(message),
    {
      name: errorType,
      errorType,
      code,
    },
  );

  return new PermanentFailureError('Project sync terminal failure', originalError, {
    operation: 'pushProject',
    projectId,
    code,
  });
}
