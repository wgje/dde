import { Injector } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Connection, Project } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';
import {
  ProjectDetailLoaderService,
  type ProjectDetailAuthRetryHandler,
  type ProjectDetailLoadDependencies,
} from './project-detail-loader.service';
import { ProjectTaskDataService } from './project-task-data.service';

function createMetadataQuery() {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: {
        id: 'project-1',
        owner_id: 'owner-a',
        title: 'Project 1',
        description: '',
        created_date: '2026-07-14T00:00:00.000Z',
        updated_at: '2026-07-14T00:00:00.000Z',
        deleted_at: null,
        version: 1,
      },
      error: null,
    }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  return query;
}

function createConnectionQuery(
  limit: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ data: [], error: null }),
) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    gt: vi.fn(),
    or: vi.fn(),
    order: vi.fn(),
    limit,
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.gt.mockReturnValue(query);
  query.or.mockReturnValue(query);
  query.order.mockReturnValue(query);
  return query;
}

function createMutablePagedConnectionQueries(rows: Array<Record<string, unknown>>): {
  createQuery: () => Record<string, unknown>;
  limitCursors: Array<string | null>;
  rangeStarts: number[];
} {
  const limitCursors: Array<string | null> = [];
  const rangeStarts: number[] = [];
  let pageRequests = 0;

  const readPage = (
    cursor: { updatedAt: string | null; id: string } | null,
    from: number,
    to: number,
  ) => {
    const ordered = rows
      .filter((row) => {
        if (!cursor) return true;
        const updatedAt = typeof row['updated_at'] === 'string' ? row['updated_at'] : null;
        const id = String(row['id'] ?? '');
        if (cursor.updatedAt === null) return updatedAt === null && id > cursor.id;
        if (updatedAt === null) return true;
        return updatedAt > cursor.updatedAt
          || updatedAt === cursor.updatedAt && id > cursor.id;
      })
      .slice()
      .sort((left, right) => {
        const leftUpdatedAt = typeof left['updated_at'] === 'string' ? left['updated_at'] : null;
        const rightUpdatedAt = typeof right['updated_at'] === 'string' ? right['updated_at'] : null;
        if (leftUpdatedAt === null && rightUpdatedAt !== null) return 1;
        if (rightUpdatedAt === null && leftUpdatedAt !== null) return -1;
        const updatedOrder = (leftUpdatedAt ?? '').localeCompare(rightUpdatedAt ?? '');
        return updatedOrder !== 0
          ? updatedOrder
          : String(left['id']).localeCompare(String(right['id']));
      });
    const page = ordered.slice(from, to + 1);
    if (pageRequests++ === 0) {
      rows[0]['updated_at'] = '2026-07-14T01:00:00.000Z';
    }
    return Promise.resolve({ data: page, error: null });
  };

  const createQuery = () => {
    let cursor: { updatedAt: string | null; id: string } | null = null;
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(() => query),
      is: vi.fn((column: string, value: unknown) => {
        if (column === 'updated_at' && value === null) cursor = { updatedAt: null, id: '' };
        return query;
      }),
      gt: vi.fn((column: string, value: string) => {
        if (column === 'id' && cursor?.updatedAt === null) {
          cursor = { updatedAt: null, id: value };
        }
        return query;
      }),
      or: vi.fn((filters: string) => {
        const match = /^updated_at\.gt\.(.*),and\(updated_at\.eq\.(.*),id\.gt\.(.*)\),updated_at\.is\.null$/.exec(filters);
        if (match) cursor = { updatedAt: match[2], id: match[3] };
        return query;
      }),
      limit: vi.fn((count: number) => {
        limitCursors.push(cursor ? `${cursor.updatedAt ?? 'null'}|${cursor.id}` : null);
        return readPage(cursor, 0, count - 1);
      }),
      range: vi.fn((from: number, to: number) => {
        rangeStarts.push(from);
        return readPage(cursor, from, to);
      }),
    };
    return query;
  };

  return { createQuery, limitCursors, rangeStarts };
}

function createLoader(options: {
  execute: ReturnType<typeof vi.fn>;
  pullTasksThrottled: ReturnType<typeof vi.fn>;
}): ProjectDetailLoaderService {
  return Injector.create({
    providers: [
      { provide: ProjectDetailLoaderService, useClass: ProjectDetailLoaderService },
      { provide: RequestThrottleService, useValue: { execute: options.execute } },
      { provide: ProjectTaskDataService, useValue: { pullTasksThrottled: options.pullTasksThrottled } },
      {
        provide: LoggerService,
        useValue: {
          category: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
        },
      },
      {
        provide: SentryLazyLoaderService,
        useValue: { addBreadcrumb: vi.fn(), captureException: vi.fn(), captureMessage: vi.fn() },
      },
    ],
  }).get(ProjectDetailLoaderService);
}

function createDependencies(
  client: unknown,
  withAuthRetry: ProjectDetailAuthRetryHandler,
): ProjectDetailLoadDependencies {
  return {
    getClient: vi.fn().mockResolvedValue(client),
    withAuthRetry,
    rowToProject: (row) => ({
      id: String(row.id),
      name: String(row.title),
      description: String(row.description ?? ''),
      createdDate: String(row.created_date ?? ''),
      tasks: [],
      connections: [],
    } satisfies Project),
    rowToTask: (row) => ({ id: String(row.id) } as never),
    rowToConnection: (row) => ({
      id: String(row.id),
      source: String(row.source_id),
      target: String(row.target_id),
    } as Connection),
  };
}

describe('ProjectDetailLoaderService owner/auth boundaries', () => {
  beforeEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
  });

  it('顺序加载应把 owner scope 传给 tasks 并用于 connections 去重键', async () => {
    const metadataQuery = createMetadataQuery();
    const connectionQuery = createConnectionQuery();
    const client = {
      from: vi.fn((table: string) => {
        if (table === 'projects') return metadataQuery;
        if (table === 'connections') return connectionQuery;
        throw new Error(`unexpected table ${table}`);
      }),
    };
    const execute = vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation());
    const pullTasksThrottled = vi.fn().mockResolvedValue([]);
    const withAuthRetry = vi.fn(async (_context: string, operation: () => Promise<unknown>) => operation());
    const loader = createLoader({ execute, pullTasksThrottled });
    const dependencies = createDependencies(
      client,
      withAuthRetry as unknown as ProjectDetailAuthRetryHandler,
    );

    const project = await loader.loadFullProject('project-1', 'owner-a', dependencies);

    expect(project?.id).toBe('project-1');
    expect(pullTasksThrottled).toHaveBeenCalledWith(
      'project-1',
      client,
      dependencies.rowToTask,
      'owner-a',
      dependencies.withAuthRetry,
    );
    expect(execute.mock.calls.map(([key]) => key)).toContain('connections:owner-a:project-1');
  });

  it('connections 分页遇到鉴权错误时应刷新后重试一次', async () => {
    const metadataQuery = createMetadataQuery();
    const limit = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: 'PGRST301', message: 'JWT expired' } })
      .mockResolvedValueOnce({ data: [], error: null });
    const connectionQuery = createConnectionQuery(limit);
    const client = {
      from: vi.fn((table: string) => {
        if (table === 'projects') return metadataQuery;
        if (table === 'connections') return connectionQuery;
        throw new Error(`unexpected table ${table}`);
      }),
    };
    const execute = vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation());
    const pullTasksThrottled = vi.fn().mockResolvedValue([]);
    const withAuthRetry = vi.fn(async (_context: string, operation: () => Promise<unknown>) => {
      try {
        return await operation();
      } catch {
        return await operation();
      }
    });
    const loader = createLoader({ execute, pullTasksThrottled });
    const dependencies = createDependencies(
      client,
      withAuthRetry as unknown as ProjectDetailAuthRetryHandler,
    );

    const project = await loader.loadFullProject('project-1', 'owner-a', dependencies);

    expect(project?.id).toBe('project-1');
    expect(limit).toHaveBeenCalledTimes(2);
    expect(withAuthRetry).toHaveBeenCalledWith('loadFullProject.connections', expect.any(Function));
  });

  it('connections keyset 在行跨页移动和更新时间为空时不漏行或重复', async () => {
    const baseTime = Date.parse('2026-07-14T00:00:00.000Z');
    const rows = Array.from({ length: 2001 }, (_, index) => ({
      id: `conn-${index.toString().padStart(4, '0')}`,
      project_id: 'project-1',
      source_id: 'task-source',
      target_id: 'task-target',
      updated_at: index >= 1001 ? null : new Date(baseTime + index * 1000).toISOString(),
      deleted_at: null,
    }));
    const metadataQuery = createMetadataQuery();
    const paged = createMutablePagedConnectionQueries(rows);
    const client = {
      from: vi.fn((table: string) => {
        if (table === 'projects') return metadataQuery;
        if (table === 'connections') return paged.createQuery();
        throw new Error(`unexpected table ${table}`);
      }),
    };
    const execute = vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation());
    const pullTasksThrottled = vi.fn().mockResolvedValue([]);
    const withAuthRetry = vi.fn(async (_context: string, operation: () => Promise<unknown>) => operation());
    const loader = createLoader({ execute, pullTasksThrottled });
    const dependencies = createDependencies(
      client,
      withAuthRetry as unknown as ProjectDetailAuthRetryHandler,
    );

    const project = await loader.loadFullProject('project-1', 'owner-a', dependencies);
    const connectionIds = project?.connections.map(connection => connection.id) ?? [];

    expect(connectionIds).toHaveLength(2001);
    expect(new Set(connectionIds).size).toBe(2001);
    expect(connectionIds).toContain('conn-2000');
    expect(paged.limitCursors).toHaveLength(3);
    expect(paged.limitCursors[2]).toMatch(/^null\|conn-/);
    expect(paged.rangeStarts).toEqual([]);
  });

  it('任务行结构不完整时应拒绝整次项目加载且不继续加载连接', async () => {
    const metadataQuery = createMetadataQuery();
    const connectionQuery = createConnectionQuery();
    const client = {
      from: vi.fn((table: string) => {
        if (table === 'projects') return metadataQuery;
        if (table === 'connections') return connectionQuery;
        throw new Error(`unexpected table ${table}`);
      }),
    };
    const execute = vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation());
    const pullTasksThrottled = vi.fn().mockRejectedValue(new Error('task row structure incomplete'));
    const withAuthRetry = vi.fn(async (_context: string, operation: () => Promise<unknown>) => operation());
    const loader = createLoader({ execute, pullTasksThrottled });
    const dependencies = createDependencies(
      client,
      withAuthRetry as unknown as ProjectDetailAuthRetryHandler,
    );

    const project = await loader.loadFullProject('project-1', 'owner-a', dependencies);

    expect(project).toBeNull();
    expect(connectionQuery.select).not.toHaveBeenCalled();
  });
});
