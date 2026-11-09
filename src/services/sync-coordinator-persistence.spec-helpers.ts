import { beforeEach, describe, expect, it, vi, success } from './sync-coordinator.service.spec-context';
import type { Project, SyncCoordinatorService, SyncState, Task } from './sync-coordinator.service.spec-context';
import { registerSyncCoordinatorOwnerHandoffSpecs } from './sync-coordinator-owner-handoff.spec-helpers';
import {
  getLocalBackupUiRestoreQuiescenceSentinelStorageKey,
  LocalBackupUiRestoreWriterPausedError,
} from './local-backup-ui-restore-writer-quiescence-tracker';
import {
  LocalBackupUiRestoreWriterQuiescenceService,
} from './local-backup-ui-restore-writer-quiescence.service';

export interface SyncCoordinatorPersistenceSpecContext {
  service(): SyncCoordinatorService;
  mockSyncService(): any;
  mockTabSyncService(): any;
  mockProjectStateService(): any;
  mockChangeTrackerService(): any;
  mockActionQueueService(): any;
  mockAuthService(): any;
  mockToastService(): any;
  mockRetryQueueService(): any;
  mockConflictStorageService(): any;
  mockLoggerCategory(): any;
  createTestProject(overrides?: Partial<Project>): Project;
  createTestTask(overrides?: Partial<Task>): Task;
  createMockSyncState(overrides?: Partial<SyncState>): SyncState;
}

export function registerSyncCoordinatorPersistenceSpecs(context: SyncCoordinatorPersistenceSpecContext): void {
  let service: SyncCoordinatorService;
  let mockSyncService: any;
  let mockTabSyncService: any;
  let mockProjectStateService: any;
  let mockChangeTrackerService: any;
  let mockActionQueueService: any;
  let mockAuthService: any;
  let mockToastService: any;
  let mockRetryQueueService: any;
  let mockConflictStorageService: any;
  let mockLoggerCategory: any;

  const createTestProject = context.createTestProject;
  const createTestTask = context.createTestTask;
  const createMockSyncState = context.createMockSyncState;

  beforeEach(() => {
    service = context.service();
    mockSyncService = context.mockSyncService();
    mockTabSyncService = context.mockTabSyncService();
    mockProjectStateService = context.mockProjectStateService();
    mockChangeTrackerService = context.mockChangeTrackerService();
    mockActionQueueService = context.mockActionQueueService();
    mockAuthService = context.mockAuthService();
    mockToastService = context.mockToastService();
    mockRetryQueueService = context.mockRetryQueueService();
    mockConflictStorageService = context.mockConflictStorageService();
    mockLoggerCategory = context.mockLoggerCategory();
  });

  registerSyncCoordinatorOwnerHandoffSpecs(context);

  // ==================== 持久化状态管理 ====================

describe('持久化状态管理', () => {
    it('恢复准备会等待已开始的项目云端持久化完成', async () => {
      vi.useRealTimers();
      const ownerUserId = `sync-persist-writer-${Date.now()}`;
      const project = createTestProject({ id: 'proj-persist-quiescence' });
      const quiescenceService = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
      let resolveSave: (value: { success: boolean; newVersion: number }) => void = () => undefined;
      let persistPromise: Promise<boolean> | null = null;
      let preparePromise: ReturnType<typeof quiescenceService.prepare> | null = null;
      let prepared = false;
      let quiescence: Awaited<ReturnType<typeof quiescenceService.prepare>> | null = null;
      let quiescenceReleased = false;

      mockAuthService.currentUserId.mockReturnValue(ownerUserId);
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveProjectSmart.mockImplementationOnce(() => new Promise(resolve => {
        resolveSave = resolve as (value: { success: boolean; newVersion: number }) => void;
      }));

      try {
        service.markLocalChanges('content');
        persistPromise = service.flushPendingPersistToCloud('restore-quiescence', { force: true });
        await vi.waitFor(() => expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(1));
        mockProjectStateService.updateProjects.mockImplementationOnce(() => {
          throw new LocalBackupUiRestoreWriterPausedError(ownerUserId);
        });

        preparePromise = quiescenceService.prepare(ownerUserId).then(handle => {
          prepared = true;
          return handle;
        });
        const sentinelKey = getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId);
        await vi.waitFor(() => expect(localStorage.getItem(sentinelKey)).not.toBeNull());
        await new Promise(resolve => setTimeout(resolve, 5));

        expect(prepared).toBe(false);

        resolveSave({ success: true, newVersion: 2 });
        await persistPromise;
        expect(service.hasPendingLocalChanges()).toBe(true);
        quiescence = await preparePromise;
        expect(prepared).toBe(true);

        await quiescence.abortBeforeMutation();
        quiescenceReleased = true;
        await vi.waitFor(() => expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(2), {
          timeout: 5000,
          interval: 25,
        });
        await vi.waitFor(() => expect(service.hasPendingLocalChanges()).toBe(false), {
          timeout: 1000,
          interval: 10,
        });
      } finally {
        resolveSave({ success: true, newVersion: 2 });
        if (persistPromise) await persistPromise.catch(() => undefined);
        if (preparePromise && !quiescence) {
          quiescence = await preparePromise.catch(() => null);
        }
        if (!quiescenceReleased) await quiescence?.abortBeforeMutation();
        service.destroy();
      }
    }, 10000);

    it('恢复栅栏暂停云端持久化时保留 dirty 状态并在释放后重试', async () => {
      vi.useRealTimers();
      const ownerUserId = `sync-persist-paused-${Date.now()}`;
      const project = createTestProject({ id: 'proj-persist-paused' });
      const quiescenceService = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
      mockAuthService.currentUserId.mockReturnValue(ownerUserId);
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveProjectSmart.mockClear();
      mockSyncService.saveOfflineSnapshot.mockClear();

      const quiescence = await quiescenceService.prepare(ownerUserId);
      try {
        service.markLocalChanges('content');
        const flushed = await service.flushPendingPersistToCloud('restore-paused', { force: true });

        expect(flushed).toBe(false);
        expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
        expect(mockSyncService.saveOfflineSnapshot).not.toHaveBeenCalled();
        expect(service.hasPendingLocalChanges()).toBe(true);

        await quiescence.abortBeforeMutation();
        await vi.waitFor(() => expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(1), {
          timeout: 5000,
          interval: 25,
        });
        await vi.waitFor(() => expect(service.hasPendingLocalChanges()).toBe(false), {
          timeout: 1000,
          interval: 10,
        });
      } finally {
        await quiescence.abortBeforeMutation().catch(() => undefined);
        service.destroy();
      }
    }, 10000);

    it('initialize 应注册 TabSync data-synced 回调', () => {
      expect(mockTabSyncService.setOnDataSyncedCallback).toHaveBeenCalledTimes(1);
      expect(mockTabSyncService.setOnDataSyncedCallback).toHaveBeenCalledWith(expect.any(Function));
    });

    it('markLocalChanges 应该设置 hasPendingLocalChanges 为 true', () => {
      expect(service.hasPendingLocalChanges()).toBe(false);

      service.markLocalChanges();

      expect(service.hasPendingLocalChanges()).toBe(true);
    });

    it('markLocalChanges 应将活动项目标记为 pendingSync 并提前保存本地快照', async () => {
      const project = createTestProject({ id: 'proj-mark-dirty', pendingSync: false });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveOfflineSnapshot.mockClear();

      service.markLocalChanges('content');

      const updatedProject = mockProjectStateService.projects().find((p: Project) => p.id === 'proj-mark-dirty');
      expect(updatedProject?.pendingSync).toBe(true);

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockSyncService.saveOfflineSnapshot).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'proj-mark-dirty', pendingSync: true })
        ])
      );
    });

    it('markLocalChanges 应该更新 lastUpdateType', () => {
      service.markLocalChanges('content');
      expect(service.getLastUpdateType()).toBe('content');

      service.markLocalChanges('position');
      expect(service.getLastUpdateType()).toBe('position');

      service.markLocalChanges('structure');
      expect(service.getLastUpdateType()).toBe('structure');
    });

    it('getLastPersistAt 初始应该为 0', () => {
      expect(service.getLastPersistAt()).toBe(0);
    });

    it('schedulePersist 应该在延迟后触发持久化', async () => {
      const project = createTestProject({ id: 'proj-1' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);

      // 清除前面测试可能的影响
      mockSyncService.saveOfflineSnapshot.mockClear();

      service.schedulePersist();

      // 持久化尚未执行
      expect(mockSyncService.saveOfflineSnapshot).not.toHaveBeenCalled();

      // 前进 3000ms（SYNC_CONFIG.DEBOUNCE_DELAY = 3000）
      await vi.advanceTimersByTimeAsync(3000);

      // 等待异步持久化操作完成
      await vi.waitFor(() => {
        expect(mockSyncService.saveOfflineSnapshot).toHaveBeenCalled();
      }, { timeout: 200, interval: 10 });
    });

    it('内容版本未变化时应跳过持久化前的重复全量快照写入（dirty-flag）', async () => {
      // 写放大回归：一次编辑周期原本最多 3 次全量序列化 × 双存储写入
      // （1s 防抖快照、3s 持久化前快照、推送成功后快照）；
      // 持久化前快照在内容版本未变时只多一个 updatedAt 印章，应跳过
      const project = createTestProject({ id: 'proj-snapshot-dedupe' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveOfflineSnapshot.mockClear();
      mockSyncService.saveProjectSmart.mockClear();

      service.schedulePersist();
      await vi.advanceTimersByTimeAsync(1000);
      // 1s 防抖本地快照（主耐久通道，无条件保留）
      expect(mockSyncService.saveOfflineSnapshot).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalled();
      }, { timeout: 500, interval: 20 });

      await vi.waitFor(() => {
        // 持久化前快照被跳过：只有防抖快照 + 推送成功后的权威快照
        expect(mockSyncService.saveOfflineSnapshot).toHaveBeenCalledTimes(2);
      }, { timeout: 500, interval: 20 });
    });

    it('自动持久化应使用当前 store 快照而不是陈旧 activeProject，并清理过期重试项', async () => {
      const staleTask = createTestTask({
        id: 'task-stale',
        title: 'Stale Task',
        updatedAt: '2026-04-10T00:00:00.000Z',
      });
      const currentTask = createTestTask({
        id: 'task-current',
        title: 'Current Task',
        updatedAt: '2026-04-10T01:00:00.000Z',
      });
      const staleProject = createTestProject({
        id: 'proj-store-snapshot',
        tasks: [staleTask],
        connections: [
          {
            id: 'connection-stale',
            source: 'task-stale',
            target: 'task-gone',
            title: 'stale edge',
          },
        ],
      });
      const currentProject = {
        ...staleProject,
        tasks: [currentTask],
        connections: [],
      };

      mockProjectStateService.activeProject.set(staleProject);
      mockProjectStateService.projects.set([staleProject]);
      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => [currentProject]);
      mockProjectStateService.setProjects.mockClear();
      mockSyncService.saveProjectSmart.mockClear();
      mockRetryQueueService.removeByEntities.mockReset();
      mockRetryQueueService.removeConnectionsReferencingTasks.mockReset();
      mockRetryQueueService.removeByEntities
        .mockReturnValueOnce(['task-stale'])
        .mockReturnValueOnce(['connection-stale']);
      mockRetryQueueService.removeConnectionsReferencingTasks.mockReturnValueOnce(['connection-stale']);

      service.schedulePersist();
      await vi.advanceTimersByTimeAsync(3000);

      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(1);
      });

      expect(mockProjectStateService.setProjects).toHaveBeenCalledWith([currentProject]);
      expect(mockSyncService.saveProjectSmart).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'proj-store-snapshot',
          tasks: [currentTask],
          connections: [],
        }),
        'user-123',
      );
      expect(mockRetryQueueService.removeByEntities).toHaveBeenNthCalledWith(1, 'task', ['task-stale']);
      expect(mockRetryQueueService.removeByEntities).toHaveBeenNthCalledWith(2, 'connection', ['connection-stale']);
      expect(mockRetryQueueService.removeConnectionsReferencingTasks).toHaveBeenCalledWith(
        'proj-store-snapshot',
        ['task-stale'],
      );
      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => mockProjectStateService.projects());
    });

    it('自动持久化检测到同 id 新快照时应清理过期重试载荷', async () => {
      const staleTask = createTestTask({
        id: 'task-shared',
        title: 'Stale Task',
        updatedAt: '2026-04-10T00:00:00.000Z',
      });
      const currentTask = {
        ...staleTask,
        title: 'Current Task',
        updatedAt: '2026-04-10T01:00:00.000Z',
      };
      const staleProject = createTestProject({
        id: 'proj-superseded-retry',
        tasks: [staleTask],
        connections: [
          {
            id: 'connection-shared',
            source: 'task-shared',
            target: 'task-shared',
            title: 'stale edge',
            updatedAt: '2026-04-10T00:00:00.000Z',
          },
        ],
      });
      const currentProject = {
        ...staleProject,
        tasks: [currentTask],
        connections: [
          {
            ...staleProject.connections[0],
            title: 'current edge',
            updatedAt: '2026-04-10T01:00:00.000Z',
          },
        ],
      };

      mockProjectStateService.activeProject.set(staleProject);
      mockProjectStateService.projects.set([staleProject]);
      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => [currentProject]);
      mockProjectStateService.setProjects.mockClear();
      mockSyncService.saveProjectSmart.mockClear();
      mockRetryQueueService.removeByEntities.mockReset();
      mockRetryQueueService.removeConnectionsReferencingTasks.mockReset();
      mockRetryQueueService.removeByEntities
        .mockReturnValueOnce(['task-shared'])
        .mockReturnValueOnce(['connection-shared']);
      mockRetryQueueService.removeConnectionsReferencingTasks.mockReturnValue([]);

      service.schedulePersist();
      await vi.advanceTimersByTimeAsync(3000);

      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(1);
      });

      expect(mockProjectStateService.setProjects).toHaveBeenCalledWith([currentProject]);
      expect(mockSyncService.saveProjectSmart).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'proj-superseded-retry',
          tasks: [currentTask],
          connections: currentProject.connections,
        }),
        'user-123',
      );
      expect(mockRetryQueueService.removeByEntities).toHaveBeenNthCalledWith(1, 'task', ['task-shared']);
      expect(mockRetryQueueService.removeByEntities).toHaveBeenNthCalledWith(2, 'connection', ['connection-shared']);
      expect(mockRetryQueueService.removeConnectionsReferencingTasks).not.toHaveBeenCalled();
      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => mockProjectStateService.projects());
    });

    it('连续调用 schedulePersist 应该只触发一次持久化', async () => {
      // 确保从干净状态开始
      mockSyncService.saveOfflineSnapshot.mockClear();

      const project = createTestProject({ id: 'proj-1' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);

      // 记录初始调用次数（可能有来自本地自动保存的调用）
      const initialCalls = mockSyncService.saveOfflineSnapshot.mock.calls.length;

      // 连续快速调用三次，由于防抖机制，应该只触发一次持久化
      service.schedulePersist();
      service.schedulePersist();
      service.schedulePersist();

      // 等待 DEBOUNCE_DELAY (3000ms) 后应该触发
      await vi.advanceTimersByTimeAsync(3000);

      // 等待异步持久化操作完成
      await vi.waitFor(() => {
        // 验证持久化已被调用（至少有 persistActiveProject 的 2 次调用）
        // 注意：还可能有本地自动保存的调用（每秒一次）
        const totalCalls = mockSyncService.saveOfflineSnapshot.mock.calls.length;
        expect(totalCalls).toBeGreaterThanOrEqual(initialCalls + 2);
      });
    });

    it('连续调度持久化时应清理浏览器返回 0 的旧本地快照 timer handle', () => {
      const project = createTestProject({ id: 'proj-timer-zero' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.activeProjectId.set(project.id);
      mockProjectStateService.projects.set([project]);

      let timerIndex = 0;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
        .mockImplementation((() => {
          const handle = timerIndex;
          timerIndex += 1;
          return handle;
        }) as unknown as typeof setTimeout);
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
        .mockImplementation((() => undefined) as unknown as typeof clearTimeout);

      try {
        service.schedulePersist();
        service.schedulePersist();

        expect(setTimeoutSpy).toHaveBeenCalled();
        expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    });

    it('被新 timer 替换后的旧本地快照 callback 不应继续写入快照', () => {
      const project = createTestProject({ id: 'proj-stale-local-snapshot' });
      const timerCallbacks: Array<() => void> = [];
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.activeProjectId.set(project.id);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveOfflineSnapshot.mockClear();

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
        .mockImplementation(((callback: TimerHandler) => {
          timerCallbacks.push(
            typeof callback === 'function'
              ? () => callback()
              : () => undefined,
          );
          return timerCallbacks.length;
        }) as unknown as typeof setTimeout);
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
        .mockImplementation((() => undefined) as unknown as typeof clearTimeout);

      try {
        service.schedulePersist();
        const staleLocalSnapshotCallback = timerCallbacks[0];
        service.schedulePersist();

        staleLocalSnapshotCallback();

        expect(mockSyncService.saveOfflineSnapshot).not.toHaveBeenCalled();
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    });

    it('被新 timer 替换后的旧云端持久化 callback 不应继续触发保存', async () => {
      const project = createTestProject({ id: 'proj-stale-persist' });
      const timerCallbacks: Array<() => void> = [];
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.activeProjectId.set(project.id);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveProjectSmart.mockClear();
      mockSyncService.saveOfflineSnapshot.mockClear();

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
        .mockImplementation(((callback: TimerHandler) => {
          timerCallbacks.push(
            typeof callback === 'function'
              ? () => callback()
              : () => undefined,
          );
          return timerCallbacks.length;
        }) as unknown as typeof setTimeout);
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
        .mockImplementation((() => undefined) as unknown as typeof clearTimeout);

      try {
        service.schedulePersist();
        const stalePersistCallback = timerCallbacks[1];
        service.schedulePersist();

        stalePersistCallback();
        await Promise.resolve();

        expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    });

    it('存在未解决冲突时应跳过云端持久化（避免重复弹窗）', async () => {
      const project = createTestProject({ id: 'proj-1' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);

      mockSyncService.syncState.set(createMockSyncState({
        hasConflict: true,
        conflictData: { projectId: 'proj-1' } as any,
      }));

      mockSyncService.saveOfflineSnapshot.mockClear();
      service.schedulePersist();
      // DEBOUNCE_DELAY = 3000ms, 需要推进足够时间让定时器触发
      await vi.advanceTimersByTimeAsync(3500);

      await vi.waitFor(() => {
        // persist + 可能的 autosave 定时器：至少 1 次保存
        expect(mockSyncService.saveOfflineSnapshot).toHaveBeenCalled();
      }, { timeout: 500, interval: 20 });
      // 关键断言：存在冲突时不应调用云端保存
      expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
    });

    it('local-only 项目应仅保留本地，不自动上传云端', async () => {
      const project = createTestProject({
        id: 'proj-local-only',
        syncSource: 'local-only',
        pendingSync: false,
      });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);

      mockSyncService.saveOfflineSnapshot.mockClear();
      mockSyncService.saveProjectSmart.mockClear();

      service.schedulePersist();
      await vi.advanceTimersByTimeAsync(3500);

      await vi.waitFor(() => {
        expect(mockSyncService.saveOfflineSnapshot).toHaveBeenCalled();
      }, { timeout: 500, interval: 20 });

      expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();
      const persistedProject = mockProjectStateService.projects().find((p: Project) => p.id === 'proj-local-only');
      expect(persistedProject?.syncSource).toBe('local-only');
      expect(persistedProject?.pendingSync).toBe(true);
    });

    it('remoteConfirmed 后应广播 data-synced', async () => {
      const project = createTestProject({ id: 'proj-1' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveProjectSmart.mockResolvedValueOnce({ success: true, newVersion: 3 });

      service.schedulePersist();
      await vi.advanceTimersByTimeAsync(3000);

      await vi.waitFor(() => {
        expect(mockTabSyncService.notifyDataSynced).toHaveBeenCalledWith('proj-1', expect.any(String));
      });
    });

    it('旧会话的自动持久化冲突结果不应注入当前 active conflict', async () => {
      const project = createTestProject({ id: 'proj-stale-conflict' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.setConflict.mockClear();
      mockConflictStorageService.saveConflict.mockClear();

      let resolvePersist: ((value: { success: boolean; conflict?: boolean; remoteData?: Project }) => void) | null = null;
      mockSyncService.saveProjectSmart.mockImplementationOnce(() => new Promise(resolve => {
        resolvePersist = resolve;
      }));

      service.schedulePersist();
      await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(1);
      });

      (service as unknown as { authContextGeneration: number }).authContextGeneration += 1;
      mockAuthService.currentUserId.mockReturnValue('user-456');

      resolvePersist!({
        success: false,
        conflict: true,
        remoteData: createTestProject({ id: 'proj-stale-conflict', version: 3 }),
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSyncService.setConflict).not.toHaveBeenCalled();
      expect(mockConflictStorageService.saveConflict).not.toHaveBeenCalled();
    });

    it('flushPendingPersist 应在后台切走前抢发一次云端持久化', async () => {
      const project = createTestProject({ id: 'proj-bg-flush' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveProjectSmart.mockClear();
      mockSyncService.saveOfflineSnapshot.mockClear();

      service.markLocalChanges('content');
      service.flushPendingPersist();

      expect(mockSyncService.saveOfflineSnapshot).toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(1);
      });
    });

    it('partialRetryHandoff 仍有 project ActionQueue 回放兜底时不应升级为风险告警', async () => {
      const project = createTestProject({ id: 'proj-partial-handoff-covered' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockActionQueueService.getPendingActionsForProject.mockReturnValueOnce([
        {
          entityType: 'project',
          entityId: 'proj-partial-handoff-covered',
          type: 'update',
        },
      ]);
      mockSyncService.saveProjectSmart.mockResolvedValueOnce({
        success: false,
        failedConnectionIds: ['connection-risk'],
        retryEnqueued: [],
        partialRetryHandoff: true,
        failureReason: 'project batch sync partially delegated; some failures did not enter retry queue',
      });
      mockLoggerCategory.info.mockClear();
      mockLoggerCategory.warn.mockClear();
      mockToastService.warning.mockClear();

      service.markLocalChanges('content');
      service.flushPendingPersist();

      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(1);
      });

      expect(mockLoggerCategory.info).toHaveBeenCalledWith(
        '远端未完全确认，未入重试队列的项仍由 ActionQueue 保底回放',
        expect.objectContaining({
          projectId: 'proj-partial-handoff-covered',
          uncoveredConnectionCount: 1,
        }),
      );
      expect(mockLoggerCategory.warn).not.toHaveBeenCalledWith(
        '远端未完全确认，存在未入重试队列的风险项',
        expect.anything(),
      );
      expect(mockToastService.warning).not.toHaveBeenCalledWith(
        '同步未完成',
        expect.any(String),
      );
    });

    it('partialRetryHandoff 缺少 project ActionQueue 回放兜底时仍应保留风险告警', async () => {
      const project = createTestProject({ id: 'proj-partial-handoff-uncovered' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockActionQueueService.getPendingActionsForProject.mockReturnValueOnce([]);
      mockSyncService.saveProjectSmart.mockResolvedValueOnce({
        success: false,
        failedConnectionIds: ['connection-risk'],
        retryEnqueued: [],
        partialRetryHandoff: true,
        failureReason: 'project batch sync partially delegated; some failures did not enter retry queue',
      });
      mockLoggerCategory.warn.mockClear();
      mockToastService.warning.mockClear();

      service.markLocalChanges('content');
      service.flushPendingPersist();

      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(1);
      });

      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        '远端未完全确认，存在未入重试队列的风险项',
        expect.objectContaining({
          projectId: 'proj-partial-handoff-uncovered',
          uncoveredConnectionCount: 1,
        }),
      );
      expect(mockToastService.warning).toHaveBeenCalledWith(
        '同步未完成',
        expect.stringContaining('连接失败 1 项'),
      );
    });

    it('flushPendingPersistToCloud 离线时应只保留本地快照', async () => {
      const project = createTestProject({ id: 'proj-offline-flush' });
      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.syncState.set(createMockSyncState({ isOnline: false }));
      mockSyncService.saveProjectSmart.mockClear();

      const previousOnline = navigator.onLine;
      Object.defineProperty(navigator, 'onLine', {
        value: false,
        configurable: true,
      });

      service.markLocalChanges('content');
      const flushed = await service.flushPendingPersistToCloud('before-unload:test');

      expect(flushed).toBe(false);
      expect(mockSyncService.saveProjectSmart).not.toHaveBeenCalled();

      Object.defineProperty(navigator, 'onLine', {
        value: previousOnline,
        configurable: true,
      });
    });

    it('后台 flush 遇到进行中的持久化时应保留脏标记并补刷下一轮', async () => {
      const project = createTestProject({ id: 'proj-inflight-flush' });
      const resolvers: Array<(value: { success: boolean; newVersion: number }) => void> = [];

      mockProjectStateService.activeProject.set(project);
      mockProjectStateService.projects.set([project]);
      mockSyncService.saveProjectSmart.mockClear();
      mockChangeTrackerService.clearProjectFieldLocks.mockClear();
      mockChangeTrackerService.clearProjectChanges.mockClear();
      mockSyncService.saveProjectSmart.mockImplementation(
        () => new Promise(resolve => {
          resolvers.push(resolve as (value: { success: boolean; newVersion: number }) => void);
        })
      );

      service.markLocalChanges('content');
      service.schedulePersist();
      await vi.advanceTimersByTimeAsync(3000);

      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(1);
      });

      service.markLocalChanges('content');
      service.schedulePersist();
      service.flushPendingPersist();

      expect(service.hasPendingLocalChanges()).toBe(true);

      resolvers[0]?.({ success: true, newVersion: 2 });
      await vi.waitFor(() => {
        expect(service.hasPendingLocalChanges()).toBe(true);
      });
      expect(mockProjectStateService.projects().find((p: Project) => p.id === 'proj-inflight-flush')?.pendingSync).toBe(true);
      expect(mockChangeTrackerService.clearProjectFieldLocks).not.toHaveBeenCalled();
      expect(mockChangeTrackerService.clearProjectChanges).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3000);
      await vi.waitFor(() => {
        expect(mockSyncService.saveProjectSmart).toHaveBeenCalledTimes(2);
      });

      resolvers[1]?.({ success: true, newVersion: 3 });
      await vi.waitFor(() => {
        expect(service.hasPendingLocalChanges()).toBe(false);
      });
      expect(mockProjectStateService.projects().find((p: Project) => p.id === 'proj-inflight-flush')?.pendingSync).toBe(false);
      expect(mockChangeTrackerService.clearProjectFieldLocks).toHaveBeenCalledTimes(1);
      expect(mockChangeTrackerService.clearProjectChanges).toHaveBeenCalledTimes(1);
    });

    it('收到 data-synced 广播应走本地回填并受 cooldown 限制', () => {
      const callback = mockTabSyncService.setOnDataSyncedCallback.mock.calls[0]?.[0] as
        | ((projectId: string, updatedAt: string) => void)
        | undefined;
      expect(callback).toBeTypeOf('function');

      const snapshotProject = createTestProject({
        id: 'proj-1',
        updatedAt: '2026-02-14T00:00:00.000Z',
        tasks: [createTestTask({ id: 'task-1' })],
      });

      mockProjectStateService.projects.set([createTestProject({ id: 'proj-1' })]);
      mockSyncService.loadOfflineSnapshot.mockReturnValue([snapshotProject]);
      mockActionQueueService.getPendingActionsForProject.mockReturnValue([]);
      mockChangeTrackerService.hasProjectChanges.mockReturnValue(false);

      callback?.('proj-1', '2026-02-14T00:00:00.000Z');
      callback?.('proj-1', '2026-02-14T00:00:01.000Z');

      expect(mockProjectStateService.updateProjects).toHaveBeenCalledTimes(1);
      expect(mockSyncService.loadProjectsFromCloud).not.toHaveBeenCalled();
    });
  });


}
