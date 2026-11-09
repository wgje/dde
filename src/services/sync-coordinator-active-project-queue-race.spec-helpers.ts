import { beforeEach, expect, FEATURE_FLAGS, it, vi } from './sync-coordinator.service.spec-context';
import type { Project, SyncCoordinatorService } from './sync-coordinator.service.spec-context';
import type { SyncCoordinatorOfflineMergeSpecContext } from './sync-coordinator-offline-merge.spec-helpers';

export function registerSyncCoordinatorActiveProjectQueueRaceSpecs(
  context: SyncCoordinatorOfflineMergeSpecContext,
): void {
  let service: SyncCoordinatorService;
  let mockSyncService: any;
  let mockProjectStateService: any;
  let mockAuthService: any;
  let mockActionQueueService: any;
  let mockRetryQueueService: any;
  let mockConflictService: any;

  beforeEach(() => {
    service = context.service();
    mockSyncService = context.mockSyncService();
    mockProjectStateService = context.mockProjectStateService();
    mockAuthService = context.mockAuthService();
    mockActionQueueService = context.mockActionQueueService();
    mockRetryQueueService = context.mockRetryQueueService();
    mockConflictService = context.mockConflictService();
  });

  it('refreshActiveProjectSilent 远端加载期间 ActionQueue 变为 pending 时不应应用旧远端结果', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;
    const localProject = context.createTestProject({
      id: 'proj-action-queue-race',
      updatedAt: '2026-02-14T08:00:00.000Z',
      tasks: [context.createTestTask({ id: 'task-action-queue-race', title: 'Local task' })],
    });
    const remoteProject = context.createTestProject({
      id: localProject.id,
      updatedAt: '2026-02-14T08:10:00.000Z',
      tasks: [context.createTestTask({ id: 'task-action-queue-race', title: 'Remote task' })],
    });
    let resolveRemoteProject!: (project: Project) => void;
    const remoteProjectPromise = new Promise<Project>(resolve => {
      resolveRemoteProject = resolve;
    });
    let actionQueueState: 'clear' | 'pending' = 'clear';

    mockProjectStateService.projects.set([localProject]);
    mockProjectStateService.activeProjectId.set(localProject.id);
    mockAuthService.currentUserId.mockReturnValue('user-123');
    mockActionQueueService.getProjectPendingWriteState.mockImplementation(() => actionQueueState);
    mockRetryQueueService.getProjectPendingWriteState.mockReturnValue('clear');
    mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce(remoteProject.updatedAt);
    mockSyncService.loadFullProjectOptimized.mockReturnValueOnce(remoteProjectPromise);

    const refreshing = service.refreshActiveProjectSilent('resume:test:action-queue-race');
    await vi.waitFor(() => {
      expect(mockSyncService.loadFullProjectOptimized).toHaveBeenCalledWith(localProject.id);
    });
    actionQueueState = 'pending';
    resolveRemoteProject(remoteProject);

    const result = await refreshing;
    mockActionQueueService.getProjectPendingWriteState.mockImplementation(
      (projectId: string) => (
        mockActionQueueService.getPendingActionsForProject(projectId).length > 0 ? 'pending' : 'clear'
      ),
    );

    expect(result).toEqual({ refreshed: false, skippedReason: 'pending-local-writes' });
    expect(mockConflictService.smartMerge).not.toHaveBeenCalled();
    expect(mockProjectStateService.updateProjects).not.toHaveBeenCalled();
    expect(mockSyncService.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
    expect(mockSyncService.commitProjectSyncCursor).not.toHaveBeenCalled();
  });

  it('refreshActiveProjectSilent merge 期间 RetryQueue 变为 unknown 时不应应用旧合并结果', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;
    const localProject = context.createTestProject({
      id: 'proj-retry-queue-race',
      updatedAt: '2026-02-14T08:00:00.000Z',
      tasks: [context.createTestTask({ id: 'task-retry-queue-race', title: 'Local task' })],
    });
    const remoteProject = context.createTestProject({
      id: localProject.id,
      updatedAt: '2026-02-14T08:10:00.000Z',
      tasks: [context.createTestTask({ id: 'task-retry-queue-race', title: 'Remote task' })],
    });
    let resolveTombstoneIds!: (ids: Set<string>) => void;
    const tombstoneIdsPromise = new Promise<Set<string>>(resolve => {
      resolveTombstoneIds = resolve;
    });
    let retryQueueState: 'clear' | 'unknown' = 'clear';

    mockProjectStateService.projects.set([localProject]);
    mockProjectStateService.activeProjectId.set(localProject.id);
    mockAuthService.currentUserId.mockReturnValue('user-123');
    mockActionQueueService.getProjectPendingWriteState.mockReturnValue('clear');
    mockRetryQueueService.getProjectPendingWriteState.mockImplementation(() => retryQueueState);
    mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce(remoteProject.updatedAt);
    mockSyncService.loadFullProjectOptimized.mockResolvedValueOnce(remoteProject);
    mockSyncService.getTombstoneIds.mockReturnValueOnce(tombstoneIdsPromise);
    mockConflictService.smartMerge.mockReturnValueOnce({
      project: remoteProject,
      issues: [],
      conflictCount: 0,
    });

    const refreshing = service.refreshActiveProjectSilent('resume:test:retry-queue-race');
    await vi.waitFor(() => {
      expect(mockSyncService.getTombstoneIds).toHaveBeenCalledWith(localProject.id);
    });
    retryQueueState = 'unknown';
    resolveTombstoneIds(new Set());

    const result = await refreshing;
    mockRetryQueueService.getProjectPendingWriteState.mockReturnValue('clear');

    expect(result).toEqual({ refreshed: false, skippedReason: 'pending-local-writes' });
    expect(mockConflictService.smartMerge).toHaveBeenCalledOnce();
    expect(mockProjectStateService.updateProjects).not.toHaveBeenCalled();
    expect(mockSyncService.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
    expect(mockSyncService.commitProjectSyncCursor).not.toHaveBeenCalled();
  });
}
