import { AUTH_CONFIG, beforeEach, expect, FEATURE_FLAGS, it } from './sync-coordinator.service.spec-context';
import type { Project, SyncCoordinatorService } from './sync-coordinator.service.spec-context';
import { registerSyncCoordinatorActiveProjectQueueRaceSpecs } from './sync-coordinator-active-project-queue-race.spec-helpers';
import { registerSyncCoordinatorActiveProjectTombstoneCompletenessSpecs } from './sync-coordinator-active-project-tombstone-completeness.spec-helpers';
import type { SyncCoordinatorOfflineMergeSpecContext } from './sync-coordinator-offline-merge.spec-helpers';

export function registerSyncCoordinatorRefreshWatermarkSpecs(
  context: SyncCoordinatorOfflineMergeSpecContext,
): void {
  let service: SyncCoordinatorService;
  let mockSyncService: any;
  let mockProjectStateService: any;
  let mockAuthService: any;
  let mockActionQueueService: any;
  let mockRetryQueueService: any;
  let mockConflictService: any;

  const createTestProject = context.createTestProject;
  const createTestTask = context.createTestTask;

  beforeEach(() => {
    service = context.service();
    mockSyncService = context.mockSyncService();
    mockProjectStateService = context.mockProjectStateService();
    mockAuthService = context.mockAuthService();
    mockActionQueueService = context.mockActionQueueService();
    mockRetryQueueService = context.mockRetryQueueService();
    mockConflictService = context.mockConflictService();
  });

  registerSyncCoordinatorActiveProjectQueueRaceSpecs(context);
  registerSyncCoordinatorActiveProjectTombstoneCompletenessSpecs(context);

  it('refreshActiveProjectSilent 在远端水位未超过拉取游标时应走快路跳过远端拉取', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

    const localUpdatedAt = '2026-02-14T08:00:00.000Z';
    const localProject = createTestProject({
      id: 'proj-1',
      updatedAt: localUpdatedAt
    });

    mockProjectStateService.projects.set([localProject]);
    mockProjectStateService.activeProjectId.set('proj-1');
    mockAuthService.currentUserId.mockReturnValue('user-123');
    // 快路合法前提：该项目的增量拉取游标已经覆盖远端水位
    mockSyncService.ensureProjectSyncCursorLoaded.mockResolvedValueOnce({
      updatedAt: '2026-02-14T08:00:00.000Z',
      entityType: 'project',
      id: 'proj-1',
    });
    mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T07:59:59.000Z');

    const result = await service.refreshActiveProjectSilent('resume:test');

    expect(result).toEqual({
      refreshed: false,
      skippedReason: 'watermark-not-newer',
      fastPathHit: true
    });
    expect(mockSyncService.commitProjectSyncTimestamp).toHaveBeenCalledWith('proj-1', '2026-02-14T07:59:59.000Z');
    expect(mockSyncService.loadFullProjectOptimized).not.toHaveBeenCalled();
  });

  it('refreshActiveProjectSilent 在本地模式下不应触发远端探测或项目拉取', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

    const localProject = createTestProject({
      id: 'proj-local',
      updatedAt: '2026-02-14T08:00:00.000Z',
    });

    mockProjectStateService.projects.set([localProject]);
    mockProjectStateService.activeProjectId.set('proj-local');
    mockAuthService.currentUserId.mockReturnValue(AUTH_CONFIG.LOCAL_MODE_USER_ID);

    const result = await service.refreshActiveProjectSilent('resume:local-mode');

    expect(result).toEqual({ refreshed: false, skippedReason: 'local-mode' });
    expect(mockSyncService.getAccessibleProjectProbe).not.toHaveBeenCalled();
    expect(mockSyncService.getProjectSyncWatermark).not.toHaveBeenCalled();
    expect(mockSyncService.loadFullProjectOptimized).not.toHaveBeenCalled();
  });

  it.each(['pending', 'unknown'] as const)(
    'refreshActiveProjectSilent 在 RetryQueue owner 写入状态为 %s 时应 fail closed 保留本地项目',
    async (retryQueueState) => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;
      const localProject = createTestProject({
        id: 'proj-retry-protected',
        updatedAt: '2026-02-14T08:00:00.000Z',
        tasks: [createTestTask({ id: 'task-retry-protected', title: 'Local pending write' })],
      });
      mockProjectStateService.projects.set([localProject]);
      mockProjectStateService.activeProjectId.set(localProject.id);
      mockAuthService.currentUserId.mockReturnValue('user-123');
      mockActionQueueService.getProjectPendingWriteState.mockReturnValueOnce('clear');
      mockRetryQueueService.getProjectPendingWriteState.mockReturnValueOnce(retryQueueState);

      const result = await service.refreshActiveProjectSilent(`resume:retry-${retryQueueState}`);

      expect(result).toEqual({ refreshed: false, skippedReason: 'pending-local-writes' });
      expect(mockSyncService.getAccessibleProjectProbe).not.toHaveBeenCalled();
      expect(mockSyncService.getProjectSyncWatermark).not.toHaveBeenCalled();
      expect(mockSyncService.loadFullProjectOptimized).not.toHaveBeenCalled();
      expect(mockConflictService.smartMerge).not.toHaveBeenCalled();
      expect(mockProjectStateService.updateProjects).not.toHaveBeenCalled();
      expect(mockSyncService.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
      expect(mockSyncService.commitProjectSyncCursor).not.toHaveBeenCalled();
    },
  );

  it('refreshActiveProjectSilent 本地数据水位追平远端但拉取游标落后时不得走快路推进游标', async () => {
    // P0 回归：本机推送回显会把本地聚合水位抬到与远端相等，
    // 但拉取游标仍停在旧位置——中间可能有另一设备的未拉取行。
    // 快路若按"本地数据水位"判定并 commitProjectSyncTimestamp(远端水位)，
    // 该行将永远落在增量窗口之外（永久静默缺口）。
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

    const localProject = createTestProject({
      id: 'proj-agg',
      updatedAt: '2026-02-14T08:00:00.000Z',
      tasks: [
        createTestTask({
          id: 'task-agg',
          // 本机推送回显：本地聚合水位 = 远端水位
          updatedAt: '2026-02-14T08:12:00.000Z'
        })
      ],
    });
    const remoteProject = createTestProject({
      id: 'proj-agg',
      updatedAt: '2026-02-14T08:12:00.000Z',
      tasks: [createTestTask({ id: 'task-agg', updatedAt: '2026-02-14T08:12:00.000Z' })],
    });

    mockProjectStateService.projects.set([localProject]);
    mockProjectStateService.activeProjectId.set('proj-agg');
    mockAuthService.currentUserId.mockReturnValue('user-123');
    // 拉取游标停在旧位置：07:58（07:59:20 的另一设备写入尚未拉取）
    mockSyncService.ensureProjectSyncCursorLoaded.mockResolvedValueOnce({
      updatedAt: '2026-02-14T07:58:00.000Z',
      entityType: 'project',
      id: 'proj-agg',
    });
    mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T08:12:00.000Z');
    mockSyncService.loadFullProjectOptimized.mockResolvedValueOnce(remoteProject);
    mockConflictService.smartMerge.mockReturnValueOnce({
      project: remoteProject,
      issues: [],
      conflictCount: 0,
    });

    const result = await service.refreshActiveProjectSilent('resume:test:cursor-behind-watermark');

    expect(result.fastPathHit).not.toBe(true);
    expect(mockSyncService.loadFullProjectOptimized).toHaveBeenCalledWith('proj-agg');
    // 不得在未拉取的情况下用远端水位直接推进游标
    expect(mockSyncService.commitProjectSyncTimestamp).not.toHaveBeenCalled();
  });

  it('refreshActiveProjectSilent 拉取游标已覆盖远端水位时应命中快路', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

    const localProject = createTestProject({
      id: 'proj-agg',
      updatedAt: '2026-02-14T08:00:00.000Z',
      tasks: [
        createTestTask({
          id: 'task-agg',
          updatedAt: '2026-02-14T08:12:00.000Z'
        })
      ],
    });

    mockProjectStateService.projects.set([localProject]);
    mockProjectStateService.activeProjectId.set('proj-agg');
    mockAuthService.currentUserId.mockReturnValue('user-123');
    // 游标已覆盖远端水位：上次增量拉取推进到 08:11
    mockSyncService.ensureProjectSyncCursorLoaded.mockResolvedValueOnce({
      updatedAt: '2026-02-14T08:11:00.000Z',
      entityType: 'task',
      id: 'task-agg',
    });
    mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T08:10:00.000Z');

    const result = await service.refreshActiveProjectSilent('resume:test:cursor-fastpath');

    expect(result).toEqual({
      refreshed: false,
      skippedReason: 'watermark-not-newer',
      fastPathHit: true
    });
    expect(mockSyncService.commitProjectSyncTimestamp).toHaveBeenCalledWith('proj-agg', '2026-02-14T08:10:00.000Z');
    expect(mockSyncService.loadFullProjectOptimized).not.toHaveBeenCalled();
  });

  it('refreshActiveProjectSilent 在远端水位更新时应加载并静默合并活动项目', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

    const localProject = createTestProject({
      id: 'proj-1',
      updatedAt: '2026-02-14T08:00:00.000Z',
      tasks: [createTestTask({ id: 'task-local', updatedAt: '2026-02-14T07:55:00.000Z' })],
    });
    const remoteProject = createTestProject({
      id: 'proj-1',
      updatedAt: '2026-02-14T08:10:00.000Z',
      tasks: [createTestTask({ id: 'task-remote' })],
    });
    const staleShellProject = createTestProject({
      id: 'proj-shell',
      tasks: [],
    });
    const authoritativeShellTask = createTestTask({
      id: 'task-authoritative',
      content: 'must survive active-project refresh snapshot persistence',
    });

    mockProjectStateService.projects.set([localProject, staleShellProject]);
    mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => (
      mockProjectStateService.projects().map((project: Project) => (
        project.id === staleShellProject.id
          ? { ...project, tasks: [authoritativeShellTask] }
          : project
      ))
    ));
    mockProjectStateService.activeProjectId.set('proj-1');
    mockAuthService.currentUserId.mockReturnValue('user-123');
    mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T08:10:00.000Z');
    mockSyncService.loadFullProjectOptimized.mockResolvedValueOnce(remoteProject);
    mockConflictService.smartMerge.mockReturnValueOnce({
      project: remoteProject,
      issues: [],
      conflictCount: 0,
    });

    const calls: string[] = [];
    mockProjectStateService.updateProjects.mockImplementation((updater: (projects: Project[]) => Project[]) => {
      mockProjectStateService.projects.set(updater(mockProjectStateService.projects()));
      calls.push('merge');
    });
    mockSyncService.saveOfflineSnapshotAndWait.mockImplementation(async () => {
      calls.push('persist');
    });
    mockSyncService.commitProjectSyncCursor.mockImplementation(async () => {
      calls.push('commit');
    });

    const result = await service.refreshActiveProjectSilent('resume:test');

    expect(result.refreshed).toBe(true);
    expect(mockSyncService.loadFullProjectOptimized).toHaveBeenCalledWith('proj-1');
    expect(mockSyncService.saveOfflineSnapshotAndWait).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'proj-1', updatedAt: '2026-02-14T08:10:00.000Z' }),
      expect.objectContaining({
        id: 'proj-shell',
        tasks: [expect.objectContaining({
          id: 'task-authoritative',
          content: 'must survive active-project refresh snapshot persistence',
        })],
      }),
    ]));
    expect(mockSyncService.commitProjectSyncCursor).toHaveBeenCalledWith('proj-1', {
      updatedAt: '2026-02-14T08:10:00.000Z',
      entityType: 'project',
      id: 'proj-1',
    });
    expect(calls).toEqual(['merge', 'persist', 'commit']);
    expect(mockProjectStateService.projects()[0]?.updatedAt).toBe('2026-02-14T08:10:00.000Z');
  });

  it('refreshActiveProjectSilent 应以 getProjectWithCurrentData 的全量本地项目作为 smartMerge baseline', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

    const projectId = 'proj-authoritative-refresh';
    const shellProject = createTestProject({
      id: projectId,
      updatedAt: '2026-02-14T08:00:00.000Z',
      tasks: [],
      connections: [],
    });
    const authoritativeLocalProject = createTestProject({
      id: projectId,
      updatedAt: '2026-02-14T08:00:00.000Z',
      tasks: [
        createTestTask({
          id: 'task-authoritative-refresh',
          title: 'Authoritative local task',
          content: 'must be used as refresh local baseline',
          updatedAt: '2026-02-14T08:00:00.000Z',
        }),
      ],
      connections: [
        {
          id: 'conn-authoritative-refresh',
          source: 'task-authoritative-refresh',
          target: 'task-authoritative-refresh',
        } as Project['connections'][number],
      ],
    });
    const remoteProject = createTestProject({
      id: projectId,
      updatedAt: '2026-02-14T08:10:00.000Z',
      tasks: [createTestTask({ id: 'task-remote-refresh' })],
    });
    let authoritativeProjects = [authoritativeLocalProject];
    const defaultGetProject = mockProjectStateService.getProject.getMockImplementation();
    const defaultGetProjectsWithCurrentData = mockProjectStateService.getProjectsWithCurrentData.getMockImplementation();
    const defaultGetProjectWithCurrentData = mockProjectStateService.getProjectWithCurrentData.getMockImplementation();
    const defaultUpdateProjects = mockProjectStateService.updateProjects.getMockImplementation();

    try {
      mockProjectStateService.projects.set([shellProject]);
      mockProjectStateService.activeProjectId.set(projectId);
      mockProjectStateService.getProject.mockImplementation((id: string) =>
        id === projectId ? shellProject : undefined);
      mockProjectStateService.getProjectsWithCurrentData.mockImplementation(() => authoritativeProjects);
      mockProjectStateService.getProjectWithCurrentData.mockImplementation((id: string) =>
        authoritativeProjects.find((project: Project) => project.id === id));
      mockProjectStateService.updateProjects.mockImplementation((updater: (projects: Project[]) => Project[]) => {
        authoritativeProjects = updater(authoritativeProjects);
        mockProjectStateService.projects.set(authoritativeProjects);
      });
      mockAuthService.currentUserId.mockReturnValue('user-123');
      mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T08:10:00.000Z');
      mockSyncService.loadFullProjectOptimized.mockResolvedValueOnce(remoteProject);
      mockConflictService.smartMerge.mockReturnValueOnce({
        project: remoteProject,
        issues: [],
        conflictCount: 0,
      });

      const result = await service.refreshActiveProjectSilent('resume:test:authoritative-baseline');

      expect(result.refreshed).toBe(true);
      expect(mockConflictService.smartMerge).toHaveBeenCalledWith(
        expect.objectContaining({
          id: projectId,
          tasks: [
            expect.objectContaining({
              id: 'task-authoritative-refresh',
              content: 'must be used as refresh local baseline',
            }),
          ],
          connections: [
            expect.objectContaining({
              id: 'conn-authoritative-refresh',
              source: 'task-authoritative-refresh',
              target: 'task-authoritative-refresh',
            }),
          ],
        }),
        remoteProject,
        expect.anything(),
      );
    } finally {
      if (defaultGetProject) {
        mockProjectStateService.getProject.mockImplementation(defaultGetProject);
      } else {
        mockProjectStateService.getProject.mockReset();
      }
      if (defaultGetProjectsWithCurrentData) {
        mockProjectStateService.getProjectsWithCurrentData.mockImplementation(defaultGetProjectsWithCurrentData);
      } else {
        mockProjectStateService.getProjectsWithCurrentData.mockReset();
      }
      if (defaultGetProjectWithCurrentData) {
        mockProjectStateService.getProjectWithCurrentData.mockImplementation(defaultGetProjectWithCurrentData);
      } else {
        mockProjectStateService.getProjectWithCurrentData.mockReset();
      }
      if (defaultUpdateProjects) {
        mockProjectStateService.updateProjects.mockImplementation(defaultUpdateProjects);
      } else {
        mockProjectStateService.updateProjects.mockReset();
      }
    }
  });

  it('refreshActiveProjectSilent 远端加载期间出现新的本地编辑时不应用旧本地快照合并结果', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

    const localProject = createTestProject({
      id: 'proj-1',
      updatedAt: '2026-02-14T08:00:00.000Z',
      tasks: [
        createTestTask({
          id: 'task-draft',
          title: '请求前标题',
          content: '请求前正文',
          updatedAt: '2026-02-14T08:00:00.000Z',
        }),
      ],
    });
    const localProjectEditedDuringRequest = {
      ...localProject,
      updatedAt: '2026-02-14T08:12:00.000Z',
      tasks: [
        {
          ...localProject.tasks[0],
          title: '请求期间本地标题',
          content: '请求期间本地正文',
          updatedAt: '2026-02-14T08:12:00.000Z',
        },
      ],
    };
    const remoteProject = createTestProject({
      id: 'proj-1',
      updatedAt: '2026-02-14T08:10:00.000Z',
      tasks: [
        createTestTask({
          id: 'task-draft',
          title: '远端旧标题',
          content: '远端旧正文',
          updatedAt: '2026-02-14T08:10:00.000Z',
        }),
      ],
    });
    let resolveRemoteProject!: (project: Project) => void;
    const remoteProjectPromise = new Promise<Project>(resolve => {
      resolveRemoteProject = resolve;
    });

    mockProjectStateService.projects.set([localProject]);
    mockProjectStateService.activeProjectId.set('proj-1');
    mockAuthService.currentUserId.mockReturnValue('user-123');
    mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T08:10:00.000Z');
    mockSyncService.loadFullProjectOptimized.mockReturnValueOnce(remoteProjectPromise);
    mockConflictService.smartMerge.mockImplementationOnce((local: Project, remote: Project) => ({
      project: {
        ...remote,
        tasks: local.tasks,
        updatedAt: local.updatedAt,
        pendingSync: true,
      },
      issues: [],
      conflictCount: 0,
    }));

    const refreshing = service.refreshActiveProjectSilent('resume:test:local-edit-during-refresh');
    await Promise.resolve();

    mockProjectStateService.projects.set([localProjectEditedDuringRequest]);
    resolveRemoteProject(remoteProject);

    const result = await refreshing;

    expect(result).toEqual({
      refreshed: false,
      skippedReason: 'local-project-changed-during-refresh',
    });
    expect(mockProjectStateService.updateProjects).not.toHaveBeenCalled();
    expect(mockSyncService.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
    expect(mockSyncService.commitProjectSyncCursor).not.toHaveBeenCalled();
    expect(mockProjectStateService.projects()[0]?.tasks[0]?.title).toBe('请求期间本地标题');
    expect(mockProjectStateService.projects()[0]?.tasks[0]?.content).toBe('请求期间本地正文');
  });

  it('refreshActiveProjectSilent 本地结构变化但最大时间戳不变时不应应用旧远端结果', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

    const localProject = createTestProject({
      id: 'proj-structural-race',
      updatedAt: '2026-02-14T08:20:00.000Z',
      tasks: [
        createTestTask({
          id: 'task-draft',
          content: '请求前正文',
          updatedAt: '2026-02-14T08:00:00.000Z',
        }),
      ],
    });
    const locallyEditedProject = {
      ...localProject,
      tasks: [{
        ...localProject.tasks[0],
        content: '请求期间本地正文',
      }],
    };
    const remoteProject = createTestProject({
      id: 'proj-structural-race',
      updatedAt: '2026-02-14T08:30:00.000Z',
      tasks: [createTestTask({
        id: 'task-draft',
        content: '远端旧正文',
        updatedAt: '2026-02-14T08:10:00.000Z',
      })],
    });
    let resolveRemoteProject!: (project: Project) => void;
    const remoteProjectPromise = new Promise<Project>(resolve => {
      resolveRemoteProject = resolve;
    });

    mockProjectStateService.projects.set([localProject]);
    mockProjectStateService.activeProjectId.set('proj-structural-race');
    mockAuthService.currentUserId.mockReturnValue('user-123');
    mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T08:30:00.000Z');
    mockSyncService.loadFullProjectOptimized.mockReturnValueOnce(remoteProjectPromise);
    mockConflictService.smartMerge.mockReturnValueOnce({
      project: remoteProject,
      issues: [],
      conflictCount: 0,
    });

    const refreshing = service.refreshActiveProjectSilent('resume:test:structural-race');
    await Promise.resolve();
    mockProjectStateService.projects.set([locallyEditedProject]);
    resolveRemoteProject(remoteProject);

    const result = await refreshing;

    expect(result).toEqual({
      refreshed: false,
      skippedReason: 'local-project-changed-during-refresh',
    });
    expect(mockProjectStateService.updateProjects).not.toHaveBeenCalled();
    expect(mockSyncService.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
    expect(mockSyncService.commitProjectSyncCursor).not.toHaveBeenCalled();
    expect(mockProjectStateService.projects()[0]?.tasks[0]?.content).toBe('请求期间本地正文');
  });

  it('refreshActiveProjectSilent 远端加载期间 active project 或 owner 变化时不应应用晚到结果', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;

    const localProject = createTestProject({
      id: 'proj-1',
      updatedAt: '2026-02-14T08:00:00.000Z',
      tasks: [createTestTask({ id: 'task-local', updatedAt: '2026-02-14T07:55:00.000Z' })],
    });
    const otherProject = createTestProject({
      id: 'proj-2',
      updatedAt: '2026-02-14T08:01:00.000Z',
    });
    const remoteProject = createTestProject({
      id: 'proj-1',
      updatedAt: '2026-02-14T08:10:00.000Z',
      tasks: [createTestTask({ id: 'task-remote' })],
    });
    let resolveRemoteProject!: (project: Project) => void;
    const remoteProjectPromise = new Promise<Project>(resolve => {
      resolveRemoteProject = resolve;
    });

    mockProjectStateService.projects.set([localProject, otherProject]);
    mockProjectStateService.activeProjectId.set('proj-1');
    mockAuthService.currentUserId.mockReturnValue('user-123');
    mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce('2026-02-14T08:10:00.000Z');
    mockSyncService.loadFullProjectOptimized.mockReturnValueOnce(remoteProjectPromise);
    mockConflictService.smartMerge.mockReturnValueOnce({
      project: remoteProject,
      issues: [],
      conflictCount: 0,
    });

    const refreshing = service.refreshActiveProjectSilent('resume:test:stale-active');
    await Promise.resolve();

    mockProjectStateService.activeProjectId.set('proj-2');
    mockAuthService.currentUserId.mockReturnValue('user-456');
    resolveRemoteProject(remoteProject);

    const result = await refreshing;

    expect(result).toEqual({
      refreshed: false,
      skippedReason: 'stale-active-project',
    });
    expect(mockProjectStateService.updateProjects).not.toHaveBeenCalled();
    expect(mockSyncService.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
    expect(mockSyncService.commitProjectSyncCursor).not.toHaveBeenCalled();
    expect(mockSyncService.commitProjectSyncTimestamp).not.toHaveBeenCalled();
    expect(mockProjectStateService.projects()[0]?.updatedAt).toBe('2026-02-14T08:00:00.000Z');
  });

  it('refreshProjectManifestIfNeeded 命中用户水位快路时应跳过头信息刷新', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
    mockAuthService.currentUserId.mockReturnValue('user-123');
    localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
    mockSyncService.getUserProjectsWatermark.mockResolvedValueOnce('2026-02-15T07:59:59.000Z');

    const result = await service.refreshProjectManifestIfNeeded('manifest:fast-path');

    expect(result).toEqual({
      skipped: true,
      watermark: '2026-02-15T07:59:59.000Z',
    });
    expect(mockSyncService.listProjectHeadsSince).not.toHaveBeenCalled();
  });

  it('refreshProjectManifestIfNeeded 使用预加载水位时不应重复调用 RPC', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
    mockAuthService.currentUserId.mockReturnValue('user-123');
    localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');

    const result = await service.refreshProjectManifestIfNeeded('manifest:prefetched', {
      prefetchedRemoteWatermark: '2026-02-15T07:59:59.000Z',
    });

    expect(result).toEqual({
      skipped: true,
      watermark: '2026-02-15T07:59:59.000Z',
    });
    expect(mockSyncService.getUserProjectsWatermark).not.toHaveBeenCalled();
    expect(mockSyncService.listProjectHeadsSince).not.toHaveBeenCalled();
  });

  it('refreshProjectManifestIfNeeded 删除事件推动预加载 watermark 前进时不应命中快路', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
    mockAuthService.currentUserId.mockReturnValue('user-123');
    localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
    mockSyncService.listProjectHeadsSince.mockResolvedValueOnce([]);

    const result = await service.refreshProjectManifestIfNeeded('manifest:prefetched-delete', {
      prefetchedRemoteWatermark: '2026-02-15T08:20:00.000Z',
      deferCommit: true,
    });

    expect(result).toEqual({
      skipped: false,
      watermark: '2026-02-15T08:20:00.000Z',
    });
    expect(mockSyncService.getUserProjectsWatermark).not.toHaveBeenCalled();
    expect(mockSyncService.listProjectHeadsSince).toHaveBeenCalledWith(
      '2026-02-15T08:00:00.000Z',
      '2026-02-15T08:20:00.000Z',
    );
    expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-123')).toBe('2026-02-15T08:00:00.000Z');
  });

  it('refreshProjectManifestIfNeeded 冷启动无本地水位时不应调用 heads RPC 且不跳过慢路', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
    mockAuthService.currentUserId.mockReturnValue('user-123');
    mockSyncService.getUserProjectsWatermark.mockResolvedValueOnce('2026-02-15T08:20:00.000Z');

    const result = await service.refreshProjectManifestIfNeeded('manifest:cold-start');

    expect(result).toEqual({
      skipped: false,
      watermark: '2026-02-15T08:20:00.000Z',
    });
    expect(mockSyncService.listProjectHeadsSince).not.toHaveBeenCalled();
    expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-123')).toBe('2026-02-15T08:20:00.000Z');
  });

  it('refreshProjectManifestIfNeeded 远端更新且 heads 为空时也不应跳过慢路', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
    mockAuthService.currentUserId.mockReturnValue('user-123');
    localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
    mockSyncService.getUserProjectsWatermark.mockResolvedValueOnce('2026-02-15T08:20:00.000Z');
    mockSyncService.listProjectHeadsSince.mockResolvedValueOnce([]);

    const result = await service.refreshProjectManifestIfNeeded('manifest:heads-empty');

    expect(result).toEqual({
      skipped: false,
      watermark: '2026-02-15T08:20:00.000Z',
    });
    expect(mockSyncService.listProjectHeadsSince).toHaveBeenCalledWith(
      '2026-02-15T08:00:00.000Z',
      '2026-02-15T08:20:00.000Z',
    );
  });

  it('refreshProjectManifestIfNeeded heads 分页失败时不应推进本地水位', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
    mockAuthService.currentUserId.mockReturnValue('user-123');
    localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
    mockSyncService.getUserProjectsWatermark.mockResolvedValueOnce('2026-02-15T08:20:00.000Z');
    mockSyncService.listProjectHeadsSince.mockResolvedValueOnce(null);

    const result = await service.refreshProjectManifestIfNeeded('manifest:heads-failed');

    expect(result).toEqual({ skipped: false });
    expect(mockSyncService.listProjectHeadsSince).toHaveBeenCalledWith(
      '2026-02-15T08:00:00.000Z',
      '2026-02-15T08:20:00.000Z',
    );
    expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-123')).toBe('2026-02-15T08:00:00.000Z');
  });

  it('refreshProjectManifestIfNeeded 远端有更新时应拉取头信息并更新本地水位', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
    mockAuthService.currentUserId.mockReturnValue('user-123');
    localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
    mockProjectStateService.projects.set([
      createTestProject({
        id: 'proj-1',
        updatedAt: '2026-02-15T08:00:00.000Z',
        version: 1,
      }),
    ]);
    mockSyncService.getUserProjectsWatermark.mockResolvedValueOnce('2026-02-15T08:20:00.000Z');
    mockSyncService.listProjectHeadsSince.mockResolvedValueOnce([
      {
        id: 'proj-1',
        updatedAt: '2026-02-15T08:19:00.000Z',
        version: 3,
      },
    ]);

    const result = await service.refreshProjectManifestIfNeeded('manifest:slow-path');

    expect(result).toEqual({
      skipped: false,
      watermark: '2026-02-15T08:20:00.000Z',
    });
    expect(mockSyncService.listProjectHeadsSince).toHaveBeenCalledWith(
      '2026-02-15T08:00:00.000Z',
      '2026-02-15T08:20:00.000Z',
    );
    const updated = mockProjectStateService.projects()[0];
    expect(updated?.updatedAt).toBe('2026-02-15T08:19:00.000Z');
    expect(updated?.version).toBe(3);
    expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-123')).toBe('2026-02-15T08:20:00.000Z');
  });

  it('refreshProjectManifestIfNeeded 远端水位返回前 owner 变化时不应应用旧结果', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
    localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
    localStorage.setItem('nanoflow.project-manifest-watermark.user-456', '2026-02-15T09:00:00.000Z');
    mockProjectStateService.projects.set([
      createTestProject({
        id: 'proj-1',
        updatedAt: '2026-02-15T08:00:00.000Z',
        version: 1,
      }),
    ]);
    let resolveRemoteWatermark!: (watermark: string) => void;
    mockAuthService.currentUserId.mockReturnValue('user-123');
    mockSyncService.getUserProjectsWatermark.mockReturnValueOnce(new Promise<string>(resolve => {
      resolveRemoteWatermark = resolve;
    }));
    mockSyncService.listProjectHeadsSince.mockResolvedValueOnce([
      {
        id: 'proj-1',
        updatedAt: '2026-02-15T08:19:00.000Z',
        version: 3,
      },
    ]);

    const refreshing = service.refreshProjectManifestIfNeeded('manifest:stale-owner');
    await Promise.resolve();

    mockAuthService.currentUserId.mockReturnValue('user-456');
    resolveRemoteWatermark('2026-02-15T08:20:00.000Z');

    const result = await refreshing;

    expect(result).toEqual({
      skipped: true,
      watermark: '2026-02-15T08:20:00.000Z',
    });
    expect(mockSyncService.listProjectHeadsSince).not.toHaveBeenCalled();
    expect(mockProjectStateService.updateProjects).not.toHaveBeenCalled();
    expect(mockProjectStateService.projects()[0]?.updatedAt).toBe('2026-02-15T08:00:00.000Z');
    expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-123')).toBe('2026-02-15T08:00:00.000Z');
    expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-456')).toBe('2026-02-15T09:00:00.000Z');
  });

  it('refreshProjectManifestIfNeeded 并发刷新晚到时不应回退本地水位', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).USER_PROJECTS_WATERMARK_RPC_V1 = true;
    mockAuthService.currentUserId.mockReturnValue('user-123');
    localStorage.setItem('nanoflow.project-manifest-watermark.user-123', '2026-02-15T08:00:00.000Z');
    let resolveFirstHeads!: (heads: unknown[]) => void;
    mockSyncService.getUserProjectsWatermark.mockReset();
    mockSyncService.listProjectHeadsSince.mockReset();
    mockSyncService.getUserProjectsWatermark
      .mockResolvedValueOnce('2026-02-15T08:10:00.000Z')
      .mockResolvedValueOnce('2026-02-15T08:20:00.000Z');
    let headsCall = 0;
    mockSyncService.listProjectHeadsSince.mockImplementation(() => {
      headsCall += 1;
      if (headsCall === 1) return new Promise(resolve => {
        resolveFirstHeads = resolve;
      });
      return Promise.resolve([]);
    });

    const first = service.refreshProjectManifestIfNeeded('manifest:race:first');
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSyncService.listProjectHeadsSince).toHaveBeenCalledTimes(1);
    const second = service.refreshProjectManifestIfNeeded('manifest:race:second');

    await second;
    resolveFirstHeads([]);
    await first;

    expect(localStorage.getItem('nanoflow.project-manifest-watermark.user-123')).toBe('2026-02-15T08:20:00.000Z');
  });
}
