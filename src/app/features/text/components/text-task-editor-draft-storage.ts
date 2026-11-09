import type { TaskAttentionDraftItem } from '../../../../models';

export interface TextTaskEditorDraftScope {
  userId: string | null;
  projectId: string | null;
  taskId: string;
}

export interface TextTaskEditorDraftRecord extends TextTaskEditorDraftScope {
  title?: string;
  content?: string;
  expectedMinutes?: string;
  waitMinutes?: string;
  cognitiveLoad?: 'high' | 'low' | '';
  attentionRows?: TaskAttentionDraftItem[];
  updatedAt: string;
}

export type TextTaskEditorTextDraftField = 'title' | 'content';
export type TextTaskEditorPlannerDraftField = 'expectedMinutes' | 'waitMinutes' | 'cognitiveLoad';
export type TextTaskEditorStringDraftField = TextTaskEditorTextDraftField | TextTaskEditorPlannerDraftField;
export type TextTaskEditorDraftField = TextTaskEditorStringDraftField | 'attentionRows';

const TEXT_TASK_EDITOR_DRAFT_PREFIX = 'nanoflow.textTaskEditorDraft.';
const FALLBACK_USER_ID = '__local__';
const FALLBACK_PROJECT_ID = '__unknown_project__';

export function readTextTaskEditorDraft(scope: TextTaskEditorDraftScope): TextTaskEditorDraftRecord | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }

  let parsed: unknown = null;
  try {
    const raw = localStorage.getItem(getTextTaskEditorDraftKey(scope));
    if (raw) {
      parsed = JSON.parse(raw) as unknown;
    }
  } catch {
    parsed = null;
  }

  return isTextTaskEditorDraftRecord(parsed, scope) ? parsed : null;
}

export function writeTextTaskEditorDraftField(
  scope: TextTaskEditorDraftScope,
  field: TextTaskEditorStringDraftField,
  value: string,
): void;
export function writeTextTaskEditorDraftField(
  scope: TextTaskEditorDraftScope,
  field: 'attentionRows',
  value: TaskAttentionDraftItem[],
): void;
export function writeTextTaskEditorDraftField(
  scope: TextTaskEditorDraftScope,
  field: TextTaskEditorDraftField,
  value: string | TaskAttentionDraftItem[],
): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  const existing = readTextTaskEditorDraft(scope);
  const record: TextTaskEditorDraftRecord = {
    userId: scope.userId,
    projectId: scope.projectId,
    taskId: scope.taskId,
    ...(existing ?? {}),
    updatedAt: new Date().toISOString(),
  };
  if (field === 'attentionRows') {
    record.attentionRows = value as TaskAttentionDraftItem[];
  } else if (field === 'cognitiveLoad') {
    record.cognitiveLoad = isTextTaskEditorCognitiveLoadDraft(value) ? value : '';
  } else {
    record[field] = value as string;
  }

  try {
    localStorage.setItem(getTextTaskEditorDraftKey(scope), JSON.stringify(record));
  } catch {
    // Best effort: durable task storage remains the primary local-first path.
  }
}

export function clearTextTaskEditorDraftField(
  scope: TextTaskEditorDraftScope,
  field: TextTaskEditorDraftField,
): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  const existing = readTextTaskEditorDraft(scope);
  if (!existing) {
    return;
  }

  const next = { ...existing };
  delete next[field];

  try {
    if (!hasTextTaskEditorDraftPayload(next)) {
      localStorage.removeItem(getTextTaskEditorDraftKey(scope));
      return;
    }
    next.updatedAt = new Date().toISOString();
    localStorage.setItem(getTextTaskEditorDraftKey(scope), JSON.stringify(next));
  } catch {
    // Ignore cleanup failures; retaining the draft is safer than losing user input.
  }
}

function getTextTaskEditorDraftKey(scope: TextTaskEditorDraftScope): string {
  return [
    TEXT_TASK_EDITOR_DRAFT_PREFIX,
    encodeURIComponent(scope.userId ?? FALLBACK_USER_ID),
    '.',
    encodeURIComponent(scope.projectId ?? FALLBACK_PROJECT_ID),
    '.',
    encodeURIComponent(scope.taskId),
  ].join('');
}

function isTextTaskEditorDraftRecord(
  value: unknown,
  scope: TextTaskEditorDraftScope,
): value is TextTaskEditorDraftRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Partial<TextTaskEditorDraftRecord>;
  return isMatchingTextTaskEditorDraftScope(record, scope)
    && typeof record.updatedAt === 'string'
    && isOptionalStringDraftValue(record.title)
    && isOptionalStringDraftValue(record.content)
    && isOptionalStringDraftValue(record.expectedMinutes)
    && isOptionalStringDraftValue(record.waitMinutes)
    && isOptionalCognitiveLoadDraftValue(record.cognitiveLoad)
    && isOptionalAttentionRowsDraftValue(record.attentionRows);
}

function hasTextTaskEditorDraftPayload(record: TextTaskEditorDraftRecord): boolean {
  return record.title !== undefined
    || record.content !== undefined
    || record.expectedMinutes !== undefined
    || record.waitMinutes !== undefined
    || record.cognitiveLoad !== undefined
    || record.attentionRows !== undefined;
}

function isTaskAttentionDraftItem(value: unknown): value is TaskAttentionDraftItem {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Partial<TaskAttentionDraftItem>;
  return typeof record.text === 'string'
    && (
      record.level === undefined
      || record.level === 'info'
      || record.level === 'warning'
      || record.level === 'blocker'
    )
    && (record.done === undefined || typeof record.done === 'boolean')
    && (record.id === undefined || typeof record.id === 'string')
    && (record.createdAt === undefined || typeof record.createdAt === 'string')
    && (record.updatedAt === undefined || typeof record.updatedAt === 'string');
}

function isMatchingTextTaskEditorDraftScope(
  record: Partial<TextTaskEditorDraftRecord>,
  scope: TextTaskEditorDraftScope,
): boolean {
  return record.userId === scope.userId
    && record.projectId === scope.projectId
    && record.taskId === scope.taskId;
}

function isOptionalStringDraftValue(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isTextTaskEditorCognitiveLoadDraft(value: unknown): value is 'high' | 'low' | '' {
  return value === '' || value === 'high' || value === 'low';
}

function isOptionalCognitiveLoadDraftValue(value: unknown): value is 'high' | 'low' | '' | undefined {
  return value === undefined || isTextTaskEditorCognitiveLoadDraft(value);
}

function isOptionalAttentionRowsDraftValue(value: unknown): value is TaskAttentionDraftItem[] | undefined {
  return value === undefined
    || (Array.isArray(value) && value.every(isTaskAttentionDraftItem));
}
