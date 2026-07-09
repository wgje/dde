import { vi } from 'vitest';

import type { Task } from '../../../../models';

export function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: '购置零件',
    content: '',
    status: 'active',
    stage: 1,
    order: 0,
    parentId: null,
    rank: 0,
    x: 0,
    y: 0,
    createdDate: new Date('2026-04-04T08:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-04-04T08:00:00.000Z').toISOString(),
    displayId: '1,a',
    attachments: [],
    tags: [],
    parkingMeta: null,
    expected_minutes: null,
    wait_minutes: null,
    cognitive_load: null,
    ...overrides,
  };
}

export const createClickEvent = (
  timeStamp: number,
  target: EventTarget = document.body,
) => ({
  timeStamp,
  target,
  stopPropagation: vi.fn(),
  composedPath: () => [target, document.body, document, window],
} as unknown as MouseEvent);

export const createPathClickEvent = (
  target: EventTarget,
  path: EventTarget[],
  timeStamp = Date.now(),
) => ({
  timeStamp,
  target,
  stopPropagation: vi.fn(),
  composedPath: () => path,
} as unknown as MouseEvent);
