/**
 * Vitest 全局 mocks（无 Angular 初始化）
 *
 * 目的：让不同的 Vitest 配置可以选择不同的 Angular TestBed 初始化方式，
 * 但共享同一套 Supabase/Sentry/浏览器 API mocks。
 */
import { vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';

// ============================================
// 🔒 全局模块 Mock（在任何导入之前）
// ============================================

// ============================================
// Supabase Mock - 完整版（支持链式调用 + Storage + Realtime）
// @see docs/test-architecture-modernization-plan.md Section 2.3.2
// ============================================

/**
 * 创建可链式调用的查询 Mock
 * 支持任意深度的链式调用
 */
const createChainableQuery = (defaultResponse = { data: null, error: null }) => {
  const mock: Record<string, unknown> = {};
  
  // 链式方法（返回 this）
  const chainMethods = [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'like', 'ilike', 'is', 'in', 'contains', 'containedBy',
    'order', 'limit', 'range', 'filter', 'not', 'or', 'and',
    'textSearch', 'match', 'overlaps', 'rangeGt', 'rangeLt',
  ];
  
  chainMethods.forEach(method => {
    mock[method] = vi.fn().mockReturnValue(mock);
  });
  
  // 终结方法（返回 Promise）
  mock.single = vi.fn().mockResolvedValue(defaultResponse);
  mock.maybeSingle = vi.fn().mockResolvedValue(defaultResponse);
  mock.throwOnError = vi.fn().mockReturnValue(mock);
  
  // 支持 await query 直接返回结果
  mock.then = (resolve: (value: unknown) => void) => 
    Promise.resolve(defaultResponse).then(resolve);
  
  return mock;
};

// 默认查询 mock（向后兼容）
const mockSupabaseQuery = createChainableQuery();

// Realtime Channel Mock（增强版）
const mockSupabaseChannel = {
  on: vi.fn().mockReturnThis(),
  subscribe: vi.fn((callback?: (status: string) => void) => {
    if (callback) callback('SUBSCRIBED');
    return mockSupabaseChannel;
  }),
  unsubscribe: vi.fn().mockResolvedValue('ok'),
  send: vi.fn().mockResolvedValue('ok'),
  track: vi.fn().mockResolvedValue('ok'),
  untrack: vi.fn().mockResolvedValue('ok'),
  // 模拟事件触发（用于测试）
  _trigger: (event: string, payload?: unknown) => {
    // 可在测试中使用
    return { event, payload };
  },
};

// Storage Bucket Mock
const createStorageBucketMock = (_bucketName: string) => ({
  upload: vi.fn().mockResolvedValue({ 
    data: { path: 'mock-path', id: 'mock-id', fullPath: 'mock-bucket/mock-path' }, 
    error: null 
  }),
  download: vi.fn().mockResolvedValue({ 
    data: new Blob(['mock content'], { type: 'text/plain' }), 
    error: null 
  }),
  remove: vi.fn().mockResolvedValue({ data: [{ name: 'mock-file' }], error: null }),
  list: vi.fn().mockResolvedValue({ data: [], error: null }),
  move: vi.fn().mockResolvedValue({ data: { message: 'moved' }, error: null }),
  copy: vi.fn().mockResolvedValue({ data: { path: 'new-path' }, error: null }),
  getPublicUrl: vi.fn().mockReturnValue({ 
    data: { publicUrl: 'https://mock-storage.supabase.co/mock-path' } 
  }),
  createSignedUrl: vi.fn().mockResolvedValue({ 
    data: { signedUrl: 'https://mock-storage.supabase.co/mock-signed-url' }, 
    error: null 
  }),
  createSignedUrls: vi.fn().mockResolvedValue({ data: [], error: null }),
  createSignedUploadUrl: vi.fn().mockResolvedValue({ 
    data: { signedUrl: 'https://mock-storage.supabase.co/mock-upload-url', path: 'mock-path', token: 'mock-token' }, 
    error: null 
  }),
  uploadToSignedUrl: vi.fn().mockResolvedValue({ data: { path: 'mock-path' }, error: null }),
});

// Storage Mock
const mockSupabaseStorage = {
  from: vi.fn((bucket: string) => createStorageBucketMock(bucket)),
  listBuckets: vi.fn().mockResolvedValue({ data: [], error: null }),
  getBucket: vi.fn().mockResolvedValue({ data: { id: 'mock-bucket', name: 'mock-bucket' }, error: null }),
  createBucket: vi.fn().mockResolvedValue({ data: { name: 'new-bucket' }, error: null }),
  updateBucket: vi.fn().mockResolvedValue({ data: { message: 'updated' }, error: null }),
  deleteBucket: vi.fn().mockResolvedValue({ data: { message: 'deleted' }, error: null }),
  emptyBucket: vi.fn().mockResolvedValue({ data: { message: 'emptied' }, error: null }),
};

// Auth Mock（增强版）
const mockSupabaseAuth = {
  getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
  getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
  onAuthStateChange: vi.fn(() => ({
    data: {
      subscription: { unsubscribe: vi.fn() },
    },
  })),
  signInWithPassword: vi.fn().mockResolvedValue({ data: { session: null, user: null }, error: null }),
  signUp: vi.fn().mockResolvedValue({ data: { session: null, user: null }, error: null }),
  signOut: vi.fn().mockResolvedValue({ error: null }),
  signInWithOAuth: vi.fn().mockResolvedValue({ data: { provider: 'google', url: 'mock-url' }, error: null }),
  signInWithOtp: vi.fn().mockResolvedValue({ data: { messageId: 'mock-id' }, error: null }),
  verifyOtp: vi.fn().mockResolvedValue({ data: { session: null, user: null }, error: null }),
  refreshSession: vi.fn().mockResolvedValue({ data: { session: null, user: null }, error: null }),
  updateUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
  resetPasswordForEmail: vi.fn().mockResolvedValue({ data: {}, error: null }),
  setSession: vi.fn().mockResolvedValue({ data: { session: null, user: null }, error: null }),
  exchangeCodeForSession: vi.fn().mockResolvedValue({ data: { session: null, user: null }, error: null }),
};

// 完整的 Supabase Client Mock
const mockSupabaseClient = {
  from: vi.fn(() => mockSupabaseQuery),
  rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  channel: vi.fn(() => mockSupabaseChannel),
  removeChannel: vi.fn().mockResolvedValue('ok'),
  removeAllChannels: vi.fn().mockResolvedValue([]),
  getChannels: vi.fn().mockReturnValue([]),
  auth: mockSupabaseAuth,
  storage: mockSupabaseStorage,
  // Realtime 相关
  realtime: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    setAuth: vi.fn(),
  },
  // Functions（Edge Functions）
  functions: {
    invoke: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
};

// 导出辅助函数：设置特定查询的返回值
export function mockSupabaseQueryResult(
  table: string, 
  response: { data: unknown; error: unknown }
) {
  const chainable = createChainableQuery(response as { data: null; error: null });
  mockSupabaseClient.from.mockImplementation((t: string) => 
    t === table ? chainable : createChainableQuery()
  );
  return chainable;
}

// 导出 mock 实例（供测试中直接访问）
export { mockSupabaseClient, mockSupabaseQuery, mockSupabaseChannel, mockSupabaseStorage, mockSupabaseAuth };

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
// IndexedDB Mock（轻量级 fallback）
// ============================================

const indexedDBStores: Record<string, Record<string, unknown>> = {};
const isIndexedDbFallback = typeof indexedDB === 'undefined';

if (isIndexedDbFallback) {
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
}

// ============================================
// DestroyRef Mock 工厂
// @see docs/test-architecture-modernization-plan.md Section 2.2.3
// ============================================

/**
 * 创建 DestroyRef Mock 工厂函数
 * 用于测试使用 inject(DestroyRef) 的服务
 * 
 * @example
 * const { destroyRef, destroy } = createMockDestroyRef();
 * const injector = Injector.create({
 *   providers: [{ provide: DestroyRef, useValue: destroyRef }]
 * });
 * // 触发销毁回调
 * destroy();
 */
export function createMockDestroyRef() {
  const callbacks: Array<() => void> = [];
  
  const destroyRef = {
    onDestroy: vi.fn((callback: () => void) => {
      callbacks.push(callback);
      // 返回取消注册函数
      return () => {
        const index = callbacks.indexOf(callback);
        if (index > -1) callbacks.splice(index, 1);
      };
    }),
  };
  
  const destroy = () => {
    callbacks.forEach(cb => cb());
    callbacks.length = 0;
  };
  
  return { destroyRef, destroy };
}

// 简单版本（向后兼容）
export const mockDestroyRef = {
  onDestroy: vi.fn((callback: () => void) => {
    // 立即注册但不执行，测试可以手动触发
    return () => {};
  }),
};

// ============================================
// 清理函数
// ============================================

export function resetMocks() {
  localStorageMock.clear();
  if (isIndexedDbFallback) {
    Object.keys(indexedDBStores).forEach(k => delete indexedDBStores[k]);
  } else if (typeof indexedDB !== 'undefined') {
    const dbFactory = indexedDB as IDBFactory & {
      databases?: () => Promise<Array<{ name?: string | null }>>;
    };

    if (typeof dbFactory.databases === 'function') {
      dbFactory.databases()
        .then(dbs => dbs.forEach(db => {
          if (db?.name) indexedDB.deleteDatabase(db.name);
        }))
        .catch(() => undefined);
    }
  }

  // 只清理 setup 内部的全局 mock（Sentry/Supabase），避免全局 clearAllMocks 的性能开销。
  sentryMock.captureException.mockClear();
  sentryMock.captureMessage.mockClear();
  sentryMock.addBreadcrumb.mockClear();
  sentryMock.init.mockClear();

  // Supabase Client
  mockSupabaseClient.from.mockClear();
  mockSupabaseClient.rpc.mockClear();
  mockSupabaseClient.channel.mockClear();
  mockSupabaseClient.removeChannel.mockClear();
  mockSupabaseClient.removeAllChannels.mockClear();
  
  // Supabase Auth
  mockSupabaseAuth.getSession.mockClear();
  mockSupabaseAuth.getUser.mockClear();
  mockSupabaseAuth.onAuthStateChange.mockClear();
  mockSupabaseAuth.signInWithPassword.mockClear();
  mockSupabaseAuth.signUp.mockClear();
  mockSupabaseAuth.signOut.mockClear();
  mockSupabaseAuth.refreshSession.mockClear();
  
  // Supabase Storage
  mockSupabaseStorage.from.mockClear();
  
  // Supabase Realtime Channel
  mockSupabaseChannel.on.mockClear();
  mockSupabaseChannel.subscribe.mockClear();
  mockSupabaseChannel.unsubscribe.mockClear();
}

beforeEach(() => {
  resetMocks();
});

// ============================================
// 全局污染检测（事件监听/定时器）
// ============================================

type ListenerRegistry = Map<string, Set<EventListenerOrEventListenerObject>>;

const POLLUTION_GUARD_ENABLED = process.env.VITEST_POLLUTION_GUARD !== '0';
const POLLUTION_GUARD_STRICT = process.env.VITEST_POLLUTION_STRICT === '1';

type PollutionGuardConfig = {
  disabled: boolean;
  ignoreEventTypes: Set<string>;
  ignoreTargets: Set<EventTarget>;
};

const pollutionGuardConfig: PollutionGuardConfig = {
  disabled: false,
  ignoreEventTypes: new Set<string>(),
  ignoreTargets: new Set<EventTarget>(),
};

export const disablePollutionGuard = () => {
  pollutionGuardConfig.disabled = true;
};

export const enablePollutionGuard = () => {
  pollutionGuardConfig.disabled = false;
};

export const ignorePollutionEventTypes = (types: string[]) => {
  types.forEach(type => pollutionGuardConfig.ignoreEventTypes.add(type));
};

export const ignorePollutionTarget = (target: EventTarget) => {
  pollutionGuardConfig.ignoreTargets.add(target);
};

const listenerRegistry = new Map<EventTarget, ListenerRegistry>();
const eventPatches = new Map<EventTarget, { add: EventTarget['addEventListener']; remove: EventTarget['removeEventListener'] }>();

const patchEventTarget = (target: EventTarget | null | undefined) => {
  if (!target || eventPatches.has(target)) return;
  if (!('addEventListener' in (target as object)) || !('removeEventListener' in (target as object))) return;
  const originalAdd = target.addEventListener.bind(target);
  const originalRemove = target.removeEventListener.bind(target);

  eventPatches.set(target, { add: originalAdd, remove: originalRemove });

  target.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
    if (listener && POLLUTION_GUARD_ENABLED && !pollutionGuardConfig.disabled) {
      if (pollutionGuardConfig.ignoreEventTypes.has(type) || pollutionGuardConfig.ignoreTargets.has(target)) {
        return originalAdd(type, listener as EventListenerOrEventListenerObject, options as AddEventListenerOptions);
      }
      const registry = listenerRegistry.get(target) ?? new Map();
      const listeners = registry.get(type) ?? new Set();
      listeners.add(listener);
      registry.set(type, listeners);
      listenerRegistry.set(target, registry);
    }
    return originalAdd(type, listener as EventListenerOrEventListenerObject, options as AddEventListenerOptions);
  }) as EventTarget['addEventListener'];

  target.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
    if (listener && POLLUTION_GUARD_ENABLED && !pollutionGuardConfig.disabled) {
      if (pollutionGuardConfig.ignoreEventTypes.has(type) || pollutionGuardConfig.ignoreTargets.has(target)) {
        return originalRemove(type, listener as EventListenerOrEventListenerObject, options as EventListenerOptions);
      }
      const registry = listenerRegistry.get(target);
      const listeners = registry?.get(type);
      listeners?.delete(listener);
      if (listeners && listeners.size === 0) registry?.delete(type);
    }
    return originalRemove(type, listener as EventListenerOrEventListenerObject, options as EventListenerOptions);
  }) as EventTarget['removeEventListener'];
};

if (typeof window !== 'undefined') {
  patchEventTarget(window);
}
if (typeof document !== 'undefined') {
  patchEventTarget(document);
}
patchEventTarget(globalThis as unknown as EventTarget);

const cleanupEventListeners = () => {
  if (!POLLUTION_GUARD_ENABLED || pollutionGuardConfig.disabled) return;
  for (const [target, registry] of listenerRegistry.entries()) {
    const patch = eventPatches.get(target);
    if (!patch) continue;
    for (const [type, listeners] of registry.entries()) {
      listeners.forEach(listener => {
        try {
          patch.remove(type, listener);
        } catch {
          // noop
        }
      });
    }
  }
  listenerRegistry.clear();
};

const checkLeakWarning = (message: string) => {
  if (!POLLUTION_GUARD_ENABLED || pollutionGuardConfig.disabled) return;
  if (POLLUTION_GUARD_STRICT) {
    throw new Error(message);
  }
  console.warn(message);
};

afterEach(() => {
  if (!POLLUTION_GUARD_ENABLED || pollutionGuardConfig.disabled) return;

  const leakedListeners = Array.from(listenerRegistry.values())
    .reduce((count, registry) => {
      for (const listeners of registry.values()) count += listeners.size;
      return count;
    }, 0);

  if (leakedListeners > 0) {
    checkLeakWarning(`[PollutionGuard] 检测到 ${leakedListeners} 个未清理的事件监听器`);
  }

  if (typeof vi.isFakeTimers === 'function' && vi.isFakeTimers()) {
    const pendingTimers = typeof vi.getTimerCount === 'function' ? vi.getTimerCount() : 0;
    if (pendingTimers > 0) {
      checkLeakWarning(`[PollutionGuard] 检测到 ${pendingTimers} 个未清理的定时器`);
    }
  }

  cleanupEventListeners();
});
