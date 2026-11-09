import { expect, it, type Mock, vi } from 'vitest';

import type { Task } from '../../../../models';
import { PermanentFailureError } from '../../../../utils/permanent-failure-error';
import type { TaskSyncOperationsService } from './task-sync-operations.service';

type MockFn = Mock<(...args: any[]) => any>;
type TaskFreshnessResult = {
  data: { id: string; updated_at: string | null; deleted_at: string | null } | null;
  error: unknown | null;
};
type TaskMutationResult = { data: { updated_at: string } | null; error: unknown | null };

export interface TaskSyncOperationsDirectUpsertSpecContext {
  service: TaskSyncOperationsService;
  getUpsertPayload(): Record<string, unknown> | null;
  setUpsertPayload(payload: Record<string, unknown> | null): void;
  setTaskFreshnessResult(result: TaskFreshnessResult): void;
  setTaskInsertResult(result: TaskMutationResult): void;
  setTaskUpdateResult(result: TaskMutationResult): void;
  mockClient: {
    from: MockFn;
  };
  mockRetryQueue: {
    add: MockFn;
    recordCircuitSuccess: MockFn;
  };
  mockTaskStore: {
    getTask: MockFn;
    setTask: MockFn;
  };
}

function createTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-direct-upsert',
    title: '任务',
    content: '内容',
    stage: 0,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    displayId: 'T-D',
    createdDate: new Date().toISOString(),
    deletedAt: null,
    ...overrides,
  };
}

export function registerTaskSyncOperationsDirectUpsertSpecs(
  getContext: () => TaskSyncOperationsDirectUpsertSpecContext,
): void {
  it('pushTask 应将 parking_meta 上行到 Supabase', async () => {
    const { service, getUpsertPayload } = getContext();
    const parkingMeta = {
      state: 'parked' as const,
      parkedAt: new Date().toISOString(),
      lastVisitedAt: new Date().toISOString(),
      contextSnapshot: null,
      reminder: null,
      pinned: false,
    };

    const result = await service.pushTask(createTask({
      id: 'task-1',
      displayId: 'T-1',
      parkingMeta,
    }), 'project-1');

    const payload = getUpsertPayload();
    expect(result).toBe(true);
    expect(payload).toBeTruthy();
    expect(payload?.['parking_meta']).toEqual(parkingMeta);
  });

  it('pushTask 应将 attention_meta 上行到 Supabase', async () => {
    const { service, getUpsertPayload } = getContext();
    const attentionMeta: Task['attentionMeta'] = {
      items: [
        {
          id: 'attention-1',
          text: 'Token 过期需刷新',
          level: 'warning',
          done: false,
          createdAt: '2026-06-05T00:00:00.000Z',
          updatedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
      pinned: true,
      updatedAt: '2026-06-05T00:00:00.000Z',
    };

    const result = await service.pushTask(createTask({
      id: 'task-attention-sync',
      displayId: 'T-1',
      attentionMeta,
    }), 'project-1');

    expect(result).toBe(true);
    expect(getUpsertPayload()?.['attention_meta']).toEqual(attentionMeta);
  });

  it('pushTask 直接 upsert 成功后应把服务端 canonical updated_at 写回本地任务', async () => {
    const { service, setUpsertPayload, mockClient, mockTaskStore } = getContext();
    const serverUpdatedAt = '2026-04-30T08:15:00.000Z';
    mockClient.from.mockImplementation((table: string) => {
      if (table === 'task_tombstones') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: null, error: null })),
            })),
          })),
        };
      }

      if (table === 'tasks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: null, error: null })),
              })),
            })),
          })),
          insert: vi.fn((payload: Record<string, unknown>) => {
            setUpsertPayload(payload);
            return {
              select: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: { updated_at: serverUpdatedAt },
                  error: null,
                })),
              })),
            };
          }),
          update: vi.fn(),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });
    const task = createTask({
      id: 'task-canonical-direct',
      displayId: 'T-CD',
      createdDate: '2026-04-30T08:00:00.000Z',
      updatedAt: '2026-04-30T08:00:00.000Z',
    });
    mockTaskStore.getTask.mockReturnValueOnce({ ...task });

    const result = await service.pushTask(task, 'project-1');

    expect(result).toBe(true);
    expect(task.updatedAt).toBe(serverUpdatedAt);
    expect(mockTaskStore.setTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-canonical-direct',
        updatedAt: serverUpdatedAt,
      }),
      'project-1',
    );
  });

  it('pushTask 直接 upsert 前若远端任务更新更晚则应抛出版本冲突并阻止覆盖', async () => {
    const { service, getUpsertPayload, setUpsertPayload, mockClient, mockRetryQueue } = getContext();
    mockClient.from.mockImplementation((table: string) => {
      if (table === 'task_tombstones') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: null, error: null })),
            })),
          })),
        };
      }

      if (table === 'tasks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: {
                    id: 'task-direct-conflict',
                    updated_at: '2026-04-30T09:00:00.000Z',
                    deleted_at: null,
                  },
                  error: null,
                })),
              })),
            })),
          })),
          insert: vi.fn((payload: Record<string, unknown>) => {
            setUpsertPayload(payload);
            return {
              select: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: { updated_at: new Date().toISOString() },
                  error: null,
                })),
              })),
            };
          }),
          update: vi.fn(),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    await expect(service.pushTask(createTask({
      id: 'task-direct-conflict',
      displayId: 'T-DCF',
      createdDate: '2026-04-30T08:00:00.000Z',
      updatedAt: '2026-04-30T08:00:00.000Z',
    }), 'project-1')).rejects.toBeInstanceOf(PermanentFailureError);

    expect(getUpsertPayload()).toBeNull();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('pushTask 直接写入在 preflight 后被并发更新抢先时应以版本冲突失败收口', async () => {
    const {
      service,
      setTaskFreshnessResult,
      setTaskUpdateResult,
      mockRetryQueue,
    } = getContext();
    setTaskFreshnessResult({
      data: {
        id: 'task-direct-cas-miss',
        updated_at: '2026-04-30T08:00:00.000Z',
        deleted_at: null,
      },
      error: null,
    });
    setTaskUpdateResult({
      data: null,
      error: null,
    });

    await expect(service.pushTask(createTask({
      id: 'task-direct-cas-miss',
      displayId: 'T-DCM',
      createdDate: '2026-04-30T08:00:00.000Z',
      updatedAt: '2026-04-30T08:00:00.000Z',
    }), 'project-1')).rejects.toBeInstanceOf(PermanentFailureError);

    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });

  it('pushTask 直接 insert 在写回未返回行时应以版本冲突失败收口，避免 406 冒泡', async () => {
    const {
      service,
      getUpsertPayload,
      setTaskFreshnessResult,
      setTaskInsertResult,
      mockRetryQueue,
    } = getContext();
    setTaskFreshnessResult({ data: null, error: null });
    setTaskInsertResult({ data: null, error: null });

    await expect(service.pushTask(createTask({
      id: 'task-direct-insert-empty',
      displayId: 'T-DIE',
      createdDate: '2026-04-30T08:00:00.000Z',
      updatedAt: '2026-04-30T08:00:00.000Z',
    }), 'project-1')).rejects.toBeInstanceOf(PermanentFailureError);

    expect(getUpsertPayload()).not.toBeNull();
    expect(mockRetryQueue.add).not.toHaveBeenCalled();
    expect(mockRetryQueue.recordCircuitSuccess).not.toHaveBeenCalled();
  });
}
