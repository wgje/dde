import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Project } from '../../../../models';
import { ClockSyncService } from '../../../../services/clock-sync.service';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { SyncRpcClientService } from '../../../../services/sync-rpc-client.service';
import { ToastService } from '../../../../services/toast.service';
import { ProjectDataService } from './project-data.service';
import { ProjectPushRpcResultHandlerService } from './project-push-rpc-result-handler.service';
import { ProjectPushService } from './project-push.service';
import type { DurableRetryHandler } from './project-push.types';
import { SessionManagerService } from './session-manager.service';
import { SyncStateService } from './sync-state.service';

function createProject(id = 'project-client-rejected'): Project {
  return {
    id,
    name: `Project ${id}`,
    description: '',
    tasks: [],
    connections: [],
    createdDate: '2026-06-27T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
  };
}

function createSupabaseClient(userId: string): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: {
            user: { id: userId },
          },
        },
        error: null,
      })),
    },
  } as unknown as SupabaseClient;
}

describe('ProjectPushService', () => {
  it('pushProjectWithResult 缺少 operationId 时应先 durable retry 且不调用 RPC', async () => {
    const loggerCategory = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const durableRetryHandler = vi.fn<DurableRetryHandler>().mockResolvedValue(true);
    const rpcResultHandler = { handle: vi.fn() };
    const syncState = {
      sessionExpired: false,
      lastSyncTime: '2026-06-29T00:00:00.000Z',
    };
    const injector = Injector.create({
      providers: [
        { provide: ProjectPushService, useClass: ProjectPushService },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => loggerCategory),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            syncState: vi.fn(() => syncState),
            setSyncError: vi.fn(),
          },
        },
        {
          provide: SessionManagerService,
          useValue: {
            tryRefreshSession: vi.fn(async () => false),
            isSessionExpiredError: vi.fn(() => false),
            handleAuthErrorWithRefresh: vi.fn(async () => false),
            handleSessionExpired: vi.fn(),
            isRlsPolicyViolation: vi.fn(() => false),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(async (_key: string, executor: () => Promise<boolean>) => executor()),
          },
        },
        {
          provide: ToastService,
          useValue: {
            warning: vi.fn(),
          },
        },
        {
          provide: ClockSyncService,
          useValue: {
            recordServerTimestamp: vi.fn(),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            captureMessage: vi.fn(),
          },
        },
        {
          provide: ProjectDataService,
          useValue: {
            loadFullProjectOptimized: vi.fn(async () => null),
          },
        },
        {
          provide: SyncRpcClientService,
          useValue: {
            isFeatureEnabled: vi.fn(() => false),
            isClientRejected: vi.fn(() => false),
            checkProtocol: vi.fn(),
          },
        },
        {
          provide: ProjectPushRpcResultHandlerService,
          useValue: rpcResultHandler,
        },
      ],
    });
    const service = runInInjectionContext(injector, () => injector.get(ProjectPushService));
    service.getSupabaseClientHandler = vi.fn(async () => createSupabaseClient('user-missing-operation'));
    service.durableRetryHandler = durableRetryHandler;
    const project = createProject('project-missing-operation-id');

    const result = await service.pushProjectWithResult(project, false, 'user-missing-operation');

    expect(result).toEqual({
      success: false,
      retryEnqueued: true,
      failureReason: 'project sync queued for retry',
    });
    expect(rpcResultHandler.handle).not.toHaveBeenCalled();
    expect(durableRetryHandler).toHaveBeenCalledWith(
      'project',
      'upsert',
      project,
      undefined,
      'user-missing-operation',
      undefined,
      undefined,
      undefined,
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    );
  });

  it('pushProjectWithResult 遇到已拒绝的 sync RPC client 且已有 operationId 时应入 durable retry', async () => {
    const loggerCategory = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const durableRetryHandler = vi.fn<DurableRetryHandler>().mockResolvedValue(true);
    const syncState = {
      sessionExpired: false,
      lastSyncTime: '2026-06-27T00:00:00.000Z',
    };
    const injector = Injector.create({
      providers: [
        { provide: ProjectPushService, useClass: ProjectPushService },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => loggerCategory),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            syncState: vi.fn(() => syncState),
            setSyncError: vi.fn(),
          },
        },
        {
          provide: SessionManagerService,
          useValue: {
            tryRefreshSession: vi.fn(async () => false),
            isSessionExpiredError: vi.fn(() => false),
            handleAuthErrorWithRefresh: vi.fn(async () => false),
            handleSessionExpired: vi.fn(),
            isRlsPolicyViolation: vi.fn(() => false),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(async (_key: string, executor: () => Promise<boolean>) => executor()),
          },
        },
        {
          provide: ToastService,
          useValue: {
            warning: vi.fn(),
          },
        },
        {
          provide: ClockSyncService,
          useValue: {
            recordServerTimestamp: vi.fn(),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            captureMessage: vi.fn(),
          },
        },
        {
          provide: ProjectDataService,
          useValue: {
            loadFullProjectOptimized: vi.fn(async () => null),
          },
        },
        {
          provide: SyncRpcClientService,
          useValue: {
            isFeatureEnabled: vi.fn(() => true),
            isClientRejected: vi.fn(() => true),
            checkProtocol: vi.fn(),
          },
        },
        {
          provide: ProjectPushRpcResultHandlerService,
          useValue: {
            handle: vi.fn(),
          },
        },
      ],
    });
    const service = runInInjectionContext(injector, () => injector.get(ProjectPushService));
    service.getSupabaseClientHandler = vi.fn(async () => createSupabaseClient('user-client-rejected'));
    service.durableRetryHandler = durableRetryHandler;
    const project = createProject();

    const result = await service.pushProjectWithResult(
      project,
      false,
      'user-client-rejected',
      undefined,
      undefined,
      'op-project-client-rejected',
    );

    expect(result).toEqual({
      success: false,
      retryEnqueued: true,
      failureReason: 'project sync queued for retry',
    });
    expect(durableRetryHandler).toHaveBeenCalledWith(
      'project',
      'upsert',
      project,
      undefined,
      'user-client-rejected',
      undefined,
      undefined,
      undefined,
      'op-project-client-rejected',
      {
        errorType: 'ClientVersionRejectedError',
        message: '当前客户端同步协议已过期，请刷新后重试',
        remoteOutcome: 'unknown',
        recordedAt: expect.any(Number),
      },
    );
  });
});
