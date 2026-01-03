/**
 * Vitest 全局 mocks（无 Angular 初始化）
 *
 * 目的：让不同的 Vitest 配置可以选择不同的 Angular TestBed 初始化方式，
 * 但共享同一套 Supabase/Sentry/浏览器 API mocks。
 */
import { vi, beforeEach } from 'vitest';

// ============================================
// 🔒 全局模块 Mock（在任何导入之前）
// ============================================

// 全局 Supabase Mock - 避免任何真实网络/SDK 初始化开销（支持链式调用）
const mockSupabaseQuery = {
  select: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  upsert: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  delete: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  gt: vi.fn().mockReturnThis(),
  is: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  single: vi.fn().mockResolvedValue({ data: null, error: null }),
  then: undefined as unknown,
};

const mockSupabaseChannel = {
  on: vi.fn().mockReturnThis(),
  subscribe: vi.fn().mockReturnThis(),
  unsubscribe: vi.fn().mockReturnThis(),
};

const mockSupabaseClient = {
  from: vi.fn(() => mockSupabaseQuery),
  rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  channel: vi.fn(() => mockSupabaseChannel),
  removeChannel: vi.fn().mockResolvedValue(undefined),
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    onAuthStateChange: vi.fn(() => ({
      data: {
        subscription: { unsubscribe: vi.fn() },
      },
    })),
    signInWithPassword: vi.fn().mockResolvedValue({ data: { session: null, user: null }, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  },
};

vi.mock('@supabase/supabase-js', () => {
  return {
    createClient: vi.fn(() => mockSupabaseClient),
  };
});

// 全局 Sentry Mock - 避免 SDK 初始化和网络调用
const sentryMock = (() => {
  const mockScope = { setExtras: vi.fn(), setTag: vi.fn(), setLevel: vi.fn() };
  return {
    init: vi.fn(),
    captureException: vi.fn().mockReturnValue('mock-event-id'),
    captureMessage: vi.fn().mockReturnValue('mock-event-id'),
    addBreadcrumb: vi.fn(),
    withScope: vi.fn((callback: (scope: unknown) => void) => callback(mockScope)),
    setUser: vi.fn(),
    setTag: vi.fn(),
    setExtra: vi.fn(),
    setContext: vi.fn(),
    browserTracingIntegration: vi.fn(() => ({})),
    replayIntegration: vi.fn(() => ({})),
    ErrorBoundary: vi.fn(({ children }: { children: unknown }) => children),
    TraceService: class MockTraceService {},
  };
})();

vi.mock('@sentry/angular', () => {
  const mockScope = { setExtras: vi.fn(), setTag: vi.fn(), setLevel: vi.fn() };
  return {
    ...sentryMock,
    withScope: vi.fn((callback: (scope: unknown) => void) => callback(mockScope)),
  };
});

// ============================================
// 浏览器 API Mock（轻量级，单例）
// ============================================

// localStorage mock
const localStorageStore: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => localStorageStore[key] ?? null,
  setItem: (key: string, value: string) => {
    localStorageStore[key] = value;
  },
  removeItem: (key: string) => {
    delete localStorageStore[key];
  },
  clear: () => {
    Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
  },
  get length() {
    return Object.keys(localStorageStore).length;
  },
  key: (index: number) => Object.keys(localStorageStore)[index] || null,
};

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// navigator.onLine mock
Object.defineProperty(globalThis.navigator, 'onLine', {
  value: true,
  writable: true,
  configurable: true,
});

// crypto.randomUUID mock
if (!globalThis.crypto) {
  (globalThis as { crypto: object }).crypto = {};
}
if (!globalThis.crypto.randomUUID) {
  globalThis.crypto.randomUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    }) as `${string}-${string}-${string}-${string}-${string}`;
  };
}

// ============================================
// IndexedDB Mock（轻量级）
// ============================================

const indexedDBStores: Record<string, Record<string, unknown>> = {};

const createMockStore = (storeName: string) => ({
  put: vi.fn((record: { projectId: string }) => {
    const key = record.projectId;
    if (!indexedDBStores[storeName]) indexedDBStores[storeName] = {};
    indexedDBStores[storeName][key] = record;
    return { onsuccess: null, onerror: null };
  }),
  get: vi.fn((key: string) => {
    const result = indexedDBStores[storeName]?.[key] || null;
    return { onsuccess: null, onerror: null, result };
  }),
  getAll: vi.fn(() => {
    const result = Object.values(indexedDBStores[storeName] || {});
    return { onsuccess: null, onerror: null, result };
  }),
  delete: vi.fn((key: string) => {
    if (indexedDBStores[storeName]) delete indexedDBStores[storeName][key];
    return { onsuccess: null, onerror: null };
  }),
  count: vi.fn(() => {
    const result = Object.keys(indexedDBStores[storeName] || {}).length;
    return { onsuccess: null, onerror: null, result };
  }),
});

const indexedDBMock = {
  open: vi.fn(() => {
    const request = {
      result: {
        objectStoreNames: { contains: vi.fn(() => true) },
        transaction: vi.fn((_storeNames: string[]) => ({
          objectStore: vi.fn((name: string) => createMockStore(name)),
        })),
        close: vi.fn(),
      },
      error: null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onupgradeneeded: null as ((event: { target: { result: unknown } }) => void) | null,
    };

    if (typeof queueMicrotask === 'function') {
      queueMicrotask(() => request.onsuccess?.());
    } else {
      Promise.resolve().then(() => request.onsuccess?.());
    }
    return request;
  }),
};

Object.defineProperty(globalThis, 'indexedDB', {
  value: indexedDBMock,
  writable: true,
  configurable: true,
});

// ============================================
// 清理函数
// ============================================

export function resetMocks() {
  localStorageMock.clear();
  Object.keys(indexedDBStores).forEach(k => delete indexedDBStores[k]);

  // 只清理 setup 内部的全局 mock（Sentry/Supabase），避免全局 clearAllMocks 的性能开销。
  sentryMock.captureException.mockClear();
  sentryMock.captureMessage.mockClear();
  sentryMock.addBreadcrumb.mockClear();
  sentryMock.init.mockClear();

  mockSupabaseClient.from.mockClear();
  mockSupabaseClient.rpc.mockClear();
  mockSupabaseClient.channel.mockClear();
  mockSupabaseClient.removeChannel.mockClear();
  mockSupabaseClient.auth.getSession.mockClear();
  mockSupabaseClient.auth.onAuthStateChange.mockClear();
  mockSupabaseClient.auth.signInWithPassword.mockClear();
  mockSupabaseClient.auth.signOut.mockClear();
}

beforeEach(() => {
  resetMocks();
});
