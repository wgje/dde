export const LEGACY_RETRY_REVIEW_STORAGE_KEY_PREFIX = 'nanoflow.retry-queue.legacy-review.';

type UnknownRecord = Record<string, unknown>;

export interface LegacyRetryReviewBackupItem extends UnknownRecord {
  item: UnknownRecord & {
    id: string;
    operationId: string;
    sourceUserId: string;
    type: string;
    operation: string;
    data: UnknownRecord & { id: string };
  };
  reason: string;
  quarantinedAt: string;
  ownerUserId: string;
}

export function collectLegacyRetryReviewValidationErrors(value: unknown, ownerUserId: unknown, prefix = 'legacyRetryReview'): string[] {
  const errors = collectLegacyRetryReviewBaseValidationErrors(value, ownerUserId, prefix);
  if (!Array.isArray(value)) return errors;
  for (const [index, candidate] of value.entries()) {
    if (!isRecord(candidate) || candidate['retainedVersions'] === undefined) continue;
    const label = `${prefix}[${index}].retainedVersions`;
    const versions = candidate['retainedVersions'];
    if (!Array.isArray(versions)) { errors.push(`${label} must be an array`); continue; }
    for (const [versionIndex, version] of versions.entries()) {
      errors.push(...collectLegacyRetryReviewBaseValidationErrors([version], ownerUserId, `${label}[${versionIndex}]`));
      if (!isRecord(version)) continue;
      if (version['retainedVersions'] !== undefined) errors.push(`${label} must be flat`);
      if (isRecord(version['item']) && isRecord(candidate['item']) && version['item']['id'] !== candidate['item']['id']) errors.push(`${label} queue id must match`);
    }
  }
  return errors;
}
function collectLegacyRetryReviewBaseValidationErrors(
  value: unknown,
  ownerUserId: unknown,
  prefix = 'legacyRetryReview',
): string[] {
  const errors: string[] = [];
  if (!Array.isArray(value)) {
    errors.push(`${prefix} must be an array`);
    return errors;
  }

  const expectedOwner = nonEmptyString(ownerUserId);
  const seenIds = new Set<string>();
  const seenOperationIds = new Set<string>();
  value.forEach((candidate, index) => {
    const itemPrefix = `${prefix}[${index}]`;
    if (!isRecord(candidate)) {
      errors.push(`${itemPrefix} must be an object`);
      return;
    }

    const recordOwner = nonEmptyString(candidate['ownerUserId']);
    if (!recordOwner || !expectedOwner || recordOwner !== expectedOwner) {
      errors.push(`${itemPrefix}.ownerUserId must match ownerUserId`);
    }
    if (!nonEmptyString(candidate['reason'])) {
      errors.push(`${itemPrefix}.reason is required`);
    }
    const quarantinedAt = nonEmptyString(candidate['quarantinedAt']);
    if (!quarantinedAt || Number.isNaN(Date.parse(quarantinedAt))) {
      errors.push(`${itemPrefix}.quarantinedAt must be a timestamp`);
    }

    const queueItem = candidate['item'];
    if (!isRecord(queueItem)) {
      errors.push(`${itemPrefix}.item must be an object`);
      return;
    }
    const id = nonEmptyString(queueItem['id']);
    const operationId = nonEmptyString(queueItem['operationId']);
    const sourceUserId = nonEmptyString(queueItem['sourceUserId']);
    if (!id) errors.push(`${itemPrefix}.item.id is required`);
    if (!operationId) errors.push(`${itemPrefix}.item.operationId is required`);
    if (!sourceUserId) errors.push(`${itemPrefix}.item.sourceUserId is required`);
    if (!expectedOwner || sourceUserId !== expectedOwner) {
      errors.push(`${itemPrefix}.item.sourceUserId must match ownerUserId`);
    }
    if (!nonEmptyString(queueItem['type'])) {
      errors.push(`${itemPrefix}.item.type is required`);
    }
    if (!nonEmptyString(queueItem['operation'])) {
      errors.push(`${itemPrefix}.item.operation is required`);
    }
    const data = queueItem['data'];
    if (!isRecord(data) || !nonEmptyString(data['id'])) {
      errors.push(`${itemPrefix}.item.data.id is required`);
    }

    if (id && seenIds.has(id)) errors.push(`${itemPrefix}.item.id must be unique`);
    if (operationId && seenOperationIds.has(operationId)) {
      errors.push(`${itemPrefix}.item.operationId must be unique`);
    }
    if (id) seenIds.add(id);
    if (operationId) seenOperationIds.add(operationId);
  });

  return errors;
}

export function collectLegacyRetryReviewQueueIdentityOverlapErrors(
  retryQueue: unknown,
  reviewItems: unknown,
  prefix = 'localState.legacyRetryReview',
): string[] {
  if (!Array.isArray(retryQueue) || !Array.isArray(reviewItems)) return [];
  const retryIds = new Set<string>();
  const retryOperationIds = new Set<string>();
  for (const item of retryQueue) {
    if (!isRecord(item)) continue;
    const id = nonEmptyString(item['id']);
    const operationId = nonEmptyString(item['operationId']);
    if (id) retryIds.add(id);
    if (operationId) retryOperationIds.add(operationId);
  }

  const errors: string[] = [];
  const allReviewItems = reviewItems.flatMap(reviewItem => isRecord(reviewItem) && Array.isArray(reviewItem['retainedVersions'])
    ? [reviewItem, ...reviewItem['retainedVersions']] : [reviewItem]);
  allReviewItems.forEach((reviewItem, index) => {
    if (!isRecord(reviewItem) || !isRecord(reviewItem['item'])) return;
    const id = nonEmptyString(reviewItem['item']['id']);
    const operationId = nonEmptyString(reviewItem['item']['operationId']);
    if (id && retryIds.has(id)) {
      errors.push(`${prefix}[${index}].item.id also appears in localState.retryQueue`);
    }
    if (operationId && retryOperationIds.has(operationId)) {
      errors.push(`${prefix}[${index}].item.operationId also appears in localState.retryQueue`);
    }
  });
  return errors;
}

export function parseLegacyRetryReviewItems(
  value: unknown,
  ownerUserId: string,
  prefix = 'legacyRetryReview',
): LegacyRetryReviewBackupItem[] {
  const errors = collectLegacyRetryReviewValidationErrors(value, ownerUserId, prefix);
  if (errors.length > 0) {
    throw new Error(`legacy retry review is invalid: ${errors.join('; ')}`);
  }
  return (value as LegacyRetryReviewBackupItem[]).map(item => ({
    ...item,
    item: { ...item.item, data: { ...item.item.data } },
  }));
}

export function parseLegacyRetryReviewStorageValue(
  value: string | null,
  ownerUserId: string,
): LegacyRetryReviewBackupItem[] {
  if (value === null) return [];
  try {
    return parseLegacyRetryReviewItems(
      JSON.parse(value) as unknown,
      ownerUserId,
      'legacyRetryReview storage',
    );
  } catch (error) {
    throw new Error(`legacy retry review storage is invalid: ${formatError(error)}`);
  }
}

function reviewEvidenceIdentity(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value);
  const keys = new Set<string>();
  const pending: unknown[] = [{ item: value['item'], reason: value['reason'], ownerUserId: value['ownerUserId'] }];
  const evidence = pending[0];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry && typeof entry === 'object' && !visited.has(entry)) {
      visited.add(entry);
      for (const [key, item] of Object.entries(entry)) { keys.add(key); pending.push(item); }
    }
  }
  return JSON.stringify(evidence, [...keys].sort());
}
export function mergeLegacyRetryReviewItems(
  currentItems: unknown,
  incomingItems: unknown,
  ownerUserId: string,
): LegacyRetryReviewBackupItem[] {
  const current = parseLegacyRetryReviewItems(currentItems, ownerUserId, 'current legacyRetryReview');
  const incoming = parseLegacyRetryReviewItems(incomingItems, ownerUserId, 'backup legacyRetryReview');
  const byId = new Map(current.map(item => [item.item.id, item]));
  const byOperationId = new Map(current.map(item => [item.item.operationId, item]));

  for (const item of incoming) {
    const existingById = byId.get(item.item.id);
    const existingByOperationId = byOperationId.get(item.item.operationId);
    if ((existingById && existingById.item.operationId !== item.item.operationId)
      || (existingByOperationId && existingByOperationId.item.id !== item.item.id)) {
      throw new Error('legacy retry review identity conflict');
    }
    if (existingById) {
      const versions = Array.isArray(existingById['retainedVersions']) ? [...existingById['retainedVersions']] : [];
      const { retainedVersions: _versions, ...incomingBase } = item;
      const incomingVersions = [incomingBase, ...(Array.isArray(item['retainedVersions']) ? item['retainedVersions'] : [])];
      for (const version of incomingVersions) {
        const identity = reviewEvidenceIdentity(version);
        if (reviewEvidenceIdentity(existingById) !== identity && !versions.some(existing => reviewEvidenceIdentity(existing) === identity)) versions.push(version);
      }
      if (versions.length > 0) existingById['retainedVersions'] = versions;
    }
    if (!existingById && !existingByOperationId) {
      byId.set(item.item.id, item);
      byOperationId.set(item.item.operationId, item);
      current.push(item);
    }
  }

  return current;
}

export function ownerScopedLegacyRetryReviewStorageKey(ownerUserId: string): string {
  return `${LEGACY_RETRY_REVIEW_STORAGE_KEY_PREFIX}${ownerUserId}`;
}

export function readOwnerScopedLegacyRetryReviewStorageValue(ownerUserId: string): string | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }
  try {
    return localStorage.getItem(ownerScopedLegacyRetryReviewStorageKey(ownerUserId));
  } catch (error) {
    throw new Error(`legacy retry review localStorage read failed: ${formatError(error)}`);
  }
}

export function writeOwnerScopedLegacyRetryReviewItems(
  ownerUserId: string,
  items: unknown,
): void {
  const validated = parseLegacyRetryReviewItems(items, ownerUserId);
  if (typeof localStorage === 'undefined') {
    if (validated.length === 0) return;
    throw new Error('legacy retry review localStorage is unavailable');
  }
  const key = ownerScopedLegacyRetryReviewStorageKey(ownerUserId);
  if (validated.length === 0) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, JSON.stringify(validated));
}

export function restoreOwnerScopedLegacyRetryReviewStorageValue(
  ownerUserId: string,
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  if (value !== null) parseLegacyRetryReviewStorageValue(value, ownerUserId);
  if (typeof localStorage === 'undefined') {
    if (value === null) return;
    throw new Error('legacy retry review localStorage is unavailable');
  }
  const key = ownerScopedLegacyRetryReviewStorageKey(ownerUserId);
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
