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

export function createBackupTableClient(
  tableData: Record<string, unknown[]>,
  options: { error?: unknown } = {},
) {
  const ranges: Record<string, Array<[number, number]>> = {};
  const from = vi.fn((table: string) => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(() => query),
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
  return { client: { from }, ranges };
}
