import type { Project } from '../models';
import { vi } from 'vitest';

export function createProject(): Project {
  return {
    id: 'project-1',
    name: 'Inbox',
    description: 'Primary',
    createdDate: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
    version: 2,
    tasks: [{
      id: 'task-1',
      title: 'Task A',
      content: 'Body',
      stage: 1,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 1,
      y: 2,
      createdDate: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-02T00:00:00.000Z',
      displayId: '1',
      shortId: 'NF-1',
      attachments: [],
      tags: ['focus'],
      priority: 'high',
      dueDate: null,
      expected_minutes: 30,
      cognitive_load: 'high',
      wait_minutes: null,
      parkingMeta: {
        state: 'parked',
        parkedAt: '2026-03-01T12:00:00.000Z',
        lastVisitedAt: null,
        contextSnapshot: null,
        reminder: null,
        pinned: false,
      },
      attentionMeta: {
        items: [{
          id: 'attention-1',
          text: '检查灾备字段',
          level: 'warning',
          done: false,
          createdAt: '2026-03-01T13:00:00.000Z',
          updatedAt: '2026-03-01T13:00:00.000Z',
        }],
        updatedAt: '2026-03-01T13:00:00.000Z',
      },
    }],
    connections: [{
      id: 'conn-1',
      source: 'task-1',
      target: 'task-1',
      title: 'Loop',
      description: 'Self',
      deletedAt: null,
      updatedAt: '2026-03-02T00:00:00.000Z',
    }],
  };
}

export async function seedStore(
  dbName: string,
  version: number,
  ensureStores: (db: IDBDatabase) => void,
  writer: (db: IDBDatabase) => Promise<void>,
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, version);
    request.onupgradeneeded = () => ensureStores(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  try {
    await writer(db);
  } finally {
    db.close();
  }
}

export function createPersonalBackupTableFixtures(
  rowCount: number,
): Record<string, unknown[]> {
  const ids = Array.from({ length: rowCount }, (_, index) => index.toString().padStart(4, '0'));
  const createdAt = '2026-06-09T00:00:00.000Z';
  const updatedAt = '2026-06-09T00:00:01.000Z';

  return {
    user_preferences: ids.map((id) => ({
      id: `pref-${id}`,
      user_id: 'user-1',
      created_at: createdAt,
      updated_at: updatedAt,
    })),
    focus_sessions: ids.map((id, index) => ({
      id: `focus-${id}`,
      user_id: 'user-1',
      started_at: createdAt,
      ended_at: null,
      session_state: { index },
      updated_at: updatedAt,
    })),
    transcription_usage: ids.map((id) => ({
      id: `usage-${id}`,
      user_id: 'user-1',
      date: '2026-06-09',
      audio_seconds: 42,
      created_at: createdAt,
    })),
    routine_tasks: ids.map((id) => ({
      id: `routine-${id}`,
      user_id: 'user-1',
      title: `Routine ${id}`,
      max_times_per_day: 2,
      is_enabled: true,
      created_at: createdAt,
      updated_at: updatedAt,
    })),
    routine_completions: ids.map((id) => ({
      id: `completion-${id}`,
      routine_id: `routine-${id}`,
      user_id: 'user-1',
      date_key: '2026-06-09',
      count: 1,
      updated_at: updatedAt,
    })),
  };
}

export function createBackupTableClient(
  tableData: Record<string, unknown[]>,
  options: {
    error?: unknown;
    rpcData?: unknown;
    rpcError?: unknown;
  } = {},
) {
  const ranges: Record<string, Array<[number, number]>> = {};
  const keysetCursors: Record<string, Array<string | null>> = {};
  const limits: Record<string, number[]> = {};
  const from = vi.fn((table: string) => {
    let idCursor: string | null = null;
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(() => query),
      gt: vi.fn((column: string, value: string) => {
        if (column === 'id') idCursor = value;
        return query;
      }),
      limit: vi.fn(async (count: number) => {
        keysetCursors[table] ??= [];
        keysetCursors[table].push(idCursor);
        limits[table] ??= [];
        limits[table].push(count);
        if (options.error) {
          return { data: null, error: options.error };
        }
        const rows = [...(tableData[table] ?? [])]
          .filter((row) => {
            if (!idCursor || !row || typeof row !== 'object') return true;
            const id = 'id' in row ? row.id : null;
            return typeof id === 'string' && id > idCursor;
          })
          .sort((left, right) => {
            const leftId = left && typeof left === 'object' && 'id' in left ? String(left.id) : '';
            const rightId = right && typeof right === 'object' && 'id' in right ? String(right.id) : '';
            return leftId.localeCompare(rightId);
          });
        return { data: rows.slice(0, count), error: null };
      }),
      range: vi.fn(async (from: number, to: number) => {
        ranges[table] ??= [];
        ranges[table].push([from, to]);
        if (options.error) {
          return { data: null, error: options.error };
        }
        return { data: (tableData[table] ?? []).slice(from, to + 1), error: null };
      }),
    };
    return query;
  });
  const rpc = vi.fn(async () => {
    if (options.rpcError !== undefined) {
      return { data: null, error: options.rpcError };
    }
    if (Object.prototype.hasOwnProperty.call(options, 'rpcData')) {
      return { data: options.rpcData, error: null };
    }
    return {
      data: null,
      error: {
        code: 'PGRST202',
        message: 'Could not find the function public.get_personal_backup_snapshot',
      },
    };
  });
  return {
    client: { from, rpc },
    from,
    rpc,
    ranges,
    keysetCursors,
    limits,
  };
}
