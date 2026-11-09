import { Injector, computed, runInInjectionContext, signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardModalComponent } from './dashboard-modal.component';
import { ActionQueueService } from '../../../services/action-queue.service';
import { SyncStateService } from '../../core/services/sync/sync-state.service';
import { RetryQueueService } from '../../core/services/sync/retry-queue.service';
import { AuthService } from '../../../services/auth.service';
import { ConflictStorageService } from '../../../services/conflict-storage.service';
import { ProjectOperationService } from '../../../services/project-operation.service';
import { ToastService } from '../../../services/toast.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { ConflictAutoResolverService } from '../../../services/conflict-auto-resolver.service';
import { LoggerService } from '../../../services/logger.service';
import { ProjectStore } from '../../core/state/stores';
import { captureConflictFingerprint } from '../../../services/project-operation-conflict-fingerprint';

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

function createTask(id: string, title: string, updatedAt: string) {
  return {
    id,
    title,
    content: title,
    stage: null,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'todo' as const,
    x: 0,
    y: 0,
    createdDate: '2026-03-30T00:00:00.000Z',
    updatedAt,
    displayId: id,
  };
}

function createConnection(id: string, source: string, target: string, title: string, updatedAt: string) {
  return {
    id,
    source,
    target,
    title,
    description: title,
    updatedAt,
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
    syncError: null as string | null,
    backgroundSyncNotice: null as string | null,
    cloudSyncPausedReason: null as 'no-session' | 'refresh-failed' | null,
    offlineMode: false,
  });

  const syncServiceMock = {
    syncState,
  };

  const retryQueueMock = {
    processQueue: vi.fn().mockResolvedValue(undefined),
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
    resolveConflictWithPlan: vi.fn().mockResolvedValue(true),
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

  const loggerMock = {
    category: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    conflictStorageCount.set(1);
    conflictStorageMock.getAllConflicts.mockResolvedValue([]);
    projectOpsMock.resolveConflict.mockResolvedValue(true);
    projectOpsMock.resolveConflictWithPlan.mockResolvedValue(true);

    const injector = Injector.create({
      providers: [
        { provide: ActionQueueService, useValue: actionQueueMock },
        { provide: SyncStateService, useValue: syncServiceMock },
        { provide: RetryQueueService, useValue: retryQueueMock },
        { provide: AuthService, useValue: authServiceMock },
        { provide: ConflictStorageService, useValue: conflictStorageMock },
        { provide: ProjectOperationService, useValue: projectOpsMock },
        { provide: ToastService, useValue: toastMock },
        { provide: SyncCoordinatorService, useValue: syncCoordinatorMock },
        { provide: LoggerService, useValue: loggerMock },
        { provide: ConflictAutoResolverService, useClass: ConflictAutoResolverService, deps: [LoggerService] },
        { provide: ProjectStore, useValue: { getProject: vi.fn(() => undefined) } },
      ],
    });

    component = runInInjectionContext(injector, () => new DashboardModalComponent());
  });

  it('loadConflicts 应把 task 操作级冲突证据映射到任务差异数据源', async () => {
    const localTask = createTask('task-1', '本地标题', '2026-03-30T00:05:00.000Z');
    const remoteTask = createTask('task-1', '云端标题', '2026-03-30T00:10:00.000Z');
    const record = {
      ...createConflictRecord(false),
      operationConflicts: [
        {
          actionType: 'task:update' as const,
          entityType: 'task' as const,
          entityId: 'task-1',
          projectId: 'proj-1',
          operationId: 'op-task-1',
          localEntity: localTask,
          remoteEntity: remoteTask,
          message: '云端任务更新较新',
          conflictedAt: '2026-03-30T00:11:00.000Z',
          reason: 'remote-newer' as const,
        },
      ],
    };
    conflictStorageMock.getAllConflicts.mockResolvedValueOnce([record]);

    await component.loadConflicts();

    const [conflict] = component.conflictItems();
    expect(conflict.localTasks).toEqual([localTask]);
    expect(conflict.remoteTasks).toEqual([remoteTask]);
    expect(conflict.localTaskCount).toBe(1);
    expect(conflict.remoteTaskCount).toBe(1);
  });

  it('loadConflicts 应把 connection 操作级冲突证据映射为可见摘要', async () => {
    const localConnection = createConnection('conn-1', 'task-a', 'task-b', '本地关联', '2026-03-30T00:05:00.000Z');
    const remoteConnection = createConnection('conn-1', 'task-a', 'task-c', '云端关联', '2026-03-30T00:10:00.000Z');
    const record = {
      ...createConflictRecord(false),
      operationConflicts: [
        {
          actionType: 'connection:update' as const,
          entityType: 'connection' as const,
          entityId: 'conn-1',
          projectId: 'proj-1',
          operationId: 'op-conn-1',
          localEntity: localConnection,
          remoteEntity: remoteConnection,
          message: '云端关联更新较新',
          conflictedAt: '2026-03-30T00:11:00.000Z',
          reason: 'remote-newer' as const,
        },
      ],
    };
    conflictStorageMock.getAllConflicts.mockResolvedValueOnce([record]);

    await component.loadConflicts();

    const [conflict] = component.conflictItems() as unknown as Array<{
      operationConflictSummaries: Array<{
        id: string;
        actionLabel: string;
        reasonLabel: string;
        localSummary: string;
        remoteSummary: string;
        message: string;
      }>;
    }>;
    expect(conflict.operationConflictSummaries).toEqual([
      {
        id: 'op-conn-1',
        actionLabel: '更新关联',
        reasonLabel: '云端版本较新',
        localSummary: 'task-a -> task-b · 本地关联',
        remoteSummary: 'task-a -> task-c · 云端关联',
        message: '云端关联更新较新',
      },
    ]);
  });

  it('resolveUseRemote 不应把存储中的 stale remote 重新注入 active conflict', async () => {
    conflictStorageMock.getConflict.mockResolvedValueOnce(createConflictRecord(false));
    const loadConflictsSpy = vi.spyOn(component, 'loadConflicts').mockResolvedValue(undefined);

    await component.resolveUseRemote('proj-1');

    expect(projectOpsMock.resolveConflict).toHaveBeenCalledWith('proj-1', 'remote', { backgroundPersist: true });
    expect(syncCoordinatorMock.captureConflict).not.toHaveBeenCalled();
    expect(loadConflictsSpy).toHaveBeenCalled();
    expect(toastMock.success).toHaveBeenCalledWith('已采用云端版本', '当前项目已切换到云端结果');
  });

  it('resolveUseLocal 失败时不应误报成功', async () => {
    conflictStorageMock.getConflict.mockResolvedValueOnce(createConflictRecord(true));
    projectOpsMock.resolveConflict.mockResolvedValueOnce(false);
    const loadConflictsSpy = vi.spyOn(component, 'loadConflicts').mockResolvedValue(undefined);

    await component.resolveUseLocal('proj-1');

    expect(projectOpsMock.resolveConflict).toHaveBeenCalledWith('proj-1', 'local', { backgroundPersist: true });
    expect(loadConflictsSpy).toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('resolveKeepBoth 失败时不应提示成功', async () => {
    conflictStorageMock.getConflict.mockResolvedValueOnce(createConflictRecord(true));
    projectOpsMock.resolveConflict.mockResolvedValueOnce(false);
    const loadConflictsSpy = vi.spyOn(component, 'loadConflicts').mockResolvedValue(undefined);

    await component.resolveKeepBoth('proj-1');

    expect(projectOpsMock.resolveConflict).toHaveBeenCalledWith('proj-1', 'merge', { backgroundPersist: true });
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(loadConflictsSpy).toHaveBeenCalled();
  });

  it('applyAutoResolution 应按逐任务计划调用 resolveConflictWithPlan，并优先采用用户选择', async () => {
    const loadConflictsSpy = vi.spyOn(component, 'loadConflicts').mockResolvedValue(undefined);
    const conflict = {
      projectId: 'proj-1',
      projectName: 'Local Project',
      reason: 'version_mismatch',
      reasonLabel: '版本不匹配',
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localTaskCount: 2,
      remoteTaskCount: 2,
      localTasks: [],
      remoteTasks: [],
      remoteSnapshotFresh: true,
      isResolving: false,
      autoReport: {
        projectId: 'proj-1',
        recommendations: [
          {
            taskId: 'task-1',
            title: 'Task 1',
            recommendation: 'remote',
            confidence: 'suggest',
            reason: '云端版本较新',
            reasoning: ['云端更新时间更晚'],
            conflictedFields: ['content'],
          },
          {
            taskId: 'task-2',
            title: 'Task 2',
            recommendation: 'remote',
            confidence: 'auto',
            reason: '任务仅存在于云端',
            reasoning: ['其他设备新建'],
            conflictedFields: [],
          },
        ],
        autoCount: 1,
        suggestCount: 1,
        manualCount: 0,
        generatedAt: '2026-03-30T00:00:00.000Z',
        overallSuggestion: '可直接应用系统建议',
      },
      taskResolutions: new Map([['task-1', 'local']]),
      selectiveMode: true,
    } as unknown as Parameters<DashboardModalComponent['applyAutoResolution']>[0];

    await component.applyAutoResolution(conflict);

    expect(projectOpsMock.resolveConflictWithPlan).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({
        taskChoices: expect.objectContaining({
          'task-1': 'local',
          'task-2': 'remote',
        }),
        appliedBy: 'mixed',
      }),
      { backgroundPersist: true },
    );
    expect(projectOpsMock.resolveConflict).not.toHaveBeenCalled();
    expect(loadConflictsSpy).toHaveBeenCalled();
    expect(toastMock.success).toHaveBeenCalledWith(
      '智能解决完成',
      expect.stringContaining('其中 1 项来自您的明确选择'),
    );
  });

  it('远端快照过期时不应允许直接应用系统建议', async () => {
    const loadConflictsSpy = vi.spyOn(component, 'loadConflicts').mockResolvedValue(undefined);
    const staleConflict = {
      projectId: 'proj-1',
      projectName: 'Local Project',
      reason: 'version_mismatch',
      reasonLabel: '版本不匹配',
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localTaskCount: 1,
      remoteTaskCount: 1,
      localTasks: [],
      remoteTasks: [],
      remoteSnapshotFresh: false,
      isResolving: false,
      autoReport: {
        projectId: 'proj-1',
        recommendations: [
          {
            taskId: 'task-1',
            title: 'Task 1',
            recommendation: 'remote',
            confidence: 'suggest',
            reason: '云端版本较新',
            reasoning: ['云端更新时间更晚'],
            conflictedFields: ['content'],
          },
        ],
        autoCount: 0,
        suggestCount: 1,
        manualCount: 0,
        generatedAt: '2026-03-30T00:00:00.000Z',
        overallSuggestion: '建议先确认后再处理',
      },
      taskResolutions: new Map(),
      selectiveMode: false,
    } as unknown as Parameters<DashboardModalComponent['applyAutoResolution']>[0];

    expect(component.canApplySuggestedResolution(staleConflict)).toBe(false);
    expect(component.getSuggestedResolutionSummary(staleConflict)).toContain('不是本轮冲突中的最新结果');

    await component.applyAutoResolution(staleConflict);

    expect(projectOpsMock.resolveConflictWithPlan).not.toHaveBeenCalled();
    expect(loadConflictsSpy).not.toHaveBeenCalled();
    expect(toastMock.warning).toHaveBeenCalledWith(
      '建议暂不可直接应用',
      '当前云端快照不是本轮最新结果，请先重新同步或逐项确认后再处理',
    );
  });

  it('applyAutoResolution 执行前应阻止旧 UI 建议覆盖已更新的冲突证据', async () => {
    const originalRecord = createConflictRecord(true);
    const localTask = createTask('task-1', '本地标题', '2026-03-30T00:05:00.000Z');
    const remoteTask = createTask('task-1', '云端标题', '2026-03-30T00:10:00.000Z');
    const latestRecord = {
      ...originalRecord,
      operationConflicts: [{
        actionType: 'task:update' as const,
        entityType: 'task' as const,
        entityId: 'task-1',
        projectId: 'proj-1',
        operationId: 'op-task-new',
        localEntity: localTask,
        remoteEntity: remoteTask,
        message: '后台同步追加了新的任务冲突证据',
        conflictedAt: '2026-03-30T00:11:00.000Z',
        reason: 'remote-newer' as const,
      }],
    };
    const staleConflict = {
      projectId: 'proj-1',
      projectName: 'Local Project',
      reason: 'version_mismatch',
      reasonLabel: '版本不匹配',
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localTaskCount: 1,
      remoteTaskCount: 1,
      localTasks: [localTask],
      remoteTasks: [remoteTask],
      operationConflictSummaries: [],
      remoteSnapshotFresh: true,
      isResolving: false,
      autoReport: {
        projectId: 'proj-1',
        recommendations: [{
          taskId: 'task-1',
          title: 'Task 1',
          recommendation: 'remote',
          confidence: 'auto',
          reason: '云端版本较新',
          reasoning: ['云端更新时间更晚'],
          conflictedFields: ['content'],
        }],
        autoCount: 1,
        suggestCount: 0,
        manualCount: 0,
        generatedAt: '2026-03-30T00:00:00.000Z',
        overallSuggestion: '可直接应用系统建议',
      },
      taskResolutions: new Map(),
      selectiveMode: false,
      sourceFingerprint: captureConflictFingerprint(originalRecord, null, 'user-1'),
    } as unknown as Parameters<DashboardModalComponent['applyAutoResolution']>[0];
    conflictStorageMock.getConflict.mockResolvedValueOnce(latestRecord);
    const loadConflictsSpy = vi.spyOn(component, 'loadConflicts').mockResolvedValue(undefined);

    await component.applyAutoResolution(staleConflict);

    expect(conflictStorageMock.getConflict).toHaveBeenCalledWith('proj-1');
    expect(projectOpsMock.resolveConflictWithPlan).not.toHaveBeenCalled();
    expect(loadConflictsSpy).toHaveBeenCalled();
    expect(toastMock.warning).toHaveBeenCalledWith(
      '冲突已更新',
      '冲突数据已变化，已刷新列表，请基于最新状态重新应用系统建议',
    );
  });

  it('retryAll 应先重放 RetryQueue，再处理 ActionQueue', async () => {
    await component.retryAll();

    expect(actionQueueMock.processQueue).toHaveBeenCalledOnce();
    expect(retryQueueMock.processQueue).toHaveBeenCalledWith(undefined, true);
    expect(retryQueueMock.processQueue.mock.invocationCallOrder[0]).toBeLessThan(
      actionQueueMock.processQueue.mock.invocationCallOrder[0],
    );
    expect(toastMock.success).toHaveBeenCalledOnce();
  });

  describe('backgroundSyncNotice 通道（partial-handoff UI 修复）', () => {
    it('backgroundSyncNotice 信号应从 syncState 转发', () => {
      // 中文注释：partial-handoff 写到 backgroundSyncNotice 后，模板独立绑定的 signal 必须取到值。
      syncState.set({
        ...syncState(),
        backgroundSyncNotice: '部分同步失败，已进入重试队列',
      });
      expect(component.backgroundSyncNotice()).toBe('部分同步失败，已进入重试队列');
      expect(component.syncError()).toBeNull();
    });

    it('syncError 与 backgroundSyncNotice 通道互不干扰', () => {
      syncState.set({
        ...syncState(),
        syncError: '检测到版本冲突，请刷新后重试',
        backgroundSyncNotice: '部分同步失败，已进入重试队列',
      });
      // 中文注释：两个通道独立运作，模板会分别渲染红条 + 信息条。
      expect(component.syncError()).toBe('检测到版本冲突，请刷新后重试');
      expect(component.backgroundSyncNotice()).toBe('部分同步失败，已进入重试队列');
    });

    it('清空 backgroundSyncNotice 后信号回退为 null（不影响 syncError）', () => {
      syncState.set({
        ...syncState(),
        syncError: '真错误',
        backgroundSyncNotice: 'notice',
      });
      syncState.set({ ...syncState(), backgroundSyncNotice: null });
      expect(component.backgroundSyncNotice()).toBeNull();
      expect(component.syncError()).toBe('真错误');
    });
  });

  describe('cloudSyncPausedReason 通道（本地可用但云同步暂停）', () => {
    it('网络已恢复但会话不可用时应显示本地可用而非连接中断', () => {
      syncState.set({
        ...syncState(),
        isOnline: true,
        offlineMode: true,
        cloudSyncPausedReason: 'no-session',
      });

      expect(component.detailedStatus()).toBe('本地数据可用 - 登录后继续云同步');
      expect(component.hasIssues()).toBe(true);
    });
  });
});
