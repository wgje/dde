import { describe, expect, it, vi } from 'vitest';
import { hasTaskContentMissingFromSource } from '../../../../utils/task-content-guard';
import {
  mapTaskRowToTask,
  type TaskRowLike,
  type TaskRowMappingReporter,
} from './task-row.mapper';

function createCompleteTaskRow(overrides: Partial<TaskRowLike> = {}): TaskRowLike {
  return {
    id: 'task-1',
    title: 'Task',
    content: '',
    stage: null,
    parent_id: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('mapTaskRowToTask', () => {
  const reporter: TaskRowMappingReporter = {
    warnContentMissing: vi.fn(),
    captureContentMissing: vi.fn(),
  };

  it('maps persisted task fields without dropping content or planning metadata', () => {
    const task = mapTaskRowToTask(createCompleteTaskRow({
      title: 'Title',
      content: 'Body',
      stage: 2,
      parent_id: 'parent-1',
      order: 3,
      rank: 9,
      status: 'completed',
      x: 11,
      y: 22,
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-02T00:00:00.000Z',
      completed_at: '2026-06-03T00:00:00.000Z',
      short_id: 'NF-1',
      deleted_at: null,
      attachments: [{
        id: 'att-1',
        type: 'file',
        name: 'note.txt',
        url: 'https://example.test/note.txt',
        createdAt: '2026-06-01T00:00:00.000Z',
      }],
      tags: ['deep-work'],
      priority: 'high',
      due_date: '2026-06-04',
      expected_minutes: 45,
      cognitive_load: 'high',
      wait_minutes: 5,
      parking_meta: { state: 'parked' },
      attention_meta: {
        items: [{
          id: 'attention-1',
          text: 'Check dependency',
          level: 'warning',
          done: false,
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        }],
      },
    }), reporter);

    expect(task).toMatchObject({
      id: 'task-1',
      title: 'Title',
      content: 'Body',
      stage: 2,
      parentId: 'parent-1',
      order: 3,
      rank: 9,
      status: 'completed',
      x: 11,
      y: 22,
      createdDate: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
      completedAt: '2026-06-03T00:00:00.000Z',
      shortId: 'NF-1',
      expected_minutes: 45,
      cognitive_load: 'high',
      wait_minutes: 5,
    });
    expect(task.attachments).toHaveLength(1);
    expect(task.tags).toEqual(['deep-work']);
    expect(task.parkingMeta).toEqual({ state: 'parked' });
    expect(task.attentionMeta?.items).toHaveLength(1);
  });

  it('preserves explicit null metadata while keeping omitted legacy columns undefined', () => {
    const explicitNullTask = mapTaskRowToTask(createCompleteTaskRow({
      id: 'task-null-meta',
      parking_meta: null,
      attention_meta: null,
    }), reporter);
    const omittedLegacyTask = mapTaskRowToTask(createCompleteTaskRow({
      id: 'task-legacy-meta',
    }), reporter);

    expect(explicitNullTask.parkingMeta).toBeNull();
    expect(explicitNullTask.attentionMeta).toBeNull();
    expect(omittedLegacyTask.parkingMeta).toBeUndefined();
    expect(omittedLegacyTask.attentionMeta).toBeUndefined();
  });

  it('marks task content as source-missing when the row omits content', () => {
    const localReporter: TaskRowMappingReporter = {
      warnContentMissing: vi.fn(),
      captureContentMissing: vi.fn(),
    };

    const row = createCompleteTaskRow({
      id: 'task-missing-content',
      title: 'Title',
      updated_at: '2026-06-02T00:00:00.000Z',
    });
    delete row.content;

    const task = mapTaskRowToTask(row, localReporter);

    expect(task.content).toBe('');
    expect(hasTaskContentMissingFromSource(task)).toBe(true);
    expect(localReporter.warnContentMissing).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-missing-content' }),
    );
    expect(localReporter.captureContentMissing).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-missing-content' }),
    );
  });

  it('recovers when content is explicitly undefined on the row', () => {
    const localReporter: TaskRowMappingReporter = {
      warnContentMissing: vi.fn(),
      captureContentMissing: vi.fn(),
    };
    const row = createCompleteTaskRow({ id: 'task-undefined-content' });
    Object.defineProperty(row, 'content', {
      configurable: true,
      enumerable: true,
      value: undefined,
    });

    const task = mapTaskRowToTask(row, localReporter);

    expect(task.content).toBe('');
    expect(hasTaskContentMissingFromSource(task)).toBe(true);
    expect(localReporter.warnContentMissing).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-undefined-content' }),
    );
    expect(localReporter.captureContentMissing).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-undefined-content',
        rowKeys: expect.arrayContaining(['content']),
      }),
    );
  });

  it.each([
    ['null', null],
    ['non-string', 42],
  ])('rejects %s content and reports the incomplete source row', (label, content) => {
    const localReporter: TaskRowMappingReporter = {
      warnContentMissing: vi.fn(),
      captureContentMissing: vi.fn(),
    };
    const row = createCompleteTaskRow({ id: `task-${label}-content` });
    row.content = content as unknown as string;

    expect(() => mapTaskRowToTask(row, localReporter)).toThrowError(
      /missing required fields.*content/i,
    );
    expect(localReporter.warnContentMissing).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: row.id }),
    );
    expect(localReporter.captureContentMissing).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: row.id }),
    );
  });

  it('preserves an empty string as valid task content', () => {
    const localReporter: TaskRowMappingReporter = {
      warnContentMissing: vi.fn(),
      captureContentMissing: vi.fn(),
    };

    const task = mapTaskRowToTask(createCompleteTaskRow({ content: '' }), localReporter);

    expect(task.content).toBe('');
    expect(hasTaskContentMissingFromSource(task)).toBe(false);
    expect(localReporter.warnContentMissing).not.toHaveBeenCalled();
    expect(localReporter.captureContentMissing).not.toHaveBeenCalled();
  });

  it('preserves numeric zero values instead of replacing them with defaults', () => {
    const task = mapTaskRowToTask(createCompleteTaskRow({
      id: 'task-zero',
      order: 0,
      rank: 0,
      x: 0,
      y: 0,
      updated_at: '2026-06-02T00:00:00.000Z',
    }), reporter);

    expect(task.order).toBe(0);
    expect(task.rank).toBe(0);
    expect(task.x).toBe(0);
    expect(task.y).toBe(0);
  });

  it.each([
    'stage',
    'parent_id',
    'order',
    'rank',
    'status',
    'updated_at',
  ] as const)('rejects a task row that omits required field %s', (field) => {
    const row = createCompleteTaskRow({ id: `task-missing-${field}` });
    delete row[field];

    expect(() => mapTaskRowToTask(row, reporter)).toThrowError(
      new RegExp(`missing required fields.*${field}`, 'i'),
    );
  });

  it('accepts explicit null for nullable structural fields', () => {
    const task = mapTaskRowToTask(createCompleteTaskRow({
      stage: null,
      parent_id: null,
    }), reporter);

    expect(task.stage).toBeNull();
    expect(task.parentId).toBeNull();
    expect(hasTaskContentMissingFromSource(task)).toBe(false);
  });
});
