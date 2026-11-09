import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Connection } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { ToastService } from '../../../../services/toast.service';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import type { EnhancedError } from '../../../../utils/supabase-error';
import { ConnectionPushErrorHandlerService } from './connection-push-error-handler.service';
import { RetryQueueService } from './retry-queue.service';

function createEnhancedError(
  message: string,
  errorType: string,
  isRetryable: boolean,
  extras: Partial<EnhancedError> = {},
): EnhancedError {
  return Object.assign(new Error(message), {
    errorType,
    isRetryable,
    ...extras,
  }) as EnhancedError;
}

describe('ConnectionPushErrorHandlerService', () => {
  const connection: Connection = {
    id: 'connection-1',
    source: 'source-task',
    target: 'target-task',
  };
  const loggerCategory = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const retryQueue = {
    recordCircuitFailure: vi.fn(),
  };
  const sentry = {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  };
  const toast = {
    warning: vi.fn(),
  };

  let service: ConnectionPushErrorHandlerService;

  beforeEach(() => {
    vi.clearAllMocks();

    TestBed.configureTestingModule({
      providers: [
        ConnectionPushErrorHandlerService,
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => loggerCategory),
          },
        },
        { provide: RetryQueueService, useValue: retryQueue },
        { provide: SentryLazyLoaderService, useValue: sentry },
        { provide: ToastService, useValue: toast },
      ],
    });

    service = TestBed.inject(ConnectionPushErrorHandlerService);
  });

  it('records retryable failures and enqueues them with remote outcome context', async () => {
    const enqueueRetry = vi.fn(async () => true);
    const error = createEnhancedError('request timed out', 'TimeoutError', true, {
      remoteOutcome: 'unknown',
    });

    const handled = await service.handlePushConnectionError(
      error,
      connection,
      'project-1',
      false,
      'user-1',
      'operation-1',
      enqueueRetry,
    );

    expect(handled).toBe(false);
    expect(retryQueue.recordCircuitFailure).toHaveBeenCalledWith('TimeoutError');
    expect(loggerCategory.debug).toHaveBeenCalledWith(
      '推送连接失败 (TimeoutError)，准备保留到重试队列',
      expect.objectContaining({ connectionId: 'connection-1' }),
    );
    expect(sentry.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        tags: { operation: 'pushConnection' },
        extra: expect.objectContaining({
          connectionId: 'connection-1',
          projectId: 'project-1',
          errorType: 'TimeoutError',
          isRetryable: true,
        }),
      }),
    );
    expect(enqueueRetry).toHaveBeenCalledWith(
      connection,
      'project-1',
      'user-1',
      undefined,
      'operation-1',
      expect.objectContaining({
        errorType: 'TimeoutError',
        message: 'request timed out',
        remoteOutcome: 'unknown',
      }),
    );
  });

  it('turns connection version conflicts into permanent failures', async () => {
    const enqueueRetry = vi.fn(async () => true);
    const error = createEnhancedError('stale connection version', 'VersionConflictError', false);

    await expect(service.handlePushConnectionError(
      error,
      connection,
      'project-1',
      false,
      'user-1',
      'operation-1',
      enqueueRetry,
    )).rejects.toThrow(PermanentFailureError);

    expect(toast.warning).toHaveBeenCalledWith('版本冲突', '数据已被修改，请刷新后重试');
    expect(sentry.captureMessage).toHaveBeenCalledWith(
      'Optimistic lock conflict in pushConnection',
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          operation: 'pushConnection',
          connectionId: 'connection-1',
          projectId: 'project-1',
        }),
      }),
    );
    expect(enqueueRetry).not.toHaveBeenCalled();
  });

  it('rethrows browser suspension errors when already processing retry queue', async () => {
    const enqueueRetry = vi.fn(async () => true);
    const error = createEnhancedError('browser network suspended', 'BrowserNetworkSuspendedError', true);

    await expect(service.handlePushConnectionError(
      error,
      connection,
      'project-1',
      true,
      'user-1',
      'operation-1',
      enqueueRetry,
    )).rejects.toBe(error);

    expect(retryQueue.recordCircuitFailure).not.toHaveBeenCalled();
    expect(enqueueRetry).not.toHaveBeenCalled();
  });

  it('leaves retry replay circuit accounting to the queue runner', async () => {
    const enqueueRetry = vi.fn(async () => true);
    const error = createEnhancedError('gateway unavailable', 'GatewayError', true);

    await expect(service.handlePushConnectionError(
      error,
      connection,
      'project-1',
      true,
      'user-1',
      'operation-1',
      enqueueRetry,
    )).rejects.toBe(error);

    expect(retryQueue.recordCircuitFailure).not.toHaveBeenCalled();
    expect(enqueueRetry).not.toHaveBeenCalled();
  });
});
