/**
 * SyncCoordinatorService 单元测试 (Vitest + Injector 隔离模式)
 *
 * 测试覆盖：
 * 1. 持久化状态管理 - 防抖、标记本地变更
 * 2. 版本冲突检测 - 本地 v2 vs 远程 v3 场景
 * 3. 离线队列处理 - 队列积压、合并发送、逐个发送
 * 4. 同步状态机流转 - 在线/离线/同步中/会话过期
 * 5. 边缘情况 - 网络抖动、并发请求
 * 6. 验证与重平衡 - 数据完整性检查
 *
 * 迁移说明：使用 Injector.create + runInInjectionContext 替代 TestBed，
 * 实现更轻量级的依赖注入隔离测试。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext, DestroyRef, signal } from '@angular/core';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { registerSyncCoordinatorConflictRehydrateSpecs } from './sync-coordinator-conflict-rehydrate.spec-helpers';
import { registerSyncCoordinatorIntegrationSpecs } from './sync-coordinator-integration.spec-helpers';
import { registerSyncCoordinatorProjectSyncOperationsSpecs } from './sync-coordinator-project-sync-operations.spec-helpers';
import { registerSyncCoordinatorRuntimeSpecs } from './sync-coordinator-runtime.spec-helpers';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { ProjectDataService } from '../app/core/services/sync/project-data.service';
import { ProjectSyncCursorService } from '../app/core/services/sync/project-sync-cursor.service';
import { RealtimePollingService } from '../app/core/services/sync/realtime-polling.service';
import { TaskSyncOperationsService } from '../app/core/services/sync/task-sync-operations.service';
import { TombstoneService } from '../app/core/services/sync/tombstone.service';
import { SupabaseClientService } from './supabase-client.service';
import { ProjectSaveFlightCoordinatorService } from '../app/core/services/sync/project-save-flight-coordinator.service';
import { SyncStateService } from '../app/core/services/sync/sync-state.service';
import { RetryQueueService } from '../app/core/services/sync/retry-queue.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import { ActionQueueService } from './action-queue.service';
import { ActionQueueProcessorsService } from './action-queue-processors.service';
import { DeltaSyncCoordinatorService } from './delta-sync-coordinator.service';
import { ProjectSyncOperationsService } from './project-sync-operations.service';
import { ConflictResolutionService } from './conflict-resolution.service';
import { ConflictStorageService } from './conflict-storage.service';
import { ChangeTrackerService } from './change-tracker.service';
import { ProjectStateService } from './project-state.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { SentryAlertService } from './sentry-alert.service';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';
import { SyncModeService } from './sync-mode.service';
import { PersistSchedulerService } from './persist-scheduler.service';
import { BlackBoxSyncService } from './black-box-sync.service';
import { TabSyncService } from './tab-sync.service';
import { SyncCoordinatorConflictService } from './sync-coordinator-conflicts.service';
import { SyncCoordinatorPersistService } from './sync-coordinator-persist.service';
import { SyncCoordinatorProjectRefreshService } from './sync-coordinator-project-refresh.service';
import { SyncCoordinatorRuntimeService } from './sync-coordinator-runtime.service';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { Project, Task, SyncState } from '../models';
import { success } from '../utils/result';

// ========== 模拟依赖服务 ==========

const createMockSyncState = (overrides?: Partial<SyncState>): SyncState => ({
  isSyncing: false,
  isOnline: true,
  offlineMode: false,
  sessionExpired: false,
  syncError: null,
  hasConflict: false,
  conflictData: null,
  ...overrides,
});

const mockSyncService = {
  syncState: signal(createMockSyncState()),
  state: {
    update: vi.fn((updater: (state: SyncState) => SyncState) => {
      mockSyncService.syncState.update(updater);
    }),
  },
  isLoadingRemote: signal(false),
  setConflict: vi.fn((conflictData) => {
    mockSyncService.syncState.update(state => ({
      ...state,
      hasConflict: true,
      conflictData,
    }));
  }),
  clearConflict: vi.fn(() => {
    mockSyncService.syncState.update(state => ({
      ...state,
      hasConflict: false,
      conflictData: null,
    }));
  }),
  saveOfflineSnapshot: vi.fn(),
  saveOfflineSnapshotAndWait: vi.fn().mockResolvedValue(undefined),
  loadOfflineSnapshot: vi.fn().mockReturnValue(null),
  clearOfflineCache: vi.fn(),
  loadProjectListMetadataFromCloud: vi.fn().mockResolvedValue([]),
  loadProjectsFromCloud: vi.fn().mockResolvedValue([]),
  saveProjectToCloud: vi.fn().mockResolvedValue({ success: true }),
  saveProjectSmart: vi.fn().mockResolvedValue({ success: true, newVersion: 2 }),
  deleteProjectFromCloud: vi.fn().mockResolvedValue(true),
  loadFullProjectOptimized: vi.fn().mockResolvedValue(null),
  loadSingleProject: vi.fn().mockResolvedValue(null),
  getTombstoneIds: vi.fn().mockResolvedValue(new Set<string>()),
  tryReloadConflictData: vi.fn().mockResolvedValue(undefined),
  saveUserPreferences: vi.fn().mockResolvedValue(true),
  setRemoteChangeCallback: vi.fn(),
  setTaskChangeCallback: vi.fn(),
  pauseRealtimeUpdates: vi.fn(),
  resumeRealtimeUpdates: vi.fn(),
  initRealtimeSubscription: vi.fn().mockResolvedValue(undefined),
  teardownRealtimeSubscription: vi.fn(),
  destroy: vi.fn(),
  flushRetryQueueSync: vi.fn(),
  getLastSyncTime: vi.fn().mockReturnValue(null),
  setLastSyncTime: vi.fn(),
  // 快路判定基准：项目增量拉取游标（null = 从未拉取过，快路必须 miss）
  ensureProjectSyncCursorLoaded: vi.fn().mockResolvedValue(null),
  commitProjectSyncTimestamp: vi.fn().mockResolvedValue(undefined),
  commitProjectSyncCursor: vi.fn().mockResolvedValue(undefined),
  buildProjectSyncCursorFromProject: vi.fn().mockImplementation((project: Project) => ({
    updatedAt: project.updatedAt,
    entityType: 'project',
    id: project.id,
  })),
  getProjectSyncWatermark: vi.fn().mockResolvedValue(null),
  getUserProjectsWatermark: vi.fn().mockResolvedValue(null),
  listProjectHeadsSince: vi.fn().mockResolvedValue([]),
  getAccessibleProjectProbe: vi.fn().mockResolvedValue(null),
  getBlackBoxSyncWatermark: vi.fn().mockResolvedValue(null),
};

// SyncStateService mock —— 与 mockSyncService 共享同一 syncState/isLoadingRemote 信号，
// 使 this.syncStateService.syncState() 与测试驱动的 mockSyncService.syncState.set(...) 保持一致。
// Phase 3 门面安乐死：sync-coordinator 内部状态读取逐簇从 this.core 迁到具体子服务时复用此 mock。
const mockSyncStateService = {
  syncState: mockSyncService.syncState,
  state: mockSyncService.state,
  isLoadingRemote: mockSyncService.isLoadingRemote,
  update: vi.fn((partial: Partial<SyncState>) => {
    mockSyncService.syncState.update(s => ({ ...s, ...partial }));
  }),
  setPendingCount: vi.fn(),
  // setConflict/clearConflict 复用 mockSyncService 的同一 spy（共享 spy）：
  // Phase 3 把 this.core.setConflict/clearConflict 迁到 this.syncStateService 后，
  // 既有断言 expect(mockSyncService.setConflict)... 仍命中同一调用记录。
  setConflict: mockSyncService.setConflict,
  clearConflict: mockSyncService.clearConflict,
};

// RealtimePollingService mock —— setOnRemoteChange 别名复用 mockSyncService.setRemoteChangeCallback 同一 spy
// （门面方法名 setRemoteChangeCallback → 具体服务名 setOnRemoteChange），既有断言仍命中。
const mockRealtimePollingService = {
  setOnRemoteChange: mockSyncService.setRemoteChangeCallback,
  setTaskChangeCallback: mockSyncService.setTaskChangeCallback,
  unsubscribeFromProject: vi.fn().mockResolvedValue(undefined),
};

// TaskSyncOperationsService mock —— getTombstoneIds 复用 mockSyncService 同一 spy；
// softDeleteTasksBatch 门面 mock 此前未暴露，给独立 spy。
const mockTaskSyncOpsService = {
  getTombstoneIds: mockSyncService.getTombstoneIds,
  getTombstoneIdsWithStatus: vi.fn().mockResolvedValue({
    ids: new Set<string>(),
    fromRemote: true,
    localCacheOnly: false,
    timestamp: Date.now(),
  }),
  softDeleteTasksBatch: vi.fn().mockResolvedValue(0),
};

const mockActionQueueService = {
  queueSize: signal(0),
  setQueueProcessCallbacks: vi.fn(),
  registerProcessor: vi.fn(),
  validateProcessors: vi.fn().mockReturnValue([]),
  getRegisteredProcessorTypes: vi.fn().mockReturnValue([]),
  getPendingActionsForProject: vi.fn().mockReturnValue([]),
  getProjectPendingWriteState: vi.fn(),
  enqueue: vi.fn().mockResolvedValue(true),
  enqueueForOwner: vi.fn().mockResolvedValue(true),
  processQueue: vi.fn().mockResolvedValue(undefined),
  queueFrozen: signal(false),
};
mockActionQueueService.getProjectPendingWriteState.mockImplementation(
  (projectId: string) => (
    mockActionQueueService.getPendingActionsForProject(projectId).length > 0 ? 'pending' : 'clear'
  ),
);

const mockRetryQueueService = {
  length: 0,
  getItems: vi.fn().mockReturnValue([]),
  getProjectPendingWriteState: vi.fn().mockReturnValue('clear'),
  removeByEntities: vi.fn().mockReturnValue([]),
  removeConnectionsReferencingTasks: vi.fn().mockReturnValue([]),
  pressureEvents: 0,
  clear: vi.fn(),
};

const mockBlackBoxSyncService = {
  forceSync: vi.fn().mockResolvedValue(undefined),
  pullChanges: vi.fn().mockResolvedValue(undefined),
};

const mockTabSyncService = {
  notifyDataSynced: vi.fn(),
  setOnDataSyncedCallback: vi.fn(),
};

const mockConflictService = {
  hasConflict: signal(false),
  conflictData: signal(null),
  resolveConflict: vi.fn().mockReturnValue(success({ id: 'proj-1', name: 'Resolved', tasks: [], connections: [], createdDate: '', version: 1 })),
  smartMerge: vi.fn().mockReturnValue({
    project: { id: 'proj-1', name: 'Merged', tasks: [], connections: [], createdDate: '', version: 2 },
    issues: [],
    conflictCount: 0,
  }),
};

const mockProjectStateService = {
  projects: signal<Project[]>([]),
  activeProject: signal<Project | null>(null),
  activeProjectId: signal<string | null>(null),
  updateProjects: vi.fn(),
  setProjects: vi.fn(),
  setActiveProjectId: vi.fn(),
  getProject: vi.fn((id: string) => mockProjectStateService.projects().find((p: Project) => p.id === id)),
  getProjectWithCurrentData: vi.fn((id: string) => mockProjectStateService.getProjectsWithCurrentData().find((p: Project) => p.id === id)),
  getProjectsWithCurrentData: vi.fn(() => mockProjectStateService.projects()),
};

const resolveMockActiveProjectId = (): string | null => {
  return mockProjectStateService.activeProjectId() ?? mockProjectStateService.activeProject()?.id ?? null;
};

const bindProjectStateMockImplementations = () => {
  mockProjectStateService.getProject.mockImplementation(
    (id: string) => mockProjectStateService.projects().find((project: Project) => project.id === id)
  );
  mockProjectStateService.getProjectWithCurrentData.mockImplementation(
    (id: string) => mockProjectStateService.getProjectsWithCurrentData().find((project: Project) => project.id === id)
  );
  mockProjectStateService.setProjects.mockImplementation((projects: Project[]) => {
    mockProjectStateService.projects.set(projects);
    const activeProjectId = resolveMockActiveProjectId();
    mockProjectStateService.activeProject.set(
      activeProjectId ? projects.find((project: Project) => project.id === activeProjectId) ?? null : null
    );
  });
  mockProjectStateService.setActiveProjectId.mockImplementation((projectId: string | null) => {
    mockProjectStateService.activeProjectId.set(projectId);
    mockProjectStateService.activeProject.set(
      projectId ? mockProjectStateService.projects().find((project: Project) => project.id === projectId) ?? null : null
    );
  });
  mockProjectStateService.updateProjects.mockImplementation((updater: (projects: Project[]) => Project[]) => {
    const current = mockProjectStateService.projects();
    mockProjectStateService.projects.set(updater(current));
    const activeProjectId = resolveMockActiveProjectId();
    mockProjectStateService.activeProject.set(
      activeProjectId ? mockProjectStateService.projects().find((project: Project) => project.id === activeProjectId) ?? null : null
    );
  });
};

const mockAuthService = {
  currentUserId: vi.fn().mockReturnValue('user-123'),
  isConfigured: true,
};

const mockToastService = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

const mockSentryAlertService = {
  updateSyncContext: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  setContext: vi.fn(),
};

const mockLayoutService = {
  validateAndFixTree: vi.fn((project: Project) => ({
    project,
    issues: [] as string[],
  })),
  rebalance: vi.fn((project: Project) => project),
};

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

// ========== 新增缺失的 mock 服务 ==========

const mockConflictStorageService = {
  saveConflict: vi.fn().mockResolvedValue(true),
  getAllConflicts: vi.fn().mockResolvedValue([]),
  getConflict: vi.fn().mockResolvedValue(null),
  deleteConflict: vi.fn().mockResolvedValue(true),
  hasConflicts: vi.fn().mockResolvedValue(false),
};

const mockChangeTrackerService = {
  pendingChangesCount: signal(0),
  trackTaskCreate: vi.fn(),
  trackTaskUpdate: vi.fn(),
  trackTaskDelete: vi.fn(),
  trackConnectionCreate: vi.fn(),
  trackConnectionDelete: vi.fn(),
  clearProjectFieldLocks: vi.fn(),
  getProjectChanges: vi.fn(),
  clearProjectChanges: vi.fn(),
  getChangedProjectIds: vi.fn().mockReturnValue([]),
  hasProjectChanges: vi.fn().mockReturnValue(false),
  clearAllChanges: vi.fn(),
  getOldestChangeAgeMs: vi.fn().mockReturnValue(0),
};

const mockSyncModeService = {
  mode: signal('automatic'),
  isAutomatic: vi.fn().mockReturnValue(true),
  perceptionEnabled: vi.fn().mockReturnValue(false),
  setMode: vi.fn(),
  setSyncCallback: vi.fn(),
  config: vi.fn().mockReturnValue({
    mode: 'automatic',
    syncOnBoot: true,
    syncOnExit: true,
    autoSyncInterval: 300000, // 5分钟，匹配新的 DEFAULT_SYNC_INTERVAL
    perceptionEnabled: false,
  }),
  triggerSync: vi.fn().mockResolvedValue(undefined),
};

// Sprint 4 新增：PersistSchedulerService mock
const mockPersistSchedulerService = {
  state: signal({
    isPersisting: false,
    hasPending: false,
    lastPersistAt: 0,
    hasPendingLocalChanges: false,
    lastUpdateType: 'structure' as const
  }),
  setCallbacks: vi.fn(),
  startLocalAutosave: vi.fn(),
  stopLocalAutosave: vi.fn(),
  markLocalChanges: vi.fn(),
  clearLocalChanges: vi.fn(),
  getLastUpdateType: vi.fn().mockReturnValue('structure'),
  hasPendingLocalChanges: vi.fn().mockReturnValue(false),
  getLastPersistAt: vi.fn().mockReturnValue(0),
  isPersisting: vi.fn().mockReturnValue(false),
  schedulePersist: vi.fn(),
  flushPendingPersist: vi.fn().mockResolvedValue(undefined)
};

// Sprint 9 新增：ActionQueueProcessorsService mock
const mockActionQueueProcessorsService = {
  setProjectConflictHandler: vi.fn(),
  setupProcessors: vi.fn(),
};

// Sprint 9 新增：DeltaSyncCoordinatorService mock
const mockDeltaSyncCoordinatorService = {
  performDeltaSync: vi.fn().mockResolvedValue({ taskChanges: 0, connectionChanges: 0 }),
  hasProjectContentDifference: vi.fn().mockReturnValue(false),
};

// Sprint 9 新增：ProjectSyncOperationsService mock
const mockProjectSyncOperationsService = {
  resyncActiveProject: vi.fn().mockResolvedValue({ success: true, message: '已同步' }),
  mergeOfflineDataOnReconnect: vi.fn().mockResolvedValue({ projects: [], syncedCount: 0, conflictProjects: [] }),
  validateAndRebalanceWithResult: vi.fn().mockImplementation((project: Project) => ({ ok: true, value: project })),
  validateAndRebalance: vi.fn().mockImplementation((project: Project) => project),
};

function createDefaultProjectChanges() {
  return {
    tasksToCreate: [],
    tasksToUpdate: [],
    taskIdsToDelete: [],
    connectionsToCreate: [],
    connectionsToUpdate: [],
    connectionsToDelete: [],
    hasChanges: false,
    totalChanges: 0,
  };
}

// ========== 辅助函数 ==========

function createTestProject(overrides?: Partial<Project>): Project {
  return {
    id: `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
    connections: [],
    version: 1,
    ...overrides,
  };
}

function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    displayId: 'A',
    hasIncompleteTask: false,
    ...overrides,
  };
}

// ========== 测试用例 ==========

// DestroyRef mock（服务内部使用 inject(DestroyRef)）
const destroyCallbacks: Array<() => void> = [];
const mockDestroyRef: Pick<DestroyRef, 'onDestroy'> = {
  onDestroy: (cb: () => void) => { destroyCallbacks.push(cb); return () => {}; },
};

// 共享 provider 工厂 —— 消除两个 SyncCoordinatorService describe 块此前逐字复制的 20+ provider 数组。
// SyncStateService 用 mockSyncStateService（带 syncState 信号），为 Phase 3 逐簇下切 this.core 做准备。
function buildCoordinatorProviders() {
  return [
    { provide: SimpleSyncService, useValue: mockSyncService },
    { provide: ActionQueueService, useValue: mockActionQueueService },
    { provide: RetryQueueService, useValue: mockRetryQueueService },
    { provide: ConflictResolutionService, useValue: mockConflictService },
    { provide: ConflictStorageService, useValue: mockConflictStorageService },
    { provide: ChangeTrackerService, useValue: mockChangeTrackerService },
    { provide: ProjectStateService, useValue: mockProjectStateService },
    { provide: AuthService, useValue: mockAuthService },
    { provide: ToastService, useValue: mockToastService },
    { provide: SentryAlertService, useValue: mockSentryAlertService },
    SessionRuntimeResetRegistry,
    { provide: LayoutService, useValue: mockLayoutService },
    { provide: LoggerService, useValue: mockLoggerService },
    { provide: SyncModeService, useValue: mockSyncModeService },
    { provide: PersistSchedulerService, useValue: mockPersistSchedulerService },
    { provide: BlackBoxSyncService, useValue: mockBlackBoxSyncService },
    { provide: TabSyncService, useValue: mockTabSyncService },
    { provide: ActionQueueProcessorsService, useValue: mockActionQueueProcessorsService },
    { provide: DeltaSyncCoordinatorService, useValue: mockDeltaSyncCoordinatorService },
    { provide: ProjectSyncOperationsService, useValue: mockProjectSyncOperationsService },
    SyncCoordinatorConflictService,
    SyncCoordinatorPersistService,
    SyncCoordinatorProjectRefreshService,
    SyncCoordinatorRuntimeService,
    { provide: DestroyRef, useValue: mockDestroyRef },
    { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
    { provide: SyncStateService, useValue: mockSyncStateService },
    // ProjectDataService 复用 mockSyncService（它已有全部项目数据读写 spy）：
    // Phase 3 把 this.core 的 ProjectData 簇迁到 this.projectData 后，既有
    // expect(mockSyncService.saveOfflineSnapshot/...) 断言仍命中同一 spy。
    { provide: ProjectDataService, useValue: mockSyncService },
    // ProjectSyncCursorService 同理复用 mockSyncService（含 commit*/buildProjectSyncCursorFromProject/getLastSyncTime spy）。
    { provide: ProjectSyncCursorService, useValue: mockSyncService },
    { provide: RealtimePollingService, useValue: mockRealtimePollingService },
    { provide: TaskSyncOperationsService, useValue: mockTaskSyncOpsService },
    // ProjectSaveFlightCoordinatorService.save 别名复用 mockSyncService.saveProjectSmart 同一 spy：
    // Phase 3 把 this.core.saveProjectSmart 迁到 this.projectSaveCoordinator.save 后，既有断言仍命中。
    { provide: ProjectSaveFlightCoordinatorService, useValue: { save: mockSyncService.saveProjectSmart } },
    // Phase 3 batchPreloadTombstones 具体 owner：SupabaseClientService(离线守卫返 false 跳过预热) + TombstoneService。
    { provide: SupabaseClientService, useValue: { isConfigured: false, isOfflineMode: () => true, clientAsync: vi.fn().mockResolvedValue(null) } },
    { provide: TombstoneService, useValue: { batchPreloadTombstones: vi.fn().mockResolvedValue(true) } },
  ];
}

describe('SyncCoordinatorService', () => {
  let service: SyncCoordinatorService;
  let injector: Injector;
  const originalResumeWatermarkFlag = FEATURE_FLAGS.RESUME_WATERMARK_RPC_V1;
  const originalUserProjectsWatermarkFlag = FEATURE_FLAGS.USER_PROJECTS_WATERMARK_RPC_V1;
  const originalBlackBoxWatermarkFlag = FEATURE_FLAGS.BLACKBOX_WATERMARK_PROBE_V1;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    destroyCallbacks.length = 0;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = originalResumeWatermarkFlag;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = originalUserProjectsWatermarkFlag;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).BLACKBOX_WATERMARK_PROBE_V1 = originalBlackBoxWatermarkFlag;

    mockAuthService.currentUserId.mockReset();
    mockAuthService.currentUserId.mockReturnValue('user-123');
    mockTaskSyncOpsService.getTombstoneIdsWithStatus.mockReset();
    mockTaskSyncOpsService.getTombstoneIdsWithStatus.mockImplementation(async (projectId: string) => ({
      ids: await mockSyncService.getTombstoneIds(projectId),
      fromRemote: true,
      localCacheOnly: false,
      timestamp: Date.now(),
    }));
    mockSyncService.saveProjectSmart.mockReset();
    mockSyncService.saveProjectSmart.mockResolvedValue({ success: true, newVersion: 2 });
    mockSyncService.saveOfflineSnapshot.mockReset();
    mockSyncService.saveOfflineSnapshotAndWait.mockReset();
    mockSyncService.saveOfflineSnapshotAndWait.mockResolvedValue(undefined);
    mockSyncService.ensureProjectSyncCursorLoaded.mockReset();
    mockSyncService.ensureProjectSyncCursorLoaded.mockResolvedValue(null);
    mockSyncService.commitProjectSyncTimestamp.mockReset();
    mockSyncService.commitProjectSyncTimestamp.mockResolvedValue(undefined);
    mockSyncService.commitProjectSyncCursor.mockReset();
    mockSyncService.commitProjectSyncCursor.mockResolvedValue(undefined);
    mockSyncService.buildProjectSyncCursorFromProject.mockReset();
    mockSyncService.buildProjectSyncCursorFromProject.mockImplementation((project: Project) => ({
      updatedAt: project.updatedAt,
      entityType: 'project',
      id: project.id,
    }));
    mockSyncService.loadOfflineSnapshot.mockReset();
    mockSyncService.loadOfflineSnapshot.mockReturnValue(null);
    mockActionQueueService.getPendingActionsForProject.mockReset();
    mockActionQueueService.getPendingActionsForProject.mockReturnValue([]);
    mockActionQueueService.enqueueForOwner.mockReset();
    mockActionQueueService.enqueueForOwner.mockResolvedValue(true);
    mockChangeTrackerService.getProjectChanges.mockReset();
    mockChangeTrackerService.getProjectChanges.mockImplementation(() => createDefaultProjectChanges());
    mockChangeTrackerService.getChangedProjectIds.mockReset();
    mockChangeTrackerService.getChangedProjectIds.mockReturnValue([]);
    mockChangeTrackerService.hasProjectChanges.mockReset();
    mockChangeTrackerService.hasProjectChanges.mockReturnValue(false);

    // 重置 mock signals
    mockSyncService.syncState.set(createMockSyncState());
    mockSyncService.isLoadingRemote.set(false);
    mockActionQueueService.queueSize.set(0);
    mockProjectStateService.projects.set([]);
    mockProjectStateService.activeProject.set(null);
    mockProjectStateService.activeProjectId.set(null);
    bindProjectStateMockImplementations();
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('nanoflow.project-manifest-watermark');
      localStorage.removeItem('nanoflow.blackbox-manifest-watermark');
      localStorage.removeItem('nanoflow.project-manifest-watermark.user-123');
      localStorage.removeItem('nanoflow.blackbox-manifest-watermark.user-123');
    }

    injector = Injector.create({
      providers: buildCoordinatorProviders(),
    });

    service = runInInjectionContext(injector, () => new SyncCoordinatorService());
    // 【性能审计 2026-02-07】构造函数不再启动副作用，需显式初始化
    service.initialize();
  });

  afterEach(() => {
    vi.useRealTimers();
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = originalResumeWatermarkFlag;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = originalUserProjectsWatermarkFlag;
    (FEATURE_FLAGS as unknown as Record<string, boolean>).BLACKBOX_WATERMARK_PROBE_V1 = originalBlackBoxWatermarkFlag;
  });

  it('destroy 不应清空 RetryQueue，避免生命周期销毁覆盖持久 outbox', () => {
    service.destroy();

    expect(mockRetryQueueService.clear).not.toHaveBeenCalled();
  });

  it('ActionQueue 已结算但 RetryQueue 仍有项目写入时应继续判定本地有待同步修改', () => {
    const projectId = 'project-retry-only-pending';
    mockActionQueueService.getPendingActionsForProject.mockReturnValueOnce([]);
    mockRetryQueueService.getProjectPendingWriteState.mockReturnValueOnce('pending');

    expect(service.hasPendingChangesForProject(projectId)).toBe(true);
  });

  it('RetryQueue owner 状态未知时应阻止 hydration 把项目误判为无本地写入', () => {
    const projectId = 'project-retry-load-unknown';
    mockActionQueueService.getPendingActionsForProject.mockReturnValueOnce([]);
    mockRetryQueueService.getProjectPendingWriteState.mockReturnValueOnce('unknown');

    expect(service.hasPendingChangesForProject(projectId)).toBe(true);
  });

  it('ActionQueue owner 状态未知时应阻止 hydration 把项目误判为无本地写入', () => {
    const projectId = 'project-action-queue-load-unknown';
    mockActionQueueService.getProjectPendingWriteState.mockReturnValueOnce('unknown');
    mockRetryQueueService.getProjectPendingWriteState.mockReturnValueOnce('clear');

    expect(service.hasPendingChangesForProject(projectId)).toBe(true);
  });

  it('完整项目加载失败时不得应用远端状态、写离线快照或推进项目游标', async () => {
    const localProject = createTestProject({ id: 'project-integrity-guard' });
    mockProjectStateService.projects.set([localProject]);
    mockProjectStateService.activeProject.set(localProject);
    mockProjectStateService.activeProjectId.set(localProject.id);
    mockSyncService.getAccessibleProjectProbe.mockResolvedValueOnce(null);
    mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce(null);
    mockSyncService.loadFullProjectOptimized.mockResolvedValueOnce(null);
    mockProjectStateService.updateProjects.mockClear();
    mockSyncService.saveOfflineSnapshotAndWait.mockClear();
    mockSyncService.commitProjectSyncCursor.mockClear();
    mockSyncService.commitProjectSyncTimestamp.mockClear();

    const result = await service.refreshActiveProjectSilent('task-row-integrity-failure');

    expect(result).toEqual({
      refreshed: false,
      skippedReason: 'remote-project-missing',
    });
    expect(mockProjectStateService.updateProjects).not.toHaveBeenCalled();
    expect(mockSyncService.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
    expect(mockSyncService.commitProjectSyncCursor).not.toHaveBeenCalled();
    expect(mockSyncService.commitProjectSyncTimestamp).not.toHaveBeenCalled();
    expect(mockProjectStateService.projects()).toEqual([localProject]);
  });

  it('owner A→B→A during autosave should not let the old A completion clear dirty state', async () => {
    const project = createTestProject({
      id: 'project-owner-aba',
      version: 1,
      pendingSync: true,
    });
    mockProjectStateService.projects.set([project]);
    mockProjectStateService.activeProject.set(project);
    mockProjectStateService.activeProjectId.set(project.id);
    mockChangeTrackerService.clearProjectChanges.mockClear();
    mockChangeTrackerService.clearProjectFieldLocks.mockClear();

    let resolveSave!: (result: { success: boolean; newVersion: number }) => void;
    mockSyncService.saveProjectSmart.mockImplementationOnce(
      () => new Promise(resolve => {
        resolveSave = resolve;
      }),
    );

    service.markLocalChanges('content');
    const flush = service.flushPendingPersistToCloud('owner-aba', { force: true });
    await vi.waitFor(() => {
      expect(mockSyncService.saveProjectSmart).toHaveBeenCalledOnce();
    });

    mockAuthService.currentUserId.mockReturnValue('user-b');
    injector.get(SessionRuntimeResetRegistry).resetAll('owner-change');
    mockAuthService.currentUserId.mockReturnValue('user-123');
    resolveSave({ success: true, newVersion: 9 });

    await expect(flush).resolves.toBe(false);
    expect(service.hasPendingLocalChanges()).toBe(true);
    expect(mockProjectStateService.projects()[0]?.version).toBe(1);
    expect(mockChangeTrackerService.clearProjectFieldLocks).not.toHaveBeenCalled();
    expect(mockChangeTrackerService.clearProjectChanges).not.toHaveBeenCalled();
  });

  it('forwards operationId to task sync operations for batched task deletion', async () => {
    const projectId = 'project-delete-operation';
    const taskIds = ['task-delete-operation'];
    const tombstoneTimestamps = { [taskIds[0]]: '2026-11-01T00:00:00.000Z' };
    const baseUpdatedAtMap = { [taskIds[0]]: '2026-10-31T00:00:00.000Z' };
    const operationId = '12345678-1234-4234-8234-123456789abc';
    mockTaskSyncOpsService.softDeleteTasksBatch.mockResolvedValueOnce(1);

    await expect(service.softDeleteTasksBatch(
      projectId,
      taskIds,
      tombstoneTimestamps,
      baseUpdatedAtMap,
      operationId,
    )).resolves.toBe(1);

    expect(mockTaskSyncOpsService.softDeleteTasksBatch).toHaveBeenCalledWith(
      projectId,
      taskIds,
      tombstoneTimestamps,
      baseUpdatedAtMap,
      operationId,
    );
  });

  registerSyncCoordinatorRuntimeSpecs({
    service: () => service,
    mockSyncService: () => mockSyncService,
    mockTaskSyncOperationsService: () => mockTaskSyncOpsService,
    mockTabSyncService: () => mockTabSyncService,
    mockProjectStateService: () => mockProjectStateService,
    mockChangeTrackerService: () => mockChangeTrackerService,
    mockActionQueueService: () => mockActionQueueService,
    mockAuthService: () => mockAuthService,
    mockToastService: () => mockToastService,
    mockRetryQueueService: () => mockRetryQueueService,
    mockConflictStorageService: () => mockConflictStorageService,
    mockLoggerCategory: () => mockLoggerCategory,
    mockConflictService: () => mockConflictService,
    mockProjectSyncOperationsService: () => mockProjectSyncOperationsService,
    mockBlackBoxSyncService: () => mockBlackBoxSyncService,
    mockLayoutService: () => mockLayoutService,
    mockRealtimePollingService: () => mockRealtimePollingService,
    mockActionQueueProcessorsService: () => mockActionQueueProcessorsService,
    createTestProject,
    createTestTask,
    createMockSyncState,
  });

  registerSyncCoordinatorConflictRehydrateSpecs({
    buildCoordinatorProviders,
    createTestProject,
    mockConflictStorageService,
    mockSyncService,
  });
});

registerSyncCoordinatorProjectSyncOperationsSpecs({
  createTestProject,
  createTestTask,
});

// ==================== 集成场景测试 ====================

describe('SyncCoordinatorService 集成场景', () => {
  let service: SyncCoordinatorService;
  let injector: Injector;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    destroyCallbacks.length = 0;

    mockSyncService.syncState.set(createMockSyncState());
    mockSyncService.isLoadingRemote.set(false);
    mockActionQueueService.queueSize.set(0);
    mockProjectStateService.projects.set([]);
    mockProjectStateService.activeProject.set(null);
    mockProjectStateService.activeProjectId.set(null);
    bindProjectStateMockImplementations();

    injector = Injector.create({
      providers: buildCoordinatorProviders(),
    });

    service = runInInjectionContext(injector, () => new SyncCoordinatorService());
    // 【性能审计 2026-02-07】构造函数不再启动副作用，需显式初始化
    service.initialize();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  registerSyncCoordinatorIntegrationSpecs({
    service: () => service,
    mockSyncService: () => mockSyncService,
    mockProjectStateService: () => mockProjectStateService,
    mockProjectSyncOperationsService: () => mockProjectSyncOperationsService,
    mockConflictService: () => mockConflictService,
    createTestProject,
    createTestTask,
    createMockSyncState,
  });
});
