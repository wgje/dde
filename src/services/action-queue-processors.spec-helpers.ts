import { Injector, runInInjectionContext } from '@angular/core';
import { expect, vi } from 'vitest';

import {
  ConnectionSyncOperationsService,
  FocusConsoleSyncService,
  ProjectDataService,
  ProjectDeleteCoordinatorService,
  ProjectSaveFlightCoordinatorService,
  RealtimePollingService,
  RetryQueueEnqueueService,
  RetryQueueService,
  TaskSyncOperationsService,
  UserPreferencesSyncService,
} from '../core-bridge';
import { ActionQueueConnectionProcessorsService } from './action-queue-connection-processors.service';
import { ActionQueueAttachmentProcessorsService } from './action-queue-attachment-processors.service';
import { ActionQueueProcessorsService } from './action-queue-processors.service';
import { ActionQueueProjectProcessorsService } from './action-queue-project-processors.service';
import { ActionQueueTaskFocusProcessorsService } from './action-queue-task-focus-processors.service';
import { ActionQueueService, type ActionQueueProcessorResult } from './action-queue.service';
import type { QueuedAction as QueuedActionModel } from './action-queue.types';
import { AuthService } from './auth.service';
import { ConflictStorageService } from './conflict-storage.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';

export type QueuedAction = Omit<Partial<QueuedActionModel>, 'payload'> & { payload: unknown };
type RegisteredProcessor = (action: QueuedActionModel) => Promise<ActionQueueProcessorResult>;
export type QueueSettlementSummary = {
  processed: number;
  failed: number;
  movedToDeadLetter: number;
  remaining: number;
  remoteSuccessCount: number;
  resolvedNoOpCount: number;
};
type MockRetryQueueItem = {
  type: 'project' | 'task' | 'connection';
  operation?: 'upsert' | 'delete';
  data: { id: string; syncSource?: string; name?: string; title?: string; source?: string; target?: string };
  sourceUserId: string;
  projectId?: string;
  taskIdsToDelete?: string[];
  operationId?: string;
};

export const mockLoggerCategory = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};
const mockLoggerService = { category: vi.fn(() => mockLoggerCategory) };

export const mockActionQueueService = {
  registerProcessor: vi.fn(),
  setQueueProcessCallbacks: vi.fn(),
  markActionSyncedRemotely: vi.fn(),
  markActionResolvedWithoutRemote: vi.fn(),
  moveToDeadLetter: vi.fn(),
  deferRetry: vi.fn((error) => ({ outcome: 'defer-retry', error })),
  failRetry: vi.fn((error) => ({ outcome: 'failed', error })),
  discardActions: vi.fn(),
  settleProjectDeleteSuccessForOwner: vi.fn().mockResolvedValue(1),
  enqueueForOwner: vi.fn().mockResolvedValue('queued-owner-action'),
  getCurrentQueueViewGeneration: vi.fn(() => 1),
  getProjectMutationViewGeneration: vi.fn(() => 0),
  isQueueViewCurrent: vi.fn(() => true),
};

const mockAttachmentProcessors = {
  setupProcessors: vi.fn(() => {
    mockActionQueueService.registerProcessor('attachment:create', vi.fn().mockResolvedValue(true));
  }),
};

export const mockRetryQueueService = {
  removeByProjectId: vi.fn(),
  getItems: vi.fn(() => []),
  findItemForOwner: vi.fn<(...args: unknown[]) => MockRetryQueueItem | undefined>(() => undefined),
};

// saveProjectSmart 已重命名为 ProjectSaveFlightCoordinatorService.save；二者共享同一 spy 以维持既有断言
const saveProjectResultFn = vi.fn().mockResolvedValue({ success: true, newVersion: 2 });
export const mockSyncService = {
  pauseRealtimeUpdates: vi.fn(),
  resumeRealtimeUpdates: vi.fn(),
  hasPendingRetryRecovery: vi.fn(() => false),
  markSyncRecoveredIfIdle: vi.fn(),
  save: saveProjectResultFn,
  saveProjectSmart: saveProjectResultFn,
  loadFullProjectOptimized: vi.fn().mockResolvedValue(null),
  deleteProjectFromCloud: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  pushTask: vi.fn().mockResolvedValue(true),
  pushConnection: vi.fn().mockResolvedValue(true),
  deleteTask: vi.fn().mockResolvedValue(true),
  saveUserPreferences: vi.fn().mockResolvedValue(true),
  saveFocusSession: vi.fn().mockResolvedValue({ ok: true }),
  upsertRoutineTask: vi.fn().mockResolvedValue({ ok: true }),
  incrementRoutineCompletion: vi.fn().mockResolvedValue({ ok: true }),
};

export const mockProjectStateService = {
  updateProjects: vi.fn(),
  getProject: vi.fn<(projectId: string) => { id: string; syncSource?: string } | undefined>(() => undefined),
};
export const mockAuthService = { currentUserId: vi.fn<() => string | null>(() => 'test-user') };
export const mockConflictStorageService = { saveConflict: vi.fn().mockResolvedValue(true) };
export const mockToastService = { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() };

/** Retrieve the handler registered for a given action type */
export function getProcessor(type: string): (action: QueuedAction) => Promise<ActionQueueProcessorResult> {
  const call = mockActionQueueService.registerProcessor.mock.calls.find(
    (c: unknown[]) => c[0] === type,
  ) as [string, RegisteredProcessor] | undefined;
  if (!call) throw new Error(`No processor registered for "${type}"`);
  return call[1] as unknown as (action: QueuedAction) => Promise<ActionQueueProcessorResult>;
}

export function getSettledCallback(): (summary: QueueSettlementSummary) => void {
  const settledCallback = mockActionQueueService.setQueueProcessCallbacks.mock.calls[0]?.[2] as
    | ((summary: QueueSettlementSummary) => void)
    | undefined;

  expect(settledCallback).toBeTypeOf('function');
  if (!settledCallback) {
    throw new Error('Expected queue settled callback to be registered');
  }

  return settledCallback;
}

function resetProcessorHarnessMocks(): void {
  mockAuthService.currentUserId.mockReturnValue('test-user');
  mockProjectStateService.getProject.mockReturnValue(undefined);
  mockSyncService.saveProjectSmart.mockResolvedValue({ success: true, newVersion: 2 });
  mockSyncService.loadFullProjectOptimized.mockResolvedValue(null);
  mockSyncService.deleteProjectFromCloud.mockResolvedValue({ ok: true, value: undefined });
  mockSyncService.pushTask.mockResolvedValue(true);
  mockSyncService.pushConnection.mockResolvedValue(true);
  mockSyncService.deleteTask.mockResolvedValue(true);
  mockSyncService.saveUserPreferences.mockResolvedValue(true);
  mockSyncService.saveFocusSession.mockResolvedValue({ ok: true });
  mockSyncService.upsertRoutineTask.mockResolvedValue({ ok: true });
  mockSyncService.incrementRoutineCompletion.mockResolvedValue({ ok: true });
  mockSyncService.hasPendingRetryRecovery.mockReset();
  mockSyncService.hasPendingRetryRecovery.mockReturnValue(false);
  mockSyncService.markSyncRecoveredIfIdle.mockReset();
  mockRetryQueueService.findItemForOwner.mockReturnValue(undefined);
  mockConflictStorageService.saveConflict.mockResolvedValue(true);
  mockActionQueueService.getCurrentQueueViewGeneration.mockReturnValue(1);
  mockActionQueueService.getProjectMutationViewGeneration.mockReset();
  mockActionQueueService.getProjectMutationViewGeneration.mockReturnValue(0);
  mockActionQueueService.isQueueViewCurrent.mockReturnValue(true);
  mockActionQueueService.settleProjectDeleteSuccessForOwner.mockResolvedValue(1);
}

function createActionQueueProcessorsInjector(): Injector {
  return Injector.create({
    providers: [
      { provide: ActionQueueProcessorsService, useClass: ActionQueueProcessorsService },
      { provide: ActionQueueProjectProcessorsService, useClass: ActionQueueProjectProcessorsService },
      { provide: ActionQueueConnectionProcessorsService, useClass: ActionQueueConnectionProcessorsService },
      { provide: ActionQueueTaskFocusProcessorsService, useClass: ActionQueueTaskFocusProcessorsService },
      { provide: ActionQueueAttachmentProcessorsService, useValue: mockAttachmentProcessors },
      { provide: LoggerService, useValue: mockLoggerService },
      { provide: ActionQueueService, useValue: mockActionQueueService },
      { provide: TaskSyncOperationsService, useValue: mockSyncService },
      { provide: ConnectionSyncOperationsService, useValue: mockSyncService },
      { provide: RealtimePollingService, useValue: mockSyncService },
      { provide: RetryQueueEnqueueService, useValue: mockSyncService },
      { provide: ProjectSaveFlightCoordinatorService, useValue: mockSyncService },
      { provide: ProjectDeleteCoordinatorService, useValue: mockSyncService },
      { provide: ProjectDataService, useValue: mockSyncService },
      { provide: UserPreferencesSyncService, useValue: mockSyncService },
      { provide: FocusConsoleSyncService, useValue: mockSyncService },
      { provide: RetryQueueService, useValue: mockRetryQueueService },
      { provide: ProjectStateService, useValue: mockProjectStateService },
      { provide: AuthService, useValue: mockAuthService },
      { provide: ConflictStorageService, useValue: mockConflictStorageService },
      { provide: ToastService, useValue: mockToastService },
    ],
  });
}

export function setupActionQueueProcessorsHarness(): {
  service: ActionQueueProcessorsService;
  injector: Injector;
} {
  vi.clearAllMocks();
  resetProcessorHarnessMocks();

  const injector = createActionQueueProcessorsInjector();
  const service = runInInjectionContext(injector, () => injector.get(ActionQueueProcessorsService));
  service.setProjectConflictHandler(vi.fn());
  service.setupProcessors();

  return { service, injector };
}
