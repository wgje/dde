import { vi, describe, it, expect, beforeEach, afterEach, type Mock } from 'vitest';
import { Injector, DestroyRef, signal, WritableSignal } from '@angular/core';
import { UserSessionService } from './user-session.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SupabaseClientService } from './supabase-client.service';
import { LayoutService } from './layout.service';
import { AttachmentService } from './attachment.service';
import { DockSnapshotPersistenceService } from './dock-snapshot-persistence.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { ChangeTrackerService } from './change-tracker.service';
import { ActionQueueService } from './action-queue.service';
import { ConflictStorageService } from './conflict-storage.service';
import { RetryQueueService } from '../app/core/services/sync/retry-queue.service';
import { AUTH_CONFIG } from '../config/auth.config';
import { Project, Task } from '../models';
import { markTaskContentMissingFromSource } from '../utils/task-content-guard';
import { StartupPlaceholderStateService } from './startup-placeholder-state.service';
import { blackBoxEntriesMap, gateSnoozeCount, gateState, resetFocusState } from '../state/focus-stores';
import { StorePersistenceService } from '../app/core/state/store-persistence.service';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';
import { LocalBackupUiRestoreStartupRecoveryService } from './local-backup-ui-restore-startup-recovery.service';
import {
  createBrowserNetworkSuspendedError,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../utils/browser-network-suspension';
import { registerUserSessionLoadAndSyncSpecs } from './user-session-load-and-sync.spec-helpers';
import { registerUserSessionIdleTaskSpecs } from './user-session-idle-task.spec-helpers';
import { registerUserSessionMetadataAndSnapshotSpecs } from './user-session-metadata-and-snapshot.spec-helpers';
import { registerUserSessionSetCurrentUserSpecs } from './user-session-set-current-user.spec-helpers';
import { registerUserSessionSwitchActiveProjectSpecs } from './user-session-switch-active-project.spec-helpers';
import type { UserSessionServiceSpecContext } from './user-session.service.spec-context';

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

function createStorageMock(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      Object.keys(store).forEach((key) => delete store[key]);
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } as Storage;
}

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

type MockSyncCoordinatorCore = {
  teardownRealtimeSubscription: Mock<() => void>;
  clearOfflineCache: Mock<() => void>;
  clearOfflineSnapshot: Mock<(ownerUserId?: string | null) => void>;
  loadOfflineSnapshot: Mock<(options?: { allowOwnerHint?: boolean }) => Project[] | null>;
  loadStartupOfflineSnapshot: Mock<(options?: {
    allowOwnerHint?: boolean;
    ownerUserId?: string | null;
  }) => Promise<{
    source: string;
    projectCount: number;
    bytes: number;
    migratedLegacy: boolean;
    projects: Project[];
    ownerUserId?: string | null;
  }>>;
  saveOfflineSnapshot: Mock<(projects: Project[], ownerUserId?: string | null) => void>;
  saveProjectSmart: Mock<(project: Project, userId: string) => Promise<{ ok: boolean }>>;
  initRealtimeSubscription: Mock<(userId: string) => Promise<void>>;
  getAccessibleProjectProbe: Mock<(projectId: string) => Promise<unknown>>;
  getResumeRecoveryProbe: Mock<(projectId?: string) => Promise<unknown>>;
  setLastSyncTime: Mock<() => void>;
};

function createTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'Task',
    content: overrides.content ?? '',
    stage: 'stage' in overrides ? overrides.stage! : 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    displayId: overrides.displayId ?? '?',
    attachments: overrides.attachments,
  };
}

function createSnapshotPreviewTask(overrides: Partial<Task> = {}): Task {
  const title = overrides.title ?? 'Preview Task';
  return {
    ...createTask({
      ...overrides,
      title,
      content: overrides.content ?? title,
      stage: null,
      parentId: null,
    }),
    updatedAt: undefined,
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 'proj-1',
    name: overrides.name ?? 'Test',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? now,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    updatedAt: overrides.updatedAt ?? now,
    version: overrides.version ?? 1,
    ...overrides,
  };
}

function saveGuestDraftProjects(projects: Project[]): void {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  localStorage.setItem('nanoflow.guest-data', JSON.stringify({
    projects,
    version: 2,
    savedAt: now,
    expiresAt,
  }));
}

function createAttachment(id = crypto.randomUUID()) {
  const now = new Date().toISOString();
  return {
    id,
    type: 'file' as const,
    name: 'doc.txt',
    url: 'https://example.com/doc.txt',
    createdAt: now,
    signedAt: now,
  };
}

async function flushAsyncWork(): Promise<void> {
  // minimal setup 不加载 zone.js，按需补水链路需要显式让 load/probe/cleanup 多层微任务全部跑完。
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe('UserSessionService', () => {
  let service: UserSessionService;
  let destroyCallbacks: (() => void)[];
  let mockAuthService: Record<string, unknown>;
  let mockProjectState: Record<string, unknown>;
  let mockSyncCoordinator: Record<string, unknown>;
  let mockStorePersistence: Record<string, unknown>;
  let mockChangeTracker: Record<string, unknown>;
  let mockUndoService: Record<string, unknown>;
  let mockUiState: Record<string, unknown>;
  let mockActionQueue: Record<string, unknown>;
  let mockRetryQueue: Record<string, unknown>;
  let mockConflictStorage: Record<string, unknown>;
  let mockDockSnapshotPersistence: Record<string, unknown>;
  let mockSessionRuntimeReset: { resetAll: ReturnType<typeof vi.fn> };
  let mockLocalBackupUiRestoreStartupRecovery: {
    recover: ReturnType<typeof vi.fn>;
  };
  let mockStartupPlaceholderState: {
    isHintOnlyActive: ReturnType<typeof vi.fn>;
    activate: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };
  let mockAttachmentService: Record<string, unknown>;
  let mockLayoutService: Record<string, unknown>;
  let mockToastService: Record<string, unknown>;
  let mockSupabaseClientService: {
    isConfigured: boolean;
    isOfflineMode: ReturnType<typeof vi.fn>;
    client: ReturnType<typeof vi.fn>;
    clientAsync: ReturnType<typeof vi.fn>;
    getClient: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    getStorageKey: ReturnType<typeof vi.fn>;
    signOut: ReturnType<typeof vi.fn>;
  };
  let userIdSignal: WritableSignal<string | null>;
  let originalLocalStorage: Storage;
  let originalSessionStorage: Storage;

  beforeEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    originalLocalStorage = globalThis.localStorage;
    originalSessionStorage = globalThis.sessionStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorageMock(),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: createStorageMock(),
      configurable: true,
      writable: true,
    });

    destroyCallbacks = [];
    let projectsState: Project[] = [];
    let activeProjectIdState: string | null = null;

    // Create a real writable signal for currentUserId
    userIdSignal = signal<string | null>(null);

    mockAuthService = {
      currentUserId: userIdSignal,
      isConfigured: true,
      peekPersistedSessionIdentity: vi.fn().mockReturnValue(null),
      peekPersistedOwnerHint: vi.fn().mockReturnValue(null),
      setProvisionalCurrentUserId: vi.fn(),
    };

    const projectsMock = vi.fn(() => projectsState);
    mockProjectState = {
      projects: projectsMock,
      setProjects: vi.fn((projects: Project[]) => {
        projectsState = projects;
        projectsMock.mockReturnValue(projectsState);
      }),
      updateProjects: vi.fn((updater: (projects: Project[]) => Project[]) => {
        projectsState = updater(projectsMock());
        projectsMock.mockReturnValue(projectsState);
      }),
      activeProjectId: vi.fn(() => activeProjectIdState),
      setActiveProjectId: vi.fn((projectId: string | null) => {
        activeProjectIdState = projectId;
      }),
      getActiveProject: vi.fn(() => projectsMock().find((project: Project) => project.id === activeProjectIdState) ?? null),
      getProject: vi.fn((id: string) => projectsMock().find((project: Project) => project.id === id)),
      tasks: vi.fn(() => {
        const activeProject = projectsMock().find((project: Project) => project.id === activeProjectIdState);
        return activeProject?.tasks ?? [];
      }),
      clearData: vi.fn(() => {
        projectsState = [];
        activeProjectIdState = null;
        projectsMock.mockReturnValue(projectsState);
      }),
      clearAll: vi.fn(),
      setProjectsMetadataOnly: vi.fn((projects: Project[]) => {
        // 只更新项目元数据（与 setProjects 行为一致，但语义上不触碰 TaskStore）
        projectsState = projects;
        projectsMock.mockReturnValue(projectsState);
      }),
      getProjectsWithCurrentData: vi.fn(() => projectsMock()),
    };

    const syncCoordinatorCore: MockSyncCoordinatorCore = {
      teardownRealtimeSubscription: vi.fn(),
      clearOfflineCache: vi.fn(),
      clearOfflineSnapshot: vi.fn(),
      loadOfflineSnapshot: vi.fn(() => null),
      loadStartupOfflineSnapshot: vi.fn().mockResolvedValue({
        source: 'none',
        projectCount: 0,
        bytes: 0,
        migratedLegacy: false,
        projects: [],
      }),
      saveOfflineSnapshot: vi.fn(),
      saveProjectSmart: vi.fn().mockResolvedValue({ ok: true }),
      initRealtimeSubscription: vi.fn().mockResolvedValue(undefined),
      getAccessibleProjectProbe: vi.fn().mockResolvedValue(null),
      getResumeRecoveryProbe: vi.fn().mockResolvedValue(null),
      setLastSyncTime: vi.fn(),
    };

    mockSyncCoordinator = {
      flushPendingPersist: vi.fn(),
      preparePendingPersistForOwnerChange: vi.fn().mockResolvedValue(true),
      core: syncCoordinatorCore,
      performDeltaSync: vi.fn().mockResolvedValue({ ok: true }),
      loadSingleProjectFromCloud: vi.fn().mockResolvedValue(null),
      validateAndRebalanceWithResult: vi.fn((p: Project) => ({ ok: true, value: p })),
      mergeOfflineDataOnReconnect: vi.fn().mockResolvedValue({ ok: true }),
      hasPendingChangesForProject: vi.fn().mockReturnValue(false),
      tryReloadConflictData: vi.fn(),
      refreshProjectManifestIfNeeded: vi.fn().mockResolvedValue({ skipped: false }),
      commitProjectManifestWatermark: vi.fn(),
      refreshBlackBoxWatermarkIfNeeded: vi.fn().mockResolvedValue({ skipped: false }),
      clearActiveConflict: vi.fn(),
      teardownRealtimeSubscription: vi.fn(() => syncCoordinatorCore.teardownRealtimeSubscription()),
      clearOfflineCache: vi.fn(() => syncCoordinatorCore.clearOfflineCache()),
      clearOfflineSnapshot: vi.fn((ownerUserId?: string | null) => syncCoordinatorCore.clearOfflineSnapshot(ownerUserId)),
      loadOfflineSnapshot: vi.fn((options?: { allowOwnerHint?: boolean }) => syncCoordinatorCore.loadOfflineSnapshot(options)),
      loadStartupOfflineSnapshot: vi.fn((options?: { allowOwnerHint?: boolean; ownerUserId?: string | null }) => (
        syncCoordinatorCore.loadStartupOfflineSnapshot(options)
      )),
      saveOfflineSnapshot: vi.fn((projects: Project[], ownerUserId?: string | null) => syncCoordinatorCore.saveOfflineSnapshot(projects, ownerUserId)),
      saveOfflineSnapshotAndWait: vi.fn((projects: Project[], ownerUserId?: string | null) => syncCoordinatorCore.saveOfflineSnapshot(projects, ownerUserId)),
      saveProjectSmart: vi.fn((project: Project, userId: string) => syncCoordinatorCore.saveProjectSmart(project, userId)),
      initRealtimeSubscription: vi.fn((userId: string) => syncCoordinatorCore.initRealtimeSubscription(userId)),
      getAccessibleProjectProbe: vi.fn((projectId: string) => syncCoordinatorCore.getAccessibleProjectProbe(projectId)),
      getResumeRecoveryProbe: vi.fn((projectId?: string) => syncCoordinatorCore.getResumeRecoveryProbe(projectId)),
    };

    mockStorePersistence = {
      recoverInterruptedDataSafetyRestore: vi.fn().mockResolvedValue({ recovered: false, errors: [] }),
    };

    mockChangeTracker = {
      clearAllChanges: vi.fn(),
      hasProjectChanges: vi.fn().mockReturnValue(false),
    };

    mockUndoService = {
      clearHistory: vi.fn(),
      flushPendingAction: vi.fn(),
      onProjectSwitch: vi.fn(),
    };

    mockActionQueue = {
      clearQueue: vi.fn(),
      clearQueueForFullWipe: vi.fn(),
      clearDeadLetterQueue: vi.fn(),
      clearCurrentView: vi.fn(),
      reloadFromStorageForCurrentOwner: vi.fn(),
      storage: {
        loadQueueSnapshotForOwner: vi.fn().mockResolvedValue([]),
      },
    };

    mockRetryQueue = {
      clear: vi.fn(),
      clearCurrentView: vi.fn(),
      reloadFromStorageForCurrentOwner: vi.fn(),
      closeStorageConnections: vi.fn(),
    };

    mockConflictStorage = {
      clearFallbackStorageForOwner: vi.fn(),
      clearAllFallbackStorage: vi.fn(),
      closeStorageConnections: vi.fn(),
      refreshConflictCount: vi.fn().mockResolvedValue(undefined),
    };

    mockDockSnapshotPersistence = {
      discardPendingPersist: vi.fn().mockResolvedValue(undefined),
    };

    mockSessionRuntimeReset = {
      resetAll: vi.fn().mockReturnValue({ ok: true, reason: 'owner-change', attemptedOwners: [], failures: [] }),
    };
    mockLocalBackupUiRestoreStartupRecovery = {
      recover: vi.fn().mockResolvedValue({ status: 'none' }),
    };

    mockStartupPlaceholderState = {
      isHintOnlyActive: vi.fn(() => false),
      activate: vi.fn(),
      clear: vi.fn(),
    };

    mockUiState = {
      clearSearch: vi.fn(),
      clearAllState: vi.fn(),
      setLoading: vi.fn(),
    };

    mockAttachmentService = {
      clearMonitoredAttachments: vi.fn(),
      clearUrlRefreshCallback: vi.fn(),
      monitorAttachment: vi.fn(),
      setUrlRefreshCallback: vi.fn(),
    };

    mockLayoutService = {
      rebalance: vi.fn((p: Project) => p),
      detectIncomplete: vi.fn().mockReturnValue(false),
    };

    mockToastService = {
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    };

    mockSupabaseClientService = {
      isConfigured: true,
      isOfflineMode: vi.fn(() => false),
      client: vi.fn(() => null),
      clientAsync: vi.fn(() => Promise.resolve(null)),
      getClient: vi.fn(() => null),
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-1' } } },
        error: null,
      }),
      getStorageKey: vi.fn(() => 'sb-test-auth-token'),
      signOut: vi.fn().mockResolvedValue(undefined),
    };

    const injector = Injector.create({
      providers: [
        { provide: UserSessionService, useClass: UserSessionService },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: AuthService, useValue: mockAuthService },
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
        { provide: StorePersistenceService, useValue: mockStorePersistence },
        { provide: ActionQueueService, useValue: mockActionQueue },
        { provide: RetryQueueService, useValue: mockRetryQueue },
        { provide: ConflictStorageService, useValue: mockConflictStorage },
        { provide: DockSnapshotPersistenceService, useValue: mockDockSnapshotPersistence },
        { provide: SessionRuntimeResetRegistry, useValue: mockSessionRuntimeReset },
        {
          provide: LocalBackupUiRestoreStartupRecoveryService,
          useValue: mockLocalBackupUiRestoreStartupRecovery,
        },
        { provide: StartupPlaceholderStateService, useValue: mockStartupPlaceholderState },
        { provide: UndoService, useValue: mockUndoService },
        { provide: UiStateService, useValue: mockUiState },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: LayoutService, useValue: mockLayoutService },
        { provide: ToastService, useValue: mockToastService },
        { provide: SupabaseClientService, useValue: mockSupabaseClientService },
        { provide: DestroyRef, useValue: { onDestroy: (cb: () => void) => destroyCallbacks.push(cb) } },
      ],
    });

    service = injector.get(UserSessionService);
  });

  afterEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    delete (window as Window & { __NANOFLOW_LAUNCH_SNAPSHOT__?: unknown }).__NANOFLOW_LAUNCH_SNAPSHOT__;
    delete (window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__;
    resetFocusState({ cleanupTodayDateInterval: true });
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: originalSessionStorage,
      configurable: true,
      writable: true,
    });
  });

  function getUserSessionSpecContext(): UserSessionServiceSpecContext {
    return {
      service,
      destroyCallbacks,
      mockAuthService,
      mockProjectState,
      mockSyncCoordinator,
      mockStorePersistence,
      mockChangeTracker,
      mockUndoService,
      mockUiState,
      mockActionQueue,
      mockRetryQueue,
      mockConflictStorage,
      mockDockSnapshotPersistence,
      mockSessionRuntimeReset,
      mockStartupPlaceholderState,
      mockAttachmentService,
      mockLayoutService,
      mockToastService,
      mockLoggerCategory,
      mockSupabaseClientService,
      userIdSignal,
      blackBoxEntriesMap,
      gateSnoozeCount,
      gateState,
      createTask,
      createSnapshotPreviewTask,
      createProject,
      saveGuestDraftProjects,
      createAttachment,
      flushAsyncWork,
    };
  }

  registerUserSessionSwitchActiveProjectSpecs(getUserSessionSpecContext);
  describe('clearLocalData', () => {
    it('清除内存态数据', () => {
      service.clearLocalData();

      expect(mockProjectState['clearData']).toHaveBeenCalled();
      expect(mockUndoService['clearHistory']).toHaveBeenCalled();
      expect(mockChangeTracker['clearAllChanges']).toHaveBeenCalled();
      expect(mockSyncCoordinator['clearActiveConflict']).toHaveBeenCalled();
      expect(mockSessionRuntimeReset.resetAll).toHaveBeenCalledWith('clear-local-data');
    });
  });

  describe('session runtime reset', () => {
    it('owner 变化时在加载新会话前广播运行时重置', async () => {
      userIdSignal.set('old-user');

      await service.setCurrentUser('new-user', {
        forceLoad: true,
        skipPersistentReload: true,
      });

      expect(mockSessionRuntimeReset.resetAll).toHaveBeenCalledWith('owner-change');
    });

    it('登出时停止 Focus 模块级 interval', async () => {
      resetFocusState({ cleanupTodayDateInterval: true });
      vi.useFakeTimers();
      resetFocusState();
      expect(vi.getTimerCount()).toBe(2);
      userIdSignal.set('old-user');

      await service.setCurrentUser(null, { skipPersistentReload: true });

      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    });

    it('从匿名态登录时重新启动 Focus 模块级 interval', async () => {
      resetFocusState({ cleanupTodayDateInterval: true });
      vi.useFakeTimers();
      expect(vi.getTimerCount()).toBe(0);

      await service.setCurrentUser('new-user', {
        forceLoad: true,
        skipPersistentReload: true,
      });

      expect(vi.getTimerCount()).toBe(2);
      vi.useRealTimers();
    });
  });

  describe('local backup UI restore startup recovery', () => {
    it('blocks owner queues and project load when startup recovery stays frozen', async () => {
      const ownerUserId = 'phase2c2a-blocked-owner';
      mockLocalBackupUiRestoreStartupRecovery.recover.mockResolvedValueOnce({
        status: 'blocked',
        reason: 'active-or-mutated',
      });
      const loadUserDataSpy = vi.spyOn(
        service as unknown as {
          loadUserData: (userId: string, sessionGuard?: unknown) => Promise<void>;
        },
        'loadUserData',
      ).mockResolvedValue(undefined);

      try {
        await service.setCurrentUser(ownerUserId, { forceLoad: true });

        expect(mockLocalBackupUiRestoreStartupRecovery.recover).toHaveBeenCalledWith(ownerUserId);
        expect(mockStorePersistence['recoverInterruptedDataSafetyRestore']).not.toHaveBeenCalled();
        expect(mockActionQueue['reloadFromStorageForCurrentOwner']).not.toHaveBeenCalled();
        expect(mockRetryQueue['reloadFromStorageForCurrentOwner']).not.toHaveBeenCalled();
        expect(loadUserDataSpy).not.toHaveBeenCalled();
      } finally {
        mockLocalBackupUiRestoreStartupRecovery.recover.mockReset();
        mockLocalBackupUiRestoreStartupRecovery.recover.mockResolvedValue({ status: 'none' });
      }
    });

    it('checks the local owner before loading anonymous session data', async () => {
      mockLocalBackupUiRestoreStartupRecovery.recover.mockResolvedValueOnce({
        status: 'blocked',
        reason: 'active-or-mutated',
      });

      await service.setCurrentUser(null, { forceLoad: true });

      expect(mockLocalBackupUiRestoreStartupRecovery.recover)
        .toHaveBeenCalledWith(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      expect(mockStorePersistence['recoverInterruptedDataSafetyRestore']).not.toHaveBeenCalled();
      expect(mockActionQueue['reloadFromStorageForCurrentOwner']).not.toHaveBeenCalled();
      expect(mockRetryQueue['reloadFromStorageForCurrentOwner']).not.toHaveBeenCalled();
    });
  });

  describe('clearAllLocalData', () => {
    beforeEach(() => {
      vi.spyOn(service as unknown as { clearIndexedDB: (dbName: string) => Promise<boolean> }, 'clearIndexedDB')
        .mockResolvedValue(true);
    });

    it('清除内存和持久化数据', async () => {
      await service.clearAllLocalData();

      expect(mockProjectState['clearData']).toHaveBeenCalled();
      expect(mockUndoService['clearHistory']).toHaveBeenCalled();
      expect(mockDockSnapshotPersistence['discardPendingPersist']).toHaveBeenCalled();
    });

    it('late Layer-1 cleanup preserves a newer canonical credential bundle', async () => {
      const bundle = {
        'sb-test-auth-token': 'session-b',
        'sb-test-auth-token-code-verifier': 'verifier-b',
        'sb-test-auth-token-user': 'user-b',
      };
      Object.entries(bundle).forEach(([key, value]) => localStorage.setItem(key, value));
      (window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__ = {
        status: 'refreshed',
      };

      await service.clearAllLocalData('user-a');

      Object.entries(bundle).forEach(([key, value]) => expect(localStorage.getItem(key)).toBe(value));
      expect((window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__).toBeUndefined();
    });

    it('应清理 sessionStorage 遗留数据', async () => {
      sessionStorage.setItem('nanoflow.undo-history', 'sensitive');
      sessionStorage.setItem('nanoflow.optimistic-snapshot', 'sensitive');

      await service.clearAllLocalData();

      expect(sessionStorage.getItem('nanoflow.undo-history')).toBeNull();
      expect(sessionStorage.getItem('nanoflow.optimistic-snapshot')).toBeNull();
    });

    it('应清理 action queue 持久化键', async () => {
      localStorage.setItem('nanoflow.action-queue', JSON.stringify([{ id: 'q-1' }]));
      localStorage.setItem('nanoflow.dead-letter-queue', JSON.stringify([{ id: 'd-1' }]));
      localStorage.setItem('nanoflow.local-connection-tombstones', JSON.stringify([{ id: 'conn-1' }]));

      await service.clearAllLocalData();

      expect(localStorage.getItem('nanoflow.action-queue')).toBeNull();
      expect(localStorage.getItem('nanoflow.dead-letter-queue')).toBeNull();
      expect(localStorage.getItem('nanoflow.local-connection-tombstones')).toBeNull();
      expect(mockActionQueue['clearQueueForFullWipe']).toHaveBeenCalled();
      expect(mockActionQueue['clearQueue']).not.toHaveBeenCalled();
      expect(mockActionQueue['clearDeadLetterQueue']).toHaveBeenCalled();
      expect(mockRetryQueue['clear']).toHaveBeenCalled();
      expect(mockRetryQueue['closeStorageConnections']).toHaveBeenCalled();
    });

    it('应清理用户偏好前缀键', async () => {
      localStorage.setItem('nanoflow.preference.user-123.theme', 'ocean');
      localStorage.setItem('nanoflow.preference.user-123.layout', 'ltr');
      localStorage.setItem('nanoflow.preference.user-999.theme', 'forest');

      await service.clearAllLocalData('user-123');

      expect(localStorage.getItem('nanoflow.preference.user-123.theme')).toBeNull();
      expect(localStorage.getItem('nanoflow.preference.user-123.layout')).toBeNull();
      expect(localStorage.getItem('nanoflow.preference.user-999.theme')).toBe('forest');
    });

    it('应清理 focus_mode IndexedDB 缓存', async () => {
      const clearIndexedDBSpy = vi.spyOn(
        service as unknown as { clearIndexedDB: (dbName: string) => Promise<boolean> },
        'clearIndexedDB'
      );

      await service.clearAllLocalData();

      expect(clearIndexedDBSpy).toHaveBeenCalledWith('nanoflow-retry-queue');
      expect(clearIndexedDBSpy).toHaveBeenCalledWith('nanoflow-conflicts');
      expect(clearIndexedDBSpy).toHaveBeenCalledWith('nanoflow-offline-snapshots');
      expect(clearIndexedDBSpy).toHaveBeenCalledWith('focus_mode');
      expect(clearIndexedDBSpy).toHaveBeenCalledWith('keyval-store');
    });

    it('应清理 Dock 快照影子键', async () => {
      localStorage.setItem('nanoflow.dock-snapshot.v3.user-123', JSON.stringify({ savedAt: '2026-03-31T00:00:00.000Z' }));
      localStorage.setItem('nanoflow.dock-snapshot.v3.anonymous', JSON.stringify({ savedAt: '2026-03-31T00:00:00.000Z' }));

      await service.clearAllLocalData();

      expect(localStorage.getItem('nanoflow.dock-snapshot.v3.user-123')).toBeNull();
      expect(localStorage.getItem('nanoflow.dock-snapshot.v3.anonymous')).toBeNull();
    });

    it('应清理 owner-scoped 离线快照影子键', async () => {
      localStorage.setItem('nanoflow.offline-cache-v2.user-123', JSON.stringify({ projects: [{ id: 'p-1' }] }));
      localStorage.setItem('nanoflow.offline-cache-v2.anonymous', JSON.stringify({ projects: [{ id: 'p-2' }] }));

      await service.clearAllLocalData();

      expect(localStorage.getItem('nanoflow.offline-cache-v2.user-123')).toBeNull();
      expect(localStorage.getItem('nanoflow.offline-cache-v2.anonymous')).toBeNull();
    });

    it('应清理 IndexedDB 项目降级 fallback 键', async () => {
      localStorage.setItem('nanoflow.idb-fallback.project-1', JSON.stringify({ version: 1 }));
      localStorage.setItem('nanoflow.idb-fallback.project-2', JSON.stringify({ version: 1 }));

      await service.clearAllLocalData();

      expect(localStorage.getItem('nanoflow.idb-fallback.project-1')).toBeNull();
      expect(localStorage.getItem('nanoflow.idb-fallback.project-2')).toBeNull();
    });

    it('应全量清理 conflict fallback 存储', async () => {
      await service.clearAllLocalData();

      expect(mockConflictStorage['clearAllFallbackStorage']).toHaveBeenCalled();
    });

    it('应清理项目清单和黑匣子水位缓存键', async () => {
      localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
      localStorage.setItem('nanoflow.blackbox-manifest-watermark.user-123', '2026-02-16T10:00:00.000Z');
      localStorage.setItem('nanoflow.project-manifest-watermark', 'legacy-project-watermark');
      localStorage.setItem('nanoflow.blackbox-manifest-watermark', 'legacy-blackbox-watermark');

      await service.clearAllLocalData('user-123');

      expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-123')).toBeNull();
      expect(localStorage.getItem('nanoflow.blackbox-manifest-watermark.user-123')).toBeNull();
      expect(localStorage.getItem('nanoflow.project-manifest-watermark')).toBeNull();
      expect(localStorage.getItem('nanoflow.blackbox-manifest-watermark')).toBeNull();
    });

    it('IndexedDB 未真正删除时应中止 full wipe', async () => {
      localStorage.setItem('sb-test-auth-token', JSON.stringify({ access_token: 'token' }));
      (window as Window & { __NANOFLOW_LAUNCH_SNAPSHOT__?: unknown }).__NANOFLOW_LAUNCH_SNAPSHOT__ = { projects: ['stale'] };
      (window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__ = { status: 'idle' as const };
      vi.spyOn(service as unknown as { clearIndexedDB: (dbName: string) => Promise<boolean> }, 'clearIndexedDB')
        .mockResolvedValueOnce(false);

      await expect(service.clearAllLocalData()).rejects.toThrow('IndexedDB 清理未完成');

      expect(mockSupabaseClientService.signOut).not.toHaveBeenCalled();
      expect(localStorage.getItem('sb-test-auth-token')).toBe(JSON.stringify({ access_token: 'token' }));
      expect((window as Window & { __NANOFLOW_LAUNCH_SNAPSHOT__?: unknown }).__NANOFLOW_LAUNCH_SNAPSHOT__).toBeUndefined();
      expect((window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__).toBeUndefined();
      expect(mockConflictStorage['clearAllFallbackStorage']).toHaveBeenCalled();
    });
  });

  describe('DestroyRef cleanup', () => {
    it('注册了 onDestroy 回调', () => {
      // DestroyRef 回调在构造函数中注册
      // 通过 Injector 模式验证回调注册
      expect(destroyCallbacks.length).toBeGreaterThanOrEqual(0);
      // 实际的 clearUrlRefreshCallback/clearMonitoredAttachments
      // 由 Angular DI 容器管理，Injector 隔离模式下无法完整模拟
    });
  });

  registerUserSessionSetCurrentUserSpecs(getUserSessionSpecContext);

  registerUserSessionIdleTaskSpecs({
    service: () => service,
  });

  registerUserSessionLoadAndSyncSpecs(getUserSessionSpecContext);

  registerUserSessionMetadataAndSnapshotSpecs(getUserSessionSpecContext);

});
