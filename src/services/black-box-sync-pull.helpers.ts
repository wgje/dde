import type { BlackBoxEntry } from '../models/focus';
import {
  createSafeBlackBoxKeysetFilter,
  isBlackBoxCursorRow,
  isValidBlackBoxCursor,
  type BlackBoxSyncCursor,
} from './black-box-sync-cursor';
import type {
  BlackBoxDeltaPage,
  BlackBoxDeltaPageCursorOutcome,
  BlackBoxPullContext,
  BlackBoxPullReason,
  BlackBoxSupabaseClient,
  PullChangesOptions,
} from './black-box-sync.types';

export interface MonotonicMergeConvergenceChecks {
  hasEquivalentEntryState: (merged: BlackBoxEntry, remote: BlackBoxEntry) => boolean;
  isLocalNewer: (localUpdatedAt: string, remoteUpdatedAt: string) => boolean;
}

export interface BlackBoxInFlightSnapshot {
  reason?: BlackBoxPullReason;
  force?: boolean;
  expectedUserId?: string;
  expectedRealtimeGeneration?: number;
}

export type BlackBoxInFlightAction = 'continue' | 'queue-forced-gate-review' | 'reuse';

export interface BlackBoxPullCooldownOptions {
  enabled: boolean;
  now: number;
  lastResumePullAt: number;
  cooldownMs: number;
}

export interface BlackBoxPullFreshnessOptions {
  now: number;
  lastPullTime: number;
  freshnessWindowMs: number;
}

export interface CreateBlackBoxPullContextInput {
  options?: PullChangesOptions;
  resolvedSessionUserId?: string | null;
  pendingEntriesNeedRemoteReconciliation: boolean;
}

export type BlackBoxPullFreshnessSkip =
  | { skip: false }
  | { skip: true; elapsedSec: number; freshnessWindowSec: number };

export interface BlackBoxCursorWindowProbe {
  effectiveLastSync: string;
  repairingFutureCursor: boolean;
  remoteMs: number;
  localMs: number;
  futureCursorWarning?: {
    localCursor: string;
    remoteWatermark: string;
  };
}

export interface BlackBoxWatermarkFastPathInput {
  remoteWatermark: string | null;
  remoteMs: number;
  localMs: number;
  effectiveLastSync: string;
  lastSyncCursorId: string | undefined;
  pendingEntriesNeedRemoteReconciliation: boolean;
}

export interface BlackBoxDeltaPageCursorDecision {
  outcome: BlackBoxDeltaPageCursorOutcome;
  missingCursorWarning?: {
    hasUpdatedAt: boolean;
    hasId: boolean;
  };
}

export interface BlackBoxDeltaPageQueryOptions {
  client: {
    from(table: string): { select(columns: string): unknown };
  } | null;
  cursor: BlackBoxSyncCursor;
  upperWatermark: string | null;
  expectedUserId: string;
  selectColumns: string;
  pageSize: number;
  scopedQueryUnavailableError: Error;
  warn: (message: string, details?: Record<string, unknown>) => void;
  getOptionalQueryMethod: <TArgs extends unknown[]>(
    target: unknown,
    methodName: string,
  ) => ((...args: TArgs) => unknown) | undefined;
}

export interface BlackBoxRemoteWatermarkLogger {
  debug(message: string, data?: Record<string, unknown>): void;
}

export type BlackBoxMergeDecision =
  | { action: 'use-remote'; local: BlackBoxEntry | undefined }
  | { action: 'merge-monotonic'; local: BlackBoxEntry; merged: BlackBoxEntry }
  | { action: 'keep-local'; local: BlackBoxEntry };

export function mergeRemoteMonotonicFactsIntoPending(
  local: BlackBoxEntry,
  remote: BlackBoxEntry,
): BlackBoxEntry | null {
  if (local.syncStatus !== 'pending') {
    return null;
  }

  const wouldRegressRead = remote.isRead && !local.isRead;
  const wouldRegressCompleted = remote.isCompleted && !local.isCompleted;
  const wouldResurrectDeleted = Boolean(remote.deletedAt) && !local.deletedAt;
  if (!wouldRegressRead && !wouldRegressCompleted && !wouldResurrectDeleted) {
    return null;
  }

  return {
    ...local,
    isRead: local.isRead || remote.isRead,
    isCompleted: local.isCompleted || remote.isCompleted,
    completedAt: local.completedAt ?? remote.completedAt ?? null,
    deletedAt: local.deletedAt ?? remote.deletedAt,
    syncStatus: 'pending',
  };
}

export function applyBlackBoxCursorSafetyLookback(effectiveLastSync: string, lookbackMs: number): string {
  const effectiveLastSyncMs = new Date(effectiveLastSync).getTime();
  if (!Number.isFinite(effectiveLastSyncMs) || effectiveLastSync === '1970-01-01T00:00:00Z') {
    return effectiveLastSync;
  }

  return new Date(Math.max(0, effectiveLastSyncMs - lookbackMs)).toISOString();
}

export function canConvergeMonotonicMergeToRemote(
  merged: BlackBoxEntry,
  remote: BlackBoxEntry,
  checks: MonotonicMergeConvergenceChecks,
): boolean {
  return checks.hasEquivalentEntryState(merged, remote)
    && !checks.isLocalNewer(merged.updatedAt, remote.updatedAt);
}

export function createBlackBoxPullContext(input: CreateBlackBoxPullContextInput): BlackBoxPullContext {
  return {
    reason: input.options?.reason ?? 'manual',
    force: input.options?.force ?? false,
    expectedUserId: input.options?.expectedUserId ?? input.resolvedSessionUserId ?? undefined,
    expectedRealtimeGeneration: input.options?.expectedRealtimeGeneration,
    pendingEntriesNeedRemoteReconciliation: input.pendingEntriesNeedRemoteReconciliation,
  };
}

export function mapBlackBoxRowToEntry(
  row: Record<string, unknown>,
  now: () => Date = () => new Date(),
): BlackBoxEntry {
  const fallbackNow = now().toISOString();
  return {
    id: row['id'] as string,
    projectId: (row['project_id'] as string | null) ?? null,
    userId: (row['user_id'] as string) || '',
    content: (row['content'] as string) || '',
    focusMeta: (row['focus_meta'] as BlackBoxEntry['focusMeta']) ?? null,
    date: (row['date'] as string) || fallbackNow.split('T')[0],
    createdAt: (row['created_at'] as string) || fallbackNow,
    updatedAt: (row['updated_at'] as string) || fallbackNow,
    completedAt: (row['completed_at'] as string | null) ?? null,
    isRead: (row['is_read'] as boolean) ?? false,
    isCompleted: (row['is_completed'] as boolean) ?? false,
    isArchived: (row['is_archived'] as boolean) ?? false,
    snoozeUntil: row['snooze_until'] as string | undefined,
    snoozeCount: row['snooze_count'] as number | undefined,
    deletedAt: row['deleted_at'] as string | null,
    syncStatus: 'synced',
  };
}

export function resolveNextBlackBoxDeltaPageCursor(
  pageRows: Record<string, unknown>[],
  pageSize: number,
): BlackBoxDeltaPageCursorDecision {
  if (pageRows.length < pageSize) {
    return { outcome: { status: 'done' } };
  }

  const lastRow = pageRows[pageRows.length - 1];
  if (isBlackBoxCursorRow(lastRow)) {
    return {
      outcome: {
        status: 'continue',
        pageCursor: { updatedAt: lastRow['updated_at'], id: lastRow['id'] },
      },
    };
  }

  return {
    outcome: { status: 'done' },
    missingCursorWarning: {
      hasUpdatedAt: typeof lastRow?.['updated_at'] === 'string',
      hasId: typeof lastRow?.['id'] === 'string',
    },
  };
}

export function resolveBlackBoxInFlightAction(
  pullInFlight: boolean,
  activePullOptions: BlackBoxInFlightSnapshot | null,
  context: BlackBoxPullContext,
): BlackBoxInFlightAction {
  if (!pullInFlight) {
    return 'continue';
  }

  const inFlightReason = activePullOptions?.reason ?? 'manual';
  const inFlightForce = activePullOptions?.force ?? false;
  const inFlightExpectedUserId = activePullOptions?.expectedUserId;
  const inFlightExpectedRealtimeGeneration = activePullOptions?.expectedRealtimeGeneration;
  const hasGenerationGuardMismatch =
    inFlightExpectedRealtimeGeneration !== context.expectedRealtimeGeneration
    && (
      inFlightExpectedRealtimeGeneration != null
      || context.expectedRealtimeGeneration != null
    );
  const hasGuardMismatch = inFlightExpectedUserId !== context.expectedUserId
    || hasGenerationGuardMismatch;

  if (hasGuardMismatch) {
    return 'queue-forced-gate-review';
  }

  if ((context.reason === 'gate-review' || context.force) && (inFlightReason !== 'gate-review' || !inFlightForce)) {
    return 'queue-forced-gate-review';
  }

  return 'reuse';
}

export function mergeQueuedForcedGateReviewPullGuard(
  previousGuard: Pick<PullChangesOptions, 'expectedUserId' | 'expectedRealtimeGeneration'> | null,
  guard?: Pick<PullChangesOptions, 'expectedUserId' | 'expectedRealtimeGeneration'>,
): Pick<PullChangesOptions, 'expectedUserId' | 'expectedRealtimeGeneration'> {
  const nextExpectedUserId = guard?.expectedUserId ?? previousGuard?.expectedUserId;
  const shouldResetGeneration = guard !== undefined
    && guard.expectedRealtimeGeneration == null;
  return {
    expectedUserId: nextExpectedUserId,
    expectedRealtimeGeneration: shouldResetGeneration
      ? guard?.expectedRealtimeGeneration
      : (guard?.expectedRealtimeGeneration ?? previousGuard?.expectedRealtimeGeneration),
  };
}

export function shouldSkipBlackBoxPullForCooldown(
  context: BlackBoxPullContext,
  options: BlackBoxPullCooldownOptions,
): boolean {
  return options.enabled
    && context.reason === 'resume'
    && !context.force
    && !context.pendingEntriesNeedRemoteReconciliation
    && options.lastResumePullAt > 0
    && options.now - options.lastResumePullAt < options.cooldownMs;
}

export function resolveBlackBoxPullFreshnessSkip(
  context: BlackBoxPullContext,
  options: BlackBoxPullFreshnessOptions,
): BlackBoxPullFreshnessSkip {
  if (
    context.force
    || context.reason === 'panel-open'
    || context.pendingEntriesNeedRemoteReconciliation
    || options.lastPullTime <= 0
    || options.now - options.lastPullTime >= options.freshnessWindowMs
  ) {
    return { skip: false };
  }

  return {
    skip: true,
    elapsedSec: Math.round((options.now - options.lastPullTime) / 1000),
    freshnessWindowSec: options.freshnessWindowMs / 1000,
  };
}

export function resolveBlackBoxCursorWindowProbe(
  effectiveLastSync: string,
  remoteWatermark: string | null,
): BlackBoxCursorWindowProbe {
  const remoteMs = remoteWatermark ? new Date(remoteWatermark).getTime() : NaN;
  const localMs = new Date(effectiveLastSync).getTime();
  if (remoteWatermark && Number.isFinite(remoteMs) && Number.isFinite(localMs) && localMs > remoteMs) {
    return {
      effectiveLastSync: '1970-01-01T00:00:00Z',
      repairingFutureCursor: true,
      remoteMs,
      localMs,
      futureCursorWarning: { localCursor: effectiveLastSync, remoteWatermark },
    };
  }

  return { effectiveLastSync, repairingFutureCursor: false, remoteMs, localMs };
}

export function shouldUseBlackBoxWatermarkFastPath(input: BlackBoxWatermarkFastPathInput): boolean {
  return Boolean(input.remoteWatermark)
    && Number.isFinite(input.remoteMs)
    && Number.isFinite(input.localMs)
    && Boolean(input.lastSyncCursorId)
    && input.remoteMs <= input.localMs
    && input.effectiveLastSync !== '1970-01-01T00:00:00Z'
    && !input.pendingEntriesNeedRemoteReconciliation;
}

export function parseBlackBoxRemoteWatermark(data: unknown): string | null {
  if (typeof data === 'string') {
    return data;
  }

  if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'string') {
    return data[0];
  }

  return null;
}

export async function readBlackBoxRemoteWatermark(
  client: BlackBoxSupabaseClient | null,
  logger: BlackBoxRemoteWatermarkLogger,
): Promise<string | null> {
  const missingWatermark: string | null = null;
  if (!client) return null;

  try {
    const { data, error } = await client.rpc('get_black_box_sync_watermark');
    if (error) {
      logger.debug('BlackBox watermark RPC 失败，降级为明细拉取', {
        message: typeof error.message === 'string' ? error.message : String(error.message),
      });
      return null;
    }
    return parseBlackBoxRemoteWatermark(data);
  } catch (error) {
    logger.debug('BlackBox watermark RPC 异常，降级为明细拉取', {
      error: error instanceof Error ? error.message : String(error),
    });
    return missingWatermark;
  }
}

export function resolveBlackBoxMergeDecision(
  local: BlackBoxEntry | undefined,
  remote: BlackBoxEntry,
  options: {
    preferRemoteForSyncedLocalDuringPull: boolean;
    repairingFutureCursor: boolean;
    isLocalNewer: (localUpdatedAt: string, remoteUpdatedAt: string) => boolean;
  },
): BlackBoxMergeDecision {
  const localWinsByLww = Boolean(local)
    && Boolean(local?.updatedAt)
    && Boolean(remote.updatedAt)
    && options.isLocalNewer(local!.updatedAt, remote.updatedAt);
  const preferRemoteForSyncedLocal = (options.preferRemoteForSyncedLocalDuringPull || options.repairingFutureCursor)
    && local?.syncStatus !== 'pending';

  if (!local || preferRemoteForSyncedLocal || !localWinsByLww) {
    return { action: 'use-remote', local };
  }

  const merged = mergeRemoteMonotonicFactsIntoPending(local, remote);
  if (merged) {
    return { action: 'merge-monotonic', local, merged };
  }

  return { action: 'keep-local', local };
}

function assertBlackBoxPageSize(pageSize: number): void {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new Error('SUPABASE_PAGE_SIZE_INVALID');
  }
}

export async function fetchBlackBoxDeltaPageQuery(
  options: BlackBoxDeltaPageQueryOptions,
): Promise<BlackBoxDeltaPage> {
  if (!options.client) {
    return { data: null, error: null };
  }

  if (!options.expectedUserId) {
    options.warn('黑匣子增量拉取缺少用户作用域，跳过远端读取');
    return { data: null, error: options.scopedQueryUnavailableError };
  }

  assertBlackBoxPageSize(options.pageSize);

  let cursor = options.cursor;
  if (!isValidBlackBoxCursor(cursor)) {
    options.warn('黑匣子分页游标无效，回退到安全全量窗口', {
      hasUpdatedAt: typeof cursor.updatedAt === 'string',
      hasId: typeof cursor.id === 'string',
    });
    cursor = { updatedAt: '1970-01-01T00:00:00Z', id: '' };
  }

  let baseQuery = options.client
    .from('black_box_entries')
    .select(options.selectColumns);
  const eqQuery = options.getOptionalQueryMethod<[string, string]>(baseQuery, 'eq');
  if (!eqQuery) {
    options.warn('黑匣子增量拉取缺少 user_id 查询能力，跳过远端读取以避免跨用户误拉', {
      hasCursorId: Boolean(cursor.id),
    });
    return { data: null, error: options.scopedQueryUnavailableError };
  }
  baseQuery = eqQuery('user_id', options.expectedUserId);

  const keysetFilter = createSafeBlackBoxKeysetFilter(cursor);
  let query = keysetFilter
    ? (baseQuery as { or(filter: string): unknown }).or(keysetFilter)
    : (baseQuery as { gt(column: string, value: string): unknown }).gt('updated_at', cursor.updatedAt);

  const lteQuery = options.getOptionalQueryMethod<[string, string]>(query, 'lte');
  if (options.upperWatermark && typeof lteQuery === 'function') {
    query = lteQuery('updated_at', options.upperWatermark);
  }

  interface BlackBoxOrderedQuery {
    order(column: string, options: { ascending: boolean }): BlackBoxOrderedQuery;
  }
  const orderedByIdQuery = (query as BlackBoxOrderedQuery)
    .order('updated_at', { ascending: true })
    .order('id', { ascending: true });
  const limitQuery = options.getOptionalQueryMethod<[number]>(orderedByIdQuery, 'limit');

  if (typeof limitQuery !== 'function') {
    return orderedByIdQuery as unknown as Promise<BlackBoxDeltaPage>;
  }

  return limitQuery(options.pageSize) as Promise<BlackBoxDeltaPage>;
}
