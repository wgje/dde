import type { Connection, Project, Task } from '../../../models';
import type { RetryQueueItem } from './sync';
import { vi } from 'vitest';

// vitest 4.x: vi.fn() 类型为 Mock<Procedure | Constructable>，不可直接调用；
// 使用交集类型让 mock 对象既保留 Mock 方法又可直接调用。
export type MockFn<TArgs extends unknown[] = unknown[], TResult = unknown> =
  ReturnType<typeof vi.fn> & ((...args: TArgs) => TResult);

export const expectDeferredCallback = <TArgs extends unknown[], TResult = void>(
  callback: ((...args: TArgs) => TResult) | null | undefined,
  label: string,
): ((...args: TArgs) => TResult) => {
  if (!callback) {
    throw new Error(`${label} should be assigned before invocation`);
  }

  return callback;
};

export const createMockTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: 'Test Task',
  content: '',
  stage: 1,
  parentId: null,
  order: 0,
  rank: 0,
  status: 'active',
  x: 0,
  y: 0,
  createdDate: new Date().toISOString(),
  displayId: '1',
  updatedAt: new Date().toISOString(),
  ...overrides,
});

export const createMockProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Test Project',
  description: '',
  createdDate: new Date().toISOString(),
  tasks: [],
  connections: [],
  ...overrides,
});

export const createMockConnection = (overrides: Partial<Connection> = {}): Connection => ({
  id: 'conn-1',
  source: 'task-1',
  target: 'task-2',
  ...overrides,
});

export const readRetryQueueFromIdb = async (): Promise<unknown[]> => {
  if (typeof indexedDB === 'undefined') return [];

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open('nanoflow-retry-queue', 1);

      request.onerror = () => resolve([]);
      request.onupgradeneeded = () => {
        // 首次初始化时由服务创建 store，这里不处理。
      };
      request.onsuccess = () => {
        const db = request.result;
        try {
          const tx = db.transaction('offline_mutation_queue', 'readonly');
          const store = tx.objectStore('offline_mutation_queue');
          const getAllReq = store.getAll();

          getAllReq.onerror = () => resolve([]);
          getAllReq.onsuccess = () => resolve(getAllReq.result ?? []);
        } catch {
          resolve([]);
        }
      };
    } catch {
      resolve([]);
    }
  });
};

export const setVisibilityState = (state: DocumentVisibilityState): void => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
};

export type { RetryQueueItem };
