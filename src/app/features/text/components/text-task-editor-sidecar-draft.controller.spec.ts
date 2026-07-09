import { describe, expect, it } from 'vitest';

import type { Task, TaskAttentionDraftItem } from '../../../../models';
import { TextTaskEditorSidecarDraftController } from './text-task-editor-sidecar-draft.controller';

const baseAttentionRows: TaskAttentionDraftItem[] = [
  {
    id: 'attention-1',
    text: 'Token needs rotation',
    level: 'warning',
    done: false,
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
  },
];

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    content: 'Content',
    stage: 'todo',
    order: 0,
    createdDate: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
    expected_minutes: 25,
    wait_minutes: null,
    cognitive_load: 'high',
    attentionMeta: {
      items: baseAttentionRows,
      updatedAt: '2026-06-05T00:00:00.000Z',
    },
    ...overrides,
  } as Task;
}

describe('TextTaskEditorSidecarDraftController', () => {
  it('syncs planner and attention state from persisted drafts before task sidecar values', () => {
    const controller = new TextTaskEditorSidecarDraftController();

    controller.syncFromTask({
      task: createTask(),
      persistedDraft: {
        expectedMinutes: '45',
        waitMinutes: '10',
        cognitiveLoad: 'low',
        attentionRows: [
          { text: 'Persisted attention', level: 'info', done: false },
        ],
      },
      syncAttention: true,
    });

    expect(controller.localExpectedMinutes()).toBe('45');
    expect(controller.localWaitMinutes()).toBe('10');
    expect(controller.localCognitiveLoad()).toBe('low');
    expect(controller.plannerSaveState()).toBe('idle');
    expect(controller.localAttentionDraft()).toBe('Persisted attention');
    expect(controller.attentionDraftRows()).toEqual([
      { text: 'Persisted attention', level: 'info', done: false },
    ]);
    expect(controller.attentionSaveState()).toBe('idle');
    expect(controller.shouldSyncAttentionFromTask('task-1')).toBe(true);
  });

  it('keeps focused attention rows local until the editor blurs or the task changes', () => {
    const controller = new TextTaskEditorSidecarDraftController();

    controller.syncFromTask({
      task: createTask(),
      persistedDraft: null,
      syncAttention: true,
    });
    controller.markAttentionFocused();

    expect(controller.shouldSyncAttentionFromTask('task-1')).toBe(false);
    expect(controller.shouldSyncAttentionFromTask('task-2')).toBe(true);

    controller.markAttentionBlurred('task-1');

    expect(controller.shouldSyncAttentionFromTask('task-1')).toBe(true);
  });

  it('updates attention row drafts, expansion state, and text projection together', () => {
    const controller = new TextTaskEditorSidecarDraftController();
    const rows = [
      ...baseAttentionRows,
      { text: 'Check rollback', level: 'info' as const, done: false },
      { text: 'Notify owner', level: 'info' as const, done: false },
    ];

    controller.setAttentionRows(rows);
    controller.addAttentionRowLocal();
    controller.setAttentionRowText(3, 'Confirm deploy freeze');

    expect(controller.isAttentionRowsExpanded()).toBe(true);
    expect(controller.localAttentionDraft()).toBe(
      'Token needs rotation\nCheck rollback\nNotify owner\nConfirm deploy freeze',
    );
    expect(controller.attentionDraftRows().map(row => row.text)).toEqual([
      'Token needs rotation',
      'Check rollback',
      'Notify owner',
      'Confirm deploy freeze',
    ]);

    const trimmedRows = controller.trimEmptyAttentionRows();

    expect(trimmedRows).toBeNull();
    expect(controller.hiddenAttentionRowCount()).toBe(1);
  });

  it('only lets the latest attention save result update save state', () => {
    const controller = new TextTaskEditorSidecarDraftController();

    const first = controller.startAttentionSave();
    const second = controller.startAttentionSave();

    expect(controller.finishAttentionSave(second, true)).toBe(true);
    expect(controller.attentionSaveState()).toBe('idle');
    expect(controller.finishAttentionSave(first, false)).toBe(false);
    expect(controller.attentionSaveState()).toBe('idle');
  });
});
