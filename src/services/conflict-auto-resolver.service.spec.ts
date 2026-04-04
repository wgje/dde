import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { ConflictAutoResolverService } from './conflict-auto-resolver.service';
import { LoggerService } from './logger.service';
import type { Task } from '../models';

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

describe('ConflictAutoResolverService', () => {
  const loggerMock = {
    category: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  };

  function createService(): ConflictAutoResolverService {
    const injector = Injector.create({
      providers: [
        { provide: LoggerService, useValue: loggerMock },
      ],
    });

    return runInInjectionContext(injector, () => new ConflictAutoResolverService());
  }

  it('应跳过完全无差异的任务，不生成多余建议', () => {
    const service = createService();
    const sameTask = createTask({ id: 'task-1', title: 'Same', content: 'same content' });

    const report = service.analyze('proj-1', [sameTask], [{ ...sameTask }]);

    expect(report.recommendations).toHaveLength(0);
    expect(report.autoCount).toBe(0);
  });

  it('应把布局类差异纳入建议字段，供 UI 展示与覆写', () => {
    const service = createService();
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
      updatedAt: '2026-03-31T00:00:00.000Z',
    });

    const report = service.analyze('proj-1', [localTask], [remoteTask]);

    expect(report.recommendations).toHaveLength(1);
    expect(report.recommendations[0].conflictedFields).toEqual(
      expect.arrayContaining(['x', 'y', 'stage', 'order', 'parentId', 'rank', 'wait_minutes', 'attachments'])
    );
  });

  it('应将仅附件差异标记为建议确认，而不是自动覆盖', () => {
    const service = createService();
    const localTask = createTask({
      id: 'task-attachments',
      attachments: [{
        id: 'att-1',
        type: 'document',
        name: 'local.txt',
        url: '/local.txt',
        createdAt: '2026-03-30T00:00:00.000Z',
      }],
    });
    const remoteTask = createTask({
      id: 'task-attachments',
      updatedAt: '2026-03-30T00:05:00.000Z',
      attachments: [{
        id: 'att-2',
        type: 'document',
        name: 'remote.txt',
        url: '/remote.txt',
        createdAt: '2026-03-30T00:05:00.000Z',
      }],
    });

    const report = service.analyze('proj-1', [localTask], [remoteTask]);

    expect(report.recommendations).toHaveLength(1);
    expect(report.recommendations[0]).toEqual(expect.objectContaining({
      taskId: 'task-attachments',
      confidence: 'suggest',
      recommendation: 'remote',
    }));
    expect(report.recommendations[0].conflictedFields).toContain('attachments');
  });

  it('应将内容完全相同的附件数组视为无差异', () => {
    const service = createService();
    const attachments: NonNullable<Task['attachments']> = [{
      id: 'att-1',
      type: 'document',
      name: 'same.txt',
      url: '/same.txt',
      createdAt: '2026-03-30T00:00:00.000Z',
      size: 128,
    }];
    const localTask = createTask({ id: 'task-same-attachments', attachments });
    const remoteTask = createTask({
      id: 'task-same-attachments',
      attachments: attachments.map(attachment => ({ ...attachment })),
    });

    const report = service.analyze('proj-1', [localTask], [remoteTask]);

    expect(report.recommendations).toHaveLength(0);
    expect(report.autoCount).toBe(0);
  });

  it('应将仅标签差异纳入自动建议，避免 UI 与计划脱节', () => {
    const service = createService();
    const localTask = createTask({
      id: 'task-tags',
      tags: ['本地', '重要'],
    });
    const remoteTask = createTask({
      id: 'task-tags',
      updatedAt: '2026-03-30T00:05:00.000Z',
      tags: ['云端', '重要'],
    });

    const report = service.analyze('proj-1', [localTask], [remoteTask]);

    expect(report.recommendations).toHaveLength(1);
    expect(report.recommendations[0].conflictedFields).toContain('tags');
  });

  it('应将可选数组字段的 undefined 与空数组视为等价', () => {
    const service = createService();
    const localTask = createTask({
      id: 'task-empty-arrays',
      tags: undefined,
      attachments: undefined,
    });
    const remoteTask = createTask({
      id: 'task-empty-arrays',
      tags: [],
      attachments: [],
    });

    const report = service.analyze('proj-1', [localTask], [remoteTask]);

    expect(report.recommendations).toHaveLength(0);
  });
});