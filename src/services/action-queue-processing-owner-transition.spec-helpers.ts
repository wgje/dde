import { beforeEach, expect, it, vi } from 'vitest';

import type { ActionQueueService } from './action-queue.service';
import type { QueueProcessorContext } from './action-queue-processing.types';
import type { ActionQueueProcessingRetrySpecContext } from './action-queue-processing-retry.spec-helpers';
import { taskReplayProcessorFailureCases } from './action-queue-processors-task-replay-fence.spec-helpers';
import type { EnqueueParams, QueuedAction } from './action-queue.types';
import {
  mockLeaseRelease,
  mockQueueBackupService,
  mockQueueBackupState,
} from './action-queue-service-test-harness.spec-helpers';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.service';

interface ActionQueueProcessingOwnerTransitionSpecRegistration {
  context: ActionQueueProcessingRetrySpecContext;
  service: () => ActionQueueService;
}

export function registerActionQueueProcessingOwnerTransitionSpecs({
  context,
  service: getService,
}: ActionQueueProcessingOwnerTransitionSpecRegistration): void {
  let service: ActionQueueService;
  const {
    setNetworkStatus,
    createTestProjectAction,
    createTestTaskAction,
    setCurrentUserId,
    mockSyncWriterLeaseService,
    mockLoggerWarn,
    mockToastWarning,
  } = context;

  beforeEach(() => {
    service = getService();
  });

  function delaySecondStrictMutation(markStarted: () => void, gate: Promise<void>): void {
    const updateQueueStrictly = mockQueueBackupService.updateQueueStrictly.getMockImplementation();
    if (!updateQueueStrictly) throw new Error('QueueBackup strict update mock implementation is required');
    mockQueueBackupService.updateQueueStrictly
      .mockImplementationOnce(updateQueueStrictly)
      .mockImplementationOnce(async (ownerUserId, updater) => {
        markStarted();
        await gate;
        return updateQueueStrictly(ownerUserId, updater);
      });
  }

  it.each([
    ['memory-only rejects protected settlement', false, true, 0],
    ['durable lease permits protected settlement', true, true, 1],
    ['memory-only permits ordinary settlement', false, false, 1],
  ])('%s', async (_label, durable, protectedResult, processorCalls) => {
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(durable);
    mockSyncWriterLeaseService.requestLease.mockResolvedValueOnce({
      tabId: 'tab-memory', lockName: 'nanoflow-sync:test:test-user:__global__',
      mode: durable ? 'idb-lease' : 'memory-only', signal: new AbortController().signal, release: mockLeaseRelease,
    });
    const processor = vi.fn().mockResolvedValue(true);
    service.registerProcessor('project:update', processor);
    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());
    const action = service.pendingActions()[0];
    const settledAction: QueuedAction = protectedResult ? { ...action, localHandoff: {
        kind: 'resolved-project-conflict', state: 'required', ownerUserId: 'test-user',
        projectId: action.entityId, actionId: action.id, operationId: action.operationId,
        payloadDigest: 'payload-a', conflictFingerprint: 'fingerprint-a',
      } } : action;
    if (protectedResult) vi.spyOn(service['retrySupersession'], 'settleBeforeProcessing').mockResolvedValue(settledAction);
    setNetworkStatus(true);
    const result = await service.processQueue();
    expect(mockSyncWriterLeaseService.requestLease).toHaveBeenCalledOnce();
    expect(result).toEqual({ processed: processorCalls, failed: 0, movedToDeadLetter: 0 });
    expect(processor).toHaveBeenCalledTimes(processorCalls);
    expect(service.queueSize()).toBe(processorCalls === 0 ? 1 : 0);
  });

  it('无处理器的操作应该保留在队列中', async () => {
    // 先离线
    setNetworkStatus(false);

    service.enqueue(createTestProjectAction());

    // 不注册任何处理器，上线并处理
    setNetworkStatus(true);
    const result = await service.processQueue();

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
    expect(service.queueSize()).toBe(1); // 仍在队列中
  });

  it('无处理器告警日志失败时仍应保留队列项并计入失败', async () => {
    mockLoggerWarn.mockImplementationOnce(() => {
      throw new Error('logger failed');
    });
    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());

    setNetworkStatus(true);
    await expect(service.processQueue()).resolves.toEqual({
      processed: 0,
      failed: 1,
      movedToDeadLetter: 0,
    });

    expect(service.queueSize()).toBe(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('No processor registered for action type: project:update'),
      undefined,
    );
  });

  it('无处理器待处理提示失败时仍应保留队列项并计入失败', async () => {
    mockToastWarning.mockImplementationOnce(() => {
      throw new Error('toast failed');
    });
    setNetworkStatus(false);
    const actionId = service.enqueue(createTestProjectAction());
    service.pendingActions.update(queue => queue.map(action =>
      action.id === actionId
        ? { ...action, retryCount: 3 }
        : action
    ));
    expect(service.validateProcessors([])).toEqual([]);

    setNetworkStatus(true);
    await expect(service.processQueue()).resolves.toEqual({
      processed: 0,
      failed: 1,
      movedToDeadLetter: 0,
    });

    expect(service.queueSize()).toBe(1);
    expect(mockToastWarning).toHaveBeenCalledWith(
      '操作待处理',
      expect.stringContaining('project:update'),
    );
  });

  it('恢复的旧操作在处理器未 ready 前不应因无处理器超时进入死信，并应在 ready 后重放', async () => {
    setNetworkStatus(false);

    const actionId = service.enqueue(createTestTaskAction());
    service.pendingActions.update(queue => queue.map(action =>
      action.id === actionId
        ? { ...action, timestamp: Date.now() - LOCAL_QUEUE_CONFIG.NO_PROCESSOR_TIMEOUT - 1_000 }
        : action
    ));
    service.storage.saveQueueToStorage();

    setNetworkStatus(true);
    await expect(service.processQueue()).resolves.toEqual({
      processed: 0,
      failed: 1,
      movedToDeadLetter: 0,
    });
    expect(service.queueSize()).toBe(1);
    expect(service.deadLetterSize()).toBe(0);

    const processor = vi.fn().mockResolvedValue(true);
    service.registerProcessor('task:update', processor);
    expect(service.validateProcessors(['task:update'])).toEqual([]);

    await vi.waitFor(() => {
      expect(processor).toHaveBeenCalledTimes(1);
      expect(service.queueSize()).toBe(0);
    });
    expect(service.deadLetterSize()).toBe(0);
  });

  it('切账号后旧处理循环失败结果应进入旧 owner 死信而不是污染新 owner', async () => {
    let rejectProcessing = null as ((reason?: unknown) => void) | null;
    const processor = vi.fn().mockImplementation(
      () => new Promise<boolean>((_resolve, reject) => {
        rejectProcessing = reject;
      })
    );
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
    const processingPromise = service.processQueue();
    await vi.waitFor(() => {
      expect(processor).toHaveBeenCalledTimes(1);
    });

    setCurrentUserId('other-user');
    service.clearCurrentView();

    rejectProcessing?.(new Error('network timeout'));
    await processingPromise;

    expect(service.deadLetterSize()).toBe(0);
    expect(localStorage.getItem('nanoflow.action-queue.test-user')).not.toContain(actionId);
    expect(localStorage.getItem('nanoflow.dead-letter-queue.test-user')).toContain(actionId);
    expect(localStorage.getItem('nanoflow.dead-letter-queue.other-user')).toBeNull();
  });

  it('切账号后旧 owner 失败收口遇到存储异常时不应让处理循环外抛', async () => {
    let rejectProcessing = null as ((reason?: unknown) => void) | null;
    const processor = vi.fn().mockImplementation(
      () => new Promise<boolean>((_resolve, reject) => {
        rejectProcessing = reject;
      })
    );
    const originalLocalStorage = globalThis.localStorage;
    service.registerProcessor('project:update', processor);

    try {
      setNetworkStatus(false);
      const actionId = service.enqueue(createTestProjectAction());
      service.pendingActions.update(queue => queue.map(action =>
        action.id === actionId
          ? { ...action, retryCount: LOCAL_QUEUE_CONFIG.MAX_RETRIES }
          : action
      ));
      service.storage.saveQueueToStorage();

      setNetworkStatus(true);
      const processingPromise = service.processQueue();
      await vi.waitFor(() => {
        expect(processor).toHaveBeenCalledTimes(1);
      });

      setCurrentUserId('other-user');
      service.clearCurrentView();

      const failingStorage = {
        get length() {
          return originalLocalStorage.length;
        },
        key: (index: number) => originalLocalStorage.key(index),
        getItem: (key: string) => originalLocalStorage.getItem(key),
        removeItem: (key: string) => originalLocalStorage.removeItem(key),
        clear: () => originalLocalStorage.clear(),
        setItem: (key: string, value: string) => {
          if (key === 'nanoflow.dead-letter-queue.test-user') {
            throw new DOMException('quota exceeded', 'QuotaExceededError');
          }
          originalLocalStorage.setItem(key, value);
        },
      } as Storage;
      Object.defineProperty(globalThis, 'localStorage', {
        value: failingStorage,
        configurable: true,
        writable: true,
      });

      rejectProcessing?.(new Error('network timeout'));
      await expect(processingPromise).resolves.toEqual({
        processed: 0,
        failed: 1,
        movedToDeadLetter: 0,
      });

      expect(service.storageFailure()).toBe(true);
      expect(service.queueFrozen()).toBe(true);
      expect(localStorage.getItem('nanoflow.action-queue.test-user')).toContain(actionId);
      expect(localStorage.getItem('nanoflow.dead-letter-queue.other-user')).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        value: originalLocalStorage,
        configurable: true,
        writable: true,
      });
    }
  });

  it('切账号后旧处理循环成功结果应从旧 owner 的持久化队列中移除', async () => {
    let resolveProcessing = null as ((value: boolean) => void) | null;
    const processor = vi.fn().mockImplementation(
      () => new Promise<boolean>(resolve => {
        resolveProcessing = resolve;
      })
    );
    service.registerProcessor('project:update', processor);

    setNetworkStatus(false);
    const actionId = service.enqueue(createTestProjectAction());
    expect(localStorage.getItem('nanoflow.action-queue.test-user')).toContain(actionId);

    setNetworkStatus(true);
    const processingPromise = service.processQueue();
    await vi.waitFor(() => {
      expect(processor).toHaveBeenCalledTimes(1);
    });

    setCurrentUserId('other-user');
    service.clearCurrentView();

    resolveProcessing?.(true);
    await processingPromise;

    expect(localStorage.getItem('nanoflow.action-queue.test-user')).not.toContain(actionId);
    expect(localStorage.getItem('nanoflow.action-queue.other-user')).toBeNull();
  });

  it('旧 owner 的 durable dequeue 延迟完成时不应覆盖新 owner 的可见队列', async () => {
    let releaseDurableDequeue = null as (() => void) | null;
    let markDurableDequeueStarted = null as (() => void) | null;
    const durableDequeueStarted = new Promise<void>(resolve => {
      markDurableDequeueStarted = resolve;
    });
    const durableDequeueGate = new Promise<void>(resolve => {
      releaseDurableDequeue = resolve;
    });
    delaySecondStrictMutation(() => markDurableDequeueStarted?.(), durableDequeueGate);

    const processor = vi.fn().mockResolvedValue(true);
    service.registerProcessor('project:update', processor);

    setNetworkStatus(false);
    const ownerAActionId = service.enqueue(createTestProjectAction());
    setNetworkStatus(true);

    const processingPromise = service.processQueue();
    await durableDequeueStarted;
    expect(mockQueueBackupService.updateQueueStrictly).toHaveBeenCalledWith(
      'test-user',
      expect.any(Function),
    );

    setNetworkStatus(false);
    setCurrentUserId('owner-b');
    service.clearCurrentView();
    const ownerBActionId = service.enqueue(createTestTaskAction());
    expect(service.pendingActions().map(action => action.id)).toEqual([ownerBActionId]);

    releaseDurableDequeue?.();
    await processingPromise;

    expect(localStorage.getItem('nanoflow.action-queue.test-user')).toContain(ownerAActionId);
    expect(localStorage.getItem('nanoflow.action-queue.owner-b')).toContain(ownerBActionId);
    expect(service.pendingActions().map(action => action.id)).toEqual([ownerBActionId]);
  });

  it('full wipe 应中止已进入 durable mutation 的旧 owner dequeue，避免重建剩余队列', async () => {
    let releaseDurableDequeue = null as (() => void) | null;
    let markDurableDequeueStarted = null as (() => void) | null;
    const durableDequeueStarted = new Promise<void>(resolve => {
      markDurableDequeueStarted = resolve;
    });
    const durableDequeueGate = new Promise<void>(resolve => {
      releaseDurableDequeue = resolve;
    });

    delaySecondStrictMutation(() => markDurableDequeueStarted?.(), durableDequeueGate);

    const processor = vi.fn().mockResolvedValue(true);
    service.registerProcessor('project:update', processor);

    setNetworkStatus(false);
    const firstActionId = service.enqueue(createTestProjectAction());
    const secondActionId = service.enqueue(createTestProjectAction());
    expect(mockQueueBackupState.persistedQueue.map(action => action.id)).toEqual([
      firstActionId,
      secondActionId,
    ]);

    setNetworkStatus(true);
    const processingPromise = service.processQueue();
    await durableDequeueStarted;
    expect(processor).toHaveBeenCalledTimes(1);
    expect(mockQueueBackupService.updateQueueStrictly).toHaveBeenCalledWith(
      'test-user',
      expect.any(Function),
    );

    setCurrentUserId(null);
    service.clearCurrentView();
    service.clearQueueForFullWipe();
    localStorage.removeItem('nanoflow.action-queue.test-user');
    localStorage.removeItem('nanoflow.dead-letter-queue.test-user');
    mockQueueBackupState.persistedQueue = [];
    mockQueueBackupState.recordFound = false;

    releaseDurableDequeue?.();
    await processingPromise;

    expect(localStorage.getItem('nanoflow.action-queue.test-user')).toBeNull();
    expect(mockQueueBackupState.persistedQueue).toEqual([]);
    expect(mockQueueBackupState.persistedQueue.map(action => action.id)).not.toContain(firstActionId);
    expect(mockQueueBackupState.persistedQueue.map(action => action.id)).not.toContain(secondActionId);
    expect(service.pendingActions()).toEqual([]);
    expect(processor).toHaveBeenCalledTimes(1);
  });

  it('B clearQueue 不应把延迟完成的 A dequeue 误判为 A 的 discard', async () => {
    let releaseDurableDequeue = null as (() => void) | null;
    let markDurableDequeueStarted = null as (() => void) | null;
    const durableDequeueStarted = new Promise<void>(resolve => {
      markDurableDequeueStarted = resolve;
    });
    const durableDequeueGate = new Promise<void>(resolve => {
      releaseDurableDequeue = resolve;
    });

    delaySecondStrictMutation(() => markDurableDequeueStarted?.(), durableDequeueGate);

    const processor = vi.fn().mockResolvedValue(true);
    service.registerProcessor('project:update', processor);

    setNetworkStatus(false);
    const firstActionId = service.enqueue(createTestProjectAction());
    const secondActionId = service.enqueue(createTestProjectAction());
    setNetworkStatus(true);

    const processingPromise = service.processQueue();
    await durableDequeueStarted;
    expect(processor).toHaveBeenCalledTimes(1);

    setNetworkStatus(false);
    setCurrentUserId('owner-b');
    service.clearCurrentView();
    service.clearQueue();
    expect(service.pendingActions()).toEqual([]);

    releaseDurableDequeue?.();
    await processingPromise;

    const ownerAQueueMirror = localStorage.getItem('nanoflow.action-queue.test-user') ?? '';
    expect(ownerAQueueMirror).toContain(firstActionId);
    expect(ownerAQueueMirror).toContain(secondActionId);
    expect(mockQueueBackupState.persistedQueue.map(action => action.id)).toEqual([
      firstActionId,
      secondActionId,
    ]);
    expect(service.pendingActions()).toEqual([]);
    expect(processor).toHaveBeenCalledTimes(1);
  });

  it('本地 owner clearQueue 不应把延迟完成的云 owner A dequeue 误判为全局 discard', async () => {
    let releaseDurableDequeue = null as (() => void) | null;
    let markDurableDequeueStarted = null as (() => void) | null;
    const durableDequeueStarted = new Promise<void>(resolve => {
      markDurableDequeueStarted = resolve;
    });
    const durableDequeueGate = new Promise<void>(resolve => {
      releaseDurableDequeue = resolve;
    });

    delaySecondStrictMutation(() => markDurableDequeueStarted?.(), durableDequeueGate);

    const processor = vi.fn().mockResolvedValue(true);
    service.registerProcessor('project:update', processor);

    setNetworkStatus(false);
    const firstActionId = service.enqueue(createTestProjectAction());
    const secondActionId = service.enqueue(createTestProjectAction());
    setNetworkStatus(true);

    const processingPromise = service.processQueue();
    await durableDequeueStarted;
    expect(processor).toHaveBeenCalledTimes(1);

    setNetworkStatus(false);
    setCurrentUserId(null);
    service.clearCurrentView();
    service.clearQueue();
    expect(service.pendingActions()).toEqual([]);

    releaseDurableDequeue?.();
    await processingPromise;

    const ownerAQueueMirror = localStorage.getItem('nanoflow.action-queue.test-user') ?? '';
    expect(ownerAQueueMirror).toContain(firstActionId);
    expect(ownerAQueueMirror).toContain(secondActionId);
    expect(mockQueueBackupState.persistedQueue.map(action => action.id)).toEqual([
      firstActionId,
      secondActionId,
    ]);
    expect(service.pendingActions()).toEqual([]);
    expect(processor).toHaveBeenCalledTimes(1);
  });

  it('切账号后旧处理循环返回 false 时也应推进旧 owner 的失败收口', async () => {
    let resolveProcessing = null as ((value: boolean) => void) | null;
    const processor = vi.fn().mockImplementation(
      () => new Promise<boolean>(resolve => {
        resolveProcessing = resolve;
      })
    );
    service.registerProcessor('project:update', processor);

    setNetworkStatus(false);
    const actionId = service.enqueue(createTestProjectAction());
    setNetworkStatus(true);

    const processingPromise = service.processQueue();
    await vi.waitFor(() => {
      expect(processor).toHaveBeenCalledTimes(1);
    });

    setCurrentUserId('other-user');
    service.clearCurrentView();

    resolveProcessing?.(false);
    await processingPromise;

    const persistedOldQueue = localStorage.getItem('nanoflow.action-queue.test-user') ?? '';
    expect(persistedOldQueue).toContain(actionId);
    expect(persistedOldQueue).toContain('"retryCount":1');
    expect(localStorage.getItem('nanoflow.dead-letter-queue.other-user')).toBeNull();
  });

  it('full wipe 开始后旧处理循环成功结果不应把旧 owner 队列写回本地', async () => {
    let resolveProcessing = null as ((value: boolean) => void) | null;
    const processor = vi.fn().mockImplementation(
      () => new Promise<boolean>(resolve => {
        resolveProcessing = resolve;
      })
    );
    service.registerProcessor('project:update', processor);

    setNetworkStatus(false);
    const actionId = service.enqueue(createTestProjectAction());
    expect(localStorage.getItem('nanoflow.action-queue.test-user')).toContain(actionId);

    setNetworkStatus(true);
    const processingPromise = service.processQueue();
    await vi.waitFor(() => {
      expect(processor).toHaveBeenCalledTimes(1);
    });

    setCurrentUserId(null);
    service.clearCurrentView();
    service.clearQueueForFullWipe();
    localStorage.removeItem('nanoflow.action-queue.test-user');
    localStorage.removeItem('nanoflow.dead-letter-queue.test-user');

    resolveProcessing?.(true);
    await processingPromise;

    expect(localStorage.getItem('nanoflow.action-queue.test-user')).toBeNull();
    expect(localStorage.getItem('nanoflow.dead-letter-queue.test-user')).toBeNull();
  });

  it('full wipe 开始后旧处理循环失败结果不应把旧 owner 死信写回本地', async () => {
    let rejectProcessing = null as ((reason?: unknown) => void) | null;
    const processor = vi.fn().mockImplementation(
      () => new Promise<boolean>((_resolve, reject) => {
        rejectProcessing = reject;
      })
    );
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
    const processingPromise = service.processQueue();
    await vi.waitFor(() => {
      expect(processor).toHaveBeenCalledTimes(1);
    });

    setCurrentUserId(null);
    service.clearCurrentView();
    service.clearQueueForFullWipe();
    localStorage.removeItem('nanoflow.action-queue.test-user');
    localStorage.removeItem('nanoflow.dead-letter-queue.test-user');

    rejectProcessing?.(new Error('network timeout'));
    await processingPromise;

    expect(localStorage.getItem('nanoflow.action-queue.test-user')).toBeNull();
    expect(localStorage.getItem('nanoflow.dead-letter-queue.test-user')).toBeNull();
  });

  it('切账号后旧循环 finally 不应覆盖新 owner 的 processing 状态', async () => {
    let resolveFirst = null as ((value: boolean) => void) | null;
    let resolveSecond = null as ((value: boolean) => void) | null;
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const processor = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>(resolve => {
        resolveFirst = resolve;
      }))
      .mockImplementationOnce(() => new Promise<boolean>(resolve => {
        resolveSecond = resolve;
      }));
    service.registerProcessor('project:update', processor);
    service.setQueueProcessCallbacks(onStart, onEnd);

    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());
    setNetworkStatus(true);

    const firstProcessing = service.processQueue();
    await vi.waitFor(() => {
      expect(processor).toHaveBeenCalledTimes(1);
    });
    expect(onStart).toHaveBeenCalledTimes(1);

    setCurrentUserId('other-user');
    service.clearCurrentView();
    expect(service.isProcessing()).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
    service.reloadFromStorageForCurrentOwner();
    await vi.waitFor(() => {
      expect(service.getCurrentOwnerStorageLoadState()).toBe('loaded');
    });

    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());
    setNetworkStatus(true);

    const secondProcessing = service.processQueue();
    await vi.waitFor(() => {
      expect(processor).toHaveBeenCalledTimes(2);
    });
    expect(service.isProcessing()).toBe(true);
    expect(onStart).toHaveBeenCalledTimes(2);

    resolveFirst?.(true);
    await firstProcessing;
    expect(service.isProcessing()).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);

    resolveSecond?.(true);
    await secondProcessing;
    expect(service.isProcessing()).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  it('reset 应释放进行中的队列生命周期并恢复 processing 状态', async () => {
    let resolveProcessing = null as ((value: boolean) => void) | null;
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const processor = vi.fn().mockImplementation(
      () => new Promise<boolean>(resolve => {
        resolveProcessing = resolve;
      })
    );
    service.registerProcessor('project:update', processor);
    service.setQueueProcessCallbacks(onStart, onEnd);

    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());
    setNetworkStatus(true);

    const processingPromise = service.processQueue();
    await vi.waitFor(() => {
      expect(processor).toHaveBeenCalledTimes(1);
    });
    expect(service.isProcessing()).toBe(true);

    service.reset();

    expect(service.isProcessing()).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);

    resolveProcessing?.(true);
    await processingPromise;

    expect(service.isProcessing()).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('同 ID focus action 在 processor 返回前被替换时应保留 replacement 且禁止 settled 发布', async () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const onSettled = vi.fn();
    const processor = vi.fn(async (action: QueuedAction, processorContext?: QueueProcessorContext) => {
      expect(processorContext?.isCurrent?.()).toBe(true);
      service.markActionSyncedRemotely(action.id);
      service.pendingActions.update(queue => queue.map(item => item.id === action.id
        ? {
          ...item,
          operationId: 'op-focus-replacement',
          payload: {
            record: { id: 'focus-replay', userId: 'test-user', snapshot: { version: 7 } },
            sourceUserId: 'test-user',
          } as QueuedAction['payload'],
        }
        : item));
      expect(processorContext?.isCurrent?.()).toBe(false);
      return true;
    });
    service.registerProcessor('focus-session:update', processor);
    service.setQueueProcessCallbacks(onStart, onEnd, onSettled);
    setNetworkStatus(false);
    const actionId = service.enqueue({
      ...createTestProjectAction(),
      entityType: 'focus-session',
      entityId: 'focus-replay',
      payload: {
        record: { id: 'focus-replay', userId: 'test-user', snapshot: { version: 6 } },
        sourceUserId: 'test-user',
      } as QueuedAction['payload'],
    } as EnqueueParams);
    setNetworkStatus(true);

    await service.processQueue();

    expect(onStart).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onSettled).not.toHaveBeenCalled();
    expect(service.pendingActions()).toEqual([
      expect.objectContaining({ id: actionId, operationId: 'op-focus-replacement', retryCount: 0 }),
    ]);
    expect(service.deadLetterSize()).toBe(0);
    expect(mockLeaseRelease).toHaveBeenCalledOnce();
  });

  it('完整持久化 fence 漂移后应清理生命周期但禁止 settled 发布', async () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const onSettled = vi.fn();
    const processor = vi.fn(async (action: QueuedAction, processorContext?: QueueProcessorContext) => {
      expect(processorContext?.isCurrent?.()).toBe(true);
      service.markActionSyncedRemotely(action.id);
      setCurrentUserId('other-user');
      expect(processorContext?.isCurrent?.()).toBe(false);
      return true;
    });
    service.registerProcessor('project:update', processor);
    service.setQueueProcessCallbacks(onStart, onEnd, onSettled);

    setNetworkStatus(false);
    service.enqueue(createTestProjectAction());
    setNetworkStatus(true);
    await service.processQueue();
    expect(onStart).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onSettled).not.toHaveBeenCalled();
    expect(service.isProcessing()).toBe(false);
    expect(service.queueSize()).toBe(1);
    expect(mockLeaseRelease).toHaveBeenCalledOnce();
  });

  it.each(taskReplayProcessorFailureCases)('task replay $label uses exact queue-only settlement', async ({
    source, createFailure, retryCount, syncState,
  }) => {
    const action = createTestTaskAction();
    const payload = action.payload as { task: { id: string }; projectId: string };
    const failure = createFailure({
      actionType: 'task:update', taskId: payload.task.id, projectId: payload.projectId,
    });
    const processor = source === 'thrown'
      ? () => { throw failure; }
      : async () => service.deferRetry(failure);
    service.registerProcessor('task:update', processor as Parameters<ActionQueueService['registerProcessor']>[1]);
    setNetworkStatus(false);
    const actionId = service.enqueue(action);
    setNetworkStatus(true);
    await service.processQueue();
    expect(service.pendingActions()).toEqual([expect.objectContaining({
      id: actionId, retryCount, syncState,
    })]);
    expect(service.deadLetterSize()).toBe(0);
  });

  it('task replay lifecycle completes only after the writer lease release', async () => {
    let releaseLease: () => void = () => undefined;
    const releaseGate = new Promise<void>(resolve => { releaseLease = resolve; });
    const events: string[] = [];
    mockSyncWriterLeaseService.isFeatureEnabled.mockReturnValue(true);
    mockLeaseRelease.mockImplementationOnce(async () => {
      events.push('release-start');
      await releaseGate;
      events.push('release-complete');
    });
    const processor = vi.fn(async (_action: QueuedAction, processorContext?: QueueProcessorContext) => {
      expect(processorContext?.leaseSignal).toBeInstanceOf(AbortSignal);
      expect(processorContext?.isCurrent?.()).toBe(true);
      return true;
    });
    service.registerProcessor('task:update', processor);
    service.setQueueProcessCallbacks(vi.fn(), () => events.push('lifecycle-end'), vi.fn());
    setNetworkStatus(false);
    service.enqueue(createTestTaskAction());
    setNetworkStatus(true);
    const processing = service.processQueue();
    await vi.waitFor(() => expect(mockLeaseRelease).toHaveBeenCalledOnce());
    expect(events).toEqual(['release-start']);
    releaseLease();
    await processing;

    expect(events).toEqual(['release-start', 'release-complete', 'lifecycle-end']);
  });
}
