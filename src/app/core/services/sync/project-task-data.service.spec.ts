import { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import type { TaskRow } from '../../../../models/supabase-types';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { ProjectTaskDataService } from './project-task-data.service';
import { TombstoneService } from './tombstone.service';

type AuthRetryHandler = <T>(context: string, operation: () => Promise<T>) => Promise<T>;

describe('ProjectTaskDataService owner/auth boundaries', () => {
  it('tasks keyset 分页应使用 owner scope 去重并在鉴权错误后重试', async () => {
    const taskId = '00000000-0000-4000-8000-000000000001';
    const limit = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: 'PGRST301', message: 'JWT expired' } })
      .mockResolvedValueOnce({
        data: [{
          id: taskId,
          title: 'Task 1',
          content: '',
          created_at: '2026-07-14T00:00:00.000Z',
          updated_at: '2026-07-14T00:00:00.000Z',
        }],
        error: null,
      });
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      or: vi.fn(),
      order: vi.fn(),
      limit,
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.or.mockReturnValue(query);
    query.order.mockReturnValue(query);
    const client = { from: vi.fn(() => query) };
    const execute = vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation());
    const getTombstonesWithCache = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: 'PGRST301', message: 'JWT expired' } })
      .mockResolvedValueOnce({ data: [], error: null });
    const service = Injector.create({
      providers: [
        { provide: ProjectTaskDataService, useClass: ProjectTaskDataService },
        { provide: RequestThrottleService, useValue: { execute } },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache,
            shouldMaterializeTaskDeletion: vi.fn().mockReturnValue(false),
            getLocalTombstoneTimestamp: vi.fn().mockReturnValue(undefined),
            clearLocalTombstones: vi.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
          },
        },
        { provide: SentryLazyLoaderService, useValue: { addBreadcrumb: vi.fn() } },
      ],
    }).get(ProjectTaskDataService);
    const withAuthRetry = vi.fn(async (_context: string, operation: () => Promise<unknown>) => {
      try {
        return await operation();
      } catch {
        return await operation();
      }
    }) as unknown as AuthRetryHandler;
    const pullTasks = service.pullTasksThrottled.bind(service) as unknown as (
      projectId: string,
      projectClient: unknown,
      rowToTask: (row: Record<string, unknown>) => Task,
      ownerScope: string,
      retry: AuthRetryHandler,
    ) => Promise<Task[]>;

    const tasks = await pullTasks(
      'project-1',
      client,
      (row) => ({ id: String(row.id), title: String(row.title), content: String(row.content) } as Task),
      'owner-a',
      withAuthRetry,
    );

    expect(tasks.map(task => task.id)).toEqual([taskId]);
    expect(execute).toHaveBeenCalledWith(
      'tasks-data:owner-a:project-1',
      expect.any(Function),
      expect.any(Object),
    );
    expect(limit).toHaveBeenCalledTimes(2);
    expect(limit).toHaveBeenNthCalledWith(1, 1000);
    expect(limit).toHaveBeenNthCalledWith(2, 1000);
    expect(query.or).not.toHaveBeenCalled();
    expect(withAuthRetry).toHaveBeenCalledWith('loadFullProject.tasks', expect.any(Function));
    expect(withAuthRetry).toHaveBeenCalledWith('loadFullProject.taskTombstones', expect.any(Function));
    expect(getTombstonesWithCache).toHaveBeenCalledWith('project-1', client, { forceRemote: true });
    expect(getTombstonesWithCache).toHaveBeenCalledTimes(2);
  });

  it('完整项目加载在 tombstone 查询失败时应 fail closed，禁止导入可能已删除的任务', async () => {
    const tombstoneError = new Error('task tombstones unavailable');
    const limit = vi.fn().mockResolvedValue({
      data: [{
        id: '00000000-0000-4000-8000-000000000002',
        title: 'Possibly deleted task',
        content: 'must not be materialized without tombstones',
        stage: 2,
        parent_id: null,
        order: 0,
        rank: 100,
        status: 'active',
        created_at: '2026-07-14T00:00:00.000Z',
        updated_at: '2026-07-14T00:00:00.000Z',
      }],
      error: null,
    });
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      or: vi.fn(),
      order: vi.fn(),
      limit,
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.or.mockReturnValue(query);
    query.order.mockReturnValue(query);
    const client = { from: vi.fn(() => query) };
    const rowToTask = vi.fn((row: TaskRow | Partial<TaskRow>) => ({
      id: String(row.id),
      title: String(row.title),
      content: String(row.content),
      stage: Number(row.stage),
    } as Task));
    const service = Injector.create({
      providers: [
        { provide: ProjectTaskDataService, useClass: ProjectTaskDataService },
        {
          provide: RequestThrottleService,
          useValue: { execute: vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation()) },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: null, error: tombstoneError }),
            shouldMaterializeTaskDeletion: vi.fn().mockReturnValue(false),
            getLocalTombstoneTimestamp: vi.fn().mockReturnValue(undefined),
            clearLocalTombstones: vi.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
          },
        },
        { provide: SentryLazyLoaderService, useValue: { addBreadcrumb: vi.fn() } },
      ],
    }).get(ProjectTaskDataService);

    await expect(service.pullTasksThrottled(
      'project-1',
      client as never,
      rowToTask,
      'owner-a',
    )).rejects.toThrow('task tombstones unavailable');
    expect(rowToTask).not.toHaveBeenCalled();
  });
});
