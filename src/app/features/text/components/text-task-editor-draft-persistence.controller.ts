import type { Task, TaskAttentionDraftItem } from '../../../../models';
import { taskAttentionMetaToDraftItems } from '../../../../utils/task-sidecar';
import { buildTextTaskEditorPlannerDraftState } from './text-task-editor.helpers';
import {
  clearTextTaskEditorDraftField,
  readTextTaskEditorDraft,
  writeTextTaskEditorDraftField,
  type TextTaskEditorDraftRecord,
  type TextTaskEditorDraftScope,
  type TextTaskEditorPlannerDraftField,
  type TextTaskEditorStringDraftField,
} from './text-task-editor-draft-storage';

interface TextTaskEditorDraftPersistenceControllerOptions {
  getTask(): Task;
  getUserId(): string | null;
  resolveProjectId(): string | null;
  areAttentionRowsEqual(left: TaskAttentionDraftItem[], right: TaskAttentionDraftItem[]): boolean;
}

export class TextTaskEditorDraftPersistenceController {
  constructor(private readonly options: TextTaskEditorDraftPersistenceControllerOptions) {}

  readDraft(taskId: string): TextTaskEditorDraftRecord | null {
    return readTextTaskEditorDraft(this.buildScope(taskId));
  }

  persistTextDraftField(field: 'title' | 'content', taskId: string, value: string): void {
    const currentTask = this.options.getTask();
    const currentValue = field === 'title' ? currentTask.title ?? '' : currentTask.content ?? '';
    const scope = this.buildScope(taskId);
    if (value === currentValue) {
      clearTextTaskEditorDraftField(scope, field);
      return;
    }
    writeTextTaskEditorDraftField(scope, field, value);
  }

  persistPlannerDraftField(field: TextTaskEditorPlannerDraftField, taskId: string, value: string): void {
    const plannerDraft = buildTextTaskEditorPlannerDraftState(this.options.getTask());
    const currentValue = plannerDraft[field];
    const scope = this.buildScope(taskId);
    if (value === currentValue) {
      clearTextTaskEditorDraftField(scope, field);
      return;
    }
    writeTextTaskEditorDraftField(scope, field, value);
  }

  clearPersistedStringDraftFieldIfMatches(
    field: TextTaskEditorStringDraftField,
    taskId: string,
    value: string,
  ): void {
    const scope = this.buildScope(taskId);
    const draft = readTextTaskEditorDraft(scope);
    if (draft?.[field] === value) {
      clearTextTaskEditorDraftField(scope, field);
    }
  }

  persistAttentionDraftRowsField(taskId: string, rows: TaskAttentionDraftItem[]): void {
    const scope = this.buildScope(taskId);
    const currentRows = taskAttentionMetaToDraftItems(this.options.getTask().attentionMeta);
    if (this.options.areAttentionRowsEqual(rows, currentRows)) {
      clearTextTaskEditorDraftField(scope, 'attentionRows');
      return;
    }
    writeTextTaskEditorDraftField(scope, 'attentionRows', rows);
  }

  clearPersistedAttentionDraftRowsIfMatches(taskId: string, rows: TaskAttentionDraftItem[]): void {
    const scope = this.buildScope(taskId);
    const draft = readTextTaskEditorDraft(scope);
    if (draft?.attentionRows && this.options.areAttentionRowsEqual(draft.attentionRows, rows)) {
      clearTextTaskEditorDraftField(scope, 'attentionRows');
    }
  }

  private buildScope(taskId: string): TextTaskEditorDraftScope {
    return {
      userId: this.options.getUserId(),
      projectId: this.options.resolveProjectId(),
      taskId,
    };
  }
}
