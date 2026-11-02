import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { SYNC_CONFIG } from '../config/sync.config';
import { type BlackBoxEntry } from '../models/focus';
import { blackBoxEntriesMap, updateBlackBoxEntry } from '../state/focus-stores';
import { isBrowserNetworkSuspendedError, isBrowserNetworkSuspendedWindow } from '../utils/browser-network-suspension';
import { supabaseErrorToError } from '../utils/supabase-error';
import {
  type BlackBoxSyncCursor,
} from './black-box-sync-cursor';
import {
  applyBlackBoxCursorSafetyLookback as applyBlackBoxCursorSafetyLookbackPure,
  canConvergeMonotonicMergeToRemote as canConvergeMonotonicMergeToRemotePure,
  createBlackBoxPullContext as createBlackBoxPullContextPure,
  fetchBlackBoxDeltaPageQuery,
  mapBlackBoxRowToEntry,
  mergeQueuedForcedGateReviewPullGuard,
  readBlackBoxRemoteWatermark,
  resolveBlackBoxCursorWindowProbe,
  resolveBlackBoxInFlightAction,
  resolveBlackBoxMergeDecision,
  resolveBlackBoxPullFreshnessSkip,
  resolveNextBlackBoxDeltaPageCursor as resolveNextBlackBoxDeltaPageCursorPure,
  shouldSkipBlackBoxPullForCooldown as shouldSkipBlackBoxPullForCooldownPure,
  shouldUseBlackBoxWatermarkFastPath,
} from './black-box-sync-pull.helpers';
import { handleBlackBoxPullErrorWithLocalFallback } from './black-box-sync-pull-error.helpers';
import { BlackBoxSyncPushLayer } from './black-box-sync-push.service';
import { type BlackBoxCompletedDeltaPullResult, type BlackBoxDeltaPage, type BlackBoxDeltaPageCursorOutcome, type BlackBoxDeltaPullContext, type BlackBoxDeltaPullResult, type BlackBoxMergeMode, type BlackBoxPullContext, type BlackBoxPullCursorWindowOutcome, type BlackBoxPullGuardOutcome, type BlackBoxPullInFlightOutcome, type BlackBoxPullReason, type BlackBoxRemotePullPreparationOutcome, type BlackBoxSupabaseClient, type PullChangesOptions } from './black-box-sync.types';
import { SupabaseClientService } from './supabase-client.service';

export abstract class BlackBoxSyncPullLayer extends BlackBoxSyncPushLayer {
  async pullChanges(options?: PullChangesOptions): Promise<void> {
    const context = this.createBlackBoxPullContext(options);
    const guard = await this.guardBlackBoxPull(context, options);
    if (guard.status === 'done') {
      return;
    }

    if (await this.loadLocalIfBlackBoxRemoteUnavailable()) {
      return;
    }

    await this.flushPendingPushesBeforeRecoveryPull(context.reason);

    const inFlight = await this.handleBlackBoxPullInFlight(context);
    if (inFlight.status === 'done') {
      return;
    }

    const { reason, force, expectedUserId, expectedRealtimeGeneration } = context;
    this.activePullOptions = { reason, force, expectedUserId, expectedRealtimeGeneration };
    this.pullInFlight = this.doPullChanges(
      guard.preferRemoteForSyncedLocalDuringPull,
      expectedUserId,
      expectedRealtimeGeneration,
    )
      .then((didAttemptRemoteRead) => {
        if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
          this.logger.info('黑匣子拉取完成后跳过 freshness 更新：Realtime 订阅上下文已变化');
          return false;
        }

        if (didAttemptRemoteRead) {
          const now = Date.now();
          this.lastPullTime = now;
          if (reason === 'resume') {
            this.lastResumePullAt = now;
          }
        }
        return didAttemptRemoteRead;
      })
      .catch((err) => {
        // 【监控 2026-02-14】拉取失败记录 Sentry breadcrumb，便于事后排查
        this.sentryLazyLoader.addBreadcrumb({
          category: 'sync.blackbox',
          message: 'Pull failed',
          level: 'warning',
          data: { reason, error: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      })
      .finally(() => {
        this.pullInFlight = null;
        this.activePullOptions = null;
      });

    await this.pullInFlight;
  }

  private async flushPendingPushesBeforeRecoveryPull(reason: BlackBoxPullReason): Promise<void> {
    if (reason !== 'resume' && reason !== 'gate-review') {
      return;
    }

    if (this.pendingPushEntries.size === 0) {
      return;
    }

    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
      this.pushDebounceTimer = null;
    }

    await this.flushPendingToRetryQueue();
  }

  protected async loadLocalIfBlackBoxRemoteUnavailable(): Promise<boolean> {
    if (this.supabase.isConfigured && this.network.isOnline() && !this.isRemoteUnavailable()) {
      return false;
    }

    this.logger.debug('Offline or unconfigured, loading from local');
    await this.loadFromLocal();
    return true;
  }

  protected createBlackBoxPullContext(options?: PullChangesOptions): BlackBoxPullContext {
    return createBlackBoxPullContextPure({
      options,
      resolvedSessionUserId: this.resolveRemoteSessionUserId(),
      pendingEntriesNeedRemoteReconciliation: this.getPendingEntriesForRemoteReconciliation().length > 0,
    });
  }

  protected async guardBlackBoxPull(
    context: BlackBoxPullContext,
    options?: PullChangesOptions,
  ): Promise<BlackBoxPullGuardOutcome> {
    const { expectedUserId, expectedRealtimeGeneration } = context;
    if (options?.expectedUserId && this.resolveRemoteSessionUserId() !== options.expectedUserId) {
      this.logger.info('黑匣子拉取在会话切换后跳过，避免旧回调先切回旧用户游标作用域');
      return { status: 'done' };
    }

    if (this.currentSyncUserId !== (expectedUserId ?? null)) {
      await this.syncCursorScope(expectedUserId ?? null);
    }

    if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
      this.logger.info('黑匣子拉取在 Realtime 订阅切换后跳过，避免旧会话覆盖当前视图');
      return { status: 'done' };
    }

    if (await this.shouldSkipBlackBoxPullForSession(context)) {
      return { status: 'done' };
    }

    const preferRemoteForSyncedLocalDuringPull = await this.resolveBlackBoxPullClockPreference(context.reason);
    if (this.shouldSkipBlackBoxPullForCooldown(context) || this.shouldSkipBlackBoxPullForFreshness(context)) {
      return { status: 'done' };
    }

    return { status: 'continue', preferRemoteForSyncedLocalDuringPull };
  }

  protected async shouldSkipBlackBoxPullForSession(context: BlackBoxPullContext): Promise<boolean> {
    const { reason } = context;
    if (reason !== 'resume' && reason !== 'gate-review') {
      return false;
    }

    const sessionSnapshot = FEATURE_FLAGS.RESUME_SESSION_SNAPSHOT_V1
      ? this.sessionManager.getRecentValidationSnapshot(10_000)
      : null;
    if (sessionSnapshot?.valid) {
      return false;
    }

    const session = await this.sessionManager.validateOrRefreshOnResume(`blackbox:${reason}`);
    if (session.deferred) {
      this.logger.info('黑匣子远端拉取延后：等待会话稳定后重试', {
        reason,
        deferredReason: session.reason ?? 'client-unready',
      });
      return true;
    }

    if (!session.ok) {
      this.logger.info('黑匣子远端拉取跳过：当前会话不可用', {
        reason,
        failureReason: session.reason,
      });
      return true;
    }

    return false;
  }

  protected async resolveBlackBoxPullClockPreference(reason: BlackBoxPullReason): Promise<boolean> {
    if (reason !== 'gate-review') {
      return false;
    }

    const clockResult = this.clockSync.lastSyncResult();
    const shouldRefreshClock = !clockResult || !clockResult.reliable || this.clockSync.needsResync();
    let effectiveClockResult = clockResult;
    const syncClock = shouldRefreshClock
      ? this.clockSync.checkClockDrift.bind(this.clockSync)
      : this.clockSync.ensureSynced.bind(this.clockSync);

    effectiveClockResult = await syncClock().catch((error: unknown) => {
      this.logger.debug('Gate review 时钟预同步失败，降级继续拉取', {
        error: error instanceof Error ? error.message : String(error),
      });
      return effectiveClockResult ?? null;
    });

    return !effectiveClockResult?.reliable;
  }

  protected shouldSkipBlackBoxPullForCooldown(context: BlackBoxPullContext): boolean {
    if (!shouldSkipBlackBoxPullForCooldownPure(context, {
      enabled: FEATURE_FLAGS.BLACKBOX_PULL_COOLDOWN_V1,
      now: Date.now(),
      lastResumePullAt: this.lastResumePullAt,
      cooldownMs: APP_LIFECYCLE_CONFIG.RESUME_PULL_COOLDOWN_MS,
    })) {
      return false;
    }

    this.logger.debug('Resume pull skipped by cooldown');
    return true;
  }

  protected shouldSkipBlackBoxPullForFreshness(context: BlackBoxPullContext): boolean {
    const freshnessWindow = SYNC_CONFIG.BLACKBOX_PULL_FRESHNESS_WINDOW;
    const freshness = resolveBlackBoxPullFreshnessSkip(context, {
      now: Date.now(),
      lastPullTime: this.lastPullTime,
      freshnessWindowMs: freshnessWindow,
    });
    if (!freshness.skip) {
      return false;
    }

    this.logger.debug(`Freshness window 内跳过拉取 (${freshness.elapsedSec}s < ${freshness.freshnessWindowSec}s)`);
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync.blackbox',
      message: `Duplicate pull blocked by freshness window (${freshness.elapsedSec}s)`,
      level: 'info',
      data: {
        reason: context.reason,
        elapsedSec: freshness.elapsedSec,
        freshnessWindow: freshness.freshnessWindowSec,
      },
    });
    if (context.reason === 'manual') {
      this.reportBlackBoxDuplicatePullBlocked(context.reason, freshness.elapsedSec, freshnessWindow);
    }
    return true;
  }

  protected reportBlackBoxDuplicatePullBlocked(
    reason: BlackBoxPullReason,
    elapsedSec: number,
    freshnessWindow: number,
  ): void {
    this.sentryLazyLoader.captureMessage('BlackBox duplicate pull blocked', {
      level: 'info',
      tags: {
        operation: 'pullChanges',
        classification: 'duplicate_blocked'
      },
      extra: {
        reason,
        elapsedSec,
        freshnessWindowSec: freshnessWindow / 1000
      }
    });
  }

  protected async handleBlackBoxPullInFlight(context: BlackBoxPullContext): Promise<BlackBoxPullInFlightOutcome> {
    const action = resolveBlackBoxInFlightAction(Boolean(this.pullInFlight), this.activePullOptions, context);
    if (action === 'continue') {
      return { status: 'continue' };
    }

    if (action === 'queue-forced-gate-review') {
      await this.queueForcedGateReviewPull(context);
      return { status: 'done' };
    }

    this.logger.debug('Pull already in progress, reusing promise');
    await this.pullInFlight;
    return { status: 'done' };
  }

  protected queueForcedGateReviewPull(guard?: Pick<PullChangesOptions, 'expectedUserId' | 'expectedRealtimeGeneration'>): Promise<void> {
    this.queuedForcedGateReviewPullGuard = mergeQueuedForcedGateReviewPullGuard(
      this.queuedForcedGateReviewPullGuard,
      guard,
    );
    this.queuedForcedGateReviewPullVersion += 1;

    if (this.queuedForcedGateReviewPullPromise) {
      return this.queuedForcedGateReviewPullPromise;
    }

    const currentPull = this.pullInFlight;
    this.queuedForcedGateReviewPullPromise = (async () => {
      if (currentPull) {
        await currentPull.catch((error: unknown) => {
          this.logger.debug('排队中的 gate-review 强制拉取忽略前序失败并继续执行', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      let processedVersion = 0;
      while (processedVersion !== this.queuedForcedGateReviewPullVersion) {
        processedVersion = this.queuedForcedGateReviewPullVersion;
        const queuedGuard = this.queuedForcedGateReviewPullGuard;
        await this.pullChanges({
          reason: 'gate-review',
          force: true,
          expectedUserId: queuedGuard?.expectedUserId,
          expectedRealtimeGeneration: queuedGuard?.expectedRealtimeGeneration,
        });
      }
    })().finally(() => {
      this.queuedForcedGateReviewPullPromise = null;
      this.queuedForcedGateReviewPullGuard = null;
      this.queuedForcedGateReviewPullVersion = 0;
    });

    return this.queuedForcedGateReviewPullPromise;
  }

  /**
   * 实际执行拉取变更的内部方法
   */
  protected async doPullChanges(
    preferRemoteForSyncedLocalDuringPull: boolean,
    expectedUserId?: string,
    expectedRealtimeGeneration?: number,
  ): Promise<boolean> {
    try {
      const preparation = await this.prepareBlackBoxRemotePull(expectedUserId, expectedRealtimeGeneration);
      if (preparation.status === 'done') {
        return preparation.result;
      }
      const { client, scopedUserId } = preparation.context;

      const cursorWindow = await this.resolveBlackBoxPullCursorWindow(client, scopedUserId, expectedRealtimeGeneration);
      if (cursorWindow.status === 'done') {
        return cursorWindow.result;
      }
      const effectiveLastSync = this.applyBlackBoxCursorSafetyLookback(cursorWindow.effectiveLastSync);

      this.logger.debug(`Pulling changes since: ${effectiveLastSync}`);

      const deltaPullContext: BlackBoxDeltaPullContext = {
        client,
        scopedUserId,
        effectiveLastSync,
        preferRemoteForSyncedLocalDuringPull,
        repairingFutureCursor: cursorWindow.repairingFutureCursor,
        expectedUserId: scopedUserId,
        expectedRealtimeGeneration,
      };
      const deltaPull = await this.pullBlackBoxDeltaPages(deltaPullContext);
      if (deltaPull.status === 'aborted') {
        return deltaPull.result;
      }

      return await this.finishBlackBoxDeltaPull(deltaPullContext, deltaPull);
    } catch (error) {
      // 【鲁棒性 2026-04-16】浏览器网络挂起：debug，不污染错误日志
      if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
        this.logger.debug('BlackBox 浏览器网络挂起，跳过本轮增量拉取');
        await this.loadFromLocal();
        return false;
      }
      this.logger.error('Pull changes error', error instanceof Error ? error.message : String(error));
      await this.loadFromLocal();
      return false;
    }
  }

  protected async finishBlackBoxDeltaPull(
    context: BlackBoxDeltaPullContext,
    deltaPull: BlackBoxCompletedDeltaPullResult,
  ): Promise<boolean> {
    if (!this.isExpectedRealtimeContextCurrent(context.expectedUserId, context.expectedRealtimeGeneration)) {
      this.logger.info('黑匣子拉取在远端返回后中止：Realtime 订阅上下文已变化');
      return false;
    }

    if (deltaPull.error) {
      return await this.handleBlackBoxPullError(deltaPull.error);
    }

    await this.reconcilePendingEntriesWithServer(
      context.client,
      context.preferRemoteForSyncedLocalDuringPull,
      context.repairingFutureCursor,
      context.scopedUserId,
      context.expectedRealtimeGeneration,
    );

    this.logger.info(`Pulled changes from server: ${deltaPull.pulledRowCount} entries`);
    return true;
  }

  protected async pullBlackBoxDeltaPages(context: BlackBoxDeltaPullContext): Promise<BlackBoxDeltaPullResult> {
    let pulledRowCount = 0;
    let error: unknown = null;
    let pageCursor: BlackBoxSyncCursor = { updatedAt: context.effectiveLastSync, id: '' };
    const upperWatermark = FEATURE_FLAGS.BLACKBOX_WATERMARK_PROBE_V1
      ? await this.getRemoteBlackBoxWatermark(context.client)
      : null;
    const pullStartedAt = Date.now();
    let pulledPageCount = 0;

    while (true) {
      if (this.isBlackBoxPullBudgetExhausted(pulledPageCount, pullStartedAt)) {
        this.logBlackBoxPullBudgetExhausted(pulledPageCount, pulledRowCount);
        break;
      }

      const page = await this.fetchBlackBoxDeltaPageWithSessionRetry(context, pageCursor, upperWatermark);
      error = page.error;
      if (error) break;

      const pageRows = (page.data ?? []) as Record<string, unknown>[];
      pulledPageCount += 1;
      pulledRowCount += pageRows.length;

      const merged = await this.mergeBlackBoxDeltaPageRows(pageRows, context);
      if (!merged) {
        return { status: 'aborted', result: false };
      }

      const cursorOutcome = await this.resolveNextBlackBoxDeltaPageCursor(pageRows, context.scopedUserId);
      if (cursorOutcome.status === 'done') {
        break;
      }
      pageCursor = cursorOutcome.pageCursor;
    }

    return { status: 'completed', pulledRowCount, error };
  }

  protected isBlackBoxPullBudgetExhausted(pulledPageCount: number, pullStartedAt: number): boolean {
    return pulledPageCount >= this.BLACKBOX_PULL_MAX_PAGES
      || Date.now() - pullStartedAt >= this.BLACKBOX_PULL_MAX_DURATION_MS;
  }

  protected logBlackBoxPullBudgetExhausted(pulledPageCount: number, pulledRowCount: number): void {
    this.logger.info('黑匣子分页拉取达到本轮预算，已保存当前游标，等待后续拉取继续', {
      pulledPageCount,
      pulledRowCount,
    });
  }

  protected async fetchBlackBoxDeltaPageWithSessionRetry(
    context: BlackBoxDeltaPullContext,
    pageCursor: BlackBoxSyncCursor,
    upperWatermark: string | null,
  ): Promise<BlackBoxDeltaPage> {
    const page = await this.fetchBlackBoxDeltaPage(context.client, pageCursor, upperWatermark, context.scopedUserId);
    if (!page.error || !this.sessionManager.isSessionExpiredError(supabaseErrorToError(page.error))) {
      return page;
    }

    const refreshResult = await this.sessionManager.tryRefreshSessionWithSession('BlackBoxSync.pullChanges');
    if (!refreshResult.refreshed) {
      return page;
    }

    this.logger.info('BlackBox pullChanges 会话已刷新，重试增量拉取');
    return await this.fetchBlackBoxDeltaPage(context.client, pageCursor, upperWatermark, context.scopedUserId);
  }

  protected async mergeBlackBoxDeltaPageRows(
    pageRows: Record<string, unknown>[],
    context: BlackBoxDeltaPullContext,
  ): Promise<boolean> {
    if (!this.isExpectedRealtimeContextCurrent(context.expectedUserId, context.expectedRealtimeGeneration)) {
      this.logger.info('黑匣子拉取在分页远端返回后中止：Realtime 订阅上下文已变化');
      return false;
    }

    for (const row of pageRows) {
      if (!this.isExpectedRealtimeContextCurrent(context.expectedUserId, context.expectedRealtimeGeneration)) {
        this.logger.info('黑匣子明细合并中止：Realtime 订阅上下文已变化');
        return false;
      }

      const entry = this.mapRowToEntry(row);
      await this.mergeWithLocal(entry, context.preferRemoteForSyncedLocalDuringPull, context.repairingFutureCursor);
    }

    return true;
  }

  protected async resolveNextBlackBoxDeltaPageCursor(
    pageRows: Record<string, unknown>[],
    expectedUserId: string,
  ): Promise<BlackBoxDeltaPageCursorOutcome> {
    if (pageRows.length > 0) {
      await this.commitBlackBoxCursorFromRows(pageRows, expectedUserId);
    }

    const decision = resolveNextBlackBoxDeltaPageCursorPure(pageRows, this.BLACKBOX_PULL_PAGE_SIZE);
    if (decision.missingCursorWarning) {
      this.logger.warn('黑匣子分页游标缺少关键字段，停止本轮拉取以避免跳页', decision.missingCursorWarning);
    }
    return decision.outcome;
  }

  protected async handleBlackBoxPullError(error: unknown): Promise<boolean> {
    return handleBlackBoxPullErrorWithLocalFallback(error, {
      isBlackBoxScopedQueryUnavailable: candidate => this.isBlackBoxScopedQueryUnavailable(candidate),
      isSessionExpiredError: finalError => this.sessionManager.isSessionExpiredError(finalError),
      loadFromLocal: () => this.loadFromLocal(),
      logger: this.logger,
    });
  }

  protected applyBlackBoxCursorSafetyLookback(effectiveLastSync: string): string {
    return applyBlackBoxCursorSafetyLookbackPure(
      effectiveLastSync,
      SYNC_CONFIG.CURSOR_SAFETY_LOOKBACK_MS,
    );
  }

  protected async prepareBlackBoxRemotePull(
    expectedUserId?: string,
    expectedRealtimeGeneration?: number,
  ): Promise<BlackBoxRemotePullPreparationOutcome> {
    if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
      this.logger.info('黑匣子明细拉取在 Realtime 订阅切换后中止');
      return { status: 'done', result: false };
    }

    if (this.isRemoteUnavailable()) {
      await this.loadFromLocal();
      return { status: 'done', result: false };
    }

    const sessionUserId = this.resolveRemoteSessionUserId();
    if (!sessionUserId) {
      this.logger.info('BlackBox 会话不可用，跳过远端增量拉取并保留本地快照');
      await this.loadFromLocal();
      return { status: 'done', result: false };
    }

    const scopedUserId = expectedUserId ?? sessionUserId;
    if (scopedUserId !== sessionUserId) {
      this.logger.info('黑匣子拉取用户上下文不一致，跳过远端读取');
      return { status: 'done', result: false };
    }

    const client = await this.supabase.clientAsync();
    if (!client) {
      await this.loadFromLocal();
      return { status: 'done', result: false };
    }

    if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
      this.logger.info('黑匣子拉取在获取客户端后中止：Realtime 订阅上下文已变化');
      return { status: 'done', result: false };
    }

    return { status: 'continue', context: { client, scopedUserId } };
  }

  protected async resolveBlackBoxPullCursorWindow(
    client: BlackBoxSupabaseClient,
    expectedUserId: string,
    expectedRealtimeGeneration?: number,
  ): Promise<BlackBoxPullCursorWindowOutcome> {
    let effectiveLastSync = this.lastSyncCursor?.updatedAt ?? this.lastSyncTime ?? '1970-01-01T00:00:00Z';
    let repairingFutureCursor = false;
    const pendingEntriesNeedRemoteReconciliation = this.getPendingEntriesForRemoteReconciliation().length > 0;

    if (!FEATURE_FLAGS.BLACKBOX_WATERMARK_PROBE_V1) {
      return { status: 'continue', effectiveLastSync, repairingFutureCursor };
    }

    const remoteWatermark = await this.getRemoteBlackBoxWatermark(client);
    if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
      this.logger.info('黑匣子 watermark 快路在 RPC 返回后中止：Realtime 订阅上下文已变化');
      return { status: 'done', result: false };
    }

    const cursorProbe = resolveBlackBoxCursorWindowProbe(effectiveLastSync, remoteWatermark);
    ({ effectiveLastSync, repairingFutureCursor } = cursorProbe);
    if (cursorProbe.futureCursorWarning) {
      this.logger.warn('检测到未来黑匣子游标，回退到安全全量拉取', cursorProbe.futureCursorWarning);
    }

    const fastPath = await this.resolveBlackBoxWatermarkFastPath(
      remoteWatermark,
      cursorProbe.remoteMs,
      cursorProbe.localMs,
      effectiveLastSync,
      pendingEntriesNeedRemoteReconciliation,
      expectedUserId,
      expectedRealtimeGeneration,
    );
    if (fastPath) {
      return fastPath;
    }

    return { status: 'continue', effectiveLastSync, repairingFutureCursor };
  }

  protected async resolveBlackBoxWatermarkFastPath(
    remoteWatermark: string | null,
    remoteMs: number,
    localMs: number,
    effectiveLastSync: string,
    pendingEntriesNeedRemoteReconciliation: boolean,
    expectedUserId: string,
    expectedRealtimeGeneration?: number,
  ): Promise<BlackBoxPullCursorWindowOutcome | null> {
    if (!remoteWatermark || !shouldUseBlackBoxWatermarkFastPath({
      remoteWatermark,
      remoteMs,
      localMs,
      effectiveLastSync,
      lastSyncCursorId: this.lastSyncCursor?.id,
      pendingEntriesNeedRemoteReconciliation,
    })) {
      return null;
    }

    if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
      this.logger.info('黑匣子 watermark 快路在保存游标前中止：Realtime 订阅上下文已变化');
      return { status: 'done', result: false };
    }

    await this.commitBlackBoxCursor(
      this.lastSyncCursor ?? { updatedAt: remoteWatermark, id: '' },
      expectedUserId,
    );
    if (
      this.currentSyncUserId !== expectedUserId
      || !this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)
    ) {
      this.logger.info('黑匣子 watermark 快路在游标持久化后中止：用户上下文已变化');
      return { status: 'done', result: false };
    }
    this.logger.debug('BlackBox watermark 快路命中，跳过明细拉取', {
      remoteWatermark,
      localCursor: effectiveLastSync
    });
    return { status: 'done', result: true };
  }

  protected async fetchBlackBoxDeltaPage(
    client: Awaited<ReturnType<SupabaseClientService['clientAsync']>>,
    cursor: BlackBoxSyncCursor,
    upperWatermark: string | null,
    expectedUserId: string,
  ): Promise<{ data: unknown[] | null; error: unknown }> {
    return fetchBlackBoxDeltaPageQuery({
      client,
      cursor,
      upperWatermark,
      expectedUserId,
      selectColumns: this.BLACKBOX_ENTRY_SELECT_COLUMNS,
      pageSize: this.BLACKBOX_PULL_PAGE_SIZE,
      scopedQueryUnavailableError: this.createBlackBoxScopedQueryUnavailableError(),
      warn: (message, details) => this.logger.warn(message, details),
      getOptionalQueryMethod: (target, methodName) => this.getOptionalQueryMethod(target, methodName),
    });
  }

  protected createBlackBoxScopedQueryUnavailableError(): Error {
    return new Error('blackbox_delta_missing_user_scope_query');
  }

  protected isBlackBoxScopedQueryUnavailable(error: unknown): boolean {
    return error instanceof Error && error.message === 'blackbox_delta_missing_user_scope_query';
  }

  protected async getRemoteBlackBoxWatermark(
    client: Awaited<ReturnType<SupabaseClientService['clientAsync']>>
  ): Promise<string | null> {
    return readBlackBoxRemoteWatermark(client, this.logger);
  }

  /**
   * 合并远程数据到本地（LWW 冲突解决）
   */
  protected async mergeWithLocal(
    remote: BlackBoxEntry,
    preferRemoteForSyncedLocalDuringPull: boolean,
    repairingFutureCursor: boolean,
    mergeMode: BlackBoxMergeMode = 'remote-pull',
  ): Promise<void> {
    const local = blackBoxEntriesMap().get(remote.id);
    const decision = resolveBlackBoxMergeDecision(local, remote, {
      preferRemoteForSyncedLocalDuringPull,
      repairingFutureCursor,
      isLocalNewer: (localUpdatedAt, remoteUpdatedAt) => this.clockSync.isLocalNewer(localUpdatedAt, remoteUpdatedAt),
    });

    if (decision.action === 'use-remote') {
      if (
        mergeMode === 'remote-pull'
        && local?.syncStatus === 'pending'
        && !this.hasEquivalentEntryState(local, remote)
      ) {
        this.logger.warn('黑匣子 pull 保留非等价本地 pending，等待 RetryQueue 推送路径处理冲突', {
          entryId: remote.id,
          localUpdatedAt: local.updatedAt,
          remoteUpdatedAt: remote.updatedAt,
          mergeMode,
          pendingFlushQueued: this.pendingPushEntries.has(remote.id),
        });
        return;
      }

      const safeRemote = this.hydrateBlankContentFromSource(remote, local, 'local-merge');
      await this.saveToLocal(safeRemote);
      updateBlackBoxEntry(safeRemote);
      return;
    }

    if (decision.action === 'merge-monotonic') {
      await this.saveMonotonicPendingMerge(decision.merged, decision.local, remote);
      return;
    }

    this.logger.debug('保留更晚的本地黑匣子快照，跳过远端覆盖', {
      entryId: remote.id,
      syncStatus: decision.local.syncStatus ?? 'unknown',
      localUpdatedAt: decision.local.updatedAt,
      remoteUpdatedAt: remote.updatedAt,
    });
  }

  protected async saveMonotonicPendingMerge(
    merged: BlackBoxEntry,
    local: BlackBoxEntry,
    remote: BlackBoxEntry,
  ): Promise<void> {
    if (this.canConvergeMonotonicMergeToRemote(merged, remote)) {
      const converged: BlackBoxEntry = {
        ...merged,
        updatedAt: remote.updatedAt,
        syncStatus: 'synced',
      };
      this.logger.info('黑匣子 pull 合并：单调真值补齐后已与远端等价且远端时间戳不晚于本地，直接升级 synced 以避免死循环', {
        entryId: remote.id,
        convergedUpdatedAt: remote.updatedAt,
        localUpdatedAt: local.updatedAt,
        remoteUpdatedAt: remote.updatedAt,
      });
      await this.saveToLocal(converged);
      updateBlackBoxEntry(converged);
      return;
    }

    this.logger.warn('黑匣子 pull 合并：本地 pending 胜出 LWW，但合并远端单调真值以免大门继续展示已完成条目', {
      entryId: remote.id,
      localUpdatedAt: local.updatedAt,
      remoteUpdatedAt: remote.updatedAt,
      mergedIsRead: merged.isRead,
      mergedIsCompleted: merged.isCompleted,
      mergedDeletedAt: merged.deletedAt,
    });
    await this.saveToLocal(merged);
    updateBlackBoxEntry(merged);
    await this.ensureLatestLocalEnqueued(merged, 'merge-monotonic');
  }

  protected canConvergeMonotonicMergeToRemote(merged: BlackBoxEntry, remote: BlackBoxEntry): boolean {
    return canConvergeMonotonicMergeToRemotePure(merged, remote, {
      hasEquivalentEntryState: (left, right) => this.hasEquivalentEntryState(left, right),
      isLocalNewer: (leftUpdatedAt, rightUpdatedAt) => this.clockSync.isLocalNewer(leftUpdatedAt, rightUpdatedAt),
    });
  }

  /**
   * 映射数据库行到条目
   */
  protected mapRowToEntry(row: Record<string, unknown>): BlackBoxEntry {
    return mapBlackBoxRowToEntry(row);
  }

  /**
   * 获取待同步条目数量
   */
  getPendingSyncCount(): number {
    return this.pendingPushEntries.size;
  }

}
