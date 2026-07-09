import { computed, signal } from '@angular/core';

import type { Task, TaskAttentionDraftItem } from '../../../../models';
import {
  taskAttentionDraftItemsToText,
  taskAttentionMetaToDraftItems,
  taskAttentionTextToDraftItems,
} from '../../../../utils/task-sidecar';
import {
  appendEmptyAttentionDraftRow,
  buildTextTaskEditorPlannerDraftState,
  buildVisibleAttentionDraftRows,
  countHiddenAttentionDraftRows,
  normalizeTextTaskEditorCognitiveLoadSelection,
  removeAttentionDraftRowAt,
  trimEmptyAttentionDraftRows,
  updateAttentionDraftRowText,
  type TextTaskEditorCognitiveLoadSelection,
} from './text-task-editor.helpers';
import type { TextTaskEditorDraftRecord } from './text-task-editor-draft-storage';

type SidecarDraftTask = Pick<
  Task,
  'id' | 'expected_minutes' | 'wait_minutes' | 'cognitive_load' | 'attentionMeta'
>;
type SidecarPersistedDraft = Partial<
  Pick<TextTaskEditorDraftRecord, 'expectedMinutes' | 'waitMinutes' | 'cognitiveLoad' | 'attentionRows'>
>;

export interface TextTaskEditorSidecarDraftSyncOptions {
  task: SidecarDraftTask;
  persistedDraft: SidecarPersistedDraft | null;
  syncAttention: boolean;
}

export class TextTaskEditorSidecarDraftController {
  readonly localExpectedMinutes = signal('');
  readonly localWaitMinutes = signal('');
  readonly localCognitiveLoad = signal<'high' | 'low' | ''>('');
  readonly plannerSaveState = signal<'idle' | 'saving' | 'failed'>('idle');
  readonly localAttentionDraft = signal('');
  readonly attentionDraftRows = signal<TaskAttentionDraftItem[]>([]);
  readonly attentionSaveState = signal<'idle' | 'saving' | 'failed'>('idle');
  readonly isAttentionRowsExpanded = signal(false);
  readonly visibleAttentionDraftRows = computed(() =>
    buildVisibleAttentionDraftRows(this.attentionDraftRows(), this.isAttentionRowsExpanded()),
  );
  readonly hiddenAttentionRowCount = computed(() =>
    countHiddenAttentionDraftRows(this.attentionDraftRows()),
  );

  private attentionFocused = false;
  private attentionDraftTaskId: string | null = null;
  private attentionSaveSequence = 0;

  syncFromTask({ task, persistedDraft, syncAttention }: TextTaskEditorSidecarDraftSyncOptions): void {
    const plannerDraft = buildTextTaskEditorPlannerDraftState(task);
    this.localExpectedMinutes.set(persistedDraft?.expectedMinutes ?? plannerDraft.expectedMinutes);
    this.localWaitMinutes.set(persistedDraft?.waitMinutes ?? plannerDraft.waitMinutes);
    this.localCognitiveLoad.set(persistedDraft?.cognitiveLoad ?? plannerDraft.cognitiveLoad);
    this.plannerSaveState.set('idle');

    if (!syncAttention) {
      return;
    }

    const rows = persistedDraft?.attentionRows ?? taskAttentionMetaToDraftItems(task.attentionMeta);
    this.setAttentionRowsLocal(rows);
    this.attentionSaveState.set('idle');
    this.attentionDraftTaskId = task.id;
  }

  shouldSyncAttentionFromTask(taskId: string): boolean {
    return taskId !== this.attentionDraftTaskId || !this.attentionFocused;
  }

  setExpectedMinutes(value: string): string {
    this.localExpectedMinutes.set(value);
    return value;
  }

  setWaitMinutes(value: string): string {
    this.localWaitMinutes.set(value);
    return value;
  }

  setCognitiveLoad(value: string): TextTaskEditorCognitiveLoadSelection {
    const selection = normalizeTextTaskEditorCognitiveLoadSelection(value);
    this.localCognitiveLoad.set(selection.draftValue);
    return selection;
  }

  startPlannerSave(): void {
    this.plannerSaveState.set('saving');
  }

  finishPlannerSave(saved: boolean): void {
    this.plannerSaveState.set(saved ? 'idle' : 'failed');
  }

  setAttentionRowsFromText(value: string, meta: Task['attentionMeta']): TaskAttentionDraftItem[] {
    return this.setAttentionRows(taskAttentionTextToDraftItems(value, meta));
  }

  setAttentionRowText(index: number, value: string): TaskAttentionDraftItem[] {
    return this.setAttentionRows(updateAttentionDraftRowText(this.attentionDraftRows(), index, value));
  }

  setAttentionRows(rows: TaskAttentionDraftItem[]): TaskAttentionDraftItem[] {
    this.setAttentionRowsLocal(rows);
    return rows;
  }

  addAttentionRowLocal(): void {
    this.isAttentionRowsExpanded.set(true);
    this.setAttentionRowsLocal(appendEmptyAttentionDraftRow(this.attentionDraftRows()));
  }

  toggleAttentionRowsExpanded(): void {
    this.isAttentionRowsExpanded.update(value => !value);
  }

  removeAttentionRow(index: number): TaskAttentionDraftItem[] {
    return this.setAttentionRows(removeAttentionDraftRowAt(this.attentionDraftRows(), index));
  }

  markAttentionFocused(): void {
    this.attentionFocused = true;
  }

  markAttentionBlurred(taskId: string): void {
    this.attentionFocused = false;
    this.attentionDraftTaskId = taskId;
  }

  markAttentionCommitted(taskId: string): void {
    this.attentionDraftTaskId = taskId;
  }

  trimEmptyAttentionRows(): TaskAttentionDraftItem[] | null {
    const rows = this.attentionDraftRows();
    const trimmedRows = trimEmptyAttentionDraftRows(rows);
    if (trimmedRows.length === rows.length) {
      return null;
    }

    return this.setAttentionRows(trimmedRows);
  }

  startAttentionSave(): number {
    this.attentionSaveState.set('saving');
    this.attentionSaveSequence += 1;
    return this.attentionSaveSequence;
  }

  finishAttentionSave(sequence: number, saved: boolean): boolean {
    if (sequence !== this.attentionSaveSequence) {
      return false;
    }

    this.attentionSaveState.set(saved ? 'idle' : 'failed');
    return true;
  }

  areAttentionRowsEqual(
    left: readonly TaskAttentionDraftItem[],
    right: readonly TaskAttentionDraftItem[],
  ): boolean {
    return left.length === right.length
      && left.every((row, index) => {
        const other = right[index];
        return !!other
          && row.id === other.id
          && row.text === other.text
          && row.level === other.level
          && row.done === other.done
          && row.createdAt === other.createdAt
          && row.updatedAt === other.updatedAt;
      });
  }

  private setAttentionRowsLocal(rows: TaskAttentionDraftItem[]): void {
    this.attentionDraftRows.set(rows);
    this.localAttentionDraft.set(taskAttentionDraftItemsToText(rows));
    if (this.hiddenAttentionRowCount() === 0) {
      this.isAttentionRowsExpanded.set(false);
    }
  }
}
