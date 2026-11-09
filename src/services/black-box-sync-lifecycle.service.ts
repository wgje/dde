import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { FOCUS_CONFIG } from '../config/focus.config';
import { gateState } from '../state/focus-stores';
import { BlackBoxSyncBase } from './black-box-sync-base.service';
import {
  compareBlackBoxCursor as compareBlackBoxCursorPure,
  computeBlackBoxCursorFromRows as computeBlackBoxCursorFromRowsPure,
  parseStoredSyncCursor as parseStoredSyncCursorPure,
  type BlackBoxSyncCursor,
} from './black-box-sync-cursor';
import { effect } from '@angular/core';

export abstract class BlackBoxSyncLifecycleLayer extends BlackBoxSyncBase {
  protected isRemoteUnavailable(): boolean {
    const maybeSignal = (this.supabase as unknown as { isOfflineMode?: (() => boolean) | boolean }).isOfflineMode;
    if (typeof maybeSignal === 'function') {
      try {
        return Boolean(maybeSignal());
      } catch {
        return false;
      }
    }
    return Boolean(maybeSignal);
  }

  protected getRealtimeCircuitSnapshot(userId: string): {
    remainingMs: number;
    failures: number;
    lastError: string | null;
  } {
    if (typeof window === 'undefined' || typeof window.sessionStorage === 'undefined') {
      return { remainingMs: 0, failures: 0, lastError: null };
    }

    try {
      const stored = window.sessionStorage.getItem(BlackBoxSyncBase.REALTIME_CIRCUIT_STORAGE_KEY);
      if (!stored) {
        return { remainingMs: 0, failures: 0, lastError: null };
      }

      const parsed = JSON.parse(stored) as {
        until?: number;
        ownerUserId?: string | null;
        failures?: number;
        lastError?: string | null;
      };

      if (typeof parsed.until !== 'number' || parsed.until <= Date.now()) {
        window.sessionStorage.removeItem(BlackBoxSyncBase.REALTIME_CIRCUIT_STORAGE_KEY);
        return { remainingMs: 0, failures: 0, lastError: null };
      }

      if (typeof parsed.ownerUserId === 'string' && parsed.ownerUserId !== userId) {
        return { remainingMs: 0, failures: 0, lastError: null };
      }

      return {
        remainingMs: Math.max(0, parsed.until - Date.now()),
        failures: typeof parsed.failures === 'number' ? parsed.failures : 0,
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      };
    } catch {
      return { remainingMs: 0, failures: 0, lastError: null };
    }
  }

  protected armRealtimeCircuit(userId: string, errorMessage: string | undefined, consecutiveErrors: number): number {
    const now = Date.now();
    const current = this.getRealtimeCircuitSnapshot(userId);
    const until = now + Math.max(current.remainingMs, BlackBoxSyncBase.REALTIME_CIRCUIT_TTL_MS);

    if (typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined') {
      try {
        window.sessionStorage.setItem(BlackBoxSyncBase.REALTIME_CIRCUIT_STORAGE_KEY, JSON.stringify({
          until,
          ownerUserId: userId,
          failures: Math.max(current.failures, consecutiveErrors),
          lastError: errorMessage ?? current.lastError,
          lastToastAt: 0,
        }));
      } catch {
        // sessionStorage 不可写时保留内存态退化即可。
      }
    }

    return until - now;
  }

  protected clearRealtimeCircuitRetryTimer(): void {
    if (this.realtimeCircuitRetryTimer === null) {
      return;
    }

    clearTimeout(this.realtimeCircuitRetryTimer);
    this.realtimeCircuitRetryTimer = null;
  }

  protected scheduleRealtimeCircuitRetry(
    userId: string,
    delayMs: number,
    generation: number,
  ): void {
    this.clearRealtimeCircuitRetryTimer();
    this.realtimeCircuitRetryTimer = setTimeout(() => {
      this.realtimeCircuitRetryTimer = null;
      if (this.realtimeDesiredUserId !== userId) {
        return;
      }

      if (generation != this.realtimeSubscriptionGeneration) {
        return;
      }

      const retryGeneration = ++this.realtimeSubscriptionGeneration;
      queueMicrotask(() => {
        void this.syncRealtimeSubscription(userId, retryGeneration);
      });
    }, Math.max(0, delayMs));
  }

  protected setupAuthRecoveryEffect(): void {
    effect(() => {
      const authSettling = this.isAuthSettling();
      const currentUserId = this.auth.currentUserId();

      if (authSettling) {
        this.shouldRecoverAfterAuthSettles = true;
        return;
      }

      if (!this.retryQueueHandler || !this.shouldRecoverAfterAuthSettles || !currentUserId) {
        return;
      }

      this.shouldRecoverAfterAuthSettles = false;
      this.logger.debug('Auth settled, replay pending black box recovery');
      void this.recoverPendingEntries();
    });
  }

  protected setupSyncCursorScopeEffect(): void {
    effect(() => {
      const nextSyncUserId = this.resolveRemoteSessionUserId();
      if (this.currentSyncUserId === nextSyncUserId) {
        return;
      }

      queueMicrotask(() => {
        void this.syncCursorScope(nextSyncUserId);
      });
    });
  }

  protected setupRealtimeSubscriptionEffect(): void {
    effect(() => {
      const authSettling = this.isAuthSettling();
      const currentUserId = this.auth.currentUserId();
      const gateReviewing = gateState() === 'reviewing';
      const online = this.network.isOnline();
      const shouldSubscribe = FEATURE_FLAGS.REALTIME_ENABLED
        && gateReviewing
        && online
        && this.supabase.isConfigured
        && !this.isRemoteUnavailable()
        && !authSettling
        && !!currentUserId;
      const nextRealtimeUserId = shouldSubscribe ? currentUserId : null;

      if (this.realtimeDesiredUserId === nextRealtimeUserId) {
        return;
      }

      this.realtimeDesiredUserId = nextRealtimeUserId;
      const generation = ++this.realtimeSubscriptionGeneration;

      queueMicrotask(() => {
        void this.syncRealtimeSubscription(
          nextRealtimeUserId,
          generation,
        );
      });
    });
  }

  protected readonly SYNC_METADATA_STORE = FOCUS_CONFIG.IDB_STORES.SYNC_METADATA;
  protected readonly LAST_SYNC_TIME_KEY_PREFIX = 'black_box_last_sync_time';

  protected getLastSyncTimeKey(userId: string): string {
    return `${this.LAST_SYNC_TIME_KEY_PREFIX}:${userId}`;
  }

  protected parseStoredSyncCursor(value: unknown): BlackBoxSyncCursor | null {
    return parseStoredSyncCursorPure(value);
  }

  protected compareBlackBoxCursor(left: BlackBoxSyncCursor, right: BlackBoxSyncCursor): number {
    return compareBlackBoxCursorPure(left, right);
  }

  protected computeBlackBoxCursorFromRows(rows: Array<Record<string, unknown>>): BlackBoxSyncCursor | null {
    return computeBlackBoxCursorFromRowsPure(rows);
  }

  protected async commitBlackBoxCursorFromRows(
    rows: Array<Record<string, unknown>>,
    expectedUserId: string,
  ): Promise<void> {
    const nextCursor = this.computeBlackBoxCursorFromRows(rows);
    await this.commitBlackBoxCursor(nextCursor, expectedUserId);
  }

  protected async commitBlackBoxCursor(
    nextCursor: BlackBoxSyncCursor | null,
    expectedUserId: string,
  ): Promise<void> {
    if (!nextCursor) return;
    if (this.currentSyncUserId !== expectedUserId) return;
    if (this.lastSyncCursor && this.compareBlackBoxCursor(nextCursor, this.lastSyncCursor) < 0) {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: 'blackbox.cursor_commit_ignored_stale',
        level: 'info',
        data: { existing: this.lastSyncCursor, candidate: nextCursor },
      });
      return;
    }

    const committed = await this.persistBlackBoxCursorIfNewer(nextCursor);
    if (!committed) return;
    if (this.currentSyncUserId !== expectedUserId) return;

    this.lastSyncCursor = committed;
    this.lastSyncTime = committed.updatedAt;
  }

  async forceSync(): Promise<void> {
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
      this.pushDebounceTimer = null;
    }
    await this.flushPendingToRetryQueue();

    await this.pullChanges({ reason: 'manual', force: true });
  }
}
