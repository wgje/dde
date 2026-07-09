import type { Attachment, Connection, Task } from '../models';

export function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-01-01T00:00:00.000Z',
    displayId: '1',
    ...overrides,
  };
}

export function createConnection(
  overrides: Partial<Connection> & { source: string; target: string },
): Connection {
  return {
    id: 'conn-1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function createAttachment(overrides: Partial<Attachment> = {}): Partial<Attachment> {
  return {
    id: 'att-1',
    type: 'image',
    name: 'photo.png',
    url: 'https://example.com/a.png',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
