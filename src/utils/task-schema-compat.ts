type SupabaseLikeError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

let taskCompletedAtColumnUnavailable = false;
let taskAttentionMetaColumnUnavailable = false;

function normalizeErrorText(error: unknown): string {
  if (typeof error === 'string') {
    return error.toLowerCase();
  }

  if (typeof error !== 'object' || error === null) {
    return '';
  }

  const candidate = error as SupabaseLikeError;
  return [
    candidate.message,
    candidate.details,
    candidate.hint,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase();
}

export function isMissingTaskCompletedAtColumnError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as SupabaseLikeError;
  const text = normalizeErrorText(error);
  return candidate.code === '42703'
    && text.includes('completed_at')
    && text.includes('does not exist');
}

export function isMissingTaskAttentionMetaColumnError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as SupabaseLikeError;
  const text = normalizeErrorText(error);
  return candidate.code === '42703'
    && text.includes('attention_meta')
    && text.includes('does not exist');
}

export function markTaskCompletedAtColumnUnavailable(error?: unknown): boolean {
  if (error !== undefined) {
    const missingCompletedAt = isMissingTaskCompletedAtColumnError(error);
    const missingAttentionMeta = isMissingTaskAttentionMetaColumnError(error);
    if (!missingCompletedAt && !missingAttentionMeta) {
      return false;
    }

    if (missingAttentionMeta) {
      taskAttentionMetaColumnUnavailable = true;
    }

    if (!missingCompletedAt) {
      return true;
    }
  }

  taskCompletedAtColumnUnavailable = true;
  return true;
}

export function markTaskAttentionMetaColumnUnavailable(error?: unknown): boolean {
  if (error !== undefined && !isMissingTaskAttentionMetaColumnError(error)) {
    return false;
  }

  taskAttentionMetaColumnUnavailable = true;
  return true;
}

export function getCompatibleTaskSelectFields(fields: string): string {
  if (!taskCompletedAtColumnUnavailable && !taskAttentionMetaColumnUnavailable) {
    return fields;
  }

  return stripUnavailableTaskFields(fields);
}

export function getCompatibleTaskWriteRow<T extends Record<string, unknown>>(
  row: T,
): T | Omit<T, 'completed_at' | 'attention_meta'> {
  let compatibleRow: Record<string, unknown> = row;
  if (taskCompletedAtColumnUnavailable) {
    compatibleRow = omitTaskCompletedAtColumn(compatibleRow);
  }
  if (taskAttentionMetaColumnUnavailable) {
    compatibleRow = omitTaskAttentionMetaColumn(compatibleRow);
  }
  return compatibleRow as T | Omit<T, 'completed_at' | 'attention_meta'>;
}

export function stripUnavailableTaskFields(fields: string): string {
  const unavailableFields = new Set<string>();
  if (taskCompletedAtColumnUnavailable) unavailableFields.add('completed_at');
  if (taskAttentionMetaColumnUnavailable) unavailableFields.add('attention_meta');
  return stripFields(fields, unavailableFields);
}

function stripFields(fields: string, unavailableFields: ReadonlySet<string>): string {
  return fields
    .split(',')
    .map(field => field.trim())
    .filter(field => field.length > 0 && !unavailableFields.has(field))
    .join(',');
}

export function omitTaskCompletedAtColumn<T extends Record<string, unknown>>(row: T): Omit<T, 'completed_at'> {
  const { completed_at: _completedAt, ...rest } = row;
  return rest;
}

export function omitTaskAttentionMetaColumn<T extends Record<string, unknown>>(row: T): Omit<T, 'attention_meta'> {
  const { attention_meta: _attentionMeta, ...rest } = row;
  return rest;
}

export function resetTaskSchemaCompatibilityForTests(): void {
  taskCompletedAtColumnUnavailable = false;
  taskAttentionMetaColumnUnavailable = false;
}
