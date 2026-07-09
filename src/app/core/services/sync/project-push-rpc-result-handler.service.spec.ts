import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../../models';
import { DataSafetyWriteAuditService } from '../../../../services/data-safety-write-audit.service';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { ToastService } from '../../../../services/toast.service';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { ProjectPushRpcResultHandlerService } from './project-push-rpc-result-handler.service';
import { SyncStateService } from './sync-state.service';

function createProject(id = 'project-rpc-result-handler'): Project {
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

function createService(syncState = { lastSyncTime: '2026-06-27T00:01:00.000Z' }) {
  const loggerCategory = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const injector = Injector.create({
    providers: [
      { provide: ProjectPushRpcResultHandlerService, useClass: ProjectPushRpcResultHandlerService },
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
        useValue: {
          setSyncError: vi.fn(),
          syncState: vi.fn(() => syncState),
        },
      },
      {
        provide: ToastService,
        useValue: {
          warning: vi.fn(),
        },
      },
    ],
  });

  return runInInjectionContext(injector, () => injector.get(ProjectPushRpcResultHandlerService));
}

describe('ProjectPushRpcResultHandlerService', () => {
  it('does not audit a retry queue entry when client unavailable cannot enqueue retry', async () => {
    const recordWrite = vi
      .spyOn(DataSafetyWriteAuditService.prototype, 'recordWrite')
      .mockReturnValue({} as ReturnType<DataSafetyWriteAuditService['recordWrite']>);
    const service = createService();
    const result: SyncRpcResult = {
      status: 'unauthorized',
      reason: 'supabase_client_unavailable',
      raw: null,
    };

    const handled = await service.handle({
      result,
      project: createProject(),
      fromRetryQueue: false,
      enqueueRetry: undefined,
      sourceUserId: 'user-rpc-audit',
      taskIdsToDelete: undefined,
      taskDeleteBaseUpdatedAtMap: undefined,
      operationId: 'op-client-unavailable-no-retry',
      localTimestamp: 1_000,
      lastSyncTimeBefore: '2026-06-27T00:00:00.000Z',
      updatedAtBaseline: '2026-06-27T00:00:00.000Z',
      durableRetryHandler: null,
      normalizeLocalProjectUpdatedAt: vi.fn(),
    });

    expect(handled).toBe(false);
    expect(recordWrite).toHaveBeenCalledWith(expect.objectContaining({
      enteredRetryQueue: false,
      operationId: 'op-client-unavailable-no-retry',
      retryCount: 0,
    }));
  });
});
