import { vi } from 'vitest';

import { AUTH_CONFIG } from '../config/auth.config';
import type { BlackBoxEntry } from '../models/focus';

export function createEntry(overrides: Partial<BlackBoxEntry> & Pick<BlackBoxEntry, 'id'>): BlackBoxEntry {
  return {
    projectId: null,
    userId: 'user-1',
    content: 'entry',
    date: '2026-03-04',
    createdAt: '2026-03-04T00:00:00.000Z',
    updatedAt: '2026-03-04T00:00:00.000Z',
    isRead: false,
    isCompleted: false,
    isArchived: false,
    deletedAt: null,
    ...overrides,
  };
}

export function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

export function createLegacyEntryWithUndefinedDeletedAt(entry: BlackBoxEntry): BlackBoxEntry {
  return { ...entry, deletedAt: undefined } as unknown as BlackBoxEntry;
}

export async function flushMicrotasks(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

export function createActiveSessionResult() {
  return {
    data: {
      session: {
        access_token: 'token',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    },
    error: null,
  };
}

function createLocalModeEntry(overrides: Partial<BlackBoxEntry> & Pick<BlackBoxEntry, 'id'>): BlackBoxEntry {
  return createEntry({
    userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
    ...overrides,
  });
}

// 创建带 user_id 作用域查询能力的模拟查询对象，用于验证黑匣子远端读取不会跨用户。
export function createScopedQuery<TQuery extends Record<string, unknown>>(
  query: TQuery,
): TQuery & { eq: ReturnType<typeof vi.fn> } {
  const scoped = { ...query } as TQuery & { eq: ReturnType<typeof vi.fn> };
  scoped.eq = vi.fn(() => scoped);
  return scoped;
}

// 创建支持链式 eq 与 maybeSingle 的预检查询对象，用于覆盖 push 前置对账路径。
export function createPreflightQuery(
  maybeSingle: ReturnType<typeof vi.fn>,
): { eq: ReturnType<typeof vi.fn>; maybeSingle: ReturnType<typeof vi.fn> } {
  const query = {
    eq: vi.fn(),
    maybeSingle,
  };
  query.eq.mockReturnValue(query);
  return query;
}

export function createSuccessfulIdbRequest<TResult>(
  result: TResult,
  beforeSuccess?: () => void,
): IDBRequest<TResult> {
  const request = {
    result,
    error: null,
    onsuccess: null as ((this: IDBRequest<TResult>, ev: Event) => unknown) | null,
    onerror: null as ((this: IDBRequest<TResult>, ev: Event) => unknown) | null,
  };
  queueMicrotask(() => {
    beforeSuccess?.();
    request.onsuccess?.call(
      request as unknown as IDBRequest<TResult>,
      new Event('success'),
    );
  });
  return request as unknown as IDBRequest<TResult>;
}

export function createIdbReadOnlyTransaction<TResult>(
  getAllResult: TResult[],
  options: {
    beforeGetAllSuccess?: () => void;
    onGetAll?: () => void;
  } = {},
): ReturnType<typeof vi.fn> {
  return vi.fn(() => ({
    objectStore: vi.fn(() => ({
      getAll: () => {
        options.onGetAll?.();
        return createSuccessfulIdbRequest(getAllResult, options.beforeGetAllSuccess);
      },
    })),
  }));
}

export function createIdbReadWriteTransaction<TResult>(
  options: {
    getAllResult: TResult[];
    getResult: (mode?: IDBTransactionMode) => TResult | null;
    put?: ReturnType<typeof vi.fn>;
  },
): {
  transaction: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
} {
  const put = options.put ?? vi.fn(() => createSuccessfulIdbRequest(undefined));
  const transaction = vi.fn((_storeName: string, mode?: IDBTransactionMode) => ({
    objectStore: vi.fn(() => ({
      getAll: () => createSuccessfulIdbRequest(options.getAllResult),
      get: () => createSuccessfulIdbRequest(options.getResult(mode)),
      put,
    })),
  }));
  return { transaction, put };
}
