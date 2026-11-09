import {
  Injector,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConfigurableFocusTrapFactory } from '@angular/cdk/a11y';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../models';
import { SettingsModalComponent } from '../app/shared/modals/settings-modal.component';
import { LocalBackupUIService } from '../app/shared/modals/settings-modal/local-backup-ui.service';
import { SiyuanSettingsUIService } from '../app/shared/modals/settings-modal/siyuan-settings-ui.service';
import { TaskStore, ProjectStore, ConnectionStore } from '../app/core/state/stores';
import { ProjectDataService } from '../core-bridge';
import { ProjectOfflineSnapshotService } from '../app/core/services/sync/project-offline-snapshot.service';
import {
  clearOfflineSnapshotIdb,
  getOfflineSnapshotStorageKey,
  readOfflineSnapshotFromIdb,
} from '../app/core/services/sync/project-data.service.spec-context';
import { createMockDestroyRef } from '../test-setup.mocks';
import {
  createActionQueueServiceTestInjector,
  markActionQueueCurrentOwnerStorageLoadedForTests,
  resetActionQueueServiceMocks,
} from './action-queue-service-test-harness.spec-helpers';
import { ActionQueueService } from './action-queue.service';
import { ActionQueueStorageService } from './action-queue-storage.service';
import { ActionQueueOwnerStorageService } from './action-queue-owner-storage.service';
import { ActionQueueEnqueueMutationService } from './action-queue-enqueue-mutation.service';
import { ActionQueueSyncWriterLeaseService } from './action-queue-sync-writer-lease.service';
import { ActionQueueViewStateService } from './action-queue-view-state.service';
import { ActionQueueSchedulerService } from './action-queue-scheduler.service';
import { AuthService } from './auth.service';
import { DynamicModalService, type ModalRef } from './dynamic-modal.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { ModalLoaderService } from '../app/core/services/modal-loader.service';
import { AppAuthCoordinatorService } from '../app/core/services/app-auth-coordinator.service';
import { ExternalSourceCacheService } from '../app/core/external-sources/external-source-cache.service';
import { SiyuanPreviewService } from '../app/core/external-sources/siyuan/siyuan-preview.service';
import { AttachmentExportService } from './attachment-export.service';
import { AttachmentImportService } from './attachment-import.service';
import { DockEngineService } from './dock-engine.service';
import { ExportService } from './export.service';
import { FocusPreferenceService } from './focus-preference.service';
import { GateService } from './gate.service';
import { GlobalErrorHandler } from './global-error-handler.service';
import { ImportService } from './import.service';
import { LocalBackupService } from './local-backup.service';
import { OptimisticStateService } from './optimistic-state.service';
import { ProjectOperationConflictService } from './project-operation-conflict.service';
import { ProjectOperationService } from './project-operation.service';
import { ProjectStateService } from './project-state.service';
import { PreferenceService } from './preference.service';
import { QueueBackupService } from './queue-backup.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ToastService } from './toast.service';
import { UiStateService } from './ui-state.service';
import { UserSessionService } from './user-session.service';
import { WriteGuardService } from './write-guard.service';
import { ThemeService } from './theme.service';
import { WorkspaceModalCoordinatorService } from './workspace-modal-coordinator.service';

const QUEUE_BACKUP_DB_NAME = 'nanoflow-queue-backup';

function deleteQueueBackupDatabase(): Promise<void> {
  return new Promise(resolve => {
    const request = indexedDB.deleteDatabase(QUEUE_BACKUP_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function createProject(id: string, owner: string): Project {
  return {
    id,
    name: `${owner}-${id}`,
    description: '',
    createdDate: '2026-11-07T00:00:00.000Z',
    tasks: [],
    connections: [],
  };
}

function createQueuedProjectAction(project: ReturnType<typeof createProject>, owner: string) {
  return {
    id: `action-${owner}-${project.id}`,
    operationId: `operation-${owner}-${project.id}`,
    type: 'create' as const,
    entityType: 'project' as const,
    entityId: project.id,
    payload: {
      project: { ...project, syncSource: 'synced' as const, pendingSync: true },
      sourceUserId: owner,
    },
    timestamp: Date.now(),
    localCommittedAt: Date.now(),
    syncState: 'pending_sync' as const,
    retryCount: 0,
    priority: 'normal' as const,
  };
}

function createFileEvent(): Event {
  const file = new File([
    JSON.stringify({ metadata: { version: '1.0.0' }, projects: [] }),
  ], 'project-export.json', { type: 'application/json' });
  return {
    target: { files: [file], value: file.name },
  } as unknown as Event;
}

describe('workspace modal import durable owner integration', () => {
  let currentUserId = signal<string | null>('user-a');
  let sessionGeneration = 1;
  let queueBackup: QueueBackupService;
  let actionQueue: ActionQueueService;
  let projectState: ProjectStateService;
  let projectOps: ProjectOperationService;
  let offlineSnapshots: ProjectOfflineSnapshotService;
  let destroyActionQueue: (() => void) | undefined;
  let dynamicModal: DynamicModalService;
  let coordinator: import('./workspace-modal-coordinator.service').WorkspaceModalCoordinatorService;
  let importService: {
    isImporting: ReturnType<typeof signal<boolean>>;
    validateFile: ReturnType<typeof vi.fn>;
    generatePreview: ReturnType<typeof vi.fn>;
    executeImport: ReturnType<typeof vi.fn>;
  };
  let alertSpy: ReturnType<typeof vi.spyOn>;

  const userSession = {
    currentUserId: () => currentUserId(),
    getCurrentSessionGeneration: () => sessionGeneration,
    isSessionContextCurrent: (generation: number, owner: string | null) => (
      generation === sessionGeneration && owner === currentUserId()
    ),
    isHintOnlyStartupPlaceholderVisible: () => false,
    transitionTo: (owner: string) => {
      sessionGeneration += 1;
      currentUserId.set(owner);
    },
  };
  const authService = {
    currentUserId: () => currentUserId(),
    sessionInitialized: () => true,
    authState: () => ({ isCheckingSession: false }),
    runtimeState: () => 'ready' as const,
    peekPersistedSessionIdentity: () => null,
    peekPersistedOwnerHint: () => null,
    captureAuthIdentityFence: () => `auth:${currentUserId()}`,
  };

  const logger = {
    category: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  };
  const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
  const syncCoordinator = { markLocalChanges: vi.fn(), schedulePersist: vi.fn() };
  const projectData = {
    saveOfflineSnapshot: (projects: unknown[], owner?: string | null) => offlineSnapshots.saveOfflineSnapshot(projects as never, owner),
    saveOfflineSnapshotAndWait: (projects: unknown[], owner?: string | null) => offlineSnapshots.saveOfflineSnapshotAndWait(projects as never, owner),
  };

  beforeEach(async () => {
    resetActionQueueServiceMocks();
    currentUserId = signal<string | null>('user-a');
    sessionGeneration = 1;
    localStorage.clear();
    alertSpy = vi.spyOn(globalThis, 'alert').mockImplementation(() => undefined);
    await deleteQueueBackupDatabase();

    const { destroyRef, destroy } = createMockDestroyRef();
    destroyActionQueue = destroy;
    const queueParent = createActionQueueServiceTestInjector(currentUserId, destroyRef);
    const writerInjector = Injector.create({
      parent: queueParent,
      providers: [
        { provide: QueueBackupService, useClass: QueueBackupService },
        { provide: ActionQueueService, useClass: ActionQueueService },
        { provide: ActionQueueStorageService, useClass: ActionQueueStorageService },
        { provide: ActionQueueOwnerStorageService, useClass: ActionQueueOwnerStorageService },
        { provide: ActionQueueEnqueueMutationService, useClass: ActionQueueEnqueueMutationService },
        { provide: ActionQueueSyncWriterLeaseService, useClass: ActionQueueSyncWriterLeaseService },
        { provide: ActionQueueViewStateService, useClass: ActionQueueViewStateService },
        { provide: ActionQueueSchedulerService, useClass: ActionQueueSchedulerService },
        { provide: AuthService, useValue: authService },
        { provide: UserSessionService, useValue: userSession },
        { provide: TaskStore, useClass: TaskStore },
        { provide: ProjectStore, useClass: ProjectStore },
        { provide: ConnectionStore, useClass: ConnectionStore },
        { provide: ProjectStateService, useClass: ProjectStateService },
        { provide: UiStateService, useValue: { filterMode: () => 'all', clearAllState: vi.fn(), clearSearch: vi.fn() } },
        { provide: ProjectOfflineSnapshotService, useClass: ProjectOfflineSnapshotService },
        {
          provide: ProjectDataService,
          useFactory: () => ({
            saveOfflineSnapshot: projectData.saveOfflineSnapshot,
            saveOfflineSnapshotAndWait: projectData.saveOfflineSnapshotAndWait,
          }),
        },
        { provide: SyncCoordinatorService, useValue: syncCoordinator },
        { provide: OptimisticStateService, useValue: {
          createSnapshot: vi.fn(() => ({ id: `snapshot-${Date.now()}` })),
          commitSnapshot: vi.fn(),
          rollbackSnapshot: vi.fn(),
          discardSnapshot: vi.fn(),
        } },
        { provide: LayoutService, useValue: { rebalance: (project: unknown) => project } },
        { provide: WriteGuardService, useValue: { isExportOnly: () => false } },
        { provide: ToastService, useValue: toast },
        { provide: LoggerService, useValue: logger },
        { provide: ProjectOperationConflictService, useValue: {} },
        { provide: ProjectOperationService, useClass: ProjectOperationService },
      ],
    });

    queueBackup = writerInjector.get(QueueBackupService);
    actionQueue = writerInjector.get(ActionQueueService);
    projectState = writerInjector.get(ProjectStateService);
    projectOps = writerInjector.get(ProjectOperationService);
    offlineSnapshots = writerInjector.get(ProjectOfflineSnapshotService);
    await actionQueue.reloadFromStorageForCurrentOwner();
    markActionQueueCurrentOwnerStorageLoadedForTests(actionQueue);

    importService = {
      isImporting: signal(false),
      validateFile: vi.fn().mockResolvedValue({ valid: true, data: { projects: [] } }),
      generatePreview: vi.fn().mockResolvedValue({ conflicts: [] }),
      executeImport: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [SettingsModalComponent],
      providers: [
        DynamicModalService,
        {
          provide: ConfigurableFocusTrapFactory,
          useValue: { create: () => ({ enabled: true, destroy: vi.fn(), focusInitialElement: vi.fn() }) },
        },
        { provide: WorkspaceModalCoordinatorService, useClass: WorkspaceModalCoordinatorService },
        { provide: ModalLoaderService, useValue: { loadSettingsModal: vi.fn().mockResolvedValue(SettingsModalComponent) } },
        { provide: ProjectStateService, useValue: projectState },
        { provide: ProjectOperationService, useValue: {} },
        { provide: SyncCoordinatorService, useValue: syncCoordinator },
        { provide: UserSessionService, useValue: userSession },
        { provide: AppAuthCoordinatorService, useValue: { sessionEmail: () => '' } },
        { provide: Router, useValue: {} },
        { provide: GlobalErrorHandler, useValue: {} },
        { provide: ToastService, useValue: toast },
        { provide: LoggerService, useValue: logger },
        { provide: AuthService, useValue: authService },
        { provide: ImportService, useValue: importService },
        { provide: PreferenceService, useValue: { theme: signal('default'), autoResolveConflicts: signal(true), setAutoResolveConflicts: vi.fn() } },
        { provide: ExportService, useValue: { isExporting: signal(false), exportAndDownload: vi.fn() } },
        { provide: AttachmentExportService, useValue: { isExporting: signal(false), progress: signal({ percentage: 0, processedCount: 0, totalCount: 0 }), exportAndDownload: vi.fn() } },
        { provide: AttachmentImportService, useValue: { isImporting: signal(false), progress: signal({ percentage: 0, completedItems: 0, failedItems: 0, skippedItems: 0, totalItems: 0 }), extractAttachmentsFromZip: vi.fn(), importAttachments: vi.fn() } },
        { provide: LocalBackupService, useValue: { setProjectsProvider: vi.fn(), isAvailable: signal(false), isAuthorized: signal(false), hasSavedHandle: signal(false), needsPermissionResume: signal(false), directoryName: signal(null), autoBackupEnabled: signal(false), autoBackupIntervalMs: signal(1800000), lastBackupTime: signal(null), isBackingUp: signal(false), requestDirectoryAccess: vi.fn(), revokeDirectoryAccess: vi.fn(), resumePermission: vi.fn(), performBackup: vi.fn(), stopAutoBackup: vi.fn(), startAutoBackup: vi.fn() } },
        { provide: ThemeService, useValue: { colorMode: signal('system'), setColorMode: vi.fn() } },
        { provide: DockEngineService, useValue: { dailySlots: signal([]), dailySlotService: { addDailySlot: vi.fn(), completeDailySlot: vi.fn(), setDailySlotEnabled: vi.fn(), removeDailySlot: vi.fn() } } },
        { provide: FocusPreferenceService, useValue: { preferences: signal({ gateEnabled: true, blackBoxEnabled: true, strataEnabled: true, maxSnoozePerDay: 3, routineResetHourLocal: 0, restReminderHighLoadMinutes: 90, restReminderLowLoadMinutes: 30 }), update: vi.fn(), setRestReminderHighLoadMinutes: vi.fn(), setRestReminderLowLoadMinutes: vi.fn() } },
        { provide: GateService, useValue: { devForceShowGate: vi.fn() } },
        { provide: ExternalSourceCacheService, useValue: { loadConfig: vi.fn().mockResolvedValue({}), saveConfig: vi.fn(), clearPreviewCache: vi.fn(), forgetConfig: vi.fn() } },
        { provide: SiyuanPreviewService, useValue: {} },
        { provide: LocalBackupUIService, useValue: {
          setProjectsProvider: vi.fn(), handleDownloadDataSafetyPackage: vi.fn(), loadRestorePreviewFromFile: vi.fn(), confirmRestore: vi.fn(),
          isExportingDataSafetyPackage: vi.fn(() => false), isRestoringFromBackup: vi.fn(() => false), restoreBackupFiles: vi.fn(() => []),
          restoreError: vi.fn(() => ''), restorePreview: vi.fn(() => null), restoreResultMsg: vi.fn(() => ''), restoreSelectedIndex: vi.fn(() => -1), restoreStep: vi.fn(() => 'idle'),
        } },
        { provide: SiyuanSettingsUIService, useValue: {
          loadConfig: vi.fn().mockResolvedValue(undefined), runtimeMode: vi.fn(() => 'extension-relay'), baseUrl: vi.fn(() => ''), tokenMask: vi.fn(() => ''), connectionStatus: vi.fn(() => ''),
          defaultBaseUrl: '', extensionStatus: vi.fn(() => undefined), isSavingToExtension: vi.fn(() => false), extensionSupported: vi.fn(() => true),
          extensionStatusMessage: vi.fn(() => ''), extensionStatusClass: vi.fn(() => ''), tokenLabel: vi.fn(() => ''), tokenPlaceholder: vi.fn(() => ''),
        } },
      ],
    }).overrideComponent(SettingsModalComponent, {
      set: {
        providers: [
          { provide: LocalBackupUIService, useValue: {
            setProjectsProvider: vi.fn(), handleDownloadDataSafetyPackage: vi.fn(), loadRestorePreviewFromFile: vi.fn(), confirmRestore: vi.fn(),
            isExportingDataSafetyPackage: vi.fn(() => false), isRestoringFromBackup: vi.fn(() => false), restoreBackupFiles: vi.fn(() => []),
            restoreError: vi.fn(() => ''), restorePreview: vi.fn(() => null), restoreResultMsg: vi.fn(() => ''), restoreSelectedIndex: vi.fn(() => -1), restoreStep: vi.fn(() => 'idle'),
          } },
          { provide: SiyuanSettingsUIService, useValue: {
            loadConfig: vi.fn().mockResolvedValue(undefined), runtimeMode: vi.fn(() => 'extension-relay'), baseUrl: vi.fn(() => ''), tokenMask: vi.fn(() => ''), connectionStatus: vi.fn(() => ''),
            defaultBaseUrl: '', extensionStatus: vi.fn(() => undefined), isSavingToExtension: vi.fn(() => false), extensionSupported: vi.fn(() => true),
            extensionStatusMessage: vi.fn(() => ''), extensionStatusClass: vi.fn(() => ''), tokenLabel: vi.fn(() => ''), tokenPlaceholder: vi.fn(() => ''),
          } },
        ],
      },
    }).compileComponents();

    dynamicModal = TestBed.inject(DynamicModalService);
    coordinator = TestBed.inject(WorkspaceModalCoordinatorService);
  });

  afterEach(async () => {
    dynamicModal?.closeAll();
    destroyActionQueue?.();
    await clearOfflineSnapshotIdb('user-a');
    await clearOfflineSnapshotIdb('user-b');
    localStorage.removeItem(getOfflineSnapshotStorageKey('user-a'));
    localStorage.removeItem(getOfflineSnapshotStorageKey('user-b'));
    await deleteQueueBackupDatabase();
    TestBed.resetTestingModule();
    alertSpy.mockRestore();
  });

  it('rejects an A-origin callback after A to B and preserves B durable state', async () => {
    const bProject = createProject('project-b', 'user-b');
    userSession.transitionTo('user-b');
    projectState.setProjects([bProject], 'user-b');
    await queueBackup.backupQueue([createQueuedProjectAction(bProject, 'user-b')], 'user-b');
    await offlineSnapshots.saveOfflineSnapshotAndWait([bProject], 'user-b');
    const beforeQueue = await queueBackup.restoreQueueSnapshot('user-b');
    const beforeSnapshot = await readOfflineSnapshotFromIdb('user-b');
    const beforeProjects = projectState.getProjectsWithCurrentData();
    userSession.transitionTo('user-a');

    const writer = vi.fn(async (project: ReturnType<typeof createProject>) => {
      const result = await projectOps.upsertImportedProject(project);
      if (!result.success) throw new Error(result.error ?? 'import failed');
    });
    coordinator.initCallbacks({ handleImportComplete: writer });
    let modalRef!: ModalRef<SettingsModalComponent>;
    let modalConfig: Parameters<typeof dynamicModal.open>[1];
    const open = dynamicModal.open.bind(dynamicModal);
    vi.spyOn(dynamicModal, 'open').mockImplementation(((component, config) => {
      modalConfig = config;
      modalRef = open(component, config);
      return modalRef;
    }) as typeof dynamicModal.open);
    await coordinator.openSettings();
    modalRef.componentRef.changeDetectorRef.detectChanges();
    expect(modalConfig?.inputs?.['importProject']).toEqual(expect.any(Function));
    expect((modalRef.componentRef.instance as SettingsModalComponent).constructor).toBe(SettingsModalComponent);
    expect((SettingsModalComponent as unknown as { ɵcmp?: { inputs?: Record<string, unknown> } }).ɵcmp?.inputs)
      .toEqual(expect.objectContaining({ sessionEmail: expect.anything(), projects: expect.anything(), importProject: expect.anything() }));
    const settings = modalRef.componentRef.instance as SettingsModalComponent;
    const importedProject = createProject('project-a-imported', 'user-a');
    let release!: () => void;
    let ready!: () => void;
    const reached = new Promise<void>(resolve => { ready = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    importService.executeImport.mockImplementation(async (...args: unknown[]) => {
      const callback = args[3] as (project: ReturnType<typeof createProject>) => Promise<void>;
      ready();
      await held;
      await callback(importedProject);
      return { success: true, importedCount: 1, skippedCount: 0, failedCount: 0, details: [], durationMs: 0 };
    });

    const pending = settings.handleFileSelected(createFileEvent());
    await reached;
    userSession.transitionTo('user-b');
    release();

    await expect(pending).rejects.toThrow('会话已切换，导入已取消');
    expect(writer).not.toHaveBeenCalled();
    expect(await queueBackup.restoreQueueSnapshot('user-b')).toEqual(beforeQueue);
    expect(await readOfflineSnapshotFromIdb('user-b')).toBe(beforeSnapshot);
    expect(projectState.getProjectsWithCurrentData()).toEqual(beforeProjects);
  });

  it('commits a same-session A import to owner A durable records and ProjectState', async () => {
    userSession.transitionTo('user-a');
    projectState.setProjects([], 'user-a');
    await queueBackup.clearQueueForFullWipe('user-a');
    await queueBackup.backupQueue([], 'user-a');
    await clearOfflineSnapshotIdb('user-a');
    localStorage.removeItem(getOfflineSnapshotStorageKey('user-a'));
    await actionQueue.reloadFromStorageForCurrentOwner();
    markActionQueueCurrentOwnerStorageLoadedForTests(actionQueue);

    const writer = vi.fn(async (project: ReturnType<typeof createProject>) => {
      const result = await projectOps.upsertImportedProject(project);
      if (!result.success) throw new Error(result.error ?? 'import failed');
    });
    coordinator.initCallbacks({ handleImportComplete: writer });
    let modalRef!: ModalRef<SettingsModalComponent>;
    let modalConfig: Parameters<typeof dynamicModal.open>[1];
    const open = dynamicModal.open.bind(dynamicModal);
    vi.spyOn(dynamicModal, 'open').mockImplementation(((component, config) => {
      modalConfig = config;
      modalRef = open(component, config);
      return modalRef;
    }) as typeof dynamicModal.open);
    await coordinator.openSettings();
    modalRef.componentRef.changeDetectorRef.detectChanges();
    const settings = modalRef.componentRef.instance as SettingsModalComponent;
    const importedProject = createProject('project-a-control', 'user-a');
    importService.executeImport.mockImplementation(async (...args: unknown[]) => {
      const callback = args[3] as (project: ReturnType<typeof createProject>) => Promise<void>;
      await callback(importedProject);
      return { success: true, importedCount: 1, skippedCount: 0, failedCount: 0, details: [], durationMs: 0 };
    });

    await settings.handleFileSelected(createFileEvent());

    const queue = await queueBackup.restoreQueueSnapshot('user-a');
    const snapshot = await readOfflineSnapshotFromIdb('user-a');
    expect(writer).toHaveBeenCalledOnce();
    expect(queue?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: 'project-a-control', payload: expect.objectContaining({ sourceUserId: 'user-a' }) }),
    ]));
    expect(snapshot).toContain('project-a-control');
    expect(projectState.getProjectsWithCurrentData()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'project-a-control' }),
    ]));
  });
});
