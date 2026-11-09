import { describe, it, expect } from 'vitest';
import {
  createProjectDirectConflictError,
  createProjectClockUncertainError,
  createProjectRpcConflictError,
  createProjectRpcTerminalError,
  createProjectPersistenceTerminalError,
} from './sync-project-errors';
import { isPermanentFailureError } from '../../../../utils/permanent-failure-error';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';

type ErrorWithMeta = Error & { code?: string; isRetryable?: boolean; errorType?: string };

describe('sync-project-errors', () => {
  it('createProjectDirectConflictError: remote-newer 不可重试', () => {
    const err = createProjectDirectConflictError('p1', '2026-01-01', 'remote-newer') as ErrorWithMeta;
    expect(err.name).toBe('VersionConflictError');
    expect(err.code).toBe('PROJECT_REMOTE_NEWER');
    expect(err.isRetryable).toBe(false);
  });

  it('createProjectDirectConflictError: remote-tombstone 使用墓碑 code', () => {
    const err = createProjectDirectConflictError('p1', null, 'remote-tombstone') as ErrorWithMeta;
    expect(err.code).toBe('PROJECT_REMOTE_TOMBSTONE_NEWER');
  });

  it('createProjectClockUncertainError: 可重试', () => {
    const err = createProjectClockUncertainError('p1', null, null) as ErrorWithMeta;
    expect(err.name).toBe('ClockSyncUncertainError');
    expect(err.code).toBe('PROJECT_CLOCK_SYNC_UNCERTAIN');
    expect(err.isRetryable).toBe(true);
  });

  it('createProjectRpcConflictError 返回 PermanentFailureError', () => {
    const result = { status: 'conflict', raw: null } as unknown as SyncRpcResult;
    const err = createProjectRpcConflictError('p1', result);
    expect(isPermanentFailureError(err)).toBe(true);
  });

  it('createProjectRpcTerminalError: unauthorized → 权限错误', () => {
    const result = { status: 'unauthorized', raw: null } as unknown as SyncRpcResult;
    const err = createProjectRpcTerminalError('p1', result, '未授权');
    expect(isPermanentFailureError(err)).toBe(true);
    expect((err.originalError as ErrorWithMeta).code).toBe('SYNC_RPC_UNAUTHORIZED');
  });

  it('createProjectPersistenceTerminalError: 默认业务规则错误', () => {
    const err = createProjectPersistenceTerminalError('p1', '持久化失败');
    expect(isPermanentFailureError(err)).toBe(true);
    expect((err.originalError as ErrorWithMeta).code).toBe('SYNC_PROJECT_PERSISTENCE_FAILED');
  });
});
