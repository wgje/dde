import type { Task, TaskAttentionDraftItem } from '../../../../models';

export const MAX_COLLAPSED_ATTENTION_ROWS = 3;
export const TEXT_TASK_EDITOR_MAX_ATTACHMENTS = 5;
export const TEXT_TASK_EDITOR_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export interface VisibleAttentionDraftRow {
  item: TaskAttentionDraftItem;
  index: number;
}

export type TextTaskEditorCognitiveLoadDraft = 'high' | 'low' | '';

export interface TextTaskEditorPlannerDraftState {
  expectedMinutes: string;
  waitMinutes: string;
  cognitiveLoad: TextTaskEditorCognitiveLoadDraft;
}

export interface TextTaskEditorCognitiveLoadSelection {
  draftValue: TextTaskEditorCognitiveLoadDraft;
  persistedValue: 'high' | 'low' | null;
}

const EMPTY_ATTENTION_DRAFT_ROW: TaskAttentionDraftItem = {
  text: '',
  level: 'info',
  done: false,
};

export function buildVisibleAttentionDraftRows(
  rows: TaskAttentionDraftItem[],
  isExpanded: boolean,
  maxCollapsedRows = MAX_COLLAPSED_ATTENTION_ROWS,
): VisibleAttentionDraftRow[] {
  const visibleRows = isExpanded || rows.length <= maxCollapsedRows
    ? rows
    : rows.slice(0, maxCollapsedRows);
  return visibleRows.map((item, index) => ({ item, index }));
}

export function countHiddenAttentionDraftRows(
  rows: TaskAttentionDraftItem[],
  maxCollapsedRows = MAX_COLLAPSED_ATTENTION_ROWS,
): number {
  return Math.max(0, rows.length - maxCollapsedRows);
}

export function buildTextTaskEditorPlannerDraftState(
  task: Pick<Task, 'expected_minutes' | 'wait_minutes' | 'cognitive_load'>,
): TextTaskEditorPlannerDraftState {
  return {
    expectedMinutes: task.expected_minutes == null ? '' : String(task.expected_minutes),
    waitMinutes: task.wait_minutes == null ? '' : String(task.wait_minutes),
    cognitiveLoad: task.cognitive_load ?? '',
  };
}

export function normalizeTextTaskEditorCognitiveLoadSelection(
  value: string,
): TextTaskEditorCognitiveLoadSelection {
  const persistedValue = value === 'high' || value === 'low' ? value : null;
  return {
    draftValue: persistedValue ?? '',
    persistedValue,
  };
}

export function updateAttentionDraftRowText(
  rows: TaskAttentionDraftItem[],
  index: number,
  value: string,
): TaskAttentionDraftItem[] {
  const nextRows = [...rows];
  while (nextRows.length <= index) {
    nextRows.push({ ...EMPTY_ATTENTION_DRAFT_ROW });
  }
  nextRows[index] = { ...nextRows[index], text: value };
  return nextRows;
}

export function appendEmptyAttentionDraftRow(rows: TaskAttentionDraftItem[]): TaskAttentionDraftItem[] {
  return [...rows, { ...EMPTY_ATTENTION_DRAFT_ROW }];
}

export function removeAttentionDraftRowAt(
  rows: TaskAttentionDraftItem[],
  index: number,
): TaskAttentionDraftItem[] {
  return rows.filter((_row, rowIndex) => rowIndex !== index);
}

export function trimEmptyAttentionDraftRows(rows: TaskAttentionDraftItem[]): TaskAttentionDraftItem[] {
  return rows.filter(row => row.text.trim().length > 0);
}

export function getAttachmentFileExtension(filename: string): string {
  const ext = filename.split('.').pop() || '';
  return ext.length > 4 ? ext.substring(0, 4) : ext;
}

export function formatAttachmentFileSize(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export interface MobileAttachmentFileSelection {
  remainingSlots: number;
  filesToUpload: File[];
  oversizedFile: File | null;
}

export function buildMobileAttachmentFileSelection(
  files: FileList,
  currentAttachmentCount: number,
  maxAttachments = TEXT_TASK_EDITOR_MAX_ATTACHMENTS,
  maxFileSize = TEXT_TASK_EDITOR_MAX_FILE_SIZE_BYTES,
): MobileAttachmentFileSelection {
  const remainingSlots = maxAttachments - currentAttachmentCount;
  const filesToUpload = remainingSlots > 0 ? Array.from(files).slice(0, remainingSlots) : [];
  const oversizedFile = filesToUpload.find(file => file.size > maxFileSize) ?? null;
  return { remainingSlots, filesToUpload, oversizedFile };
}

export function isEventInsideElement(event: Event, host: HTMLElement | null): boolean {
  if (!host) {
    return false;
  }

  if (eventPathContains(event, node => node === host)) {
    return true;
  }

  const target = event.target;
  return target instanceof Node ? host.contains(target) : false;
}

export function isEventInsideTaskCard(event: Event, taskId: string): boolean {
  if (eventPathContains(event, node => {
    return node instanceof HTMLElement && node.getAttribute('data-task-id') === taskId;
  })) {
    return true;
  }

  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return !!target.closest(`[data-task-id="${taskId}"]`);
}

export function resolveTextTaskEditorFieldElement(
  host: HTMLElement | null,
  field: 'title' | 'content',
): HTMLInputElement | HTMLTextAreaElement | null {
  const selector = field === 'title'
    ? '[data-testid="task-title-input"]'
    : '[data-testid="task-content-editor"]';
  return host?.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector) ?? null;
}

function eventPathContains(event: Event, predicate: (node: EventTarget) => boolean): boolean {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  return path.some(predicate);
}
