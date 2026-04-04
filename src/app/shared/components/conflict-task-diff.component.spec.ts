import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { ConflictTaskDiffComponent } from './conflict-task-diff.component';
import type { Task } from '../../../models';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'Task',
    content: overrides.content ?? '',
    stage: overrides.stage ?? 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? '2026-03-30T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-03-30T00:00:00.000Z',
    displayId: overrides.displayId ?? 'A',
    hasIncompleteTask: overrides.hasIncompleteTask ?? false,
    ...overrides,
  };
}

describe('ConflictTaskDiffComponent', () => {
  it('应把布局和停泊差异标记为 modified，避免系统建议与列表显示脱节', () => {
    const injector = Injector.create({ providers: [] });
    const component = runInInjectionContext(injector, () => new ConflictTaskDiffComponent());
    const localTask = createTask({
      id: 'task-1',
      x: 10,
      y: 20,
      stage: 1,
      order: 1,
      parentId: 'parent-local',
      rank: 1000,
      wait_minutes: 5,
      attachments: [{ id: 'att-local', name: 'local.txt' }] as Task['attachments'],
      parkingMeta: { state: 'parked', pinned: false },
    });
    const remoteTask = createTask({
      id: 'task-1',
      x: 40,
      y: 80,
      stage: 2,
      order: 5,
      parentId: 'parent-remote',
      rank: 2000,
      wait_minutes: 15,
      attachments: [{ id: 'att-remote', name: 'remote.txt' }] as Task['attachments'],
      parkingMeta: { state: 'parked', pinned: true },
    });

    Object.assign(component, {
      localTasks: () => [localTask],
      remoteTasks: () => [remoteTask],
      selectable: () => false,
      recommendations: () => [],
    });

    const diff = component.allDiffs()[0];
    expect(diff.status).toBe('modified');
    expect(diff.fieldDiffs.map(item => item.field)).toEqual(
      expect.arrayContaining(['x', 'y', 'stage', 'order', 'parentId', 'rank', 'wait_minutes', 'attachments', 'parkingMeta'])
    );
  });

  it('结构相同的 parkingMeta 不应被误判为差异', () => {
    const injector = Injector.create({ providers: [] });
    const component = runInInjectionContext(injector, () => new ConflictTaskDiffComponent());
    const localTask = createTask({
      id: 'task-1',
      parkingMeta: { state: 'parked', pinned: true, reminder: { reminderAt: '2026-04-04T12:00:00.000Z', snoozeCount: 0 } },
    });
    const remoteTask = createTask({
      id: 'task-1',
      parkingMeta: { state: 'parked', pinned: true, reminder: { reminderAt: '2026-04-04T12:00:00.000Z', snoozeCount: 0 } },
    });

    Object.assign(component, {
      localTasks: () => [localTask],
      remoteTasks: () => [remoteTask],
      selectable: () => false,
      recommendations: () => [],
    });

    const diff = component.allDiffs()[0];
    expect(diff.status).toBe('same');
    expect(diff.fieldDiffs).toHaveLength(0);
  });
});