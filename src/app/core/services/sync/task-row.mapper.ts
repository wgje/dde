import type { Attachment, Task, TaskAttentionMeta } from '../../../../models';
import type { TaskParkingMeta } from '../../../../models/parking';
import { markTaskContentMissingFromSource } from '../../../../utils/task-content-guard';

export const REQUIRED_TASK_ROW_FIELDS = [
  'content',
  'stage',
  'parent_id',
  'order',
  'rank',
  'status',
  'updated_at',
] as const;

export type RequiredTaskRowField = typeof REQUIRED_TASK_ROW_FIELDS[number];

export class TaskRowIntegrityError extends Error {
  readonly code = 'TASK_ROW_INCOMPLETE';

  constructor(
    readonly taskId: string | null | undefined,
    readonly missingFields: RequiredTaskRowField[],
    readonly rowKeys: string[],
  ) {
    super(`Task row ${taskId || '<unknown>'} missing required fields: ${missingFields.join(', ')}`);
    this.name = 'TaskRowIntegrityError';
  }
}

export interface TaskRowLike {
  id?: string | null;
  title?: string | null;
  content?: string | null;
  stage?: number | null;
  parent_id?: string | null;
  order?: number | null;
  rank?: number | null;
  status?: string | null;
  x?: number | null;
  y?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
  short_id?: string | null;
  deleted_at?: string | null;
  attachments?: unknown;
  tags?: unknown;
  priority?: string | null;
  due_date?: string | null;
  expected_minutes?: number | null;
  cognitive_load?: 'high' | 'low' | null;
  wait_minutes?: number | null;
  parking_meta?: unknown;
  attention_meta?: unknown;
}

export interface TaskRowMappingReporter {
  warnContentMissing(details: {
    taskId: string | null | undefined;
    hasTitle: boolean;
    hasStage: boolean;
  }): void;
  captureContentMissing(details: {
    taskId: string | null | undefined;
    rowKeys: string[];
  }): void;
}

function mapNullableJsonField<T>(row: TaskRowLike, key: keyof TaskRowLike): T | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(row, key)) {
    return undefined;
  }

  const value = row[key];
  return value === null || value === undefined ? null : value as T;
}

function getMissingRequiredTaskRowFields(row: TaskRowLike): RequiredTaskRowField[] {
  return REQUIRED_TASK_ROW_FIELDS.filter(field => {
    if (field === 'content') return typeof row.content !== 'string';
    return !Object.prototype.hasOwnProperty.call(row, field) || row[field] === undefined;
  });
}

function getTaskRowScalarFields(row: TaskRowLike): Pick<
  Task,
  | 'id'
  | 'title'
  | 'content'
  | 'stage'
  | 'parentId'
  | 'order'
  | 'rank'
  | 'status'
  | 'x'
  | 'y'
  | 'createdDate'
  | 'updatedAt'
  | 'completedAt'
  | 'displayId'
  | 'shortId'
  | 'deletedAt'
> {
  return {
    id: row.id || '',
    title: row.title || '',
    content: row.content ?? '',
    stage: row.stage ?? null,
    parentId: row.parent_id ?? null,
    order: row.order || 0,
    rank: row.rank || 0,
    status: (row.status as Task['status']) || 'active',
    x: row.x || 0,
    y: row.y || 0,
    createdDate: row.created_at || '',
    updatedAt: row.updated_at ?? undefined,
    completedAt: row.completed_at ?? null,
    displayId: '',
    shortId: row.short_id || undefined,
    deletedAt: row.deleted_at || undefined,
  };
}

function getTaskRowMetadataFields(row: TaskRowLike): Pick<
  Task,
  | 'attachments'
  | 'tags'
  | 'priority'
  | 'dueDate'
  | 'expected_minutes'
  | 'cognitive_load'
  | 'wait_minutes'
  | 'parkingMeta'
  | 'attentionMeta'
> {
  return {
    attachments: (row.attachments as Attachment[]) ?? [],
    tags: (row.tags as string[]) ?? [],
    priority: (row.priority as Task['priority']) ?? undefined,
    dueDate: row.due_date ?? undefined,
    expected_minutes: row.expected_minutes ?? null,
    cognitive_load: row.cognitive_load ?? null,
    wait_minutes: row.wait_minutes ?? null,
    parkingMeta: mapNullableJsonField<TaskParkingMeta>(row, 'parking_meta'),
    attentionMeta: mapNullableJsonField<TaskAttentionMeta>(row, 'attention_meta'),
  };
}

export function mapTaskRowToTask(row: TaskRowLike, reporter: TaskRowMappingReporter): Task {
  const contentMissingFromSource = typeof row.content !== 'string';
  const contentAbsentFromSource = !Object.prototype.hasOwnProperty.call(row, 'content')
    || row.content === undefined;

  if (contentMissingFromSource) {
    reporter.warnContentMissing({
      taskId: row.id,
      hasTitle: Object.prototype.hasOwnProperty.call(row, 'title'),
      hasStage: Object.prototype.hasOwnProperty.call(row, 'stage'),
    });
    reporter.captureContentMissing({
      taskId: row.id,
      rowKeys: Object.keys(row),
    });
  }

  const missingFields = getMissingRequiredTaskRowFields(row);
  if (missingFields.length > 0) {
    throw new TaskRowIntegrityError(row.id, missingFields, Object.keys(row));
  }

  const task: Task = {
    ...getTaskRowScalarFields(row),
    ...getTaskRowMetadataFields(row),
  };

  if (contentAbsentFromSource) {
    markTaskContentMissingFromSource(task);
  }

  return task;
}
