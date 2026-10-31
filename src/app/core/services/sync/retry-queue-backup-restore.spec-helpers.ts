import { expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import { localBackupUiRestoreWriterQuiescence } from '../../../../services/local-backup-ui-restore-writer-quiescence.service';
import type { RetryQueueItem, RetryQueueService } from './retry-queue.service';

export interface RetryQueueBackupRestoreSpecContext {
  service: RetryQueueService;
  createTask(label: string): Task;
}

export function registerRetryQueueBackupRestoreSpecs(
  getContext: () => RetryQueueBackupRestoreSpecContext,
): void {
  it('validated restore 应只使用捕获时钟并在 quiescence 内转发 policy', async () => {
    const { service, createTask } = getContext();
    const task = createTask('retry-validated-restore-captured-time');
    const validationNow = Date.now();
    const maxItemAge = (service as unknown as { MAX_ITEM_AGE: number }).MAX_ITEM_AGE;
    const item = makeBackupRetryQueueItem(task, {
      createdAt: validationNow - maxItemAge + 1,
    });
    const runAsyncSpy = vi.spyOn(localBackupUiRestoreWriterQuiescence, 'runAsync');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(validationNow + maxItemAge);

    try {
      const restoredCount = await restoreWithValidatedPolicy(service, [item], validationNow);

      expect(restoredCount).toBe(1);
      expect(service.getItems().map(queueItem => queueItem.data.id)).toEqual([task.id]);
      expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.test-user')).toBeNull();
      expect(runAsyncSpy).toHaveBeenCalledWith('test-user', 'retry-queue', expect.any(Function));
    } finally {
      nowSpy.mockRestore();
      runAsyncSpy.mockRestore();
    }
  });

  it.each([
    { reason: 'expired', mutate: (item: RetryQueueItem, now: number, service: RetryQueueService) => ({
      ...item,
      createdAt: now - (service as unknown as { MAX_ITEM_AGE: number }).MAX_ITEM_AGE,
    }) },
    { reason: 'max-retries', mutate: (item: RetryQueueItem, _now: number, service: RetryQueueService) => ({
      ...item,
      retryCount: (service as unknown as { MAX_RETRIES: number }).MAX_RETRIES,
    }) },
    { reason: 'invalid', mutate: (item: RetryQueueItem) => ({
      ...item,
      data: { ...item.data, id: 'not-a-uuid' },
    }) },
    { reason: 'foreign', mutate: (item: RetryQueueItem) => ({
      ...item,
      sourceUserId: 'other-user',
    }) },
  ])('validated restore 应在 mutation 前拒绝 $reason 且不产生 terminal evidence', async ({ mutate }) => {
    const { service, createTask } = getContext();
    const validationNow = Date.now();
    const acceptedItem = makeBackupRetryQueueItem(createTask('retry-validated-accepted'));
    const rejectedItem = mutate(
      makeBackupRetryQueueItem(createTask('retry-validated-rejected')),
      validationNow,
      service,
    );
    const queueStorageBefore = localStorage.getItem('nanoflow.retry-queue');
    const ownerEvidenceBefore = localStorage.getItem('nanoflow.retry-queue.legacy-review.test-user');
    const foreignEvidenceBefore = localStorage.getItem('nanoflow.retry-queue.legacy-review.other-user');

    await expect(
      restoreWithValidatedPolicy(service, [acceptedItem, rejectedItem], validationNow),
    ).rejects.toThrow(/validated restore/i);

    expect(service.getItems()).toEqual([]);
    expect(localStorage.getItem('nanoflow.retry-queue')).toBe(queueStorageBefore);
    expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.test-user')).toBe(ownerEvidenceBefore);
    expect(localStorage.getItem('nanoflow.retry-queue.legacy-review.other-user')).toBe(foreignEvidenceBefore);
  });

  it('restoreFromBackupItems 应合并当前 owner 的备份重试项且保留前台和 hidden 队列', async () => {
    const { service, createTask } = getContext();
    const currentTask = createTask('retry-restore-current');
    const restoredTask = createTask('retry-restore-backup');
    const hiddenTask = createTask('retry-restore-hidden-existing');
    const foreignBackupTask = createTask('retry-restore-foreign-backup');
    const expiredTask = createTask('retry-restore-expired');
    const maxRetryTask = createTask('retry-restore-max-retry');

    service.add('task', 'upsert', currentTask, 'project-current', 'test-user', undefined, undefined, undefined, 'op-current');
    service.add('task', 'upsert', hiddenTask, 'project-hidden', 'other-user', undefined, undefined, undefined, 'op-hidden');

    const backupItems: RetryQueueItem[] = [
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: currentTask,
        projectId: 'project-current',
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: 'test-user',
        operationId: 'op-current',
      },
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: restoredTask,
        projectId: 'project-restored',
        retryCount: 1,
        createdAt: Date.now(),
        sourceUserId: 'test-user',
        operationId: 'op-restored',
      },
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: foreignBackupTask,
        projectId: 'project-foreign',
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: 'other-user',
        operationId: 'op-foreign',
      },
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: { id: 'not-a-uuid' },
        projectId: 'project-invalid',
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: 'test-user',
        operationId: 'op-invalid',
      },
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: expiredTask,
        projectId: 'project-expired',
        retryCount: 0,
        createdAt: Date.now() - ((service as unknown as { MAX_ITEM_AGE: number }).MAX_ITEM_AGE + 1),
        sourceUserId: 'test-user',
        operationId: 'op-expired',
      },
      {
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: maxRetryTask,
        projectId: 'project-max-retry',
        retryCount: (service as unknown as { MAX_RETRIES: number }).MAX_RETRIES,
        createdAt: Date.now(),
        sourceUserId: 'test-user',
        operationId: 'op-max-retry',
      },
    ];

    const restoredCount = await (service as unknown as {
      restoreFromBackupItems(items: unknown[], ownerUserId: string): Promise<number>;
    }).restoreFromBackupItems(backupItems, 'test-user');

    expect(restoredCount).toBe(1);
    expect(service.getItems().map(item => item.data.id)).toEqual([currentTask.id, restoredTask.id]);
    expect((service as unknown as { hiddenQueueItems: RetryQueueItem[] }).hiddenQueueItems.map(item => item.data.id)).toEqual([hiddenTask.id]);
    expect(localStorage.getItem('nanoflow.retry-queue')).toContain(restoredTask.id);
    expect(localStorage.getItem('nanoflow.retry-queue')).not.toContain(foreignBackupTask.id);
    expect(localStorage.getItem('nanoflow.retry-queue')).not.toContain('not-a-uuid');
    // §5.6：过期/超限的备份项不再自动回放，但必须落入 legacy-review 隔离仓保留证据，
    // 静默跳过会让 IndexedDB 备份在下次覆写时永久丢失这些写入
    const legacyReviewRaw = localStorage.getItem('nanoflow.retry-queue.legacy-review.test-user');
    expect(legacyReviewRaw).toContain(expiredTask.id);
    expect(legacyReviewRaw).toContain(maxRetryTask.id);
  });

  it('loadFromLocalStorage 应把过期/超限重试项隔离保留而不是静默丢弃', () => {
    const { service, createTask } = getContext();
    const freshTask = createTask('retry-load-fresh');
    const expiredTask = createTask('retry-load-expired');
    const maxRetryTask = createTask('retry-load-max-retry');
    const internals = service as unknown as {
      VERSION: number;
      MAX_ITEM_AGE: number;
      MAX_RETRIES: number;
      loadFromLocalStorage(): Array<{ data: { id: string } }>;
    };

    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: internals.VERSION,
      items: [
        {
          id: crypto.randomUUID(),
          type: 'task',
          operation: 'upsert',
          data: freshTask,
          projectId: 'project-load',
          retryCount: 0,
          createdAt: Date.now(),
          sourceUserId: 'test-user',
          operationId: 'op-load-fresh',
        },
        {
          id: crypto.randomUUID(),
          type: 'task',
          operation: 'upsert',
          data: expiredTask,
          projectId: 'project-load',
          retryCount: 0,
          createdAt: Date.now() - internals.MAX_ITEM_AGE - 1,
          sourceUserId: 'test-user',
          operationId: 'op-load-expired',
        },
        {
          id: crypto.randomUUID(),
          type: 'task',
          operation: 'upsert',
          data: maxRetryTask,
          projectId: 'project-load',
          retryCount: internals.MAX_RETRIES,
          createdAt: Date.now(),
          sourceUserId: 'test-user',
          operationId: 'op-load-max-retry',
        },
      ],
    }));

    const items = internals.loadFromLocalStorage();

    expect(items.map(item => item.data.id)).toEqual([freshTask.id]);
    const legacyReviewRaw = localStorage.getItem('nanoflow.retry-queue.legacy-review.test-user');
    expect(legacyReviewRaw).toContain(expiredTask.id);
    expect(legacyReviewRaw).toContain(maxRetryTask.id);
  });

  it('restoreFromBackupItems 持久化失败时应回滚内存队列，避免误报已恢复', async () => {
    const { service, createTask } = getContext();
    const currentTask = createTask('retry-restore-rollback-current');
    const restoredTask = createTask('retry-restore-rollback-backup');
    const saveImmediateSpy = vi.spyOn(
      service as unknown as { saveToStorageImmediate: () => Promise<boolean> },
      'saveToStorageImmediate',
    ).mockResolvedValue(false);

    try {
      service.add('task', 'upsert', currentTask, 'project-current', 'test-user', undefined, undefined, undefined, 'op-current');

      const restoredCount = await (service as unknown as {
        restoreFromBackupItems(items: unknown[], ownerUserId: string): Promise<number>;
      }).restoreFromBackupItems([{
        id: crypto.randomUUID(),
        type: 'task',
        operation: 'upsert',
        data: restoredTask,
        projectId: 'project-restored',
        retryCount: 0,
        createdAt: Date.now(),
        sourceUserId: 'test-user',
        operationId: 'op-restored',
      }], 'test-user');

      expect(restoredCount).toBe(0);
      expect(service.getItems().map(item => item.data.id)).toEqual([currentTask.id]);
      expect(saveImmediateSpy).toHaveBeenCalled();
    } finally {
      saveImmediateSpy.mockRestore();
    }
  });
}

function restoreWithValidatedPolicy(
  service: RetryQueueService,
  items: unknown[],
  validationNow: number,
): Promise<number> {
  return (service as unknown as {
    restoreFromBackupItems(
      restoreItems: unknown[],
      ownerUserId: string,
      policy: { validationNow: number; terminalEvidence: 'forbid' },
    ): Promise<number>;
  }).restoreFromBackupItems(items, 'test-user', {
    validationNow,
    terminalEvidence: 'forbid',
  });
}

function makeBackupRetryQueueItem(
  task: Task,
  overrides: Partial<RetryQueueItem> = {},
): RetryQueueItem {
  return {
    id: crypto.randomUUID(),
    type: 'task',
    operation: 'upsert',
    data: task,
    projectId: 'project-validated-restore',
    retryCount: 0,
    createdAt: Date.now(),
    sourceUserId: 'test-user',
    operationId: crypto.randomUUID(),
    ...overrides,
  };
}
