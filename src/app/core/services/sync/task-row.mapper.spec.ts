import { describe, expect, it, vi } from 'vitest';
import { hasTaskContentMissingFromSource } from '../../../../utils/task-content-guard';
import { mapTaskRowToTask, type TaskRowMappingReporter } from './task-row.mapper';

describe('mapTaskRowToTask', () => {
  const reporter: TaskRowMappingReporter = {
    warnContentMissing: vi.fn(),
    captureContentMissing: vi.fn(),
  };

  it('maps persisted task fields without dropping content or planning metadata', () => {
    const task = mapTaskRowToTask({
      id: 'task-1',
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
    }, reporter);

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
    const explicitNullTask = mapTaskRowToTask({
      id: 'task-null-meta',
      content: '',
      parking_meta: null,
      attention_meta: null,
    }, reporter);
    const omittedLegacyTask = mapTaskRowToTask({
      id: 'task-legacy-meta',
      content: '',
    }, reporter);

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

    const task = mapTaskRowToTask({
      id: 'task-missing-content',
      title: 'Title',
      updated_at: '2026-06-02T00:00:00.000Z',
    }, localReporter);

    expect(task.content).toBe('');
    expect(hasTaskContentMissingFromSource(task)).toBe(true);
    expect(localReporter.warnContentMissing).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-missing-content' }),
    );
    expect(localReporter.captureContentMissing).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-missing-content' }),
    );
  });

  it('preserves numeric zero values instead of replacing them with defaults', () => {
    const task = mapTaskRowToTask({
      id: 'task-zero',
      content: '',
      order: 0,
      rank: 0,
      x: 0,
      y: 0,
      updated_at: '2026-06-02T00:00:00.000Z',
    }, reporter);

    expect(task.order).toBe(0);
    expect(task.rank).toBe(0);
    expect(task.x).toBe(0);
    expect(task.y).toBe(0);
  });
});
