const TASK_WRITE_FIELD_ORDER = [
  'id',
  'title',
  'content',
  'stage',
  'parentId',
  'order',
  'rank',
  'status',
  'x',
  'y',
  'createdDate',
  'updatedAt',
] as const;

export type UnsafeTaskWriteField = typeof TASK_WRITE_FIELD_ORDER[number];

const VALID_TASK_STATUSES = new Set(['active', 'completed', 'archived']);

export function getUnsafeTaskWriteFields(value: unknown): UnsafeTaskWriteField[] {
  if (!isRecord(value)) {
    return [...TASK_WRITE_FIELD_ORDER];
  }

  const unsafeFields: UnsafeTaskWriteField[] = [];
  if (!isNonEmptyString(value['id'])) unsafeFields.push('id');
  if (typeof value['title'] !== 'string') unsafeFields.push('title');
  if (typeof value['content'] !== 'string') unsafeFields.push('content');
  if (value['stage'] !== null && !isFiniteNumber(value['stage'])) unsafeFields.push('stage');
  if (value['parentId'] !== null && !isNonEmptyString(value['parentId'])) unsafeFields.push('parentId');
  if (!isFiniteNumber(value['order'])) unsafeFields.push('order');
  if (!isFiniteNumber(value['rank'])) unsafeFields.push('rank');
  if (typeof value['status'] !== 'string' || !VALID_TASK_STATUSES.has(value['status'])) {
    unsafeFields.push('status');
  }
  if (!isFiniteNumber(value['x'])) unsafeFields.push('x');
  if (!isFiniteNumber(value['y'])) unsafeFields.push('y');
  if (!isNonEmptyString(value['createdDate'])) unsafeFields.push('createdDate');
  if (!isNonEmptyString(value['updatedAt'])) unsafeFields.push('updatedAt');
  return unsafeFields;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
