import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { LoggerService } from '../../../../services/logger.service';
import type { Task } from '../../../../models';
import { DeltaSyncPersistenceService } from './delta-sync-persistence.service';
import { DB_CONFIG, IndexedDBService } from './indexeddb.service';

async function seedLegacyPersistenceSchema(tasks: Array<Task & { projectId: string }>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(DB_CONFIG.name, DB_CONFIG.version);

    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(DB_CONFIG.stores.projects)) {
        db.createObjectStore(DB_CONFIG.stores.projects, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(DB_CONFIG.stores.tasks)) {
        const taskStore = db.createObjectStore(DB_CONFIG.stores.tasks, { keyPath: 'id' });
        taskStore.createIndex('projectId', 'projectId', { unique: false });
        tasks.forEach((task) => taskStore.put(task));
      }

      if (!db.objectStoreNames.contains(DB_CONFIG.stores.connections)) {
        const connStore = db.createObjectStore(DB_CONFIG.stores.connections, { keyPath: 'id' });
        connStore.createIndex('projectId', 'projectId', { unique: false });
      }

      if (!db.objectStoreNames.contains(DB_CONFIG.stores.meta)) {
        db.createObjectStore(DB_CONFIG.stores.meta, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? '测试任务',
    content: overrides.content ?? '测试正文',
    stage: overrides.stage ?? 0,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 0,
    rank: overrides.rank ?? 0,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    displayId: overrides.displayId ?? 'T-1',
    createdDate: overrides.createdDate ?? '2026-03-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-03-01T00:00:00.000Z',
    deletedAt: overrides.deletedAt,
    ...overrides,
  };
}

describe('DeltaSyncPersistenceService', () => {
  let service: DeltaSyncPersistenceService;
  let indexedDbService: IndexedDBService;

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const sentry = {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  };

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        IndexedDBService,
        DeltaSyncPersistenceService,
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => logger),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: sentry,
        },
      ],
    });

    indexedDbService = TestBed.inject(IndexedDBService);
    await indexedDbService.deleteDatabase().catch(() => undefined);
    service = TestBed.inject(DeltaSyncPersistenceService);
  });

  afterEach(async () => {
    await indexedDbService.deleteDatabase().catch(() => undefined);
    vi.clearAllMocks();
  });

  it('getTasksUpdatedSince 应基于 projectId_updatedAt 复合索引返回未删除增量任务并保留 content', async () => {
    await service.saveTaskToLocal(
      createTask({
        id: 'task-stale',
        title: '较旧任务',
        content: '旧正文',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
      'project-1'
    );
    await service.saveTaskToLocal(
      createTask({
        id: 'task-fresh',
        title: '最新任务',
        content: '需要保留的正文',
        updatedAt: '2026-03-03T00:00:00.000Z',
      }),
      'project-1'
    );
    await service.saveTaskToLocal(
      createTask({
        id: 'task-deleted',
        title: '已删除任务',
        content: '不应返回',
        updatedAt: '2026-03-04T00:00:00.000Z',
        deletedAt: '2026-03-04T00:00:00.000Z',
      }),
      'project-1'
    );
    await service.saveTaskToLocal(
      createTask({
        id: 'task-other-project',
        title: '其他项目任务',
        content: '项目隔离',
        updatedAt: '2026-03-05T00:00:00.000Z',
      }),
      'project-2'
    );

    const tasks = await service.getTasksUpdatedSince('project-1', '2026-03-02T00:00:00.000Z');

    expect(tasks.map((task) => task.id)).toEqual(['task-fresh']);
    expect(tasks[0].content).toBe('需要保留的正文');
  });

  it('bulkMergeTasksToLocal 应删除软删除任务并保留活跃任务内容', async () => {
    await service.saveTaskToLocal(
      createTask({
        id: 'task-to-delete',
        title: '待删除任务',
        content: '旧内容',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
      'project-1'
    );

    await service.bulkMergeTasksToLocal(
      [
        createTask({
          id: 'task-active',
          title: '活跃任务',
          content: '应保留的新正文',
          updatedAt: '2026-03-02T00:00:00.000Z',
        }),
        createTask({
          id: 'task-to-delete',
          title: '待删除任务',
          content: '已删除正文',
          updatedAt: '2026-03-03T00:00:00.000Z',
          deletedAt: '2026-03-03T00:00:00.000Z',
        }),
      ],
      'project-1'
    );

    const tasks = await service.loadTasksFromLocal('project-1');

    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('task-active');
    expect(tasks[0].content).toBe('应保留的新正文');
  });

  it('旧 schema 缺失 projectId_updatedAt 索引时应升级修复并保留历史任务内容', async () => {
    await indexedDbService.deleteDatabase().catch(() => undefined);
    await seedLegacyPersistenceSchema([
      {
        ...createTask({
          id: 'legacy-task',
          title: '旧库任务',
          content: '旧库正文',
          updatedAt: '2026-03-06T00:00:00.000Z',
        }),
        projectId: 'legacy-project',
      },
    ]);

    const db = await indexedDbService.initDatabase();
    const taskStore = db.transaction(DB_CONFIG.stores.tasks, 'readonly').objectStore(DB_CONFIG.stores.tasks);

    expect(db.version).toBeGreaterThan(DB_CONFIG.version);
    expect(taskStore.indexNames.contains('projectId_updatedAt')).toBe(true);

    const tasks = await service.getTasksUpdatedSince('legacy-project', '2026-03-01T00:00:00.000Z');
    expect(tasks.map((task) => task.id)).toEqual(['legacy-task']);
    expect(tasks[0].content).toBe('旧库正文');
  });
});