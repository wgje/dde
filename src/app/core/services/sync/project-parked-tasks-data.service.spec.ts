import { TestBed } from '@angular/core/testing';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FOCUS_CONFIG } from '../../../../config/focus.config';
import type { Task } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import {
  LocalBackupUiRestoreWriterPausedError,
  LocalBackupUiRestoreWriterQuiescenceService,
} from '../../../../services/local-backup-ui-restore-writer-quiescence.service';
import { registerProjectParkedTasksDataDeltaSpecs } from './project-parked-tasks-data-delta.spec-helpers';
import { ProjectParkedTasksDataService } from './project-parked-tasks-data.service';

type QueryFilter =
  | { kind: 'eq-null'; column: string; value: unknown }
  | { kind: 'not'; column: string; operator: string; value: unknown }
  | { kind: 'in'; column: string; values: readonly string[] }
  | { kind: 'gt'; column: string; value: string }
  | { kind: 'gte'; column: string; value: string }
  | { kind: 'or'; filters: string };

interface QueryCall {
  table: string;
  filters: QueryFilter[];
  limitCounts: number[];
  rangeStarts: number[];
}

interface FakeSupabaseOptions {
  knownIdErrors?: Record<string, { message: string }>;
  knownIdRows?: Record<string, unknown[]>;
  parkedRows?: unknown[];
}

class FakeSupabaseQuery {
  readonly filters: QueryFilter[] = [];
  readonly limitCounts: number[] = [];
  readonly rangeStarts: number[] = [];

  constructor(
    private readonly table: string,
    private readonly calls: QueryCall[],
    private readonly options: FakeSupabaseOptions,
  ) {
    this.calls.push({
      table,
      filters: this.filters,
      limitCounts: this.limitCounts,
      rangeStarts: this.rangeStarts,
    });
  }

  select(): this {
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    this.filters.push({ kind: 'not', column, operator, value });
    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push({ kind: 'eq-null', column, value });
    return this;
  }

  in(column: string, values: readonly string[]): this {
    this.filters.push({ kind: 'in', column, values });
    return this;
  }

  gt(column: string, value: string): this {
    this.filters.push({ kind: 'gt', column, value });
    return this;
  }

  gte(column: string, value: string): this {
    this.filters.push({ kind: 'gte', column, value });
    return this;
  }

  or(filters: string): this {
    this.filters.push({ kind: 'or', filters });
    return this;
  }

  order(): this {
    return this;
  }

  limit(count: number): { data: unknown[] | null; error: { message: string } | null } {
    this.limitCounts.push(count);
    return this.readRows(0, count - 1);
  }

  range(from = 0, to = Number.MAX_SAFE_INTEGER): {
    data: unknown[] | null;
    error: { message: string } | null;
  } {
    this.rangeStarts.push(from);
    return this.readRows(from, to);
  }

  private readRows(from: number, to: number): {
    data: unknown[] | null;
    error: { message: string } | null;
  } {
    if (this.table === 'projects') {
      return { data: [{ id: 'project-1' }], error: null };
    }

    const idFilter = this.filters.find(
      (filter): filter is Extract<QueryFilter, { kind: 'in' }> =>
        filter.kind === 'in' && filter.column === 'id',
    );
    const failedKnownId = idFilter?.values.find(id => this.options.knownIdErrors?.[id]);
    if (failedKnownId) {
      return {
        data: null,
        error: this.options.knownIdErrors![failedKnownId],
      };
    }

    const configuredKnownIds = idFilter?.values.filter(id => (
      Object.prototype.hasOwnProperty.call(this.options.knownIdRows ?? {}, id)
    ));
    if (configuredKnownIds?.length) {
      return {
        data: configuredKnownIds.flatMap(id => this.options.knownIdRows?.[id] ?? []),
        error: null,
      };
    }

    if (idFilter?.values.includes('cached-task')) {
      return {
        data: [{
          id: 'cached-task',
          project_id: 'project-1',
          parking_meta: null,
          deleted_at: null,
          updated_at: '2026-06-01T00:00:00.000Z',
        }],
        error: null,
      };
    }

    const projectFilter = this.filters.find(
      (filter): filter is Extract<QueryFilter, { kind: 'in' }> =>
        filter.kind === 'in' && filter.column === 'project_id',
    );
    if (projectFilter) {
      const rows = this.applyFilters(this.options.parkedRows ?? [])
        .slice()
        .sort((left, right) => {
          const leftRow = left as Record<string, unknown>;
          const rightRow = right as Record<string, unknown>;
          const updatedOrder = String(leftRow['updated_at'] ?? '')
            .localeCompare(String(rightRow['updated_at'] ?? ''));
          return updatedOrder !== 0
            ? updatedOrder
            : String(leftRow['id'] ?? '').localeCompare(String(rightRow['id'] ?? ''));
        });
      return {
        data: rows.slice(from, to + 1),
        error: null,
      };
    }

    return { data: [], error: null };
  }

  private applyFilters(rows: unknown[]): unknown[] {
    return rows.filter(row => {
      if (!row || typeof row !== 'object') return false;
      return this.filters.every(filter => this.matchesFilter(row as Record<string, unknown>, filter));
    });
  }

  private matchesFilter(row: Record<string, unknown>, filter: QueryFilter): boolean {
    switch (filter.kind) {
      case 'eq-null':
        return row[filter.column] === filter.value;
      case 'not':
        return filter.operator === 'is' && filter.value === null
          ? row[filter.column] !== null && row[filter.column] !== undefined
          : true;
      case 'in':
        return filter.values.includes(String(row[filter.column]));
      case 'gt':
        return String(row[filter.column] ?? '') > filter.value;
      case 'gte':
        return String(row[filter.column] ?? '') >= filter.value;
      case 'or':
        return this.matchesCompositeCursorFilter(row, filter.filters);
    }
  }

  private matchesCompositeCursorFilter(row: Record<string, unknown>, filters: string): boolean {
    const match = /^updated_at\.gt\.(.*),and\(updated_at\.eq\.(.*),id\.gt\.(.*)\)$/.exec(filters);
    if (!match) return true;

    const [, updatedAtGreaterThan, updatedAtEqualTo, idGreaterThan] = match;
    const updatedAt = String(row['updated_at'] ?? '');
    const id = String(row['id'] ?? '');
    return updatedAt > updatedAtGreaterThan
      || (updatedAt === updatedAtEqualTo && id > idGreaterThan);
  }
}

function createSupabaseClient(options: FakeSupabaseOptions = {}): { client: SupabaseClient; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const client = {
    from(table: string): FakeSupabaseQuery {
      return new FakeSupabaseQuery(table, calls, options);
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

function createMutablePagedTaskClient(rows: Array<Record<string, unknown>>): {
  client: SupabaseClient;
  limitCursors: Array<string | null>;
  rangeStarts: number[];
} {
  const limitCursors: Array<string | null> = [];
  const rangeStarts: number[] = [];
  let pageRequests = 0;

  const readPage = (
    cursor: { updatedAt: string; id: string } | null,
    from: number,
    to: number,
  ) => {
    const ordered = rows
      .filter((row) => {
        if (!cursor) return true;
        const updatedAt = String(row['updated_at'] ?? '');
        const id = String(row['id'] ?? '');
        return updatedAt > cursor.updatedAt
          || updatedAt === cursor.updatedAt && id > cursor.id;
      })
      .slice()
      .sort((left, right) => {
        const updatedOrder = String(left['updated_at']).localeCompare(String(right['updated_at']));
        return updatedOrder !== 0
          ? updatedOrder
          : String(left['id']).localeCompare(String(right['id']));
      });
    const page = ordered.slice(from, to + 1);
    if (pageRequests++ === 0) {
      rows[0]['updated_at'] = '2026-06-02T01:00:00.000Z';
    }
    return { data: page, error: null };
  };

  const client = {
    from(table: string) {
      if (table !== 'tasks') throw new Error(`Unexpected table: ${table}`);
      let cursor: { updatedAt: string; id: string } | null = null;
      const query = {
        select: () => query,
        not: () => query,
        is: () => query,
        in: () => query,
        order: () => query,
        gt: (column: string, value: string) => {
          if (column === 'updated_at') cursor = { updatedAt: value, id: '' };
          return query;
        },
        gte: (column: string, value: string) => {
          if (column === 'updated_at') cursor = { updatedAt: value, id: '' };
          return query;
        },
        or: (filters: string) => {
          const match = /^updated_at\.gt\.(.*),and\(updated_at\.eq\.(.*),id\.gt\.(.*)\)$/.exec(filters);
          if (match) cursor = { updatedAt: match[2], id: match[3] };
          return query;
        },
        limit: (count: number) => {
          limitCursors.push(cursor ? `${cursor.updatedAt}|${cursor.id}` : null);
          return readPage(cursor, 0, count - 1);
        },
        range: (from: number, to: number) => {
          rangeStarts.push(from);
          return readPage(cursor, from, to);
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;

  return { client, limitCursors, rangeStarts };
}

function createMutablePagedProjectClient(rows: Array<{ id: string }>, earlierId: string): {
  client: SupabaseClient;
  projectPageCursors: Array<string | null>;
  projectRangeStarts: number[];
  queriedProjectIds: string[];
} {
  const projectPageCursors: Array<string | null> = [];
  const projectRangeStarts: number[] = [];
  const queriedProjectIds: string[] = [];
  let projectPageRequests = 0;

  const readProjectPage = (cursor: string | null, from: number, to: number) => {
    const ordered = rows
      .filter(row => !cursor || row.id > cursor)
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id));
    const page = ordered.slice(from, to + 1);
    if (projectPageRequests++ === 0) {
      rows.push({ id: earlierId });
    }
    return { data: page, error: null };
  };

  const client = {
    from(table: string) {
      let idCursor: string | null = null;
      const query = {
        select: () => query,
        not: () => query,
        is: () => query,
        order: () => query,
        or: () => query,
        gt: (column: string, value: string) => {
          if (table === 'projects' && column === 'id') idCursor = value;
          return query;
        },
        in: (column: string, values: readonly string[]) => {
          if (table === 'tasks' && column === 'project_id') {
            queriedProjectIds.push(...values);
          }
          return query;
        },
        limit: (count: number) => {
          if (table === 'projects') {
            projectPageCursors.push(idCursor);
            return readProjectPage(idCursor, 0, count - 1);
          }
          return { data: [], error: null };
        },
        range: (from: number, to: number) => {
          if (table === 'projects') {
            projectRangeStarts.push(from);
            return readProjectPage(null, from, to);
          }
          return { data: [], error: null };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;

  return {
    client,
    projectPageCursors,
    projectRangeStarts,
    queriedProjectIds,
  };
}

function createTask(id: string): Task {
  return {
    id,
    title: id,
    content: '',
    stage: null,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    displayId: id,
  };
}

interface RawParkingStores {
  parkedRows: Array<Record<string, unknown>>;
  metadataRows: Array<{ key: string; value: unknown }>;
}

const LEGACY_PARKING_CURSOR_KEY = 'parking_last_sync_time';

function ownerParkingCursorKey(ownerUserId: string): string {
  return `${LEGACY_PARKING_CURSOR_KEY}:${encodeURIComponent(ownerUserId)}`;
}

function ownerParkedTaskKey(ownerUserId: string, taskId: string): string {
  return `${encodeURIComponent(ownerUserId)}:${taskId}`;
}

async function openParkingTestDatabase(): Promise<IDBDatabase> {
  return await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(
      FOCUS_CONFIG.SYNC.IDB_NAME,
      FOCUS_CONFIG.SYNC.IDB_VERSION,
    );
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS)) {
        db.createObjectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS, { keyPath: 'taskId' });
      }
      if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA)) {
        db.createObjectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function mutateParkingStores(
  mutate: (parkedStore: IDBObjectStore, metadataStore: IDBObjectStore) => void,
): Promise<void> {
  const db = await openParkingTestDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        [FOCUS_CONFIG.IDB_STORES.PARKED_TASKS, FOCUS_CONFIG.IDB_STORES.SYNC_METADATA],
        'readwrite',
      );
      mutate(
        tx.objectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS),
        tx.objectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA),
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function seedParkingStores(
  parkedRows: Array<Record<string, unknown>>,
  metadataRows: Array<{ key: string; value: unknown }>,
): Promise<void> {
  await mutateParkingStores((parkedStore, metadataStore) => {
    for (const row of parkedRows) parkedStore.put(row);
    for (const row of metadataRows) metadataStore.put(row);
  });
}

async function readParkingStores(): Promise<RawParkingStores> {
  const db = await openParkingTestDatabase();
  try {
    return await new Promise<RawParkingStores>((resolve, reject) => {
      const tx = db.transaction(
        [FOCUS_CONFIG.IDB_STORES.PARKED_TASKS, FOCUS_CONFIG.IDB_STORES.SYNC_METADATA],
        'readonly',
      );
      const parkedRequest = tx.objectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS).getAll();
      const metadataRequest = tx.objectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA).getAll();
      tx.oncomplete = () => resolve({
        parkedRows: parkedRequest.result as Array<Record<string, unknown>>,
        metadataRows: metadataRequest.result as Array<{ key: string; value: unknown }>,
      });
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function createService(): ProjectParkedTasksDataService {
  TestBed.configureTestingModule({
    providers: [
      ProjectParkedTasksDataService,
      {
        provide: LoggerService,
        useValue: {
          category: () => ({
            debug: vi.fn(),
            warn: vi.fn(),
          }),
        },
      },
    ],
  });
  return TestBed.inject(ProjectParkedTasksDataService);
}

describe('ProjectParkedTasksDataService', () => {
  beforeEach(async () => {
    vi.useRealTimers();
    await mutateParkingStores((parkedStore, metadataStore) => {
      parkedStore.clear();
      metadataStore.clear();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not expose ownerless legacy rows or the global cursor to either owner', async () => {
    const legacyTask = createTask('legacy-task');
    await seedParkingStores([{
      taskId: legacyTask.id,
      projectId: 'legacy-project',
      task: legacyTask,
      updatedAt: legacyTask.updatedAt,
    }], [{
      key: LEGACY_PARKING_CURSOR_KEY,
      value: 'legacy-global-cursor',
    }]);
    const service = createService();

    await expect(service.loadParkedTasksCache('owner-a')).resolves.toEqual({
      entries: [],
      cursor: null,
    });
    await expect(service.loadParkedTasksCache('owner-b')).resolves.toEqual({
      entries: [],
      cursor: null,
    });
  });

  it('preserves ownerless legacy data and other owners during a normal owner-scoped save', async () => {
    const legacyTask = createTask('legacy-task');
    const ownerATask = createTask('owner-a-task');
    const ownerBTask = createTask('owner-b-task');
    await seedParkingStores([{
      taskId: legacyTask.id,
      projectId: 'legacy-project',
      task: legacyTask,
      updatedAt: legacyTask.updatedAt,
    }, {
      ownerUserId: 'owner-b',
      taskId: ownerParkedTaskKey('owner-b', ownerBTask.id),
      projectId: 'owner-b-project',
      task: ownerBTask,
      updatedAt: ownerBTask.updatedAt,
    }], [{
      key: LEGACY_PARKING_CURSOR_KEY,
      value: 'legacy-global-cursor',
    }, {
      key: ownerParkingCursorKey('owner-b'),
      value: 'owner-b-cursor',
    }]);
    const service = createService();

    await service.saveParkedTasksCache('owner-a', {
      entries: [{ task: ownerATask, projectId: 'owner-a-project' }],
      cursor: 'owner-a-cursor',
    });

    const stored = await readParkingStores();
    const storedLegacyRow = stored.parkedRows.find(row => row['taskId'] === legacyTask.id);
    expect(storedLegacyRow).toBeDefined();
    expect(storedLegacyRow).not.toHaveProperty('ownerUserId');
    expect(stored.parkedRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: ownerParkedTaskKey('owner-a', ownerATask.id),
        ownerUserId: 'owner-a',
      }),
      expect.objectContaining({
        taskId: ownerParkedTaskKey('owner-b', ownerBTask.id),
        ownerUserId: 'owner-b',
      }),
    ]));
    expect(stored.metadataRows).toEqual(expect.arrayContaining([
      { key: LEGACY_PARKING_CURSOR_KEY, value: 'legacy-global-cursor' },
      { key: ownerParkingCursorKey('owner-a'), value: 'owner-a-cursor' },
      { key: ownerParkingCursorKey('owner-b'), value: 'owner-b-cursor' },
    ]));
  });

  it('retires ownerless legacy data only when explicitly requested and preserves another owner', async () => {
    const legacyTask = createTask('legacy-task');
    const ownerATask = createTask('owner-a-task');
    const ownerBTask = createTask('owner-b-task');
    await seedParkingStores([{
      taskId: legacyTask.id,
      projectId: 'legacy-project',
      task: legacyTask,
      updatedAt: legacyTask.updatedAt,
    }, {
      ownerUserId: 'owner-b',
      taskId: ownerParkedTaskKey('owner-b', ownerBTask.id),
      projectId: 'owner-b-project',
      task: ownerBTask,
      updatedAt: ownerBTask.updatedAt,
    }], [{
      key: LEGACY_PARKING_CURSOR_KEY,
      value: 'legacy-global-cursor',
    }, {
      key: ownerParkingCursorKey('owner-b'),
      value: 'owner-b-cursor',
    }]);
    const service = createService();

    await service.saveParkedTasksCache('owner-a', {
      entries: [{ task: ownerATask, projectId: 'owner-a-project' }],
      cursor: 'owner-a-cursor',
    }, { retireLegacyOwnerlessCache: true });

    const stored = await readParkingStores();
    expect(stored.parkedRows).not.toContainEqual(expect.objectContaining({ taskId: legacyTask.id }));
    expect(stored.parkedRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: ownerParkedTaskKey('owner-a', ownerATask.id),
        ownerUserId: 'owner-a',
      }),
      expect.objectContaining({
        taskId: ownerParkedTaskKey('owner-b', ownerBTask.id),
        ownerUserId: 'owner-b',
      }),
    ]));
    expect(stored.metadataRows).not.toContainEqual(expect.objectContaining({
      key: LEGACY_PARKING_CURSOR_KEY,
    }));
    expect(stored.metadataRows).toEqual(expect.arrayContaining([
      { key: ownerParkingCursorKey('owner-a'), value: 'owner-a-cursor' },
      { key: ownerParkingCursorKey('owner-b'), value: 'owner-b-cursor' },
    ]));
  });

  it('waits for an in-flight parked-task cache save before quiescing and rejects new owner writes after freeze', async () => {
    const service = createService();
    let releaseOpen!: () => void;
    vi.spyOn(service as never as { openFocusModeDB(): Promise<never> }, 'openFocusModeDB')
      .mockImplementation(async () => {
        await new Promise<void>(resolve => {
          releaseOpen = resolve;
        });
        throw new Error('focus db blocked');
      });
    const quiescence = new LocalBackupUiRestoreWriterQuiescenceService({ pollIntervalMs: 1 });
    const save = service.saveParkedTasksCache('owner-a', {
      entries: [{ task: createTask('owner-a-task'), projectId: 'owner-a-project' }],
      cursor: 'owner-a-cursor',
    });
    await vi.waitFor(() => expect(releaseOpen).toBeTypeOf('function'));

    let prepared = false;
    const preparing = quiescence.prepare('owner-a').then(handle => {
      prepared = true;
      return handle;
    });

    await new Promise(resolve => setTimeout(resolve, 5));
    expect(prepared).toBe(false);

    releaseOpen();
    await save;
    const handle = await preparing;

    await expect(service.saveParkedTasksCache('owner-a', {
      entries: [{ task: createTask('owner-a-blocked'), projectId: 'owner-a-project' }],
      cursor: 'owner-a-cursor-next',
    })).rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);
    await handle.abortBeforeMutation();
  });

  it('应按 owner 隔离停泊任务缓存和增量游标', async () => {
    TestBed.configureTestingModule({
      providers: [
        ProjectParkedTasksDataService,
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
            }),
          },
        },
      ],
    });
    const service = TestBed.inject(ProjectParkedTasksDataService);
    const ownerATask = createTask('owner-a-task');
    const ownerBTask = createTask('owner-b-task');

    await service.saveParkedTasksCache('owner-a', {
      entries: [{ task: ownerATask, projectId: 'owner-a-project' }],
      cursor: 'owner-a-cursor',
    });
    await service.saveParkedTasksCache('owner-b', {
      entries: [{ task: ownerBTask, projectId: 'owner-b-project' }],
      cursor: 'owner-b-cursor',
    });

    await expect(service.loadParkedTasksCache('owner-a')).resolves.toEqual({
      entries: [{ task: ownerATask, projectId: 'owner-a-project' }],
      cursor: 'owner-a-cursor',
    });
    await expect(service.loadParkedTasksCache('owner-b')).resolves.toEqual({
      entries: [{ task: ownerBTask, projectId: 'owner-b-project' }],
      cursor: 'owner-b-cursor',
    });
  });

  registerProjectParkedTasksDataDeltaSpecs({
    createMutablePagedProjectClient,
    createMutablePagedTaskClient,
    createService,
    createSupabaseClient,
    createTask,
  });
});
