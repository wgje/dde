import { beforeEach, expect, FEATURE_FLAGS, it } from './sync-coordinator.service.spec-context';
import type { SyncCoordinatorService } from './sync-coordinator.service.spec-context';
import type { SyncCoordinatorOfflineMergeSpecContext } from './sync-coordinator-offline-merge.spec-helpers';

export function registerSyncCoordinatorActiveProjectTombstoneCompletenessSpecs(
  context: SyncCoordinatorOfflineMergeSpecContext,
): void {
  let service: SyncCoordinatorService;
  let mockSyncService: any;
  let mockTaskSyncOperationsService: any;
  let mockProjectStateService: any;
  let mockAuthService: any;
  let mockConflictService: any;

  beforeEach(() => {
    service = context.service();
    mockSyncService = context.mockSyncService();
    mockTaskSyncOperationsService = context.mockTaskSyncOperationsService();
    mockProjectStateService = context.mockProjectStateService();
    mockAuthService = context.mockAuthService();
    mockConflictService = context.mockConflictService();
  });

  it('refreshActiveProjectSilent tombstone 查询不完整时应保留本地项目且不得推进游标', async () => {
    (FEATURE_FLAGS as unknown as Record<string, boolean>).RESUME_WATERMARK_RPC_V1 = true;
    const projectId = 'project-tombstone-incomplete';
    const localTask = context.createTestTask({
      id: 'task-local-only',
      content: 'must survive an unverifiable refresh',
      updatedAt: '2026-07-27T00:01:00.000Z',
    });
    const localProject = context.createTestProject({
      id: projectId,
      tasks: [localTask],
      updatedAt: '2026-07-27T00:01:00.000Z',
    });
    const remoteProject = context.createTestProject({
      id: projectId,
      tasks: [],
      updatedAt: '2026-07-27T00:02:00.000Z',
    });

    mockProjectStateService.projects.set([localProject]);
    mockProjectStateService.activeProjectId.set(projectId);
    mockAuthService.currentUserId.mockReturnValue('user-123');
    mockSyncService.getProjectSyncWatermark.mockResolvedValueOnce(remoteProject.updatedAt);
    mockSyncService.loadFullProjectOptimized.mockResolvedValueOnce(remoteProject);
    mockTaskSyncOperationsService.getTombstoneIdsWithStatus.mockResolvedValueOnce({
      ids: new Set<string>(),
      deletedAtByTaskId: new Map<string, number>(),
      fromRemote: false,
      localCacheOnly: true,
      timestamp: Date.now(),
    });
    const result = await service.refreshActiveProjectSilent('resume:tombstone-incomplete');

    expect(result).toEqual({
      refreshed: false,
      skippedReason: 'tombstone-query-incomplete',
    });
    expect(mockConflictService.smartMerge).not.toHaveBeenCalled();
    expect(mockProjectStateService.updateProjects).not.toHaveBeenCalled();
    expect(mockSyncService.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
    expect(mockSyncService.commitProjectSyncCursor).not.toHaveBeenCalled();
    expect(mockSyncService.commitProjectSyncTimestamp).not.toHaveBeenCalled();
    expect(mockProjectStateService.projects()).toEqual([localProject]);
  });
}
