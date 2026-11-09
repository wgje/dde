import { type BlackBoxEntry } from '../models/focus';
import { blackBoxEntriesMap } from '../state/focus-stores';
import { getRemainingBrowserNetworkResumeDelayMs, isBrowserNetworkSuspendedWindow } from '../utils/browser-network-suspension';
import { isValidUUID } from '../utils/validation';
import { BlackBoxSyncBase } from './black-box-sync-base.service';
import { BlackBoxSyncRecoveryLayer } from './black-box-sync-recovery.service';
import { DIRECT_WIDGET_NOTIFY_TIMEOUT_MS, type BlackBoxSupabaseClient, type BlackBoxWidgetNotifyAction, type ScheduleBlackBoxSyncOptions } from './black-box-sync.types';
import type { PendingDockDirectWidgetNotifyRecord } from './dock-direct-widget-notify-outbox.service';
import { type RealtimeChannel } from '@supabase/supabase-js';

const BLACK_BOX_REALTIME_TRANSPORT_ERROR_STATUSES = new Set(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']);

export abstract class BlackBoxSyncQueueRealtimeLayer extends BlackBoxSyncRecoveryLayer {
  async scheduleSync(entry: BlackBoxEntry, options: ScheduleBlackBoxSyncOptions = {}): Promise<void> {
    // 校验 ID，拦截脏数据进入同步流程
    if (!entry.id || !isValidUUID(entry.id)) {
      this.logger.warn(`scheduleSync: 拦截非法 ID "${entry.id}"，不进入同步`);
      return;
    }

    // 1. 立即保存到本地 IndexedDB（syncStatus=pending）
    const pendingEntry: BlackBoxEntry = { ...entry, syncStatus: 'pending' };
    // 【修复 P1-01】await IDB 写入，确保 crash 时不丢数据
    try {
      await this.saveToLocal(pendingEntry);
    } catch (e) {
      this.logger.error('scheduleSync: IDB 写入失败，条目加入内存队列等待重试', e instanceof Error ? e.message : String(e));
      throw e;
    }

    if (options.immediate) {
      this.pendingPushEntries.delete(entry.id);
      if (this.pendingPushEntries.size === 0 && this.pushDebounceTimer) {
        clearTimeout(this.pushDebounceTimer);
        this.pushDebounceTimer = null;
      }
      void this.pushImmediateGateAction(pendingEntry, options.widgetNotifyAction).catch((error: unknown) => {
        this.logger.warn('黑匣子 Gate 关键动作立即同步失败，已转入重试兜底', {
          entryId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
        void this.enqueueEntryForRetry(pendingEntry).catch((enqueueError: unknown) => {
          this.logger.warn('黑匣子 Gate 关键动作重试入队失败，保留 pending 等待后续恢复', {
            entryId: entry.id,
            error: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
          });
        });
      });
      return;
    }

    // 2. 加入防抖批次
    this.pendingPushEntries.set(entry.id, pendingEntry);

    // 3. 防抖处理
    this.schedulePendingPushFlush();
  }

  protected schedulePendingPushFlush(): void {
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
    }

    this.pushDebounceTimer = setTimeout(() => {
      void this.flushPendingToRetryQueue().catch((error: unknown) => {
        this.logger.error(
          'flushPendingToRetryQueue failed',
          error instanceof Error ? error.message : String(error),
        );
      });
    }, this.DEBOUNCE_DELAY);
  }

  protected async pushImmediateGateAction(
    entry: BlackBoxEntry,
    widgetNotifyAction?: BlackBoxWidgetNotifyAction,
  ): Promise<void> {
    const pushed = await this.pushToServer(entry, entry.userId);
    if (pushed) {
      await this.sendDirectWidgetBlackBoxNotify(entry, widgetNotifyAction);
      return;
    }

    await this.enqueueEntryForRetry(entry);
  }

  protected keepEntryPendingForRetry(entry: BlackBoxEntry): void {
    this.pendingPushEntries.set(entry.id, entry);
    this.schedulePendingPushFlush();
  }

  protected async enqueueEntryForRetry(entry: BlackBoxEntry): Promise<void> {
    if (this.retryQueueHandler) {
      try {
        const enqueued = await this.retryQueueHandler(entry);
        if (!enqueued) {
          this.keepEntryPendingForRetry(entry);
          this.logger.warn('黑匣子条目入 RetryQueue 持久化失败，保留 pending 等待恢复', {
            entryId: entry.id,
          });
        }
      } catch (error) {
        this.keepEntryPendingForRetry(entry);
        this.logger.warn('黑匣子条目入 RetryQueue 持久化失败，保留 pending 等待恢复', {
          entryId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    this.pendingPushEntries.set(entry.id, entry);
    this.schedulePendingPushFlush();
  }

  protected async hasUsableDirectWidgetNotifySession(context: Record<string, unknown>): Promise<boolean> {
    try {
      const sessionResult = await this.supabase.getSession();
      const session = sessionResult.data.session;

      if (!session?.access_token || sessionResult.error) {
        this.logger.debug('direct black-box widget-notify skipped without active session', {
          ...context,
          reason: sessionResult.error?.name ?? 'session-missing',
        });
        return false;
      }

      return true;
    } catch (error) {
      this.logger.debug('direct black-box widget-notify skipped while reading session', {
        ...context,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  protected async sendDirectWidgetBlackBoxNotify(
    entry: BlackBoxEntry,
    action?: BlackBoxWidgetNotifyAction,
  ): Promise<void> {
    if (!action) return;

    if (!entry.id.trim()) {
      this.logger.debug('direct black-box widget-notify skipped without entry id', { action });
      return;
    }

    const pendingRecord = await this.enqueueDirectWidgetBlackBoxNotifyRecord(entry, action);
    if (!pendingRecord) return;

    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('direct black-box widget-notify skipped during browser network suspension', {
        entryId: entry.id,
        action,
        resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
      });
      return;
    }

    if (!(await this.hasUsableDirectWidgetNotifySession({ entryId: entry.id, action }))) {
      return;
    }

    await this.invokeDirectWidgetBlackBoxNotify(entry.id, action, pendingRecord);
  }

  private async enqueueDirectWidgetBlackBoxNotifyRecord(
    entry: BlackBoxEntry,
    action: BlackBoxWidgetNotifyAction,
  ): Promise<PendingDockDirectWidgetNotifyRecord | null> {
    const latestEntry = blackBoxEntriesMap().get(entry.id) ?? entry;
    const updatedAt = latestEntry.updatedAt || new Date().toISOString();
    let pendingRecord: PendingDockDirectWidgetNotifyRecord | null = null;

    try {
      pendingRecord = await this.directWidgetNotifyOutbox.enqueueLatest({
        kind: 'black-box',
        entryId: entry.id,
        blackBoxAction: action,
        updatedAt,
        ownerUserId: latestEntry.userId || entry.userId,
      });
    } catch (error) {
      this.logger.warn('direct black-box widget-notify outbox enqueue failed', {
        entryId: entry.id,
        action,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return pendingRecord;
  }

  private async invokeDirectWidgetBlackBoxNotify(
    entryId: string,
    action: BlackBoxWidgetNotifyAction,
    pendingRecord: PendingDockDirectWidgetNotifyRecord,
  ): Promise<void> {
    try {
      const client = await this.supabase.clientAsync();
      if (!client) return;

      const { error } = await client.functions.invoke(
        'widget-notify',
        {
          timeout: DIRECT_WIDGET_NOTIFY_TIMEOUT_MS,
          body: this.directWidgetNotifyOutbox.buildInvokeBody(pendingRecord),
        },
      );

      if (error) {
        this.logger.debug('direct black-box widget-notify skipped', {
          entryId,
          action,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      await this.directWidgetNotifyOutbox.removeRecord(pendingRecord);
    } catch (error) {
      this.logger.debug('direct black-box widget-notify threw', {
        entryId,
        action,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  protected buildDirectWidgetNotifyRequest(
    entry: BlackBoxEntry,
    action: BlackBoxWidgetNotifyAction
  ): {
    timeout: number;
    body: {
      directNotify: true;
      table: 'black_box_entries';
      webhookId: string;
      entryId: string;
      blackBoxAction: BlackBoxWidgetNotifyAction;
      updatedAt: string;
    };
  } {
    const latestEntry = blackBoxEntriesMap().get(entry.id) ?? entry;
    const updatedAt = latestEntry.updatedAt || new Date().toISOString();

    return {
      timeout: DIRECT_WIDGET_NOTIFY_TIMEOUT_MS,
      body: {
        directNotify: true,
        table: 'black_box_entries',
        webhookId: `pwa-blackbox-${entry.id}-${action}-${Math.floor(Date.now() / 1000)}`,
        entryId: entry.id,
        blackBoxAction: action,
        updatedAt,
      },
    };
  }

  /**
   * 将防抖批次中的条目提交到 RetryQueue
   */
  protected async flushPendingToRetryQueue(): Promise<void> {
    const entries = Array.from(this.pendingPushEntries.values());
    this.pendingPushEntries.clear();

    for (const entry of entries) {
      // 校验所有 UUID 字段
      if (!entry.id || !isValidUUID(entry.id)) {
        this.logger.warn(`flushPending: 跳过非法 ID "${entry.id}"`);
        continue;
      }
      if (entry.projectId != null && !isValidUUID(entry.projectId)) {
        this.logger.warn(`flushPending: 跳过非法 projectId "${entry.projectId}"，id="${entry.id}"`);
        continue;
      }
      if (this.retryQueueHandler) {
        // 通过主同步体系的 RetryQueue（持久化）
        try {
          const enqueued = await this.retryQueueHandler(entry);
          if (!enqueued) {
            this.keepEntryPendingForRetry(entry);
            this.logger.warn('flushPending: RetryQueue 持久化失败，保留 pending 等待下次恢复', {
              entryId: entry.id,
            });
          }
        } catch (error) {
          this.keepEntryPendingForRetry(entry);
          this.logger.warn('flushPending: RetryQueue 持久化失败，保留 pending 等待下次恢复', {
            entryId: entry.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // 降级：直接推送（不经过 RetryQueue）
        // 【M-03】Must not fire-and-forget: flush callers must observe push completion.
        try {
          const pushed = await this.pushToServer(entry);
          if (!pushed) {
            this.keepEntryPendingForRetry(entry);
            this.logger.warn('flushPending: 直接推送失败，保留 pending 等待下次恢复', {
              entryId: entry.id,
            });
          }
        } catch (err) {
          this.keepEntryPendingForRetry(entry);
          this.logger.error(
            'Direct fallback pushToServer failed',
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    }
  }

  protected async syncRealtimeSubscription(userId: string | null, generation: number): Promise<void> {
    this.clearRealtimeCircuitRetryTimer();

    if (generation !== this.realtimeSubscriptionGeneration) {
      return;
    }

    if (!userId) {
      await this.teardownRealtimeSubscription();
      return;
    }

    if (this.realtimeChannel && this.realtimeSubscribedUserId === userId) {
      return;
    }

    await this.teardownRealtimeSubscription();
    this.realtimeConsecutiveErrors = 0;

    if (generation !== this.realtimeSubscriptionGeneration) {
      return;
    }

    if (this.shouldSkipRealtimeSubscriptionForCircuit(userId, generation)) {
      return;
    }

    const client = await this.supabase.clientAsync().catch(() => null);
    if (!client || generation !== this.realtimeSubscriptionGeneration) {
      return;
    }

    const channel = this.createBlackBoxRealtimeChannel(client, userId, generation);

    this.realtimeChannel = channel;
    this.realtimeSubscribedUserId = userId;
  }

  protected shouldSkipRealtimeSubscriptionForCircuit(userId: string, generation: number): boolean {
    const realtimeCircuit = this.getRealtimeCircuitSnapshot(userId);
    if (realtimeCircuit.remainingMs <= 0) {
      return false;
    }

    this.scheduleRealtimeCircuitRetry(userId, realtimeCircuit.remainingMs, generation);
    this.logger.info('黑匣子 Realtime 熔断窗口内跳过订阅，继续使用 gate-review 定时拉取兜底', {
      remainingMs: realtimeCircuit.remainingMs,
      failures: realtimeCircuit.failures,
      lastError: realtimeCircuit.lastError,
    });
    return true;
  }

  protected createBlackBoxRealtimeChannel(
    client: BlackBoxSupabaseClient,
    userId: string,
    generation: number,
  ): RealtimeChannel {
    const channelName = `blackbox:${userId.substring(0, 8)}`;
    const channel = client.channel(channelName);

    return channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'black_box_entries',
        filter: `user_id=eq.${userId}`,
      },
      payload => this.handleBlackBoxRealtimePayload(payload, userId, generation),
    ).subscribe((status, error) => this.handleBlackBoxRealtimeStatus({
      status,
      error,
      channel,
      channelName,
      client,
      userId,
      generation,
    }));
  }

  protected handleBlackBoxRealtimePayload(
    payload: { eventType?: string; new?: unknown; old?: unknown },
    userId: string,
    generation: number,
  ): void {
    if (generation !== this.realtimeSubscriptionGeneration || this.realtimeSubscribedUserId !== userId) {
      return;
    }

    const row = (payload.new || payload.old) as { user_id?: string } | undefined;
    if (row?.user_id && row.user_id !== userId) {
      return;
    }

    this.logger.debug('收到黑匣子实时变更', {
      event: payload.eventType,
    });

    void this.pullChanges({
      reason: 'gate-review',
      force: true,
      expectedUserId: userId,
      expectedRealtimeGeneration: generation,
    }).catch((error: unknown) => {
      this.logger.debug('黑匣子实时变更拉取失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  protected handleBlackBoxRealtimeStatus(context: {
    status: string;
    error?: { message?: string };
    channel: RealtimeChannel;
    channelName: string;
    client: BlackBoxSupabaseClient;
    userId: string;
    generation: number;
  }): void {
    const { status, error, channel, channelName, client, userId, generation } = context;
    if (generation !== this.realtimeSubscriptionGeneration) {
      client.removeChannel(channel).catch(() => undefined);
      return;
    }

    if (this.realtimeChannel !== channel) {
      return;
    }

    if (status === 'SUBSCRIBED') {
      this.realtimeConsecutiveErrors = 0;
      this.logger.info('黑匣子 Realtime 订阅已启用', { channel: channelName });
      return;
    }

    if (this.shouldIgnoreRealtimeStatusDuringBrowserSuspend(status, error, channelName)) {
      return;
    }

    if (BLACK_BOX_REALTIME_TRANSPORT_ERROR_STATUSES.has(status)) {
      this.handleBlackBoxRealtimeTransportError(status, error, channelName, userId);
    }
  }

  protected shouldIgnoreRealtimeStatusDuringBrowserSuspend(
    status: string,
    error: { message?: string } | undefined,
    channelName: string,
  ): boolean {
    if (!BLACK_BOX_REALTIME_TRANSPORT_ERROR_STATUSES.has(status) || !isBrowserNetworkSuspendedWindow()) {
      return false;
    }

    this.logger.debug('浏览器网络挂起期间忽略黑匣子 Realtime 通道中断', {
      channel: channelName,
      status,
      error: error?.message,
    });
    return true;
  }

  protected handleBlackBoxRealtimeTransportError(
    status: string,
    error: { message?: string } | undefined,
    channelName: string,
    userId: string,
  ): void {
    this.realtimeConsecutiveErrors += 1;
    if (this.realtimeConsecutiveErrors < BlackBoxSyncBase.REALTIME_MAX_CONSECUTIVE_ERRORS) {
      this.logger.debug('黑匣子 Realtime 通道瞬时错误，等待连续失败阈值', {
        channel: channelName,
        status,
        consecutiveErrors: this.realtimeConsecutiveErrors,
        error: error?.message,
      });
      return;
    }

    const realtimeCircuitMs = this.armRealtimeCircuit(userId, error?.message, this.realtimeConsecutiveErrors);
    this.logger.warn('黑匣子 Realtime 连续失败，熔断当前会话 websocket 并保留 gate-review 定时拉取兜底', {
      channel: channelName,
      status,
      consecutiveErrors: this.realtimeConsecutiveErrors,
      realtimeCircuitMs,
      error: error?.message,
    });
    this.scheduleRealtimeCircuitRetry(userId, realtimeCircuitMs, this.realtimeSubscriptionGeneration);
    void this.teardownRealtimeSubscription();
  }

  protected async teardownRealtimeSubscription(): Promise<void> {
    const channel = this.realtimeChannel;
    this.realtimeChannel = null;
    this.realtimeSubscribedUserId = null;
    this.realtimeConsecutiveErrors = 0;

    if (!channel) {
      return;
    }

    const client = await this.supabase.clientAsync().catch(() => null);
    if (client) {
      try {
        await client.removeChannel(channel);
        return;
      } catch {
        // Fall through to the channel-owned unsubscribe fallback below.
      }
    }

    if (typeof channel.unsubscribe !== 'function') {
      return;
    }

    await channel.unsubscribe().catch(() => undefined);
  }

  /**
   * 保存到本地 IndexedDB
   */

}
