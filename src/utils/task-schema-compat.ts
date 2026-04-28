type SupabaseLikeError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

let taskCompletedAtColumnUnavailable = false;

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

export function markTaskCompletedAtColumnUnavailable(error?: unknown): boolean {
  if (error !== undefined && !isMissingTaskCompletedAtColumnError(error)) {
    return false;
  }

  taskCompletedAtColumnUnavailable = true;
  return true;
}

export function getCompatibleTaskSelectFields(fields: string): string {
  if (!taskCompletedAtColumnUnavailable) {
    return fields;
  }

  return stripTaskCompletedAtField(fields);
}

export function getCompatibleTaskWriteRow<T extends Record<string, unknown>>(row: T): T | Omit<T, 'completed_at'> {
  return taskCompletedAtColumnUnavailable ? omitTaskCompletedAtColumn(row) : row;
}

export function stripTaskCompletedAtField(fields: string): string {
  return fields
    .split(',')
    .map(field => field.trim())
    .filter(field => field.length > 0 && field !== 'completed_at')
    .join(',');
}

export function omitTaskCompletedAtColumn<T extends Record<string, unknown>>(row: T): Omit<T, 'completed_at'> {
  const { completed_at: _completedAt, ...rest } = row;
  return rest;
}

export function resetTaskSchemaCompatibilityForTests(): void {
  taskCompletedAtColumnUnavailable = false;
}
