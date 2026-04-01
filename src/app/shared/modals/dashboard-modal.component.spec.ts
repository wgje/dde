import { Injector, computed, runInInjectionContext, signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardModalComponent } from './dashboard-modal.component';
import { ActionQueueService } from '../../../services/action-queue.service';
import { SimpleSyncService } from '../../core/services/simple-sync.service';
import { AuthService } from '../../../services/auth.service';
import { ConflictStorageService } from '../../../services/conflict-storage.service';
import { ProjectOperationService } from '../../../services/project-operation.service';
import { ToastService } from '../../../services/toast.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';

function createConflictRecord(remoteSnapshotFresh = false) {
  const now = '2026-03-30T00:00:00.000Z';
  return {
    projectId: 'proj-1',
    localProject: {
      id: 'proj-1',
      name: 'Local Project',
      description: '',
      createdDate: now,
      updatedAt: now,
      version: 2,
      tasks: [],
      connections: [],
    },
    remoteProject: {
      id: 'proj-1',
      name: 'Remote Project',
      description: '',
      createdDate: now,
      updatedAt: now,
      version: 3,
      tasks: [],
      connections: [],
    },
    remoteSnapshotFresh,
    conflictedAt: now,
    localVersion: 2,
    remoteVersion: 3,
    reason: 'version_mismatch',
    acknowledged: false,
  };
}

describe('DashboardModalComponent conflict resolution', () => {
  let component: DashboardModalComponent;

  const actionQueueMock = {
    queueSize: signal(0),
    deadLetterSize: signal(0),
    deadLetterQueue: signal([]),
    isProcessing: signal(false),
    processQueue: vi.fn().mockResolvedValue(undefined),
    retryDeadLetter: vi.fn(),
    dismissDeadLetter: vi.fn(),
    clearDeadLetterQueue: vi.fn(),
  };

  const syncState = signal({
    isOnline: true,
    isSyncing: false,
    syncError: null,
    offlineMode: false,
  });

  const syncServiceMock = {
    syncState,
  };

  const authUserId = signal<string | null>('user-1');
  const authServiceMock = {
    currentUserId: authUserId,
  };

  const conflictStorageCount = signal(1);
  const conflictStorageMock = {
    getConflict: vi.fn(),
    getAllConflicts: vi.fn().mockResolvedValue([]),
    conflictCount: conflictStorageCount.asReadonly(),
    hasUnresolvedConflicts: computed(() => conflictStorageCount() > 0),
  };

  const projectOpsMock = {
    resolveConflict: vi.fn().mockResolvedValue(true),
  };

  const syncCoordinatorMock = {
    resyncActiveProject: vi.fn(),
    captureConflict: vi.fn(),
  };

  const toastMock = {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    conflictStorageCount.set(1);
    conflictStorageMock.getAllConflicts.mockResolvedValue([]);
    projectOpsMock.resolveConflict.mockResolvedValue(true);

    const injector = Injector.create({
      providers: [
        { provide: ActionQueueService, useValue: actionQueueMock },
        { provide: SimpleSyncService, useValue: syncServiceMock },
        { provide: AuthService, useValue: authServiceMock },
        { provide: ConflictStorageService, useValue: conflictStorageMock },
        { provide: ProjectOperationService, useValue: projectOpsMock },
        { provide: ToastService, useValue: toastMock },
        { provide: SyncCoordinatorService, useValue: syncCoordinatorMock },
      ],
    });

    component = runInInjectionContext(injector, () => new DashboardModalComponent());
  });

  it('resolveUseRemote 不应把存储中的 stale remote 重新注入 active conflict', async () => {
    conflictStorageMock.getConflict.mockResolvedValueOnce(createConflictRecord(false));
    const loadConflictsSpy = vi.spyOn(component, 'loadConflicts').mockResolvedValue(undefined);

    await component.resolveUseRemote('proj-1');

    expect(projectOpsMock.resolveConflict).toHaveBeenCalledWith('proj-1', 'remote');
    expect(syncCoordinatorMock.captureConflict).not.toHaveBeenCalled();
    expect(loadConflictsSpy).toHaveBeenCalled();
  });

  it('resolveKeepBoth 失败时不应提示成功', async () => {
    conflictStorageMock.getConflict.mockResolvedValueOnce(createConflictRecord(true));
    projectOpsMock.resolveConflict.mockResolvedValueOnce(false);
    const loadConflictsSpy = vi.spyOn(component, 'loadConflicts').mockResolvedValue(undefined);

    await component.resolveKeepBoth('proj-1');

    expect(projectOpsMock.resolveConflict).toHaveBeenCalledWith('proj-1', 'merge');
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(loadConflictsSpy).toHaveBeenCalled();
  });
});