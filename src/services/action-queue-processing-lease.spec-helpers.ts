import { beforeEach, expect, it, vi, type Mock } from 'vitest';

import type { Project } from '../models';
import type { ActionQueueService } from './action-queue.service';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.service';
import type { ActionQueueProcessingRetrySpecContext } from './action-queue-processing-retry.spec-helpers';
import type { ProjectPayload, QueuedAction } from './action-queue.types';
import {
  createProjectConflictRecordFingerprint,
  type ConflictRecord,
} from './conflict-storage.helpers';
import { mockQueueBackupService } from './action-queue-service-test-harness.spec-helpers';
import { createProject } from './project-operation.test-harness';
import {
  createProjectConflictHandoffPayloadDigest,
  createProjectConflictHandoffReservationId,
} from './project-operation-conflict-retry-settlement.controller';

type LeaseResolver = (handle: { mode: 'idb-lease'; signal: AbortSignal; release: Mock }) => void;

interface ActionQueueProcessingLeaseSpecRegistration {
  context: ActionQueueProcessingRetrySpecContext;
  service: () => ActionQueueService;
}

export function createProjectProcessorAction(
  type: 'create' | 'update',
  project: Project,
  overrides: Partial<QueuedAction<ProjectPayload>> = {},
): QueuedAction<ProjectPayload> {
  const action: QueuedAction<ProjectPayload> = {
    id: `action-${type}-${project.id}`,
    operationId: `op-${type}-${project.id}`,
    type,
    entityType: 'project',
    entityId: project.id,
    payload: { project, sourceUserId: 'user-1' },
    timestamp: 1,
    retryCount: 0,
    ...overrides,
  };
  if (action.syncState === 'held' && action.localHandoff) {
    action.localHandoff.payloadDigest = createProjectConflictHandoffPayloadDigest(action.payload);
  }
  return action;
}

export function createProjectProcessorConflictRecord(
  project: Project,
  remoteSnapshotFresh = false,
): ConflictRecord {
  return {
    projectId: project.id,
    ownerUserId: 'user-1',
    localProject: project,
    remoteProject: remoteSnapshotFresh ? createProject({ id: project.id, version: 3 }) : undefined,
    remoteSnapshotFresh,
    conflictedAt: '2026-07-29T00:00:00.000Z',
    localVersion: project.version ?? 0,
    remoteVersion: remoteSnapshotFresh ? 3 : undefined,
    reason: 'version_mismatch',
    acknowledged: false,
  };
}

export function createProjectProcessorHandoffAction(
  project: Project,
): QueuedAction<ProjectPayload> {
  const record = createProjectProcessorConflictRecord(project, true);
  const action = createProjectProcessorAction('update', project, {
    id: `action-handoff-${project.id}`,
    operationId: `operation-handoff-${project.id}`,
    syncState: 'pending_sync',
    payload: { project, sourceUserId: 'user-1', conflictHandoff: { conflictRecord: record } },
    localHandoff: {
      kind: 'resolved-project-conflict',
      state: 'required',
      ownerUserId: 'user-1',
      projectId: project.id,
      actionId: `action-handoff-${project.id}`,
      operationId: `operation-handoff-${project.id}`,
      payloadDigest: `payload-${project.id}`,
      conflictFingerprint: createProjectConflictRecordFingerprint(record),
    },
  });
  const handoff = action.localHandoff;
  if (!handoff) return action;
  handoff.reservationId = createProjectConflictHandoffReservationId(
    action.operationId,
    handoff.payloadDigest,
    handoff.conflictFingerprint,
  );
  return action;
}

export async function flushProjectProcessorRecoveryMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

export function registerActionQueueProcessingLeaseSpecs({
  context,
  service: getService,
}: ActionQueueProcessingLeaseSpecRegistration): void {
  let service: ActionQueueService;
  const {
    setNetworkStatus,
    createTestProjectAction,
    setCurrentUserId,
    mockSyncWriterLeaseService,
    mockLoggerDebug,
    mockLoggerWarn,
    mockLeaseRelease,
    mockSentryAddBreadcrumb,
  } = context;

  beforeEach(() => {
    service = getService();
  });

  it('processQueue 在 sync writer lease 开启时应持有 lease 后再处理并最终释放', async () => {
    const processor = vi.fn().mockResolvedValue(true);
    service.registerProcessor('project:update', processor);
    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());

    setNetworkStatus(true);
    const result = await service.processQueue();

    expect(result.processed).toBe(1);
    expect(mockSyncWriterLeaseService.requestLease).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'test-user',
      projectId: '__global__',
    }));
    expect(processor).toHaveBeenCalledTimes(1);
    expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
  });

  it('processQueue 应把获批的非内存 lease signal 原样传给 processor', async () => {
    const leaseController = new AbortController();
    const processor = vi.fn().mockResolvedValue(true);
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
    mockSyncWriterLeaseService.requestLease.mockResolvedValueOnce({
      tabId: 'tab-action',
      lockName: 'nanoflow-sync:test:test-user:__global__',
      mode: 'idb-lease',
      signal: leaseController.signal,
      release: mockLeaseRelease,
    });
    service.registerProcessor('project:update', processor);
    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());

    setNetworkStatus(true);
    await service.processQueue();

    expect(processor).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'project', type: 'update' }),
      {
        leaseSignal: leaseController.signal,
        isCurrent: expect.any(Function),
      },
    );
  });

  it('activated handoff 缺少非内存 lease 时应原样保留且不调用 processor', async () => {
    const processor = vi.fn().mockResolvedValue(service.deferRetry({ message: 'missing lease' }));
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(false);
    service.registerProcessor('project:update', processor);
    setNetworkStatus(false);
    const actionId = service.enqueue(createTestProjectAction());
    service.pendingActions.update(queue => queue.map(action => action.id === actionId ? {
      ...action,
      localHandoff: {
        kind: 'resolved-project-conflict', state: 'required', ownerUserId: 'test-user',
        projectId: action.entityId, actionId, operationId: action.operationId,
        payloadDigest: 'payload-a', conflictFingerprint: 'fingerprint-a',
      },
    } : action));
    const before = service.pendingActions();

    setNetworkStatus(true);
    await service.processQueue();

    expect(processor).not.toHaveBeenCalled();
    expect(service.pendingActions()).toEqual(before);
  });

  it('processor 已严格移除 A 时不应再执行通用 durable dequeue', async () => {
    const leaseController = new AbortController();
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
    mockSyncWriterLeaseService.requestLease.mockResolvedValueOnce({
      mode: 'idb-lease', signal: leaseController.signal, release: mockLeaseRelease,
    });
    setNetworkStatus(false);
    const actionId = await service.enqueueDurably(createTestProjectAction());
    service.pendingActions.update(queue => queue.map(action => action.id === actionId ? {
      ...action,
      localHandoff: {
        kind: 'resolved-project-conflict', state: 'complete', ownerUserId: 'test-user',
        projectId: action.entityId, actionId, operationId: action.operationId,
        payloadDigest: 'payload-a', conflictFingerprint: 'fingerprint-a',
      },
    } : action));
    mockQueueBackupService.updateQueue.mockClear();
    const processor = vi.fn(async () => {
      await mockQueueBackupService.updateQueue('test-user', queue =>
        queue.filter(action => action.id !== actionId));
      service.pendingActions.update(queue => queue.filter(action => action.id !== actionId));
      return true;
    });
    service.registerProcessor('project:update', processor);

    setNetworkStatus(true);
    await service.processQueue();

    expect(processor).toHaveBeenCalledOnce();
    expect(mockQueueBackupService.updateQueue).toHaveBeenCalledOnce();
  });

  it('processQueue 在 processor 期间丢失 lease 后应停止后续写入并保留本地队列', async () => {
    const leaseController = new AbortController();
    const processor = vi.fn().mockImplementationOnce(async () => {
      leaseController.abort();
      return true;
    });
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
    mockSyncWriterLeaseService.requestLease.mockResolvedValueOnce({
      tabId: 'tab-action',
      lockName: 'nanoflow-sync:test:test-user:__global__',
      mode: 'idb-lease',
      signal: leaseController.signal,
      release: mockLeaseRelease,
    });
    service.registerProcessor('project:update', processor);
    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());
    service.enqueue(createTestProjectAction());

    setNetworkStatus(true);
    const result = await service.processQueue();

    expect(processor).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(1);
    expect(service.queueSize()).toBe(2);
    expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
  });

  it('切换 owner 且丢失 lease 时应保留旧 owner 的成功结果等待重放', async () => {
    const leaseController = new AbortController();
    let resolveProcessing!: (saved: boolean) => void;
    const processor = vi.fn(() => new Promise<boolean>(resolve => {
      resolveProcessing = resolve;
    }));
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
    mockSyncWriterLeaseService.requestLease.mockResolvedValueOnce({
      tabId: 'tab-action',
      lockName: 'nanoflow-sync:test:test-user:__global__',
      mode: 'idb-lease',
      signal: leaseController.signal,
      release: mockLeaseRelease,
    });
    service.registerProcessor('project:update', processor);
    setNetworkStatus(false);
    const actionId = service.enqueue(createTestProjectAction());
    expect(localStorage.getItem('nanoflow.action-queue.test-user')).toContain(actionId);

    setNetworkStatus(true);
    const processing = service.processQueue();
    await vi.waitFor(() => {
      expect(processor).toHaveBeenCalledTimes(1);
    });

    setCurrentUserId('other-user');
    service.clearCurrentView();
    leaseController.abort();
    resolveProcessing(true);
    await processing;

    expect(localStorage.getItem('nanoflow.action-queue.test-user')).toContain(actionId);
    expect(localStorage.getItem('nanoflow.action-queue.other-user')).toBeNull();
    expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
  });

  it('切换 owner 且丢失 lease 时应优先收口旧 owner 的异常结果', async () => {
    const leaseController = new AbortController();
    let rejectProcessing!: (reason?: unknown) => void;
    const processor = vi.fn(() => new Promise<boolean>((_resolve, reject) => {
      rejectProcessing = reject;
    }));
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
    mockSyncWriterLeaseService.requestLease.mockResolvedValueOnce({
      tabId: 'tab-action',
      lockName: 'nanoflow-sync:test:test-user:__global__',
      mode: 'idb-lease',
      signal: leaseController.signal,
      release: mockLeaseRelease,
    });
    service.registerProcessor('project:update', processor);
    setNetworkStatus(false);
    const actionId = service.enqueue(createTestProjectAction());
    service.pendingActions.update(queue => queue.map(action =>
      action.id === actionId
        ? { ...action, retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES }
        : action
    ));
    service.storage.saveQueueToStorage();

    setNetworkStatus(true);
    const processing = service.processQueue();
    await vi.waitFor(() => {
      expect(processor).toHaveBeenCalledTimes(1);
    });

    setCurrentUserId('other-user');
    service.clearCurrentView();
    leaseController.abort();
    rejectProcessing(new Error('network timeout'));
    await processing;

    expect(localStorage.getItem('nanoflow.action-queue.test-user')).not.toContain(actionId);
    expect(localStorage.getItem('nanoflow.dead-letter-queue.test-user')).toContain(actionId);
    expect(localStorage.getItem('nanoflow.dead-letter-queue.other-user')).toBeNull();
    expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
  });

  it('processQueue 在 sync writer lease 只能退化为 memory-only 时应延后处理', async () => {
    const processor = vi.fn().mockResolvedValue(true);
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
    mockSyncWriterLeaseService.requestLease.mockResolvedValue({
      tabId: 'tab-action',
      lockName: 'nanoflow-sync:test:test-user:__global__',
      mode: 'memory-only',
      release: mockLeaseRelease,
    });
    service.registerProcessor('project:update', processor);
    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());

    setNetworkStatus(true);
    const result = await service.processQueue();

    expect(result).toEqual({ processed: 0, failed: 0, movedToDeadLetter: 0 });
    expect(processor).not.toHaveBeenCalled();
    expect(service.queueSize()).toBe(1);
    expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
  });

  it('processQueue 在 memory-only lease 告警日志失败时仍应释放 lease', async () => {
    const processor = vi.fn().mockResolvedValue(true);
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
    mockSyncWriterLeaseService.requestLease.mockResolvedValue({
      tabId: 'tab-action',
      lockName: 'nanoflow-sync:test:test-user:__global__',
      mode: 'memory-only',
      release: mockLeaseRelease,
    });
    mockLoggerWarn.mockImplementationOnce(() => {
      throw new Error('logger failed');
    });
    service.registerProcessor('project:update', processor);
    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());

    setNetworkStatus(true);
    await expect(service.processQueue()).resolves.toEqual({
      processed: 0,
      failed: 0,
      movedToDeadLetter: 0,
    });

    expect(processor).not.toHaveBeenCalled();
    expect(service.queueSize()).toBe(1);
    expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
  });

  it('processQueue 在 sync writer lease 获取失败后应调度后续重试', async () => {
    vi.useFakeTimers();
    try {
      const processor = vi.fn().mockResolvedValue(true);
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      mockSyncWriterLeaseService.requestLease
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          tabId: 'tab-action',
          lockName: 'nanoflow-sync:test:test-user:__global__',
          mode: 'idb', signal: new AbortController().signal,
          release: mockLeaseRelease,
        });
      service.registerProcessor('project:update', processor);
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setNetworkStatus(true);
      await expect(service.processQueue()).resolves.toEqual({
        processed: 0,
        failed: 0,
        movedToDeadLetter: 0,
      });
      expect(processor).not.toHaveBeenCalled();
      expect(service.queueSize()).toBe(1);

      await vi.advanceTimersByTimeAsync(0);

      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
        expect(service.queueSize()).toBe(0);
      });
      expect(mockSyncWriterLeaseService.requestLease).toHaveBeenCalledTimes(2);
      expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
    } finally {
      mockSyncWriterLeaseService.requestLease.mockReset();
      mockSyncWriterLeaseService.requestLease.mockImplementation(async () => ({
        tabId: 'tab-action',
        lockName: 'nanoflow-sync:test:test-user:__global__',
        mode: 'idb-lease', signal: new AbortController().signal,
        release: mockLeaseRelease,
      }));
      vi.useRealTimers();
    }
  });

  it('processQueue 在 sync writer lease 获取异常且告警日志失败时仍应安排后续重试', async () => {
    vi.useFakeTimers();
    try {
      const processor = vi.fn().mockResolvedValue(true);
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      mockSyncWriterLeaseService.requestLease
        .mockRejectedValueOnce(new Error('lease backend failed'))
        .mockResolvedValueOnce({
          tabId: 'tab-action',
          lockName: 'nanoflow-sync:test:test-user:__global__',
          mode: 'idb', signal: new AbortController().signal,
          release: mockLeaseRelease,
        });
      mockLoggerWarn.mockImplementationOnce(() => {
        throw new Error('logger failed');
      });
      service.registerProcessor('project:update', processor);
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setNetworkStatus(true);
      await expect(service.processQueue()).resolves.toEqual({
        processed: 0,
        failed: 0,
        movedToDeadLetter: 0,
      });
      expect(processor).not.toHaveBeenCalled();
      expect(service.queueSize()).toBe(1);

      await vi.advanceTimersByTimeAsync(0);

      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
        expect(service.queueSize()).toBe(0);
      });
      expect(mockSyncWriterLeaseService.requestLease).toHaveBeenCalledTimes(2);
      expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
    } finally {
      mockSyncWriterLeaseService.requestLease.mockReset();
      mockSyncWriterLeaseService.requestLease.mockImplementation(async () => ({
        tabId: 'tab-action',
        lockName: 'nanoflow-sync:test:test-user:__global__',
        mode: 'idb-lease', signal: new AbortController().signal,
        release: mockLeaseRelease,
      }));
      vi.useRealTimers();
    }
  });

  it('processQueue 在 retry 调度日志失败时仍应安排后续重试', async () => {
    vi.useFakeTimers();
    try {
      const processor = vi.fn().mockResolvedValue(true);
      mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
      mockSyncWriterLeaseService.requestLease
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          tabId: 'tab-action',
          lockName: 'nanoflow-sync:test:test-user:__global__',
          mode: 'idb', signal: new AbortController().signal,
          release: mockLeaseRelease,
        });
      mockLoggerDebug.mockImplementation((message: string) => {
        if (message === 'sync writer lease 未获取，已安排 ActionQueue 后续重试') {
          throw new Error('logger failed');
        }
      });
      service.registerProcessor('project:update', processor);
      setNetworkStatus(false);
      service.enqueue(createTestProjectAction());

      setNetworkStatus(true);
      await expect(service.processQueue()).resolves.toEqual({
        processed: 0,
        failed: 0,
        movedToDeadLetter: 0,
      });
      expect(processor).not.toHaveBeenCalled();
      expect(service.queueSize()).toBe(1);

      await vi.advanceTimersByTimeAsync(0);

      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
        expect(service.queueSize()).toBe(0);
      });
      expect(mockSyncWriterLeaseService.requestLease).toHaveBeenCalledTimes(2);
      expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
    } finally {
      mockSyncWriterLeaseService.requestLease.mockReset();
      mockSyncWriterLeaseService.requestLease.mockImplementation(async () => ({
        tabId: 'tab-action',
        lockName: 'nanoflow-sync:test:test-user:__global__',
        mode: 'idb-lease', signal: new AbortController().signal,
        release: mockLeaseRelease,
      }));
      vi.useRealTimers();
    }
  });

  it('processQueue 在 retry 调度失败时应保留队列并隔离异常', async () => {
    const processor = vi.fn().mockResolvedValue(true);
    const scheduleError = new Error('retry scheduler failed');
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
    mockSyncWriterLeaseService.requestLease.mockResolvedValueOnce(null);
    const scheduleRetrySpy = vi.spyOn(service.storage, 'scheduleRetry')
      .mockImplementationOnce(() => {
        throw scheduleError;
      });
    service.registerProcessor('project:update', processor);
    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());

    try {
      setNetworkStatus(true);
      await expect(service.processQueue()).resolves.toEqual({
        processed: 0,
        failed: 0,
        movedToDeadLetter: 0,
      });

      expect(scheduleRetrySpy).toHaveBeenCalledWith(0);
      expect(processor).not.toHaveBeenCalled();
      expect(service.queueSize()).toBe(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'sync writer lease 重试调度失败，已保留队列等待后续触发',
        scheduleError,
      );
    } finally {
      scheduleRetrySpy.mockRestore();
      mockSyncWriterLeaseService.requestLease.mockReset();
      mockSyncWriterLeaseService.requestLease.mockImplementation(async () => ({
        tabId: 'tab-action',
        lockName: 'nanoflow-sync:test:test-user:__global__',
        mode: 'idb-lease', signal: new AbortController().signal,
        release: mockLeaseRelease,
      }));
    }
  });

  it('processQueue 等待 sync writer lease 时应阻止并发重复申请 lease', async () => {
    let resolveLease: LeaseResolver = (_handle) => {
      throw new Error('lease resolver was not initialized');
    };
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
    mockSyncWriterLeaseService.requestLease.mockImplementation(() => new Promise<Parameters<LeaseResolver>[0]>(resolve => {
      resolveLease = resolve;
    }));
    service.registerProcessor('project:update', vi.fn().mockResolvedValue(true));
    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());
    setNetworkStatus(true);

    const first = service.processQueue();
    const second = service.processQueue();
    await Promise.resolve();

    expect(mockSyncWriterLeaseService.requestLease).toHaveBeenCalledTimes(1);

    resolveLease({ mode: 'idb-lease', signal: new AbortController().signal, release: mockLeaseRelease });
    await Promise.all([first, second]);
  });

  it('等待 sync writer lease 期间切账号后不应继续处理新 owner 队列', async () => {
    let resolveLease: LeaseResolver = (_handle) => {
      throw new Error('lease resolver was not initialized');
    };
    const processor = vi.fn().mockResolvedValue(true);
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
    mockSyncWriterLeaseService.requestLease.mockImplementation(() => new Promise<Parameters<LeaseResolver>[0]>(resolve => {
      resolveLease = resolve;
    }));
    service.registerProcessor('project:update', processor);
    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());
    setNetworkStatus(true);

    const processing = service.processQueue();
    await Promise.resolve();

    setCurrentUserId('other-user');
    service.clearCurrentView();
    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());
    setNetworkStatus(true);

    resolveLease({ mode: 'idb-lease', signal: new AbortController().signal, release: mockLeaseRelease });
    const result = await processing;

    expect(result.processed).toBe(0);
    expect(processor).not.toHaveBeenCalled();
    expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
    expect(service.queueSize()).toBe(1);
  });

  it('processQueue 应隔离生命周期回调异常并仍然释放 sync writer lease', async () => {
    const callbackError = new Error('queue callback failed');
    const processor = vi.fn().mockResolvedValue(true);
    const onStart = vi.fn();
    const onEnd = vi.fn(() => {
      throw callbackError;
    });
    const onSettled = vi.fn(() => {
      throw callbackError;
    });
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
    mockSyncWriterLeaseService.requestLease.mockResolvedValue({
      mode: 'idb-lease', signal: new AbortController().signal, release: mockLeaseRelease,
    });
    service.registerProcessor('project:update', processor);
    service.setQueueProcessCallbacks(onStart, onEnd, onSettled);
    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());

    setNetworkStatus(true);
    await expect(service.processQueue()).resolves.toEqual({
      processed: 1,
      failed: 0,
      movedToDeadLetter: 0,
    });

    expect(processor).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(service.isProcessing()).toBe(false);
    expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
  });

  it('processQueue 应隔离生命周期告警日志异常并仍然复位 processing 与释放 lease', async () => {
    const callbackError = new Error('queue callback failed');
    const loggerError = new Error('logger failed');
    const processor = vi.fn().mockResolvedValue(true);
    const onStart = vi.fn();
    const onEnd = vi.fn(() => {
      throw callbackError;
    });
    mockLoggerWarn.mockImplementationOnce(() => {
      throw loggerError;
    });
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
    mockSyncWriterLeaseService.requestLease.mockResolvedValue({
      mode: 'idb-lease', signal: new AbortController().signal, release: mockLeaseRelease,
    });
    service.registerProcessor('project:update', processor);
    service.setQueueProcessCallbacks(onStart, onEnd);
    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());

    setNetworkStatus(true);
    await expect(service.processQueue()).resolves.toEqual({
      processed: 1,
      failed: 0,
      movedToDeadLetter: 0,
    });

    expect(processor).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(service.isProcessing()).toBe(false);
    expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
  });

  it('processQueue 应隔离生命周期 outcome 清理异常并仍然释放 sync writer lease', async () => {
    const cleanupError = new Error('lifecycle cleanup failed');
    const processor = vi.fn().mockResolvedValue(true);
    const lifecycle = (service as unknown as {
      lifecycle: { clearActionOutcomes(token: number): void };
    }).lifecycle;
    vi.spyOn(lifecycle, 'clearActionOutcomes').mockImplementationOnce(() => {
      throw cleanupError;
    });
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
    mockSyncWriterLeaseService.requestLease.mockResolvedValue({
      mode: 'idb-lease', signal: new AbortController().signal, release: mockLeaseRelease,
    });
    service.registerProcessor('project:update', processor);
    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());

    setNetworkStatus(true);
    await expect(service.processQueue()).resolves.toEqual({
      processed: 1,
      failed: 0,
      movedToDeadLetter: 0,
    });

    expect(processor).toHaveBeenCalledTimes(1);
    expect(service.isProcessing()).toBe(false);
    expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'ActionQueue lifecycle outcome cleanup failed',
      cleanupError,
    );
  });

  it('enqueue 和 processQueue 应隔离 breadcrumb 异常并仍然释放 sync writer lease', async () => {
    const enqueueBreadcrumbError = new Error('enqueue breadcrumb failed');
    const processBreadcrumbError = new Error('process breadcrumb failed');
    const processor = vi.fn().mockResolvedValue(true);
    mockSentryAddBreadcrumb
      .mockImplementationOnce(() => {
        throw enqueueBreadcrumbError;
      })
      .mockImplementationOnce(() => {
        throw processBreadcrumbError;
      })
      .mockImplementationOnce(() => undefined);
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
    mockSyncWriterLeaseService.requestLease.mockResolvedValue({
      mode: 'idb-lease', signal: new AbortController().signal, release: mockLeaseRelease,
    });
    service.registerProcessor('project:update', processor);
    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());

    setNetworkStatus(true);
    await expect(service.processQueue()).resolves.toEqual({
      processed: 1,
      failed: 0,
      movedToDeadLetter: 0,
    });

    expect(processor).toHaveBeenCalledTimes(1);
    expect(service.isProcessing()).toBe(false);
    expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
  });

  it('completion breadcrumb 和告警日志都失败时仍应释放 sync writer lease', async () => {
    const completionBreadcrumbError = new Error('completion breadcrumb failed');
    const loggerError = new Error('logger failed');
    const processor = vi.fn().mockResolvedValue(true);
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
    mockSyncWriterLeaseService.requestLease.mockResolvedValue({
      mode: 'idb-lease', signal: new AbortController().signal, release: mockLeaseRelease,
    });
    service.registerProcessor('project:update', processor);
    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());
    mockSentryAddBreadcrumb
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw completionBreadcrumbError;
      });
    mockLoggerWarn.mockImplementationOnce(() => {
      throw loggerError;
    });

    setNetworkStatus(true);
    await expect(service.processQueue()).resolves.toEqual({
      processed: 1,
      failed: 0,
      movedToDeadLetter: 0,
    });

    expect(processor).toHaveBeenCalledTimes(1);
    expect(service.isProcessing()).toBe(false);
    expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
  });
}
