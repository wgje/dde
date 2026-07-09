import { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { ProjectDataService } from '../core-bridge';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { ChangeTrackerService } from './change-tracker.service';
import { LoggerService } from './logger.service';
import { PersistSchedulerService } from './persist-scheduler.service';
import { ProjectStateService } from './project-state.service';
import { ProjectSyncOperationsService } from './project-sync-operations.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { SyncCoordinatorRuntimeService } from './sync-coordinator-runtime.service';
import { TabSyncService } from './tab-sync.service';

describe('SyncCoordinatorRuntimeService', () => {
  function createRuntimeHarness() {
    const validateProcessors = vi.fn().mockReturnValue([]);
    const getRegisteredProcessorTypes = vi.fn().mockReturnValue([]);
    const logger = {
      error: vi.fn(),
      info: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: SyncCoordinatorRuntimeService, useClass: SyncCoordinatorRuntimeService },
        {
          provide: ActionQueueService,
          useValue: {
            validateProcessors,
            getRegisteredProcessorTypes,
          },
        },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => 'user-1') } },
        { provide: ChangeTrackerService, useValue: { hasProjectChanges: vi.fn(() => false) } },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => logger),
          },
        },
        {
          provide: PersistSchedulerService,
          useValue: {
            setCallbacks: vi.fn(),
            startLocalAutosave: vi.fn(),
          },
        },
        {
          provide: ProjectDataService,
          useValue: {
            loadOfflineSnapshot: vi.fn(() => []),
            saveOfflineSnapshot: vi.fn(),
          },
        },
        {
          provide: ProjectStateService,
          useValue: {
            projects: vi.fn(() => []),
            updateProjects: vi.fn(),
          },
        },
        {
          provide: ProjectSyncOperationsService,
          useValue: {
            validateAndRebalance: vi.fn(project => project),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
          },
        },
        {
          provide: TabSyncService,
          useValue: {
            setOnDataSyncedCallback: vi.fn(),
          },
        },
      ],
    });

    return {
      service: injector.get(SyncCoordinatorRuntimeService),
      validateProcessors,
    };
  }

  it('requires the attachment create processor before action queue replay is marked ready', () => {
    const { service, validateProcessors } = createRuntimeHarness();

    service.validateRequiredProcessors();

    expect(validateProcessors).toHaveBeenCalledWith(expect.arrayContaining([
      'attachment:create',
    ]));
  });
});
