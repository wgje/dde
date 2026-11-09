import type { Project, Task } from '../models';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

export function createTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 100,
    y: 100,
    createdDate: now,
    updatedAt: now,
    displayId: '1',
    deletedAt: null,
    ...overrides,
  };
}

export function createProject(tasks: Task[] = []): Project {
  const now = new Date().toISOString();
  return {
    id: 'project-1',
    name: 'Test Project',
    description: '',
    createdDate: now,
    updatedAt: now,
    tasks,
    connections: [],
  };
}

export function createDeferred<T = unknown>(): Deferred<T> {
  let resolve: ((value: T | PromiseLike<T>) => void) | null = null;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve: resolve! };
}
