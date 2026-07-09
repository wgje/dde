import { describe, expect, it } from 'vitest';
import {
  classifyRetryQueueAuthBoundaryError,
  classifyRetryAttempt,
  classifyRetryQueueItemPreflight,
  isRetryQueueServerPressureError,
  normalizeRetryQueueSliceBudget,
  shouldProcessRetryQueue,
  shouldRecoverStaleProcessingLock,
} from './retry-queue-processing';

describe('retry queue processing helpers', () => {
  it('把挂起型超时与断网/门户类基础设施失败分类为可延后压力（不消耗 retryCount）', () => {
    // P0 回归：弱网核心失败形态（客户端超时/断网/408）若不进延后通道，
    // 回放每轮 +1 retryCount，持续弱网 ~3 分钟即把队列项打入隔离区。
    expect(isRetryQueueServerPressureError(
      Object.assign(new Error('操作超时'), { errorType: 'TimeoutError' }),
    )).toBe(true);
    expect(isRetryQueueServerPressureError(
      Object.assign(new Error('请求超时 (408 Request Timeout)'), { errorType: 'RequestTimeoutError' }),
    )).toBe(true);
    expect(isRetryQueueServerPressureError(
      Object.assign(new TypeError('Failed to fetch'), { errorType: 'NetworkError' }),
    )).toBe(true);
    expect(isRetryQueueServerPressureError(
      Object.assign(new Error('设备处于离线状态'), { errorType: 'OfflineError' }),
    )).toBe(true);
    // 业务拒绝不得混入延后通道
    expect(isRetryQueueServerPressureError(
      Object.assign(new Error('version conflict'), { errorType: 'VersionConflictError' }),
    )).toBe(false);
  });
  it('normalizes retry queue slice budget options', () => {
    expect(normalizeRetryQueueSliceBudget({
      maxItems: 3,
      maxDurationMs: 250,
    })).toEqual({
      maxItems: 3,
      maxDurationMs: 250,
    });

    expect(normalizeRetryQueueSliceBudget({
      maxItems: 0,
      maxDurationMs: -1,
    })).toEqual({
      maxItems: Number.POSITIVE_INFINITY,
      maxDurationMs: Number.POSITIVE_INFINITY,
    });

    expect(normalizeRetryQueueSliceBudget({})).toEqual({
      maxItems: Number.POSITIVE_INFINITY,
      maxDurationMs: Number.POSITIVE_INFINITY,
    });
  });

  it('blocks processing when the app is offline', () => {
    expect(shouldProcessRetryQueue({
      isProcessing: false,
      queueLength: 1,
      hasHandler: true,
      isOnline: false,
      sessionExpired: false,
      circuitBreakerReady: true,
    })).toEqual({ allowed: false, reason: 'offline-or-circuit-open' });
  });

  it('blocks processing when the session is expired', () => {
    expect(shouldProcessRetryQueue({
      isProcessing: false,
      queueLength: 1,
      hasHandler: true,
      isOnline: true,
      sessionExpired: true,
      circuitBreakerReady: true,
    })).toEqual({ allowed: false, reason: 'session-expired' });
  });

  it('allows processing only when queue dependencies are ready', () => {
    expect(shouldProcessRetryQueue({
      isProcessing: false,
      queueLength: 1,
      hasHandler: true,
      isOnline: true,
      sessionExpired: false,
      circuitBreakerReady: true,
    })).toEqual({ allowed: true });
  });

  it('identifies a stale processing lock only after the configured timeout', () => {
    expect(shouldRecoverStaleProcessingLock({
      isProcessing: true,
      lastProcessTime: 1_000,
      now: 121_001,
      timeoutMs: 120_000,
    })).toBe(true);

    expect(shouldRecoverStaleProcessingLock({
      isProcessing: true,
      lastProcessTime: 1_000,
      now: 120_999,
      timeoutMs: 120_000,
    })).toBe(false);
  });

  it('classifies successful attempts as success', () => {
    expect(classifyRetryAttempt({
      success: true,
      retryCount: 4,
      maxRetries: 5,
      terminalFailure: false,
      deferredByBrowserSuspension: false,
      browserSuspendedNow: false,
    })).toEqual({ kind: 'success' });
  });

  it('classifies browser suspension as deferred without incrementing retry count', () => {
    expect(classifyRetryAttempt({
      success: false,
      retryCount: 2,
      maxRetries: 5,
      terminalFailure: false,
      deferredByBrowserSuspension: true,
      browserSuspendedNow: false,
    })).toEqual({ kind: 'deferred-browser-suspension' });
  });

  it('classifies server pressure as deferred without consuming retry budget', () => {
    expect(classifyRetryAttempt({
      success: false,
      retryCount: 4,
      maxRetries: 5,
      terminalFailure: false,
      deferredByBrowserSuspension: false,
      browserSuspendedNow: false,
      serverPressure: true,
    } as Parameters<typeof classifyRetryAttempt>[0] & { serverPressure: true })).toEqual({
      kind: 'deferred-server-pressure',
    });
  });

  it('classifies permanent failures as terminal', () => {
    expect(classifyRetryAttempt({
      success: false,
      retryCount: 1,
      maxRetries: 5,
      terminalFailure: true,
      deferredByBrowserSuspension: false,
      browserSuspendedNow: false,
    })).toEqual({ kind: 'terminal' });
  });

  it('classifies the final retry attempt as exhausted', () => {
    expect(classifyRetryAttempt({
      success: false,
      retryCount: 4,
      maxRetries: 5,
      terminalFailure: false,
      deferredByBrowserSuspension: false,
      browserSuspendedNow: false,
    })).toEqual({ kind: 'retry-exhausted', nextRetryCount: 5 });
  });

  it('classifies remaining failures as retryable with the next count', () => {
    expect(classifyRetryAttempt({
      success: false,
      retryCount: 2,
      maxRetries: 5,
      terminalFailure: false,
      deferredByBrowserSuspension: false,
      browserSuspendedNow: false,
    })).toEqual({ kind: 'retryable', nextRetryCount: 3 });
  });

  it('classifies auth boundary errors as queue-preserving pauses', () => {
    const discardedRefresh = new Error('Auth refresh result was discarded');
    discardedRefresh.name = 'AuthRefreshDiscardedError';

    expect(classifyRetryQueueAuthBoundaryError(discardedRefresh)).toEqual({
      kind: 'pause',
      reason: 'auth-session-boundary',
    });
    expect(classifyRetryQueueAuthBoundaryError({
      status: 401,
      message: 'Unauthorized',
    })).toEqual({
      kind: 'pause',
      reason: 'auth-session-boundary',
    });
  });

  it('classifies retryable auth fetch failures as client-unready pauses', () => {
    const retryableAuthFetch = new Error('Auth request unavailable');
    retryableAuthFetch.name = 'AuthRetryableFetchError';

    expect(classifyRetryQueueAuthBoundaryError(retryableAuthFetch)).toEqual({
      kind: 'pause',
      reason: 'auth-client-unready',
    });
  });

  it('removes task and connection retry items that cannot be scoped to a project', () => {
    expect(classifyRetryQueueItemPreflight({
      item: {
        id: 'queue-task-1',
        type: 'task',
        operation: 'delete',
        data: { id: '11111111-1111-4111-8111-111111111111' },
      },
      existsInQueue: true,
      currentUserId: 'user-1',
      localModeUserId: 'local-user',
      shouldSilentlyDropUnownedLegacyItem: false,
    })).toEqual({ kind: 'remove-terminal', reason: 'missing-project-id' });
  });

  it('removes task upserts that are missing updatedAt before dangerous replay', () => {
    expect(classifyRetryQueueItemPreflight({
      item: {
        id: 'queue-task-2',
        type: 'task',
        operation: 'upsert',
        projectId: 'project-1',
        sourceUserId: 'user-1',
        data: { id: '11111111-1111-4111-8111-111111111111' },
      },
      existsInQueue: true,
      currentUserId: 'user-1',
      localModeUserId: 'local-user',
      shouldSilentlyDropUnownedLegacyItem: false,
    })).toEqual({ kind: 'remove-terminal', reason: 'task-upsert-missing-updated-at' });
  });

  it('removes retry items with corrupted non-string entity ids before replay', () => {
    expect(classifyRetryQueueItemPreflight({
      item: {
        id: 'queue-connection-corrupted',
        type: 'connection',
        operation: 'upsert',
        projectId: 'project-1',
        sourceUserId: 'user-1',
        data: { id: 42 },
      },
      existsInQueue: true,
      currentUserId: 'user-1',
      localModeUserId: 'local-user',
      shouldSilentlyDropUnownedLegacyItem: false,
    })).toEqual({ kind: 'remove-terminal', reason: 'invalid-data-id' });
  });

  it('quarantines legacy retry items when owner metadata is unsafe to replay', () => {
    expect(classifyRetryQueueItemPreflight({
      item: {
        id: 'queue-project-1',
        type: 'project',
        operation: 'upsert',
        data: { id: '11111111-1111-4111-8111-111111111111' },
      },
      existsInQueue: true,
      currentUserId: 'user-1',
      localModeUserId: 'local-user',
      shouldSilentlyDropUnownedLegacyItem: false,
    })).toEqual({
      kind: 'quarantine',
      reason: 'legacy 重试项缺少来源元数据，无法安全判断归属',
    });
  });

  it('allows current-owner retry items with required metadata to replay', () => {
    expect(classifyRetryQueueItemPreflight({
      item: {
        id: 'queue-task-3',
        type: 'task',
        operation: 'upsert',
        projectId: 'project-1',
        sourceUserId: 'user-1',
        data: {
          id: '11111111-1111-4111-8111-111111111111',
          updatedAt: '2026-06-08T00:00:00.000Z',
        },
      },
      existsInQueue: true,
      currentUserId: 'user-1',
      localModeUserId: 'local-user',
      shouldSilentlyDropUnownedLegacyItem: false,
    })).toEqual({ kind: 'process' });
  });
});
