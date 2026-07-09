import { computed, signal } from '@angular/core';
import type { Task, TaskAttentionDraftItem } from '../../../../models';
import {
  taskAttentionDraftItemsToText,
  taskAttentionMetaToDraftItems,
  taskAttentionTextToDraftItems,
} from '../../../../utils/task-sidecar';

const MAX_COLLAPSED_ATTENTION_ROWS = 3;
const EMPTY_ATTENTION_DRAFT_ROW: TaskAttentionDraftItem = { text: '', level: 'info', done: false };

export interface VisibleAttentionDraftRow {
  item: TaskAttentionDraftItem;
  index: number;
}

export function buildVisibleAttentionDraftRows(
  rows: readonly TaskAttentionDraftItem[],
  isExpanded: boolean,
): VisibleAttentionDraftRow[] {
  const visibleRows = isExpanded || rows.length <= MAX_COLLAPSED_ATTENTION_ROWS
    ? rows
    : rows.slice(0, MAX_COLLAPSED_ATTENTION_ROWS);
  return visibleRows.map((item, index) => ({ item, index }));
}

export function countHiddenAttentionDraftRows(rows: readonly TaskAttentionDraftItem[]): number {
  return Math.max(0, rows.length - MAX_COLLAPSED_ATTENTION_ROWS);
}

export function buildAttentionDraftRowsFromText(
  value: string,
  meta: Task['attentionMeta'],
): TaskAttentionDraftItem[] {
  return taskAttentionTextToDraftItems(value, meta);
}

export function buildAttentionDraftRowsFromMeta(meta: Task['attentionMeta']): TaskAttentionDraftItem[] {
  return taskAttentionMetaToDraftItems(meta);
}

export function attentionDraftRowsToText(rows: readonly TaskAttentionDraftItem[]): string {
  return taskAttentionDraftItemsToText(rows);
}

export function updateAttentionDraftRow(
  rows: readonly TaskAttentionDraftItem[],
  index: number,
  value: string,
): TaskAttentionDraftItem[] {
  const nextRows = [...rows];
  while (nextRows.length <= index) nextRows.push({ ...EMPTY_ATTENTION_DRAFT_ROW });
  nextRows[index] = { ...nextRows[index], text: value };
  return nextRows;
}

export function appendEmptyAttentionDraftRow(rows: readonly TaskAttentionDraftItem[]): TaskAttentionDraftItem[] {
  return [...rows, { ...EMPTY_ATTENTION_DRAFT_ROW }];
}

export function removeAttentionDraftRowAt(
  rows: readonly TaskAttentionDraftItem[],
  index: number,
): TaskAttentionDraftItem[] {
  return rows.filter((_row, rowIndex) => rowIndex !== index);
}

export function trimEmptyAttentionDraftRows(rows: readonly TaskAttentionDraftItem[]): TaskAttentionDraftItem[] {
  return rows.filter(row => row.text.trim().length > 0);
}

export class FlowTaskDetailAttentionDraftController {
  readonly localDraft = signal('');
  readonly rows = signal<TaskAttentionDraftItem[]>([]);
  readonly expanded = signal(false);
  readonly visibleRows = computed(() => buildVisibleAttentionDraftRows(this.rows(), this.expanded()));
  readonly hiddenRowCount = computed(() => countHiddenAttentionDraftRows(this.rows()));

  private focused = false;
  private taskId: string | null = null;

  shouldSyncFromTask(taskId: string | null): boolean {
    return taskId !== this.taskId || !this.focused;
  }

  setRowsFromText(value: string, meta: Task['attentionMeta']): TaskAttentionDraftItem[] {
    return this.setRows(buildAttentionDraftRowsFromText(value, meta));
  }

  updateRow(index: number, value: string): TaskAttentionDraftItem[] {
    return this.setRows(updateAttentionDraftRow(this.rows(), index, value));
  }

  addEmptyRowLocal(): void {
    this.expanded.set(true);
    this.setRowsLocal(appendEmptyAttentionDraftRow(this.rows()));
  }

  toggleExpanded(): void {
    this.expanded.update(value => !value);
  }

  removeRow(index: number): TaskAttentionDraftItem[] {
    return this.setRows(removeAttentionDraftRowAt(this.rows(), index));
  }

  setFromMeta(meta: Task['attentionMeta'], taskId: string | null): void {
    const nextRows = buildAttentionDraftRowsFromMeta(meta);
    this.taskId = taskId;
    this.rows.set(nextRows);
    this.localDraft.set(attentionDraftRowsToText(nextRows));
  }

  markFocused(): void {
    this.focused = true;
  }

  markBlurred(taskId: string | null): void {
    this.focused = false;
    this.taskId = taskId;
  }

  trimEmptyRowsLocal(): void {
    const rows = this.rows();
    const trimmedRows = trimEmptyAttentionDraftRows(rows);
    if (trimmedRows.length !== rows.length) {
      this.setRowsLocal(trimmedRows);
    }
  }

  markCommittedTask(taskId: string): void {
    this.taskId = taskId;
  }

  private setRows(rows: TaskAttentionDraftItem[]): TaskAttentionDraftItem[] {
    this.setRowsLocal(rows);
    return rows;
  }

  private setRowsLocal(rows: TaskAttentionDraftItem[]): void {
    this.rows.set(rows);
    this.localDraft.set(attentionDraftRowsToText(rows));
    if (this.hiddenRowCount() === 0) {
      this.expanded.set(false);
    }
  }
}
