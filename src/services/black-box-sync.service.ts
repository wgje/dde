/**
 * 黑匣子同步服务
 *
 * 负责黑匣子条目的离线同步
 * 遵循 Offline-first：IndexedDB 持久化 + RetryQueue 集成
 * 冲突解决：LWW (Last-Write-Wins)
 *
 * 【数据安全设计】
 * - 所有条目先写入 IndexedDB，再推送到服务器
 * - 通过 retryQueueHandler 集成到主同步体系的 RetryQueue（持久化队列）
 * - 推送失败时自动进入 RetryQueue，浏览器崩溃/刷新后不丢失
 * - 启动时扫描 IndexedDB 中 syncStatus=pending 的条目，恢复未完成的同步
 */

import { Injectable, inject, DestroyRef } from '@angular/core';
import type { Json } from '../types/supabase';
import { BlackBoxEntry } from '../models/focus';
import { FOCUS_CONFIG } from '../config/focus.config';
import { SYNC_CONFIG } from '../config/sync.config';
import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { isValidUUID } from '../utils/validation';
import { supabaseErrorToError } from '../utils/supabase-error';
import { openIndexedDBAdaptive } from '../utils/indexeddb-open';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';
import {
  blackBoxEntriesMap,
  setBlackBoxEntries,
  updateBlackBoxEntry,
  deleteBlackBoxEntry
} from '../state/focus-stores';
import { SupabaseClientService } from './supabase-client.service';
import { NetworkAwarenessService } from './network-awareness.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { AuthService } from './auth.service';
import { SessionManagerService } from '../app/core/services/sync/session-manager.service';
import { AUTH_CONFIG } from '../config/auth.config';

/**
 * IndexedDB 中的黑匣子条目格式
 */
interface IDBBlackBoxEntry extends BlackBoxEntry {
  /** 本地版本号，用于冲突检测 */
  _localVersion?: number;
}

/**
 * RetryQueue 回调接口
 * 由 SimpleSyncService 通过 setRetryQueueHandler 注入
 */
type RetryQueueHandler = (entry: BlackBoxEntry) => void;

export interface PullChangesOptions {
  reason?: 'startup' | 'resume' | 'manual' | 'panel-open' | 'gate-review';
  force?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class BlackBoxSyncService {
  private supabase = inject(SupabaseClientService);
  private network = inject(NetworkAwarenessService);
  private auth = inject(AuthService);
  private readonly sessionManager = inject(SessionManagerService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('BlackBoxSync');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly destroyRef = inject(DestroyRef);

  private db: IDBDatabase | null = null;
  private lastSyncTime: string | null = null;

  /** RetryQueue 集成回调，由 SimpleSyncService 注入 */
  private retryQueueHandler: RetryQueueHandler | null = null;

  /** 防抖定时器（合并短时间内的多次写入） */
  private pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPushEntries: Map<string, BlackBoxEntry> = new Map();

  // 防重保护：single-flight + freshness window
  private pullInFlight: Promise<boolean> | null = null;
  /** 上次成功拉取的时间戳（毫秒），用于 freshness window 判断 */
  private lastPullTime = 0;
  private lastResumePullAt = 0;

  private readonly IDB_NAME = FOCUS_CONFIG.SYNC.IDB_NAME;
  private readonly IDB_VERSION = FOCUS_CONFIG.SYNC.IDB_VERSION;
  private readonly STORE_NAME = FOCUS_CONFIG.IDB_STORES.BLACK_BOX_ENTRIES;
  private readonly DEBOUNCE_DELAY = SYNC_CONFIG.DEBOUNCE_DELAY;
  private initIndexedDBPromise: Promise<void> | null = null;

  private isRemoteUnavailable(): boolean {
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

  constructor() {
    // 初始化 IndexedDB
    void this.initIndexedDB().catch(error => {
      this.logger.warn('Initial IndexedDB setup deferred', error instanceof Error ? error.message : String(error));
    });

    // 监听网络状态变化
    this.setupNetworkListener();
  }
  private readonly SYNC_METADATA_STORE = FOCUS_CONFIG.IDB_STORES.SYNC_METADATA;
  private readonly LAST_SYNC_TIME_KEY = 'black_box_last_sync_time';

  // ==================== RetryQueue 集成 ====================

  /**
   * 设置 RetryQueue 处理器
   * 由 SimpleSyncService 在初始化时调用，将黑匣子同步集成到主同步体系
   */
  setRetryQueueHandler(handler: RetryQueueHandler): void {
    this.retryQueueHandler = handler;

    // 处理器就绪后，恢复 IndexedDB 中未同步的条目到 RetryQueue
    this.recoverPendingEntries();
  }

  /**
   * 从 IndexedDB 恢复 syncStatus=pending 的条目到 RetryQueue
   * 防止浏览器崩溃/刷新导致数据丢失
   */
  private async recoverPendingEntries(): Promise<void> {
    if (!this.retryQueueHandler) return;

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

      // 第二步：恢复合法 pending 条目到 RetryQueue
      const validPending = entries.filter(
        e =>
          e.syncStatus === 'pending' &&
          e.id &&
          isValidUUID(e.id) &&
          (e.projectId == null || isValidUUID(e.projectId))
      );

      if (validPending.length > 0) {
        this.logger.info(`Recovering ${validPending.length} pending entries to RetryQueue`);
        for (const entry of validPending) {
          this.retryQueueHandler(entry);
        }
      }
    } catch (e) {
      this.logger.error('Failed to recover pending entries', e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 初始化 IndexedDB
   */
  private async initIndexedDB(): Promise<void> {
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
        await this.loadLastSyncTime();
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

  private ensureFocusModeStores(db: IDBDatabase): void {
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
  private async loadLastSyncTime(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(this.SYNC_METADATA_STORE, 'readonly');
        const store = tx.objectStore(this.SYNC_METADATA_STORE);
        const request = store.get(this.LAST_SYNC_TIME_KEY);

        request.onsuccess = () => {
          if (request.result) {
            this.lastSyncTime = request.result.value;
            this.logger.debug(`Loaded lastSyncTime: ${this.lastSyncTime}`);
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

  /**
   * 保存上次同步时间到 IndexedDB
   */
  private async saveLastSyncTime(): Promise<void> {
    if (!this.db || !this.lastSyncTime) return;

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(this.SYNC_METADATA_STORE, 'readwrite');
        const store = tx.objectStore(this.SYNC_METADATA_STORE);
        store.put({ key: this.LAST_SYNC_TIME_KEY, value: this.lastSyncTime });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        // 降级处理：保存失败时静默继续
        this.logger.debug('保存同步时间失败', { error: e });
        resolve();
      }
    });
  }

  /**
   * 设置网络状态监听
   * 网络恢复时，扫描并恢复未同步条目
   * 【2026-02-15 修复】保存监听器引用并在 DestroyRef 中清理
   */
  private setupNetworkListener(): void {
    if (typeof window === 'undefined') return;
    const onOnline = () => {
      this.logger.info('Network restored, recovering pending entries');
      this.recoverPendingEntries();
    };
    window.addEventListener('online', onOnline);
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('online', onOnline);
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
  async scheduleSync(entry: BlackBoxEntry): Promise<void> {
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
    }

    // 2. 加入防抖批次
    this.pendingPushEntries.set(entry.id, pendingEntry);

    // 3. 防抖处理
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
    }

    this.pushDebounceTimer = setTimeout(() => {
      this.flushPendingToRetryQueue();
    }, this.DEBOUNCE_DELAY);
  }

  /**
   * 将防抖批次中的条目提交到 RetryQueue
   */
  private flushPendingToRetryQueue(): void {
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
        this.retryQueueHandler(entry);
      } else {
        // 降级：直接推送（不经过 RetryQueue）
        // 【M-03】Must not fire-and-forget — attach .catch() to log errors
        this.pushToServer(entry).catch(err => {
          this.logger.error(
            'Fire-and-forget pushToServer failed',
            err instanceof Error ? err.message : String(err)
          );
        });
      }
    }
  }

  /**
   * 保存到本地 IndexedDB
   */
  async saveToLocal(entry: BlackBoxEntry): Promise<void> {
    if (!this.db) {
      await this.initIndexedDB();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('IndexedDB not initialized'));
        return;
      }

      const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);

      const idbEntry: IDBBlackBoxEntry = {
        ...entry,
        _localVersion: Date.now()
      };

      const request = store.put(idbEntry);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 从本地 IndexedDB 删除指定条目
   * 用于清理脏数据（如非法 ID 的条目）
   */
  async deleteFromLocal(id: string): Promise<void> {
    if (!this.db) {
      await this.initIndexedDB();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('IndexedDB not initialized'));
        return;
      }

      const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private async loadEntryFromLocal(id: string): Promise<BlackBoxEntry | null> {
    try {
      if (!this.db) {
        await this.initIndexedDB();
      }
    } catch {
      return null;
    }

    if (!this.db) {
      return null;
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.get(id);

      request.onsuccess = () => {
        const result = request.result as IDBBlackBoxEntry | undefined;
        if (!result) {
          resolve(null);
          return;
        }

        const { _localVersion, ...entry } = result;
        resolve(entry);
      };
      request.onerror = () => resolve(null);
    });
  }

  private isEntryNewer(
    candidate: Pick<BlackBoxEntry, 'updatedAt'> | null | undefined,
    baseline: Pick<BlackBoxEntry, 'updatedAt'> | null | undefined,
  ): boolean {
    if (!candidate?.updatedAt || !baseline?.updatedAt) {
      return false;
    }

    return candidate.updatedAt > baseline.updatedAt;
  }

  private async resolveLatestLocalEntry(id: string): Promise<BlackBoxEntry | null> {
    const inMemory = blackBoxEntriesMap().get(id) ?? null;
    const persisted = await this.loadEntryFromLocal(id);

    if (!persisted) {
      return inMemory;
    }

    if (!inMemory || this.isEntryNewer(persisted, inMemory)) {
      return persisted;
    }

    return inMemory;
  }

  /**
   * 从本地 IndexedDB 加载
   */
  async loadFromLocal(): Promise<BlackBoxEntry[]> {
    if (!this.db) {
      await this.initIndexedDB();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('IndexedDB not initialized'));
        return;
      }

      const tx = this.db.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const visibleUserId = this.resolveVisibleUserId();
        const entries = (request.result as IDBBlackBoxEntry[]).map(e => {

          const { _localVersion, ...entry } = e;
          return entry;
        });

        if (!visibleUserId) {
          // root fix: auth 恢复窗口内 owner 可能暂时不可见；此时保留当前内存快照，
          // 绝不能把黑匣子 UI 清空成 []，否则用户会误以为内容已经丢失。
          this.logger.info('黑匣子本地水合延后：owner 未决，保留当前内存快照', {
            authSettling: this.isAuthSettling(),
            sessionInitialized: this.auth.sessionInitialized(),
            currentUserId: this.auth.currentUserId(),
            inMemoryEntryCount: blackBoxEntriesMap().size,
          });
          resolve(Array.from(blackBoxEntriesMap().values()));
          return;
        }

        const visibleEntries = entries.filter(entry => entry.userId === visibleUserId);

        // 更新状态
        setBlackBoxEntries(visibleEntries);

        resolve(visibleEntries);
      };

      request.onerror = () => reject(request.error);
    });
  }

  private resolveVisibleUserId(): string | null {
    const currentUserId = this.auth.currentUserId();
    if (currentUserId) {
      return currentUserId;
    }

    if (!this.auth.isConfigured) {
      return AUTH_CONFIG.LOCAL_MODE_USER_ID;
    }

    if (typeof window === 'undefined') {
      return null;
    }

    try {
      if (localStorage.getItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY) === 'true') {
        return AUTH_CONFIG.LOCAL_MODE_USER_ID;
      }

      if (this.isAuthSettling()) {
        const persistedSessionUserId = this.auth.peekPersistedSessionIdentity()?.userId ?? null;
        if (persistedSessionUserId) {
          return persistedSessionUserId;
        }

        return this.auth.peekPersistedOwnerHint();
      }

      return null;
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- localStorage 访问异常时静默返回 null
      return null;
    }
  }

  private isAuthSettling(): boolean {
    return !this.auth.sessionInitialized()
      || this.auth.authState().isCheckingSession
      || this.auth.runtimeState() === 'pending';
  }

  private resolveRemoteSessionUserId(): string | null {
    const currentUserId = this.auth.currentUserId();
    if (currentUserId) {
      return currentUserId;
    }

    return this.isAuthSettling()
      ? (this.auth.peekPersistedSessionIdentity()?.userId ?? null)
      : null;
  }

  /**
   * 推送到服务器
   *
   * 公开方法：由 RetryQueue 处理器回调调用
   * 返回 boolean 表示是否成功（供 RetryQueue 决定是否重试）
   */
  async pushToServer(entry: BlackBoxEntry): Promise<boolean> {
    if (!this.supabase.isConfigured) {
      this.logger.debug('Supabase 未配置，跳过推送');
      return false;
    }
    if (this.isRemoteUnavailable()) {
      this.logger.debug('连接中断模式下跳过黑匣子推送');
      return false;
    }

    // 校验所有 UUID 字段，跳过 IndexedDB 中的脏数据（如 "dev-preview"、"dev-test"）
    if (!entry.id || !isValidUUID(entry.id)) {
      this.logger.warn(`跳过非法 ID 的条目: "${entry.id}"，从本地清理`);
      try {
        await this.deleteFromLocal(entry.id);
      } catch { /* 清理失败不阻塞 */ }
      return true; // 返回 true 让 RetryQueue 不再重试
    }

    // 共享黑匣子仓允许 projectId=null；非空时必须是合法 UUID。
    if (entry.projectId != null && !isValidUUID(entry.projectId)) {
      this.logger.warn(`跳过非法 projectId 的条目: id="${entry.id}", projectId="${entry.projectId}"，从本地清理`);
      try {
        await this.deleteFromLocal(entry.id);
      } catch { /* 清理失败不阻塞 */ }
      return true;
    }

    try {
      const client = await this.supabase.clientAsync();
      if (!client) {
        return false;
      }

      // 【终极防线】upsert 前再次内联校验所有 UUID 字段
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(entry.id) || (entry.projectId != null && !uuidPattern.test(entry.projectId))) {
        this.logger.warn(`终极防线拦截非法 UUID 字段: id="${entry.id}", projectId="${entry.projectId}"`);
        try { await this.deleteFromLocal(entry.id); } catch { /* ignore */ }
        return true;
      }

      const latestLocalBeforePush = await this.resolveLatestLocalEntry(entry.id);
      if (this.isEntryNewer(latestLocalBeforePush, entry)) {
        this.logger.debug('跳过过期黑匣子推送：本地已有更新快照', {
          entryId: entry.id,
          queuedUpdatedAt: entry.updatedAt,
          latestLocalUpdatedAt: latestLocalBeforePush?.updatedAt,
        });
        return true;
      }

      // 使用 upsert 确保幂等性
      const { error } = await client
        .from('black_box_entries')
        .upsert({
          id: entry.id,
          project_id: entry.projectId,
          user_id: entry.userId,
          content: entry.content,
          focus_meta: (entry.focusMeta ?? null) as unknown as Json | null,
          date: entry.date,
          created_at: entry.createdAt,
          updated_at: entry.updatedAt,
          is_read: entry.isRead,
          is_completed: entry.isCompleted,
          is_archived: entry.isArchived,
          snooze_until: entry.snoozeUntil,
          snooze_count: entry.snoozeCount,
          deleted_at: entry.deletedAt
        }, {
          onConflict: 'id'
        });

      if (error) {
        const enhanced = supabaseErrorToError(error);
        this.logger.error('Failed to push entry to server', enhanced.message);
        return false;
      }

      const latestLocalAfterPush = await this.resolveLatestLocalEntry(entry.id);
      if (this.isEntryNewer(latestLocalAfterPush, entry)) {
        this.logger.debug('黑匣子推送完成时检测到更晚的本地快照，跳过旧状态回写', {
          entryId: entry.id,
          pushedUpdatedAt: entry.updatedAt,
          latestLocalUpdatedAt: latestLocalAfterPush?.updatedAt,
        });
      } else {
        // 更新本地同步状态为已同步
        const synced: BlackBoxEntry = { ...entry, syncStatus: 'synced' };
        await this.saveToLocal(synced);
        updateBlackBoxEntry(synced);
      }

      // 【修复 P1-02】推送成功后更新 lastSyncTime，避免重复拉取
      if (entry.updatedAt && (!this.lastSyncTime || entry.updatedAt > this.lastSyncTime)) {
        this.lastSyncTime = entry.updatedAt;
        await this.saveLastSyncTime();
      }

      this.logger.debug(`Entry synced to server: ${entry.id}`);
      return true;
    } catch (error) {
      this.logger.error('Sync error', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * 从服务器拉取变更（增量同步）
   */
  async pullChanges(options?: PullChangesOptions): Promise<void> {
    const reason = options?.reason ?? 'manual';
    const force = options?.force ?? false;

    if (
      FEATURE_FLAGS.BLACKBOX_PULL_COOLDOWN_V1 &&
      reason === 'resume' &&
      !force &&
      this.lastResumePullAt > 0 &&
      Date.now() - this.lastResumePullAt < APP_LIFECYCLE_CONFIG.RESUME_PULL_COOLDOWN_MS
    ) {
      this.logger.debug('Resume pull skipped by cooldown');
      return;
    }

    // 【性能优化 2026-02-14】freshness window 守卫：窗口内已拉取过则跳过
    const freshnessWindow = SYNC_CONFIG.BLACKBOX_PULL_FRESHNESS_WINDOW;
    if (!force && this.lastPullTime > 0 && Date.now() - this.lastPullTime < freshnessWindow) {
      const elapsedSec = Math.round((Date.now() - this.lastPullTime) / 1000);
      this.logger.debug(`Freshness window 内跳过拉取 (${elapsedSec}s < ${freshnessWindow / 1000}s)`);
      // 【监控 2026-02-14】记录被阻断的重复拉取，用于 Sentry 告警观测
      this.sentryLazyLoader.addBreadcrumb({
        category: 'sync.blackbox',
        message: `Duplicate pull blocked by freshness window (${elapsedSec}s)`,
        level: 'info',
        data: { reason, elapsedSec, freshnessWindow: freshnessWindow / 1000 },
      });
      // 仅对真正的手动刷新保留事件上报；面板挂载/门禁轮询等被动刷新只记 breadcrumb，避免制造告警噪音。
      if (reason === 'manual') {
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
      return;
    }

    // 防重保护：single-flight 复用进行中的拉取
    if (this.pullInFlight) {
      this.logger.debug('Pull already in progress, reusing promise');
      await this.pullInFlight;
      return;
    }

    if (!this.supabase.isConfigured || !this.network.isOnline() || this.isRemoteUnavailable()) {
      this.logger.debug('Offline or unconfigured, loading from local');
      await this.loadFromLocal();
      return;
    }

    this.pullInFlight = this.doPullChanges()
      .then((didAttemptRemoteRead) => {
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
      });

    await this.pullInFlight;
  }

  /**
   * 实际执行拉取变更的内部方法
   */
  private async doPullChanges(): Promise<boolean> {
    try {
      if (this.isRemoteUnavailable()) {
        await this.loadFromLocal();
        return false;
      }

      if (!this.resolveRemoteSessionUserId()) {
        this.logger.info('BlackBox 会话不可用，跳过远端增量拉取并保留本地快照');
        await this.loadFromLocal();
        return false;
      }

      const client = await this.supabase.clientAsync();
      if (!client) {
        await this.loadFromLocal();
        return false;
      }

      // 获取上次同步时间。首次拉取优先复用本地最大 updatedAt，避免直接从 epoch 慢拉。
      let lastSync = this.lastSyncTime;
      if (!lastSync) {
        lastSync = await this.deriveLocalSyncCursor();
        if (lastSync) {
          this.lastSyncTime = lastSync;
          await this.saveLastSyncTime();
        }
      }
      const effectiveLastSync = lastSync || '1970-01-01T00:00:00Z';

      if (FEATURE_FLAGS.BLACKBOX_WATERMARK_PROBE_V1) {
        const remoteWatermark = await this.getRemoteBlackBoxWatermark(client);
        const remoteMs = remoteWatermark ? new Date(remoteWatermark).getTime() : NaN;
        const localMs = new Date(effectiveLastSync).getTime();
        if (
          remoteWatermark &&
          Number.isFinite(remoteMs) &&
          Number.isFinite(localMs) &&
          remoteMs <= localMs
        ) {
          this.lastSyncTime = remoteWatermark;
          await this.saveLastSyncTime();
          this.logger.debug('BlackBox watermark 快路命中，跳过明细拉取', {
            remoteWatermark,
            localCursor: effectiveLastSync
          });
          return true;
        }
      }

      this.logger.debug(`Pulling changes since: ${effectiveLastSync}`);

      // 增量拉取
      let { data, error } = await client
        .from('black_box_entries')
        .select('*')
        .gt('updated_at', effectiveLastSync)
        .order('updated_at', { ascending: true });

      if (error) {
        const enhanced = supabaseErrorToError(error);

        // 【JWT 自愈】检测到 session 过期时主动刷新一次并重试，避免控制台刷屏。
        // 使用 tryRefreshSessionWithSession（allowWhenExpired: true）绕过 syncState
        // .sessionExpired 短路，刷新成功后 SessionManager 会自动重置 flag。
        if (this.sessionManager.isSessionExpiredError(enhanced)) {
          const refreshResult = await this.sessionManager.tryRefreshSessionWithSession('BlackBoxSync.pullChanges');
          if (refreshResult.refreshed) {
            this.logger.info('BlackBox pullChanges 会话已刷新，重试增量拉取');
            const retry = await client
              .from('black_box_entries')
              .select('*')
              .gt('updated_at', effectiveLastSync)
              .order('updated_at', { ascending: true });
            data = retry.data;
            error = retry.error;
          }
        }

        if (error) {
          const finalErr = supabaseErrorToError(error);
          // 【鲁棒性 2026-04-16】浏览器网络挂起属瞬时错误，降级为 debug，回退到本地快照但不报 ERROR
          if (isBrowserNetworkSuspendedError(finalErr) || isBrowserNetworkSuspendedWindow()) {
            this.logger.debug('BlackBox 浏览器网络挂起，跳过增量拉取', { message: finalErr.message });
            await this.loadFromLocal();
            return true;
          }

          if (this.sessionManager.isSessionExpiredError(finalErr)) {
            this.logger.warn('BlackBox 会话失效，已保留本地快照并等待重新认证', {
              code: finalErr.code,
              message: finalErr.message,
            });
            await this.loadFromLocal();
            return true;
          }

          this.logger.error('Failed to pull changes', finalErr.message);
          await this.loadFromLocal();
          return true;
        }
      }

      // 合并到本地
      // 【M-04 Performance】Each entry is written to IDB sequentially via
      // separate readwrite transactions. For large pull batches (100+ entries)
      // this creates significant overhead. A future iteration should batch all
      // writes into a single IDB readwrite transaction (or use a bulk-put
      // helper) to reduce transaction commit overhead by ~10x.
      for (const row of data ?? []) {
        const entry = this.mapRowToEntry(row);
        await this.mergeWithLocal(entry);
      }

      // 更新同步时间并持久化
      if (data && data.length > 0) {
        this.lastSyncTime = data[data.length - 1].updated_at;
        await this.saveLastSyncTime();
      }

      this.logger.info(`Pulled changes from server: ${data?.length ?? 0} entries`);
      return true;
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

  private async getRemoteBlackBoxWatermark(
    client: Awaited<ReturnType<SupabaseClientService['clientAsync']>>
  ): Promise<string | null> {
    if (!client) return null;
    try {
      const { data, error } = await client.rpc('get_black_box_sync_watermark');
      if (error) {
        this.logger.debug('BlackBox watermark RPC 失败，降级为明细拉取', { message: error.message });
        return null;
      }
      if (typeof data === 'string') {
        return data;
      }
      // RPC 返回类型可能为数组形式，需要 unknown 过渡处理
      const raw = data as unknown;
      if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
        return raw[0];
      }
      return null;
    } catch (error) {
      this.logger.debug('BlackBox watermark RPC 异常，降级为明细拉取', {
        error: error instanceof Error ? error.message : String(error)
      });
      // eslint-disable-next-line no-restricted-syntax -- RPC 不可用时降级为明细拉取（返回 null 触发 fallback 路径）
      return null;
    }
  }

  private async deriveLocalSyncCursor(): Promise<string | null> {
    try {
      const localEntries = await this.loadFromLocal();
      let maxUpdatedAtMs = 0;

      for (const entry of localEntries) {
        const ts = entry.updatedAt ? new Date(entry.updatedAt).getTime() : 0;
        if (Number.isFinite(ts)) {
          maxUpdatedAtMs = Math.max(maxUpdatedAtMs, ts);
        }
      }

      if (maxUpdatedAtMs > 0) {
        const cursor = new Date(maxUpdatedAtMs).toISOString();
        this.logger.debug(`首次拉取采用本地游标: ${cursor}`);
        return cursor;
      }
    } catch (error) {
      this.logger.debug('推导本地同步游标失败，降级为 epoch', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return null;
  }

  /**
   * 合并远程数据到本地（LWW 冲突解决）
   */
  private async mergeWithLocal(remote: BlackBoxEntry): Promise<void> {
    const local = blackBoxEntriesMap().get(remote.id);

    // LWW: 远程更新时间更新则使用远程
    // 【修复 P1-05】等时用 id 字典序作为 tiebreaker，保证确定性
    const shouldUseRemote = !local ||
      remote.updatedAt > local.updatedAt ||
      (remote.updatedAt === local.updatedAt && remote.id > local.id);

    if (shouldUseRemote) {
      // 【修复 P1-04】已删除条目从本地状态中移除，避免 UI 残留
      if (remote.deletedAt) {
        await this.saveToLocal(remote);
        deleteBlackBoxEntry(remote.id);
      } else {
        await this.saveToLocal(remote);
        updateBlackBoxEntry(remote);
      }
    }
  }

  /**
   * 映射数据库行到条目
   */
  private mapRowToEntry(row: Record<string, unknown>): BlackBoxEntry {
    return {
      id: row['id'] as string,
      projectId: (row['project_id'] as string | null) ?? null,
      userId: (row['user_id'] as string) || '',
      content: (row['content'] as string) || '',  // 防止 content 为 null/undefined
      focusMeta: (row['focus_meta'] as BlackBoxEntry['focusMeta']) ?? null,
      date: (row['date'] as string) || new Date().toISOString().split('T')[0],
      createdAt: (row['created_at'] as string) || new Date().toISOString(),
      updatedAt: (row['updated_at'] as string) || new Date().toISOString(),
      isRead: (row['is_read'] as boolean) ?? false,
      isCompleted: (row['is_completed'] as boolean) ?? false,
      isArchived: (row['is_archived'] as boolean) ?? false,
      snoozeUntil: row['snooze_until'] as string | undefined,
      snoozeCount: row['snooze_count'] as number | undefined,
      deletedAt: row['deleted_at'] as string | null,
      syncStatus: 'synced'
    };
  }

  /**
   * 获取待同步条目数量
   */
  getPendingSyncCount(): number {
    return this.pendingPushEntries.size;
  }

  /**
   * 强制同步
   */
  async forceSync(): Promise<void> {
    // 立即刷新防抖中的条目
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
      this.pushDebounceTimer = null;
    }
    this.flushPendingToRetryQueue();

    await this.pullChanges({ reason: 'manual', force: true });
  }
}

