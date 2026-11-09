import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type { Connection } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import { isRetryDeferredError } from '../../../../utils/retry-deferred-error';
import { ConnectionSyncRpcResultHandlerService } from './connection-sync-rpc-result-handler.service';
import { SyncStateService } from './sync-state.service';

function createConnection(id = 'connection-rpc-result-handler'): Connection {
  return {
    id,
    source: 'task-source',
    target: 'task-target',
    title: 'Local connection',
    updatedAt: '2026-06-27T00:00:00.000Z',
  } as Connection;
}

function createService() {
  const loggerCategory = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const syncStateService = {
    setSyncError: vi.fn(),
  };
  const injector = Injector.create({
    providers: [
      { provide: ConnectionSyncRpcResultHandlerService, useClass: ConnectionSyncRpcResultHandlerService },
      {
        provide: LoggerService,
        useValue: {
          category: vi.fn(() => loggerCategory),
        },
      },
      {
        provide: SentryLazyLoaderService,
        useValue: {
          captureMessage: vi.fn(),
        },
      },
      {
        provide: SyncStateService,
        useValue: syncStateService,
      },
    ],
  });

  return {
    service: runInInjectionContext(injector, () => injector.get(ConnectionSyncRpcResultHandlerService)),
    syncStateService,
  };
}

describe('ConnectionSyncRpcResultHandlerService', () => {
  it('does not requeue connection writes after sync RPC rejects the client protocol version', async () => {
    const { service, syncStateService } = createService();
    const enqueueRetry = vi.fn().mockResolvedValue(true);
    const result: SyncRpcResult = {
      status: 'client-version-rejected',
      minProtocolVersion: 2,
      raw: null,
    };

    const handled = await service.handleConnectionSyncRpcResult(
      result,
      createConnection('connection-client-version-rejected'),
      'project-client-version-rejected',
      false,
      'user-client-version-rejected',
      {
        discardInvalid: vi.fn(),
        enqueueRetry,
        normalizeUpdatedAt: vi.fn(),
      },
    );

    expect(handled).toBe(false);
    expect(enqueueRetry).not.toHaveBeenCalled();
    expect(syncStateService.setSyncError).toHaveBeenCalledWith('当前客户端同步协议已过期，请刷新后重试');
  });

  it('turns retry-queue remote-newer replay into a terminal conflict with structured evidence', async () => {
    const { service } = createService();
    const enqueueRetry = vi.fn().mockResolvedValue(true);
    const connection = createConnection('connection-remote-newer-replay');
    const result: SyncRpcResult = {
      status: 'remote-newer',
      remoteUpdatedAt: '2026-06-27T01:00:00.000Z',
      reason: 'remote-newer',
      raw: null,
    };

    await expect(service.handleConnectionSyncRpcResult(
      result,
      connection,
      'project-remote-newer-replay',
      true,
      'user-remote-newer-replay',
      {
        discardInvalid: vi.fn(),
        enqueueRetry,
        normalizeUpdatedAt: vi.fn(),
      },
    )).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof PermanentFailureError) || isRetryDeferredError(error)) {
        return false;
      }

      const originalError = error.originalError as { code?: string; details?: unknown } | undefined;
      const details = originalError?.details as Record<string, unknown> | undefined;
      return originalError?.code === 'CONNECTION_REMOTE_NEWER'
        && details?.['connectionId'] === connection.id
        && details?.['projectId'] === 'project-remote-newer-replay'
        && details?.['remoteUpdatedAt'] === '2026-06-27T01:00:00.000Z';
    });
    expect(enqueueRetry).not.toHaveBeenCalled();
  });
});
