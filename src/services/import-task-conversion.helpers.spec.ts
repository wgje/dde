import { describe, expect, it } from 'vitest';
import type { ExportTask } from './export.service';
import { convertExportTaskToTask } from './import-task-conversion.helpers';

describe('convertExportTaskToTask', () => {
  const now = '2026-06-09T00:00:00.000Z';

  function createExportTask(overrides: Partial<ExportTask> = {}): ExportTask {
    return {
      id: 'task-1',
      title: 'Imported task',
      content: '',
      stage: 0,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 0,
      y: 0,
      displayId: '1',
      createdAt: '2026-06-08T00:00:00.000Z',
      ...overrides,
    };
  }

  it('maps task and parent ids while preserving completed timestamp fallback', () => {
    const idMap = new Map([
      ['task-1', 'new-task-1'],
      ['parent-1', 'new-parent-1'],
    ]);
    const task = convertExportTaskToTask(
      createExportTask({
        parentId: 'parent-1',
        status: 'completed',
        updatedAt: '2026-06-08T01:00:00.000Z',
      }),
      { idMap, now }
    );

    expect(task).toEqual(expect.objectContaining({
      id: 'new-task-1',
      parentId: 'new-parent-1',
      completedAt: '2026-06-08T01:00:00.000Z',
      updatedAt: now,
    }));
  });

  it('normalizes planning fields, parking metadata, and attachment metadata', () => {
    const futureReminder = {
      reminderAt: '2026-06-10T00:00:00.000Z',
      snoozeCount: 0,
      maxSnoozeCount: 3,
    };
    const expiredReminder = {
      reminderAt: '2026-06-08T00:00:00.000Z',
      snoozeCount: 0,
      maxSnoozeCount: 3,
    };

    const taskWithFutureReminder = convertExportTaskToTask(
      createExportTask({
        expected_minutes: 30,
        cognitive_load: 'high',
        wait_minutes: 5,
        parkingMeta: {
          state: 'parked',
          parkedAt: '2026-06-08T02:00:00.000Z',
          lastVisitedAt: '2026-06-08T03:00:00.000Z',
          contextSnapshot: {
            savedAt: '2026-06-08T03:00:00.000Z',
            contentHash: 'hash',
            viewMode: 'text',
            cursorPosition: null,
            scrollAnchor: null,
            structuralAnchor: null,
            flowViewport: null,
          },
          reminder: futureReminder,
          pinned: false,
        },
        attachments: [{
          id: 'attachment-1',
          name: 'doc.pdf',
          size: 10,
          mimeType: 'application/pdf',
          url: 'https://example.com/doc.pdf',
          createdAt: '2026-06-08T04:00:00.000Z',
        }],
      }),
      { now }
    );

    expect(taskWithFutureReminder).toEqual(expect.objectContaining({
      expected_minutes: 30,
      cognitive_load: 'high',
      wait_minutes: 5,
      parkingMeta: expect.objectContaining({
        lastVisitedAt: now,
        contextSnapshot: null,
        reminder: futureReminder,
      }),
      attachments: [{
        id: 'attachment-1',
        name: 'doc.pdf',
        size: 10,
        mimeType: 'application/pdf',
        type: 'document',
        url: '',
        thumbnailUrl: undefined,
        createdAt: '2026-06-08T04:00:00.000Z',
      }],
    }));

    const taskWithExpiredReminder = convertExportTaskToTask(
      createExportTask({
        expected_minutes: 'invalid' as unknown as number,
        cognitive_load: 'medium' as unknown as 'high',
        wait_minutes: null,
        parkingMeta: {
          state: 'parked',
          parkedAt: '2026-06-08T02:00:00.000Z',
          lastVisitedAt: null,
          contextSnapshot: null,
          reminder: expiredReminder,
          pinned: false,
        },
      }),
      { now }
    );

    expect(taskWithExpiredReminder).toEqual(expect.objectContaining({
      expected_minutes: null,
      cognitive_load: null,
      wait_minutes: null,
      parkingMeta: expect.objectContaining({
        lastVisitedAt: now,
        reminder: null,
      }),
    }));
  });

  it('preserves exported task attention metadata on import', () => {
    const attentionMeta: ExportTask['attentionMeta'] = {
      items: [{
        id: 'attention-1',
        text: '需要确认验收口径',
        level: 'warning',
        done: false,
        createdAt: '2026-06-08T05:00:00.000Z',
        updatedAt: '2026-06-08T05:00:00.000Z',
      }],
      pinned: true,
      updatedAt: '2026-06-08T05:00:00.000Z',
    };

    const task = convertExportTaskToTask(createExportTask({ attentionMeta }), { now });

    expect(task.attentionMeta).toEqual(attentionMeta);
  });
});
