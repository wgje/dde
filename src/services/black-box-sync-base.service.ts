import { FOCUS_CONFIG } from '../config/focus.config';
import { SYNC_CONFIG } from '../config/sync.config';
import { SessionManagerService } from '../core-bridge';
import { type BlackBoxEntry } from '../models/focus';
import { type TablesInsert, type TablesUpdate } from '../types/supabase';
import { AuthService } from './auth.service';
import { type BlackBoxSyncCursor } from './black-box-sync-cursor';
import { type BlackBoxCompletedDeltaPullResult, type BlackBoxDeltaPage, type BlackBoxDeltaPageCursorOutcome, type BlackBoxDeltaPullContext, type BlackBoxDeltaPullResult, type BlackBoxMergeMode, type BlackBoxPullContext, type BlackBoxPullCursorWindowOutcome, type BlackBoxPullGuardOutcome, type BlackBoxPullInFlightOutcome, type BlackBoxPushGuardOutcome, type BlackBoxPushPreflightConflictOutcome, type BlackBoxPushPreflightDoneOutcome, type BlackBoxPushPreflightOutcome, type BlackBoxPushPreflightRowOutcome, type BlackBoxPushPreparedEntryOutcome, type BlackBoxRemotePullPreparationOutcome, type BlackBoxRemoteReconcileReason, type BlackBoxSupabaseClient, type BlackBoxUpsertWriteResult, type BlackBoxWidgetNotifyAction, type IDBBlackBoxEntry, type LoadBlackBoxLocalOptions, type PullChangesOptions, type RetryQueueHandler, type ScheduleBlackBoxSyncOptions } from './black-box-sync.types';
import { ClockSyncService } from './clock-sync.service';
import { DockDirectWidgetNotifyOutboxService } from './dock-direct-widget-notify-outbox.service';
import { LoggerService } from './logger.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { SupabaseClientService } from './supabase-client.service';
import { SyncRpcClientService, type SyncRpcResult } from './sync-rpc-client.service';
import { DestroyRef, inject } from '@angular/core';
import { type RealtimeChannel } from '@supabase/supabase-js';

export abstract class BlackBoxSyncBase {
  protected static readonly REALTIME_CIRCUIT_STORAGE_KEY = 'nanoflow.realtime-transport-circuit';
  protected static readonly REALTIME_CIRCUIT_TTL_MS = 30 * 60 * 1000;
  protected static readonly REALTIME_MAX_CONSECUTIVE_ERRORS = 3;
  protected static readonly ENSURE_LATEST_LOCAL_REENTRY_WINDOW_MS: number = 30_000;
  protected static readonly ENSURE_LATEST_LOCAL_REENTRY_WARN_THRESHOLD: number = 3;

  protected supabase = inject(SupabaseClientService);
  protected network = inject(NetworkAwarenessService);
  protected auth = inject(AuthService);
  protected readonly clockSync = inject(ClockSyncService);
  protected readonly sessionManager = inject(SessionManagerService);
  protected readonly loggerService = inject(LoggerService);
  protected readonly logger = this.loggerService.category('BlackBoxSync');
  protected readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  protected readonly syncRpcClient = inject(SyncRpcClientService, { optional: true });
  protected readonly directWidgetNotifyOutbox = inject(DockDirectWidgetNotifyOutboxService);
  protected readonly destroyRef = inject(DestroyRef);

  protected db: IDBDatabase | null = null;
  protected lastSyncTime: string | null = null;
  protected lastSyncCursor: BlackBoxSyncCursor | null = null;

  /** RetryQueue 集成回调，由 SimpleSyncService 注入 */
  protected retryQueueHandler: RetryQueueHandler | null = null;

  /** 防抖定时器（合并短时间内的多次写入） */
  protected pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  protected pendingPushEntries: Map<string, BlackBoxEntry> = new Map();
  protected shouldRecoverAfterAuthSettles = false;

  // 防重保护：single-flight + freshness window
  protected pullInFlight: Promise<boolean> | null = null;
  protected activePullOptions: PullChangesOptions | null = null;
  protected queuedForcedGateReviewPullPromise: Promise<void> | null = null;
  protected queuedForcedGateReviewPullGuard: Pick<PullChangesOptions, 'expectedUserId' | 'expectedRealtimeGeneration'> | null = null;
  protected queuedForcedGateReviewPullVersion = 0;
  /** 上次成功拉取的时间戳（毫秒），用于 freshness window 判断 */
  protected lastPullTime = 0;
  protected lastResumePullAt = 0;
  protected currentSyncUserId: string | null = null;

  protected readonly IDB_NAME = FOCUS_CONFIG.SYNC.IDB_NAME;
  protected readonly IDB_VERSION = FOCUS_CONFIG.SYNC.IDB_VERSION;
  protected readonly STORE_NAME = FOCUS_CONFIG.IDB_STORES.BLACK_BOX_ENTRIES;
  protected readonly DEBOUNCE_DELAY = SYNC_CONFIG.DEBOUNCE_DELAY;
  protected readonly BLACKBOX_PULL_PAGE_SIZE = 200;
  protected readonly BLACKBOX_PULL_MAX_PAGES = 10;
  protected readonly BLACKBOX_PULL_MAX_DURATION_MS = 20_000;
  protected readonly BLACKBOX_ENTRY_SELECT_COLUMNS =
    'id, project_id, user_id, content, focus_meta, date, created_at, updated_at, completed_at, is_read, is_completed, is_archived, snooze_until, snooze_count, deleted_at';
  protected initIndexedDBPromise: Promise<void> | null = null;
  protected realtimeChannel: RealtimeChannel | null = null;
  protected realtimeSubscribedUserId: string | null = null;
  protected realtimeDesiredUserId: string | null = null;
  protected realtimeSubscriptionGeneration = 0;
  protected realtimeConsecutiveErrors = 0;
  protected realtimeCircuitRetryTimer: ReturnType<typeof setTimeout> | null = null;

  protected abstract isRemoteUnavailable(): boolean;
  protected abstract getRealtimeCircuitSnapshot(userId: string): { remainingMs: number; failures: number; lastError: string | null };
  protected abstract armRealtimeCircuit(userId: string, errorMessage: string | undefined, consecutiveErrors: number): number;
  protected abstract clearRealtimeCircuitRetryTimer(): void;
  protected abstract scheduleRealtimeCircuitRetry(userId: string, delayMs: number, generation: number): void;
  protected abstract setupAuthRecoveryEffect(): void;
  protected abstract setupSyncCursorScopeEffect(): void;
  protected abstract setupRealtimeSubscriptionEffect(): void;
  protected abstract getLastSyncTimeKey(userId: string): string;
  protected abstract parseStoredSyncCursor(value: unknown): BlackBoxSyncCursor | null;
  protected abstract compareBlackBoxCursor(left: BlackBoxSyncCursor, right: BlackBoxSyncCursor): number;
  protected abstract computeBlackBoxCursorFromRows(rows: Array<Record<string, unknown>>): BlackBoxSyncCursor | null;
  protected abstract commitBlackBoxCursorFromRows(
    rows: Array<Record<string, unknown>>,
    expectedUserId: string,
  ): Promise<void>;
  protected abstract commitBlackBoxCursor(
    nextCursor: BlackBoxSyncCursor | null,
    expectedUserId: string,
  ): Promise<void>;
  abstract setRetryQueueHandler(handler: RetryQueueHandler): void;
  protected abstract recoverPendingEntries(): Promise<void>;
  protected abstract getValidPendingEntries(entries: BlackBoxEntry[]): BlackBoxEntry[];
  protected abstract resolvePendingEntriesForRecovery(entries: BlackBoxEntry[]): Promise<BlackBoxEntry[]>;
  protected abstract initIndexedDB(): Promise<void>;
  protected abstract ensureFocusModeStores(db: IDBDatabase): void;
  protected abstract loadLastSyncTime(userId?: string | null): Promise<void>;
  protected abstract persistBlackBoxCursorIfNewer(cursor: BlackBoxSyncCursor): Promise<BlackBoxSyncCursor | null>;
  protected abstract syncCursorScope(userId: string | null): Promise<void>;
  protected abstract setupNetworkListener(): void;
  abstract scheduleSync(entry: BlackBoxEntry, options?: ScheduleBlackBoxSyncOptions): Promise<void>;
  protected abstract schedulePendingPushFlush(): void;
  protected abstract pushImmediateGateAction(entry: BlackBoxEntry, widgetNotifyAction?: BlackBoxWidgetNotifyAction): Promise<void>;
  protected abstract enqueueEntryForRetry(entry: BlackBoxEntry): Promise<void>;
  protected abstract hasUsableDirectWidgetNotifySession(context: Record<string, unknown>): Promise<boolean>;
  protected abstract sendDirectWidgetBlackBoxNotify(entry: BlackBoxEntry, action?: BlackBoxWidgetNotifyAction): Promise<void>;
  protected abstract buildDirectWidgetNotifyRequest(entry: BlackBoxEntry, action: BlackBoxWidgetNotifyAction): { timeout: number; body: { directNotify: true; table: 'black_box_entries'; webhookId: string; entryId: string; blackBoxAction: BlackBoxWidgetNotifyAction; updatedAt: string } };
  protected abstract flushPendingToRetryQueue(): Promise<void>;
  protected abstract syncRealtimeSubscription(userId: string | null, generation: number): Promise<void>;
  protected abstract shouldSkipRealtimeSubscriptionForCircuit(userId: string, generation: number): boolean;
  protected abstract createBlackBoxRealtimeChannel(client: BlackBoxSupabaseClient, userId: string, generation: number): RealtimeChannel;
  protected abstract handleBlackBoxRealtimePayload(payload: { eventType?: string; new?: unknown; old?: unknown }, userId: string, generation: number): void;
  protected abstract handleBlackBoxRealtimeStatus(context: {
    status: string;
    error?: { message?: string };
    channel: RealtimeChannel;
    channelName: string;
    client: BlackBoxSupabaseClient;
    userId: string;
    generation: number;
  }): void;
  protected abstract shouldIgnoreRealtimeStatusDuringBrowserSuspend(
    status: string,
    error: { message?: string } | undefined,
    channelName: string,
  ): boolean;
  protected abstract handleBlackBoxRealtimeTransportError(
    status: string,
    error: { message?: string } | undefined,
    channelName: string,
    userId: string,
  ): void;
  protected abstract teardownRealtimeSubscription(): Promise<void>;
  abstract saveToLocal(entry: BlackBoxEntry): Promise<void>;
  abstract markEntrySyncConflict(entry: BlackBoxEntry): Promise<void>;
  protected abstract selfHealOwnerMismatchedEntry(entry: BlackBoxEntry, sessionUserId: string, sourceUserId: string | undefined): Promise<void>;
  protected abstract rebrandLocalModeOwnerAndRetry(entry: BlackBoxEntry, sessionUserId: string): Promise<void>;
  protected abstract deleteInvalidOwnerEntry(entry: BlackBoxEntry): Promise<void>;
  protected abstract markOwnerMismatchConflict(entry: BlackBoxEntry): Promise<void>;
  protected abstract upgradeEquivalentLatestLocalToSynced(latestLocal: BlackBoxEntry, pushedEntry: BlackBoxEntry, serverUpdatedAt: string | null, source: 'rpc' | 'upsert'): Promise<void>;
  protected abstract ensureLatestLocalEnqueued(
    latestLocal: BlackBoxEntry,
    reason: 'merge-monotonic' | 'upgrade-non-equivalent' | 'skip-stale-queued-entry',
  ): Promise<void>;
  abstract deleteFromLocal(id: string): Promise<void>;
  protected abstract loadEntryFromLocal(id: string): Promise<BlackBoxEntry | null>;
  protected abstract isEntryNewer(left: BlackBoxEntry, right: BlackBoxEntry): boolean;
  protected abstract resolveLatestLocalEntry(id: string): Promise<BlackBoxEntry | null>;
  protected abstract hasMeaningfulContent(content: unknown): content is string;
  protected abstract isBlankOrMissingContent(content: unknown): boolean;
  protected abstract hydrateBlankContentFromSource(
    entry: BlackBoxEntry,
    source: BlackBoxEntry | null | undefined,
    sourceLabel: 'latest-local' | 'server-preflight' | 'local-merge' | 'local-idb',
  ): BlackBoxEntry;
  protected abstract isExpectedRealtimeContextCurrent(expectedUserId?: string, expectedRealtimeGeneration?: number): boolean;
  protected abstract getPendingEntriesForRemoteReconciliation(entries?: BlackBoxEntry[]): BlackBoxEntry[];
  protected abstract hasSameInstant(left: string | null | undefined, right: string | null | undefined): boolean;
  protected abstract hasEquivalentEntryState(local: BlackBoxEntry, remote: BlackBoxEntry): boolean;
  protected abstract reconcilePendingEntriesWithServer(client: BlackBoxSupabaseClient, preferRemoteForSyncedLocalDuringPull: boolean, repairingFutureCursor: boolean, expectedUserId?: string, expectedRealtimeGeneration?: number, sourcePendingEntries?: BlackBoxEntry[], mergeMode?: BlackBoxMergeMode): Promise<void>;
  protected abstract canStartPendingReconciliation(expectedUserId?: string, expectedRealtimeGeneration?: number): boolean;
  protected abstract fetchPendingReconcileRows(
    client: BlackBoxSupabaseClient,
    sessionUserId: string,
    pendingIds: string[],
  ): Promise<unknown[] | null>;
  protected abstract reconcilePendingRemoteRow(
    row: unknown,
    sourcePendingEntryMap: Map<string, BlackBoxEntry> | null,
    preferRemoteForSyncedLocalDuringPull: boolean,
    repairingFutureCursor: boolean,
    mergeMode: BlackBoxMergeMode,
  ): Promise<void>;
  abstract loadFromLocal(options?: LoadBlackBoxLocalOptions): Promise<BlackBoxEntry[]>;
  protected abstract readAllLocalEntries(): Promise<BlackBoxEntry[]>;
  protected abstract stripLocalEntryVersions(entries: IDBBlackBoxEntry[]): BlackBoxEntry[];
  protected abstract hydrateLocalEntriesForVisibleUser(entries: BlackBoxEntry[], options: LoadBlackBoxLocalOptions): Promise<BlackBoxEntry[]>;
  protected abstract resolveVisibleUserId(): string | null;
  protected abstract readLocalModeCacheKey(): string | null;
  protected abstract isAuthSettling(): boolean;
  protected abstract resolveRemoteSessionUserId(): string | null;
  protected abstract shouldUseSyncRpc(): boolean;
  protected abstract handleBlackBoxSyncRpcResult(result: SyncRpcResult, entry: BlackBoxEntry, client: BlackBoxSupabaseClient, sessionUserId: string): Promise<boolean>;
  protected abstract handleAppliedBlackBoxSyncRpcResult(result: SyncRpcResult, entry: BlackBoxEntry, client: BlackBoxSupabaseClient, sessionUserId: string): Promise<boolean>;
  protected abstract reconcileStaleAppliedBlackBoxSyncRpcResult(client: BlackBoxSupabaseClient, entry: BlackBoxEntry, sessionUserId: string): Promise<boolean>;
  protected abstract saveAppliedBlackBoxSyncRpcEntry(entry: BlackBoxEntry, serverUpdatedAt: string | null): Promise<void>;
  protected abstract handleRemoteNewerBlackBoxSyncRpcResult(result: SyncRpcResult, entry: BlackBoxEntry, client: BlackBoxSupabaseClient, sessionUserId: string): Promise<boolean>;
  protected abstract logRejectedBlackBoxSyncRpcResult(result: SyncRpcResult, entry: BlackBoxEntry): void;
  protected abstract reconcileAuthoritativeRemoteEntry(client: BlackBoxSupabaseClient, entry: BlackBoxEntry, sessionUserId: string, reason: BlackBoxRemoteReconcileReason): Promise<boolean>;
  protected abstract fetchRemoteEntryById(
    client: BlackBoxSupabaseClient,
    entryId: string,
    sessionUserId: string,
    reason: string,
  ): Promise<BlackBoxEntry | null>;
  abstract pushToServer(entry: BlackBoxEntry, sourceUserId?: string, operationId?: string): Promise<boolean>;
  protected abstract guardBlackBoxPush(entry: BlackBoxEntry, sourceUserId?: string): Promise<BlackBoxPushGuardOutcome>;
  protected abstract cleanupInvalidBlackBoxPushEntry(message: string, entryId: string): Promise<BlackBoxPushPreflightDoneOutcome>;
  protected abstract prepareBlackBoxEntryForPush(
    entry: BlackBoxEntry,
    sessionUserId: string,
  ): Promise<BlackBoxPushPreparedEntryOutcome>;
  protected abstract runBlackBoxPushPreflight(client: BlackBoxSupabaseClient, entry: BlackBoxEntry, sessionUserId: string): Promise<BlackBoxPushPreflightOutcome>;
  protected abstract pushBlackBoxEntryWithUpsert(
    client: BlackBoxSupabaseClient,
    entry: BlackBoxEntry,
    sessionUserId: string,
    preflightServerEntry: BlackBoxEntry | null,
  ): Promise<boolean>;
  protected abstract writeBlackBoxEntryByPreflightState(
    client: BlackBoxSupabaseClient,
    entry: BlackBoxEntry,
    sessionUserId: string,
    preflightServerEntry: BlackBoxEntry | null,
  ): Promise<BlackBoxUpsertWriteResult>;
  protected abstract updateExistingBlackBoxEntryWithCas(
    client: BlackBoxSupabaseClient,
    entry: BlackBoxEntry,
    sessionUserId: string,
    baseUpdatedAt: string,
  ): Promise<BlackBoxUpsertWriteResult>;
  protected abstract insertNewBlackBoxEntry(client: BlackBoxSupabaseClient, entry: BlackBoxEntry): Promise<BlackBoxUpsertWriteResult>;
  protected abstract applyBlackBoxUpsertSuccess(entry: BlackBoxEntry, serverUpdatedAt: string): Promise<void>;
  protected abstract buildBlackBoxInsertPayload(entry: BlackBoxEntry): TablesInsert<'black_box_entries'>;
  protected abstract buildBlackBoxUpdatePayload(entry: BlackBoxEntry): TablesUpdate<'black_box_entries'>;
  protected abstract fetchBlackBoxPushPreflightRow(client: BlackBoxSupabaseClient, entry: BlackBoxEntry, sessionUserId: string): Promise<BlackBoxPushPreflightRowOutcome>;
  protected abstract handleBlackBoxPushPreflightServerRow(entry: BlackBoxEntry, serverRow: unknown): Promise<BlackBoxPushPreflightConflictOutcome>;
  protected abstract resolveBlackBoxPushPreflightConflict(entry: BlackBoxEntry, serverEntry: BlackBoxEntry): Promise<BlackBoxPushPreflightConflictOutcome>;
  protected abstract resolveBlackBoxPreflightTimestampState(
    entry: BlackBoxEntry,
    serverEntry: BlackBoxEntry,
  ): Promise<
    | { clockReliable: boolean; rawServerMs: number; rawLocalMs: number }
    | 'defer'
    | 'server-arbitrated'
  >;
  protected abstract mergeBlackBoxPreflightMonotonicFacts(
    entry: BlackBoxEntry,
    serverEntry: BlackBoxEntry,
    serverIsNewer: boolean,
  ): BlackBoxEntry | null;
  protected abstract applyBlackBoxPreflightRemoteAuthority(
    entry: BlackBoxEntry,
    serverEntry: BlackBoxEntry,
    reason: 'server-newer-lww' | 'monotonic-regression',
  ): Promise<BlackBoxPushPreflightDoneOutcome>;
  protected abstract persistBlackBoxPreflightMonotonicMerge(
    entry: BlackBoxEntry,
    serverEntry: BlackBoxEntry,
    mergedEntry: BlackBoxEntry,
  ): Promise<BlackBoxPushPreflightConflictOutcome>;
  abstract pullChanges(options?: PullChangesOptions): Promise<void>;
  protected abstract loadLocalIfBlackBoxRemoteUnavailable(): Promise<boolean>;
  protected abstract createBlackBoxPullContext(options?: PullChangesOptions): BlackBoxPullContext;
  protected abstract guardBlackBoxPull(context: BlackBoxPullContext, options?: PullChangesOptions): Promise<BlackBoxPullGuardOutcome>;
  protected abstract shouldSkipBlackBoxPullForSession(context: BlackBoxPullContext): Promise<boolean>;
  protected abstract resolveBlackBoxPullClockPreference(reason: NonNullable<PullChangesOptions['reason']>): Promise<boolean>;
  protected abstract shouldSkipBlackBoxPullForCooldown(context: BlackBoxPullContext): boolean;
  protected abstract shouldSkipBlackBoxPullForFreshness(context: BlackBoxPullContext): boolean;
  protected abstract reportBlackBoxDuplicatePullBlocked(
    reason: NonNullable<PullChangesOptions['reason']>,
    elapsedSec: number,
    freshnessWindow: number,
  ): void;
  protected abstract handleBlackBoxPullInFlight(context: BlackBoxPullContext): Promise<BlackBoxPullInFlightOutcome>;
  protected abstract queueForcedGateReviewPull(guard?: Pick<PullChangesOptions, 'expectedUserId' | 'expectedRealtimeGeneration'>): Promise<void>;
  protected abstract doPullChanges(preferRemoteForSyncedLocalDuringPull: boolean, expectedUserId?: string, expectedRealtimeGeneration?: number): Promise<boolean>;
  protected abstract finishBlackBoxDeltaPull(context: BlackBoxDeltaPullContext, result: BlackBoxCompletedDeltaPullResult): Promise<boolean>;
  protected abstract pullBlackBoxDeltaPages(context: BlackBoxDeltaPullContext): Promise<BlackBoxDeltaPullResult>;
  protected abstract isBlackBoxPullBudgetExhausted(pulledPageCount: number, pullStartedAt: number): boolean;
  protected abstract logBlackBoxPullBudgetExhausted(pulledPageCount: number, pulledRowCount: number): void;
  protected abstract fetchBlackBoxDeltaPageWithSessionRetry(
    context: BlackBoxDeltaPullContext,
    cursor: BlackBoxSyncCursor,
    upperWatermark: string | null,
  ): Promise<BlackBoxDeltaPage>;
  protected abstract mergeBlackBoxDeltaPageRows(
    rows: Record<string, unknown>[],
    context: BlackBoxDeltaPullContext,
  ): Promise<boolean>;
  protected abstract resolveNextBlackBoxDeltaPageCursor(
    rows: Record<string, unknown>[],
    expectedUserId: string,
  ): Promise<BlackBoxDeltaPageCursorOutcome>;
  protected abstract handleBlackBoxPullError(error: unknown): Promise<boolean>;
  protected abstract prepareBlackBoxRemotePull(expectedUserId?: string, expectedRealtimeGeneration?: number): Promise<BlackBoxRemotePullPreparationOutcome>;
  protected abstract resolveBlackBoxPullCursorWindow(
    client: BlackBoxSupabaseClient,
    expectedUserId: string,
    expectedRealtimeGeneration?: number,
  ): Promise<BlackBoxPullCursorWindowOutcome>;
  protected abstract resolveBlackBoxWatermarkFastPath(
    remoteWatermark: string | null,
    remoteMs: number,
    localMs: number,
    effectiveLastSync: string,
    pendingEntriesNeedRemoteReconciliation: boolean,
    expectedUserId: string,
    expectedRealtimeGeneration?: number,
  ): Promise<BlackBoxPullCursorWindowOutcome | null>;
  protected abstract fetchBlackBoxDeltaPage(
    client: BlackBoxSupabaseClient,
    cursor: BlackBoxSyncCursor,
    upperWatermark: string | null,
    expectedUserId: string,
  ): Promise<BlackBoxDeltaPage>;
  protected abstract createBlackBoxScopedQueryUnavailableError(): Error;
  protected abstract isBlackBoxScopedQueryUnavailable(error: unknown): boolean;
  protected getOptionalQueryMethod<TArgs extends unknown[]>(
    target: unknown,
    methodName: string,
  ): ((...args: TArgs) => unknown) | undefined {
    const targetObject = target as Record<string, unknown>;
    const candidate = targetObject[methodName];
    if (typeof candidate !== 'function') {
      return undefined;
    }

    return (...args: TArgs) => Reflect.apply(candidate, target as object, args);
  }

  protected abstract getRemoteBlackBoxWatermark(client: BlackBoxSupabaseClient): Promise<string | null>;
  protected abstract mergeWithLocal(remoteEntry: BlackBoxEntry, preferRemoteForSyncedLocalDuringPull?: boolean, repairingFutureCursor?: boolean, mergeMode?: BlackBoxMergeMode): Promise<void>;
  protected abstract saveMonotonicPendingMerge(localEntry: BlackBoxEntry, remoteEntry: BlackBoxEntry, merged: BlackBoxEntry): Promise<void>;
  protected abstract canConvergeMonotonicMergeToRemote(merged: BlackBoxEntry, remote: BlackBoxEntry): boolean;
  protected abstract mapRowToEntry(row: Record<string, unknown>): BlackBoxEntry;
  abstract getPendingSyncCount(): number;
  abstract forceSync(): Promise<void>;
}
