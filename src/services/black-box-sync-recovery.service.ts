import { FOCUS_CONFIG } from '../config/focus.config';
import { type BlackBoxEntry } from '../models/focus';
import { blackBoxEntriesMap } from '../state/focus-stores';
import { openIndexedDBAdaptive } from '../utils/indexeddb-open';
import { isValidUUID } from '../utils/validation';
import { type BlackBoxSyncCursor } from './black-box-sync-cursor';
import { BlackBoxSyncLifecycleLayer } from './black-box-sync-lifecycle.service';
import { type RetryQueueHandler } from './black-box-sync.types';

export abstract class BlackBoxSyncRecoveryLayer extends BlackBoxSyncLifecycleLayer {
  setRetryQueueHandler(handler: RetryQueueHandler): void {
    this.retryQueueHandler = handler;

    // 处理器就绪后，恢复 IndexedDB 中未同步的条目到 RetryQueue
    void this.recoverPendingEntries();
  }

  /**
   * 从 IndexedDB 恢复 syncStatus=pending 的条目到 RetryQueue
   * 防止浏览器崩溃/刷新导致数据丢失
   */
  protected async recoverPendingEntries(): Promise<void> {
    if (!this.retryQueueHandler) return;

    if (this.supabase.isConfigured && this.network.isOnline() && this.isAuthSettling()) {
      this.shouldRecoverAfterAuthSettles = true;
      this.logger.debug('Auth still settling, defer black box pending recovery');
      return;
    }

    try {
      const entries = await this.loadFromLocal();

      // 第一步：主动扫描并删除所有含非法 UUID 字段的条目（不限 syncStatus）
      for (const entry of entries) {
        const hasInvalidId = !entry.id || !isValidUUID(entry.id);
        const hasInvalidProjectId =
          entry.projectId !== null &&
          entry.projectId !== undefined &&
          !isValidUUID(entry.projectId);
        if (hasInvalidId || hasInvalidProjectId) {
          this.logger.warn(`启动清理：删除非法 UUID 条目 id="${entry.id}", projectId="${entry.projectId}"`);
          try { await this.deleteFromLocal(entry.id); } catch { /* 忽略 */ }
        }
      }

      // 第二步：先对账远端权威状态，再只恢复真正仍待补推的 pending 条目。
      // 否则 stale tab / 旧设备遗留的本地 pending 会在启动瞬间整批灌入 RetryQueue，
      // 既抬高“待同步”数字，也会在缺少并发保护时把旧状态重新推回云端。
      const validPending = await this.resolvePendingEntriesForRecovery(entries);

      // 【2026-05-11 根因修复·路径 A·配套】先按当前会话过滤掉 owner-mismatch 的 pending，
      // 同样走 selfHealOwnerMismatchedEntry，避免它们在 RetryQueue 里被静默吞掉后 IDB
      // 一直挂着 pending，UI 长期显示 待同步。
      const sessionUserId = this.resolveRemoteSessionUserId();
      const recoverable: BlackBoxEntry[] = [];
      for (const entry of validPending) {
        if (sessionUserId && entry.userId !== sessionUserId) {
          await this.selfHealOwnerMismatchedEntry(entry, sessionUserId, undefined);
          continue;
        }
        recoverable.push(entry);
      }

      if (recoverable.length > 0) {
        this.logger.info(`Recovering ${recoverable.length} pending entries to RetryQueue`);
        for (const entry of recoverable) {
          await this.enqueueRecoveredPendingEntry(entry);
        }
      }
    } catch (e) {
      this.logger.error('Failed to recover pending entries', e instanceof Error ? e.message : String(e));
    }
  }

  protected getValidPendingEntries(entries: BlackBoxEntry[]): BlackBoxEntry[] {
    return entries.filter(
      entry =>
        entry.syncStatus === 'pending' &&
        entry.id &&
        isValidUUID(entry.id) &&
        (entry.projectId == null || isValidUUID(entry.projectId))
    );
  }

  private async enqueueRecoveredPendingEntry(entry: BlackBoxEntry): Promise<void> {
    if (!this.retryQueueHandler) {
      return;
    }

    try {
      const enqueued = await this.retryQueueHandler(entry);
      if (!enqueued) {
        this.keepRecoveredPendingEntryForRetry(entry);
        this.logger.warn('黑匣子 pending 恢复入 RetryQueue 持久化失败，保留本地 pending 等待下次恢复', {
          entryId: entry.id,
        });
      }
    } catch (error) {
      this.keepRecoveredPendingEntryForRetry(entry);
      this.logger.warn('黑匣子 pending 恢复入 RetryQueue 持久化失败，保留本地 pending 等待下次恢复', {
        entryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private keepRecoveredPendingEntryForRetry(entry: BlackBoxEntry): void {
    this.pendingPushEntries.set(entry.id, entry);
    this.schedulePendingPushFlush();
  }

  protected async resolvePendingEntriesForRecovery(entries: BlackBoxEntry[]): Promise<BlackBoxEntry[]> {
    const validPending = this.getValidPendingEntries(entries);
    if (validPending.length === 0) {
      return validPending;
    }

    const expectedUserId = this.resolveRemoteSessionUserId();

    if (
      !this.supabase.isConfigured
      || this.isRemoteUnavailable()
      || !this.network.isOnline()
      || this.isAuthSettling()
      || !expectedUserId
    ) {
      return validPending;
    }

    try {
      const client = await this.supabase.clientAsync();
      if (!client) {
        return validPending;
      }

      await this.reconcilePendingEntriesWithServer(
        client,
        false,
        false,
        expectedUserId,
        undefined,
        validPending,
        'authoritative-reconcile',
      );
      return this.getValidPendingEntries(
        validPending.map(entry => blackBoxEntriesMap().get(entry.id) ?? entry),
      );
    } catch (error) {
      this.logger.debug('启动前置黑匣子 pending 对账失败，降级为原始恢复路径', {
        error: error instanceof Error ? error.message : String(error),
        pendingCount: validPending.length,
      });
      return validPending;
    }
  }

  /**
   * 初始化 IndexedDB
   */
  protected async initIndexedDB(): Promise<void> {
    if (this.db) return;
    if (this.initIndexedDBPromise) return this.initIndexedDBPromise;

    this.initIndexedDBPromise = (async () => {
      try {
        this.db = await openIndexedDBAdaptive({
          dbName: this.IDB_NAME,
          targetVersion: this.IDB_VERSION,
          requiredStores: [
            this.STORE_NAME,
            FOCUS_CONFIG.IDB_STORES.OFFLINE_AUDIO_CACHE,
            FOCUS_CONFIG.IDB_STORES.FOCUS_PREFERENCES,
            FOCUS_CONFIG.IDB_STORES.SYNC_METADATA,
            FOCUS_CONFIG.IDB_STORES.PARKED_TASKS
          ],
          ensureStores: db => this.ensureFocusModeStores(db),
        });
        this.logger.debug('IndexedDB opened for focus mode', { version: this.db.version });
        await this.loadLastSyncTime(this.currentSyncUserId);
      } catch (error) {
        // 【H-13】Only null out the cached promise on failure so that a
        // subsequent call retries initialization. On success, keep the
        // resolved promise cached to avoid redundant open attempts
        // (the old `finally` block nulled it unconditionally, creating a
        // race where concurrent callers would each trigger a new open).
        this.initIndexedDBPromise = null;
        this.logger.error('Failed to open IndexedDB for focus mode', error instanceof Error ? error.message : String(error));
        throw error;
      }
    })();

    return this.initIndexedDBPromise;
  }

  protected ensureFocusModeStores(db: IDBDatabase): void {
    if (!db.objectStoreNames.contains(this.STORE_NAME)) {
      const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
      store.createIndex('by-date', 'date', { unique: false });
      store.createIndex('by-updated', 'updatedAt', { unique: false });
      store.createIndex('by-sync-status', 'syncStatus', { unique: false });
    }

    if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.OFFLINE_AUDIO_CACHE)) {
      db.createObjectStore(FOCUS_CONFIG.IDB_STORES.OFFLINE_AUDIO_CACHE, { keyPath: 'id' });
    }

    if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.FOCUS_PREFERENCES)) {
      db.createObjectStore(FOCUS_CONFIG.IDB_STORES.FOCUS_PREFERENCES, { keyPath: 'key' });
    }

    if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA)) {
      db.createObjectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA, { keyPath: 'key' });
    }

    if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS)) {
      const parkedStore = db.createObjectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS, { keyPath: 'taskId' });
      parkedStore.createIndex('by-parkedAt', 'parkedAt', { unique: false });
    }
  }

  /**
   * 从 IndexedDB 加载上次同步时间
   */
  protected async loadLastSyncTime(userId: string | null = this.currentSyncUserId): Promise<void> {
    if (!this.db) return;

    if (!userId) {
      this.lastSyncTime = null;
      return;
    }

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(this.SYNC_METADATA_STORE, 'readonly');
        const store = tx.objectStore(this.SYNC_METADATA_STORE);
        const request = store.get(this.getLastSyncTimeKey(userId));

        request.onsuccess = () => {
          if (this.currentSyncUserId !== userId) {
            resolve();
            return;
          }

          if (request.result) {
            this.lastSyncCursor = this.parseStoredSyncCursor(request.result.value);
            this.lastSyncTime = this.lastSyncCursor?.updatedAt ?? null;
            this.logger.debug(`Loaded lastSyncTime: ${this.lastSyncTime}`);
          } else {
            this.lastSyncCursor = null;
            this.lastSyncTime = null;
          }
          resolve();
        };

        request.onerror = () => {
          this.logger.warn('Failed to load lastSyncTime');
          resolve();
        };
      } catch (e) {
        // 降级处理：Store 可能不存在（首次升级前）
        this.logger.debug('IndexedDB store 不存在', { error: e });
        resolve();
      }
    });
  }

  protected async persistBlackBoxCursorIfNewer(cursor: BlackBoxSyncCursor): Promise<BlackBoxSyncCursor | null> {
    if (!this.db || !this.currentSyncUserId) return null;

    const cursorMs = new Date(cursor.updatedAt).getTime();
    if (!Number.isFinite(cursorMs)) return null;

    const currentSyncUserId = this.currentSyncUserId;
    const key = this.getLastSyncTimeKey(currentSyncUserId);

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(this.SYNC_METADATA_STORE, 'readwrite');
        const store = tx.objectStore(this.SYNC_METADATA_STORE);
        let committedCursor: BlackBoxSyncCursor = cursor;

        tx.oncomplete = () => resolve(committedCursor);
        tx.onerror = () => {
          this.logger.debug('保存黑匣子同步游标失败', { userId: currentSyncUserId, error: tx.error });
          resolve(null);
        };
        tx.onabort = () => {
          this.logger.debug('保存黑匣子同步游标中止', { userId: currentSyncUserId, error: tx.error });
          resolve(null);
        };

        const request = store.get(key);
        request.onsuccess = () => {
          const existing = this.parseStoredSyncCursor(request.result?.value);
          if (existing && this.compareBlackBoxCursor(cursor, existing) < 0) {
            this.sentryLazyLoader.addBreadcrumb({
              category: 'sync',
              message: 'blackbox.cursor_persist_ignored_stale',
              level: 'info',
              data: { existing, candidate: cursor },
            });
            committedCursor = existing;
            return;
          }

          store.put({ key, value: cursor });
        };
        request.onerror = () => {
          this.logger.debug('读取黑匣子同步游标失败', { userId: currentSyncUserId, error: request.error });
          resolve(null);
        };
      } catch (e) {
        this.logger.debug('保存黑匣子同步游标失败', { error: e });
        resolve(null);
      }
    });
  }

  protected async syncCursorScope(userId: string | null): Promise<void> {
    this.currentSyncUserId = userId;
    this.lastSyncTime = null;
    this.lastSyncCursor = null;
    this.lastPullTime = 0;
    this.lastResumePullAt = 0;
    await this.loadLastSyncTime(userId);
  }

  /**
   * 设置网络状态监听
   * 网络恢复时，扫描并恢复未同步条目
   * 【2026-02-15 修复】保存监听器引用并在 DestroyRef 中清理
   */
  protected setupNetworkListener(): void {
    if (typeof window === 'undefined') return;
    const onOnline = () => {
      this.logger.info('Network restored, recovering pending entries');
      this.recoverPendingEntries();
    };
    window.addEventListener('online', onOnline);

    // 【修复 2026-05-24】Realtime 熔断期间，visibilitychange → visible 时触发兜底拉取，
    // 降低用户感知的"不同步"时间窗口（正常情况下 Realtime 推送即时通知变更）。
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      const userId = this.resolveRemoteSessionUserId();
      if (!userId) return;
      const circuit = this.getRealtimeCircuitSnapshot(userId);
      if (circuit.remainingMs > 0) {
        this.logger.info('Realtime 熔断期 visibility 兜底拉取触发', {
          circuitRemainingMs: circuit.remainingMs,
        });
        void this.runRealtimeCircuitVisibilityFallback();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    this.destroyRef.onDestroy(() => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      this.clearRealtimeCircuitRetryTimer();
      void this.teardownRealtimeSubscription();
      // 清理防抖定时器
      if (this.pushDebounceTimer) {
        clearTimeout(this.pushDebounceTimer);
        this.pushDebounceTimer = null;
      }
    });
  }

  /**
   * 调度同步（防抖 3s）
   *
   * 数据安全保证：
   * 1. 立即写入 IndexedDB（syncStatus=pending）
   * 2. 防抖结束后通过 RetryQueue 推送（持久化队列）
   * 3. 即使浏览器崩溃，下次启动时 recoverPendingEntries 会恢复
   */

  private async runRealtimeCircuitVisibilityFallback(): Promise<void> {
    try {
      await this.flushPendingToRetryQueue();
    } catch (error) {
      this.logger.warn('Realtime 熔断期 visibility 兜底 flush pending 失败，继续执行远端拉取', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await this.pullChanges({ reason: 'resume' });
  }

}
