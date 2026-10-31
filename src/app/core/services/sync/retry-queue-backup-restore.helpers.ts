import { isSyncOperationId } from '../../../../utils/sync-operation-id';
import { isValidUUID } from '../../../../utils/validation';
import type { PersistedRetryQueueItem } from './retry-queue.types';

export interface RetryQueueValidatedRestorePolicy {
  readonly validationNow: number;
  readonly terminalEvidence: 'forbid';
}

export type RetryQueueBackupRestoreNormalization =
  | { status: 'ignored' }
  | { status: 'restorable'; item: PersistedRetryQueueItem }
  | {
    status: 'terminal';
    item: PersistedRetryQueueItem;
    reason: 'expired-on-restore' | 'max-retries-on-restore';
  };

export function resolveRetryQueueBackupRestoreValidationNow(
  policy?: RetryQueueValidatedRestorePolicy,
): number | null {
  if (!policy) {
    return null;
  }
  if (!Number.isFinite(policy.validationNow) || policy.terminalEvidence !== 'forbid') {
    rejectValidatedBackupRestore('invalid policy');
  }
  return policy.validationNow;
}

export function validateRetryQueueBackupRestoreRequest(
  items: unknown,
  ownerUserId: string,
  validatedRestore: boolean,
): items is unknown[] {
  if (Array.isArray(items) && ownerUserId.length > 0) {
    return true;
  }
  if (validatedRestore) {
    rejectValidatedBackupRestore('invalid request');
  }
  return false;
}

export function normalizeBackupRetryQueueItem(
  item: unknown,
  ownerUserId: string,
  now: number,
  limits: { maxItemAge: number; maxRetries: number },
  validatedRestore: boolean,
): RetryQueueBackupRestoreNormalization {
  if (!item || typeof item !== 'object') {
    return rejectOrIgnore(validatedRestore, 'invalid item');
  }

  const candidate = item as Partial<PersistedRetryQueueItem>;
  if (!isRestorableRetryQueueShape(candidate)
    || (validatedRestore && !isSyncOperationId(candidate.operationId))) {
    return rejectOrIgnore(validatedRestore, 'invalid item');
  }
  if (candidate.sourceUserId !== ownerUserId) {
    return rejectOrIgnore(validatedRestore, 'foreign item');
  }

  const normalized = { ...candidate, data: { ...candidate.data } };
  const expired = now - candidate.createdAt >= limits.maxItemAge;
  if (expired || candidate.retryCount >= limits.maxRetries) {
    if (validatedRestore) {
      rejectValidatedBackupRestore('terminal item');
    }
    return {
      status: 'terminal',
      item: normalized,
      reason: expired ? 'expired-on-restore' : 'max-retries-on-restore',
    };
  }
  return { status: 'restorable', item: normalized };
}

function rejectOrIgnore(
  validatedRestore: boolean,
  reason: string,
): RetryQueueBackupRestoreNormalization {
  if (validatedRestore) {
    rejectValidatedBackupRestore(reason);
  }
  return { status: 'ignored' };
}

function rejectValidatedBackupRestore(reason: string): never {
  throw new Error(`RetryQueue validated restore rejected: ${reason}`);
}

function isRestorableRetryQueueShape(
  item: Partial<PersistedRetryQueueItem>,
): item is PersistedRetryQueueItem {
  return typeof item.id === 'string'
    && isValidUUID(item.id)
    && (item.type === 'task' || item.type === 'project' || item.type === 'connection' || item.type === 'blackbox')
    && (item.operation === 'upsert' || item.operation === 'delete')
    && item.data !== undefined
    && item.data !== null
    && typeof item.data === 'object'
    && 'id' in item.data
    && typeof item.data.id === 'string'
    && isValidUUID(item.data.id)
    && typeof item.sourceUserId === 'string'
    && typeof item.retryCount === 'number'
    && Number.isFinite(item.retryCount)
    && item.retryCount >= 0
    && typeof item.createdAt === 'number'
    && Number.isFinite(item.createdAt);
}
