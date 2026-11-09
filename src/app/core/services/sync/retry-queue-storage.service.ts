import { SYNC_CONFIG } from '../../../../config';
import { isValidUUID } from '../../../../utils/validation';
import {
  beginLocalBackupUiRestoreWriterContinuation,
  runLocalBackupUiRestoreWriterContinuationSync,
  trackLocalBackupUiRestoreWriterPromise,
  type LocalBackupUiRestoreWriterHandle,
} from '../../../../services/local-backup-ui-restore-writer-quiescence-tracker';
import { minifyItem as minifyItemPure } from './retry-queue-fingerprint';
import type {
  DbInitFinalize,
  PersistedRetryQueueItem,
  RetryQueueItem,
  RetryQueueStorageLoadToken,
} from './retry-queue.types';
import { RetryQueueRunnerLayer } from './retry-queue-runner.service';

type RetryQueueLocalStorageEnvelope = { version: number; items: PersistedRetryQueueItem[]; savedAt: number; idbFallbackProof?: unknown };
type RetryQueueIdbFallbackProof = { version: 1; ownerUserId: string; savedAt: number; itemCount: number; snapshotDigest: string; recordedAt: number };
type RetryQueueIdbFallbackEnvelopeSnapshot = {
  envelope: RetryQueueLocalStorageEnvelope;
  proof: RetryQueueIdbFallbackProof;
  envelopeItemsDigest: string;
};
type RetryQueueIdbFallbackRecoveryPlan = { snapshot: RetryQueueIdbFallbackEnvelopeSnapshot; mergedItems: RetryQueueItem[]; idbDigest: string };
type RetryQueueIdbSaveCapture = { persistedDigest?: string };
type RetryQueueIdbLoadResult = { clean: PersistedRetryQueueItem[]; dirtyKeys: string[] };

export abstract class RetryQueueStorageLayer extends RetryQueueRunnerLayer {
  protected saveDebounceWriter: LocalBackupUiRestoreWriterHandle | null = null;
  // ==================== IndexedDB 支持 ====================

  /**
   * 初始化 IndexedDB
   */
  protected async initDb(): Promise<IDBDatabase | null> {
    if (this.db) return this.db;
    if (this.idbUnsupported) return null;

    if (!this.dbInitPromise) {
      this.dbInitPromise = this.createDbInitPromise();
    }

    return this.dbInitPromise;
  }

  protected createDbInitPromise(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finalize: DbInitFinalize = (db) => {
        if (settled) return;
        settled = true;
        resolve(db);
      };

      if (typeof indexedDB === 'undefined') {
        this.handleIndexedDbUnsupported(finalize);
        return;
      }

      try {
        this.attachDbOpenHandlers(indexedDB.open(this.DB_CONFIG.name, this.DB_CONFIG.version), finalize);
      } catch (err) {
        this.logger.error('IndexedDB 初始化异常', err);
        this.dbInitPromise = null;
        finalize(null);
      }
    });
  }

  protected handleIndexedDbUnsupported(finalize: DbInitFinalize): void {
    this.logger.warn('IndexedDB 不可用，将使用 localStorage');
    this.idbUnsupported = true;
    this.dbInitPromise = null;
    finalize(null);
  }

  protected attachDbOpenHandlers(request: IDBOpenDBRequest, finalize: DbInitFinalize): void {
    request.onblocked = () => {
      this.logger.warn('IndexedDB 打开被阻塞，暂时降级到 localStorage');
      this.dbInitPromise = null;
      finalize(null);
    };
    request.onerror = () => {
      this.logger.warn('IndexedDB 打开失败，降级到 localStorage', request.error);
      this.dbInitPromise = null;
      finalize(null);
    };
    request.onsuccess = () => this.handleDbOpenSuccess(request, finalize);
    request.onupgradeneeded = event => this.ensureDbObjectStore((event.target as IDBOpenDBRequest).result);
  }

  protected handleDbOpenSuccess(request: IDBOpenDBRequest, finalize: DbInitFinalize): void {
    this.db = request.result;
    this.maxQueueSize = this.MAX_SIZE_INDEXEDDB;
    this.logger.info('IndexedDB 初始化成功');
    finalize(request.result);
  }

  protected ensureDbObjectStore(db: IDBDatabase): void {
    if (db.objectStoreNames.contains(this.DB_CONFIG.storeName)) return;
    const store = db.createObjectStore(this.DB_CONFIG.storeName, { keyPath: 'id' });
    store.createIndex('createdAt', 'createdAt', { unique: false });
    store.createIndex('type', 'type', { unique: false });
    this.logger.info('IndexedDB store 创建成功');
  }

  /**
   * 从存储加载队列（优先 IndexedDB，降级 localStorage）
   */
  protected async loadFromStorage(): Promise<void> {
    const loadToken = this.captureStorageLoadToken();
    this.markOwnerStorageLoadStarted(loadToken);
    try {
      const db = await this.initDb();
      if (!this.isStorageLoadTokenCurrent(loadToken)) {
        this.logStaleStorageLoad(loadToken, 'loadFromStorage:init-db');
        return;
      }

      if (db && await this.tryLoadQueueFromIdb(db, loadToken)) return;
      this.loadQueueFromLocalStorage(loadToken);
    } catch (error) {
      this.markOwnerStorageLoadFailed(loadToken);
      throw error;
    }
  }

  protected async tryLoadQueueFromIdb(db: IDBDatabase, loadToken: RetryQueueStorageLoadToken): Promise<boolean> {
    const items = await this.loadFromIdb(db);
    if (items === null) {
      return false;
    }

    if (!this.isStorageLoadTokenCurrent(loadToken)) {
      this.logStaleStorageLoad(loadToken, 'loadFromStorage:idb');
      return true;
    }

    const recoveryPlan = this.buildIdbFallbackRecoveryPlan(items);
    const loadItems = recoveryPlan?.mergedItems ?? items;
    const { safeItems, removedCount, repairedOperationIdCount } = this.sanitizeLoadedItems(loadItems);
    if (!this.isStorageLoadTokenCurrent(loadToken)) {
      this.logStaleStorageLoad(loadToken, 'loadFromStorage:idb-sanitized');
      return true;
    }

    const duplicateRemovedCount = this.applyLoadedItems(safeItems);
    this.logger.info('从 IndexedDB 加载队列', {
      count: loadItems.length,
      visibleCount: this.queue.length,
      hiddenCount: this.hiddenQueueItems.length,
      removedCount: removedCount + duplicateRemovedCount,
      repairedOperationIdCount,
      ownerUserId: this.getCurrentOwnerUserId(),
    });
    this.finishLoadedQueueItems(removedCount + duplicateRemovedCount, repairedOperationIdCount);
    this.markOwnerStorageLoadSucceeded(loadToken);
    if (recoveryPlan) {
      await this.settleRecoveredIdbFallback(db, recoveryPlan);
    }
    return true;
  }

  protected loadQueueFromLocalStorage(loadToken: RetryQueueStorageLoadToken): void {
    const localStorageItems = this.loadFromLocalStorage();
    if (!this.isStorageLoadTokenCurrent(loadToken)) {
      this.logStaleStorageLoad(loadToken, 'loadFromStorage:localStorage');
      return;
    }

    const { safeItems, removedCount, repairedOperationIdCount } = this.sanitizeLoadedItems(localStorageItems);
    if (!this.isStorageLoadTokenCurrent(loadToken)) {
      this.logStaleStorageLoad(loadToken, 'loadFromStorage:localStorage-sanitized');
      return;
    }

    const duplicateRemovedCount = this.applyLoadedItems(safeItems);
    this.finishLoadedQueueItems(removedCount + duplicateRemovedCount, repairedOperationIdCount);
    this.markOwnerStorageLoadSucceeded(loadToken);
  }

  protected finishLoadedQueueItems(removedCount: number, repairedOperationIdCount = 0): void {
    if (removedCount > 0 || repairedOperationIdCount > 0) {
      this.saveToStorageSync();
      this.saveToStorage();
      void this.saveToStorageImmediate().then(success => {
        if (!success) {
          this.logger.warn('RetryQueue 加载修复后立即持久化失败，修复结果可能仅保留在内存中', {
            removedCount,
            repairedOperationIdCount,
          });
        }
      }).catch(error => {
        this.logger.warn('RetryQueue 加载修复后立即持久化异常，修复结果可能仅保留在内存中', {
          removedCount,
          repairedOperationIdCount,
          error,
        });
      });
    }
    this.checkCapacityWarning();
    this.syncPendingCountToState();
  }

  /** readonly complete 后发布 IndexedDB 结果，脏条目再由独立事务清理。 */
  protected async loadFromIdb(db: IDBDatabase): Promise<PersistedRetryQueueItem[] | null> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (items: PersistedRetryQueueItem[] | null): boolean => {
        if (settled) return false;
        settled = true;
        resolve(items);
        return true;
      };
      try {
        const transaction = db.transaction(this.DB_CONFIG.storeName, 'readonly');
        const store = transaction.objectStore(this.DB_CONFIG.storeName);
        const request = store.getAll();
        let loaded: RetryQueueIdbLoadResult | null = null;
        request.onsuccess = () => {
          loaded = this.filterLoadedIdbItems(request.result || []);
        };
        request.onerror = () => {
          if (settle(null)) this.logger.error('IndexedDB 加载失败', request.error);
        };
        transaction.onerror = () => {
          if (settle(null)) this.logger.error('IndexedDB 加载事务失败', transaction.error);
        };
        transaction.onabort = () => {
          if (settle(null)) this.logger.warn('IndexedDB 加载事务已中止', transaction.error);
        };
        transaction.oncomplete = () => {
          if (loaded === null) {
            settle(null);
            return;
          }
          if (!settle(loaded.clean)) return;
          this.deleteDirtyIdbItems(db, loaded.dirtyKeys);
          this.logger.debug('从 IndexedDB 加载', { count: loaded.clean.length });
        };
      } catch (err) {
        if (settle(null)) this.logger.error('IndexedDB 读取异常', err);
      }
    });
  }

  private filterLoadedIdbItems(raw: PersistedRetryQueueItem[]): RetryQueueIdbLoadResult {
    const clean: PersistedRetryQueueItem[] = [];
    const dirtyKeys: string[] = [];
    for (const item of raw) {
      if (item.data?.id && !isValidUUID(item.data.id)) {
        this.logger.warn('RetryQueue 加载：丢弃非法 ID 条目', { type: item.type, id: item.data.id });
        dirtyKeys.push(item.id);
      } else {
        clean.push(item);
      }
    }
    return { clean, dirtyKeys };
  }
  private deleteDirtyIdbItems(db: IDBDatabase, dirtyKeys: string[]): void {
    if (dirtyKeys.length === 0) return;
    this.logger.warn('RetryQueue 启动清理：从 IDB 删除脏条目', { keys: dirtyKeys });
    this.logger.info('RetryQueue 加载：已过滤脏数据', { removed: dirtyKeys.length });
    try {
      const transaction = db.transaction(this.DB_CONFIG.storeName, 'readwrite');
      const store = transaction.objectStore(this.DB_CONFIG.storeName);
      for (const key of dirtyKeys) store.delete(key);
    } catch (error) {
      this.logger.error('RetryQueue：删除脏条目失败', error);
    }
  }

  /**
   * 从 localStorage 加载
   */
  protected loadFromLocalStorage(): PersistedRetryQueueItem[] {
    const envelope = this.readLocalStorageEnvelope();
    if (!envelope) return [];
    return this.extractLoadableLocalStorageItems(envelope.items);
  }

  /**
   * 保存队列到存储（防抖版）
   * 在 500ms 内的多次调用会合并为一次实际写入操作
   *
   * 【2026-02-15 修复】解决 processQueueSlice 循环中每处理一个项就触发一次
   * IndexedDB 全量序列化+写入的性能问题
   */
  protected saveToStorage(): void {
    if (this.saveDebounceTimer !== null) return; // 已有待执行的保存，跳过
    const writer = beginLocalBackupUiRestoreWriterContinuation(this.getCurrentOwnerUserId(), 'retry-queue');
    const saveDebounceTimer = setTimeout(() => {
      if (this.saveDebounceTimer !== saveDebounceTimer) return;
      this.saveDebounceTimer = null;
      const pendingWriter = this.saveDebounceWriter;
      this.saveDebounceWriter = null;
      if (!pendingWriter) return;
      void this.saveToStorageImmediate()
        .catch(error => {
          this.logger.warn('RetryQueue 防抖保存失败', error);
        })
        .finally(() => pendingWriter.release())
        .catch(error => {
          this.logger.warn('RetryQueue 防抖 writer 释放失败', error);
        });
    }, this.SAVE_DEBOUNCE_MS);
    this.saveDebounceTimer = saveDebounceTimer;
    this.saveDebounceWriter = writer;
  }

  async persistNow(): Promise<boolean> {
    if (this.saveDebounceTimer !== null) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
      const pendingWriter = this.saveDebounceWriter;
      this.saveDebounceWriter = null;
      if (pendingWriter) return this.saveToStorageImmediateWithHandle(pendingWriter);
    }

    return this.saveToStorageImmediate();
  }

  /**
   * 立即保存队列到存储（无防抖）
   * 用于组件销毁/beforeunload 等关键路径
   * 【P2-17 修复】添加 catch 处理，防止未捕获的 Promise rejection
   * 注意：调用方故意不 await，采用 fire-and-forget 模式以不阻塞主线程
   */
  protected async saveToStorageImmediate(): Promise<boolean> {
    return trackLocalBackupUiRestoreWriterPromise(
      this.getCurrentOwnerUserId(), 'retry-queue', () => this.saveToStorageImmediateCore(),
      { continuation: true },
    );
  }

  private async saveToStorageImmediateWithHandle(
    writer: LocalBackupUiRestoreWriterHandle,
  ): Promise<boolean> {
    try {
      return await this.saveToStorageImmediate();
    } finally {
      writer.release();
    }
  }

  private async saveToStorageImmediateCore(): Promise<boolean> {
    try {
      const db = await this.initDb();

      if (db) {
        const fallbackSnapshot = this.readIdbFallbackEnvelopeSnapshot();
        const saveCapture: RetryQueueIdbSaveCapture = {};
        const success = await this.saveToIdb(db, saveCapture);
        if (success) {
          await this.settleSavedIdbFallback(db, fallbackSnapshot, saveCapture.persistedDigest);
          if ((this.queuePressureReason() ?? '').startsWith('storage_')) {
            this.clearPressureMode();
          }
          return true;
        }
      }

      // 降级到 localStorage
      return this.saveToLocalStorage({ unresolvedIdbFallback: true });
    } catch (e) {
      this.logger.warn('saveToStorage 失败，降级到 localStorage', e);
      try {
        return this.saveToLocalStorage({ unresolvedIdbFallback: true });
      } catch {
        // 完全静默：localStorage 也失败时只能丢弃
        return false;
      }
    }
  }

  /**
   * 同步保存（用于 beforeunload）
   */
  protected saveToStorageSync(): void {
    return runLocalBackupUiRestoreWriterContinuationSync(
      this.getCurrentOwnerUserId(), 'retry-queue', () => {
        this.saveToLocalStorage();
      },
    );
  }

  /**
   * 保存到 IndexedDB
   */
  protected async saveToIdb(
    db: IDBDatabase,
    capture: RetryQueueIdbSaveCapture = {},
  ): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction(this.DB_CONFIG.storeName, 'readwrite');
        const store = transaction.objectStore(this.DB_CONFIG.storeName);
        let items = this.getPersistedItems();

        transaction.oncomplete = () => {
          this.logger.debug('保存到 IndexedDB 成功', {
            count: items.length,
            visibleCount: this.queue.length,
            hiddenCount: this.hiddenQueueItems.length,
          });
          resolve(true);
        };

        transaction.onerror = () => {
          this.logger.error('保存到 IndexedDB 失败', transaction.error);
          resolve(false);
        };

        transaction.onabort = () => {
          this.logger.error('保存到 IndexedDB 中止', transaction.error);
          resolve(false);
        };

        const existingItemsRequest = store.getAll();

        existingItemsRequest.onsuccess = () => {
          const existingItems = Array.isArray(existingItemsRequest.result)
            ? existingItemsRequest.result as PersistedRetryQueueItem[]
            : [];
          items = this.mergeStoredRetryQueueItems(existingItems, items);
          capture.persistedDigest = this.computeRetryQueueItemDigest(items);

          store.clear();

          for (const item of items) {
            store.put(this.minifyItem(item));
          }
        };

        existingItemsRequest.onerror = () => {
          this.handleIdbMergeReadError(transaction, existingItemsRequest, resolve);
        };
      } catch (err) {
        this.logger.error('IndexedDB 写入异常', err);
        resolve(false);
      }
    });
  }

  private handleIdbMergeReadError(
    transaction: IDBTransaction,
    request: IDBRequest<PersistedRetryQueueItem[]>,
    resolve: (value: boolean) => void,
  ): void {
    this.logger.error('IndexedDB 合并读取失败', request.error);
    try {
      transaction.abort();
    } catch (abortError) {
      try {
        this.logger.error('IndexedDB 合并读取失败后中止事务失败，降级到 localStorage', abortError);
      } catch {
        // 日志不可用时仍继续降级，避免关键保存挂起。
      }
      resolve(false);
    }
  }

  /**
   * 保存到 localStorage
   */
  protected saveToLocalStorage(
    options: { unresolvedIdbFallback?: boolean } = {},
  ): boolean {
    if (typeof localStorage === 'undefined') return false;

    try {
      const items = this.mergeLocalStorageItemsForFallback(this.getPersistedItems());
      const minifiedItems = items.map(item => this.minifyItem(item));
      const savedAt = Date.now();
      const existingProof = this.parseIdbFallbackProof(
        this.readLocalStorageEnvelope({ logErrors: false })?.idbFallbackProof,
      );
      const nextProof = options.unresolvedIdbFallback === true || existingProof
        ? this.buildIdbFallbackProof(minifiedItems, savedAt)
        : undefined;
      const data: RetryQueueLocalStorageEnvelope = {
        version: this.VERSION,
        items: minifiedItems,
        savedAt,
        ...(nextProof ? { idbFallbackProof: nextProof } : {}),
      };

      const json = JSON.stringify(data);

      // 检查大小
      if (json.length > SYNC_CONFIG.RETRY_QUEUE_SIZE_LIMIT_BYTES) {
        this.enterPressureMode('storage_size_limit');
        this.logger.error('队列数据过大，拒绝覆盖存储以保护历史写入', {
          size: json.length,
          limit: SYNC_CONFIG.RETRY_QUEUE_SIZE_LIMIT_BYTES
        });
        this.toast.error('本地存储压力过高', '同步队列写入已冻结，请释放存储空间');
        return false;
      }

      localStorage.setItem(this.STORAGE_KEY, json);
      if ((this.queuePressureReason() ?? '').startsWith('storage_')) {
        this.clearPressureMode();
      }
      return true;
    } catch (e) {
      if ((e as Error).name === 'QuotaExceededError') {
        this.enterPressureMode('storage_quota_exceeded');
        this.logger.error('localStorage 配额超限，拒绝淘汰历史写入', {
          queueSize: this.queue.length
        });
        this.toast.error('存储空间不足', '同步队列写入已冻结，请清理浏览器存储后重试');
      } else {
        this.logger.error('localStorage 保存失败', e);
      }
      return false;
    }
  }

  private mergeLocalStorageItemsForFallback(currentItems: RetryQueueItem[]): RetryQueueItem[] {
    return this.mergeStoredRetryQueueItems(this.loadFromLocalStorage(), currentItems);
  }

  private mergeStoredRetryQueueItems(
    storedItems: PersistedRetryQueueItem[],
    currentItems: RetryQueueItem[],
  ): RetryQueueItem[] {
    const merged = new Map<string, RetryQueueItem>();

    for (const item of storedItems) {
      if (!this.isMergeableStoredRetryQueueItem(item)) {
        continue;
      }
      if (this.locallyRemovedRetryItemIds.has(item.id)) {
        continue;
      }
      const safeItem = this.ensureLoadedItemOperationId(item);
      this.mergeRetryQueueItemByEntityKey(merged, safeItem);
    }

    for (const item of currentItems) {
      this.mergeRetryQueueItemByEntityKey(merged, item, { preferExistingOnTie: true });
    }

    return Array.from(merged.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  private buildIdbFallbackRecoveryPlan(
    idbItems: PersistedRetryQueueItem[],
  ): RetryQueueIdbFallbackRecoveryPlan | null {
    const snapshot = this.readIdbFallbackEnvelopeSnapshot();
    if (!snapshot) return null;
    return {
      snapshot,
      mergedItems: this.mergeRecoveredIdbFallbackItems(
        idbItems,
        this.extractLoadableLocalStorageItems(snapshot.envelope.items),
      ),
      idbDigest: this.computeRetryQueueItemDigest(idbItems),
    };
  }

  private async settleRecoveredIdbFallback(
    db: IDBDatabase,
    recoveryPlan: RetryQueueIdbFallbackRecoveryPlan,
  ): Promise<void> {
    const currentDigest = this.computeRetryQueueItemDigest(this.getPersistedItems());
    if (recoveryPlan.idbDigest === currentDigest) {
      this.replaceIdbFallbackEnvelopeIfCurrent(
        recoveryPlan.snapshot,
        this.getPersistedItems(),
      );
      return;
    }
    const saveCapture: RetryQueueIdbSaveCapture = {};
    if (!await this.saveToIdb(db, saveCapture)) {
      this.logger.warn('RetryQueue unresolved IDB fallback 恢复后提升失败，保留 localStorage proof', { ownerUserId: recoveryPlan.snapshot.proof.ownerUserId, itemCount: recoveryPlan.snapshot.proof.itemCount });
      return;
    }
    await this.clearIdbFallbackProofAfterReadback(
      db,
      recoveryPlan.snapshot,
      saveCapture.persistedDigest,
      '提升',
    );
  }

  private mergeRecoveredIdbFallbackItems(
    idbItems: PersistedRetryQueueItem[],
    fallbackItems: PersistedRetryQueueItem[],
  ): RetryQueueItem[] {
    const merged = new Map<string, RetryQueueItem>();
    const appendItems = (items: PersistedRetryQueueItem[]): void => {
      for (const item of items) {
        if (!this.isMergeableStoredRetryQueueItem(item) || this.locallyRemovedRetryItemIds.has(item.id)) continue;
        this.mergeRetryQueueItemByEntityKey(merged, this.ensureLoadedItemOperationId(item));
      }
    };
    appendItems(idbItems);
    appendItems(fallbackItems);
    return Array.from(merged.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  private readLocalStorageEnvelope(
    options: { logErrors?: boolean } = {},
  ): RetryQueueLocalStorageEnvelope | null {
    if (typeof localStorage === 'undefined') return null;
    let parsed: Partial<RetryQueueLocalStorageEnvelope> | null = null;
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      if (!data) return null;
      parsed = JSON.parse(data) as Partial<RetryQueueLocalStorageEnvelope>;
    } catch (error) {
      if (options.logErrors !== false) this.logger.error('localStorage 加载失败', error);
    }
    return parsed && parsed.version === this.VERSION && Array.isArray(parsed.items)
      ? { version: parsed.version, items: parsed.items as PersistedRetryQueueItem[], savedAt: Number.isFinite(parsed.savedAt) ? parsed.savedAt as number : 0, idbFallbackProof: parsed.idbFallbackProof }
      : null;
  }

  private extractLoadableLocalStorageItems(
    items: PersistedRetryQueueItem[],
  ): PersistedRetryQueueItem[] {
    const now = Date.now();
    const loadableItems = items.filter(item => {
      if (now - item.createdAt >= this.MAX_ITEM_AGE || item.retryCount >= this.MAX_RETRIES) {
        void this.persistTerminalRetryEvidence(
        this.ensureLoadedItemOperationId({ ...item, data: { ...item.data } }),
          now - item.createdAt >= this.MAX_ITEM_AGE ? 'expired-on-load' : 'max-retries-on-load',
        );
        return false;
      }
      if (item.data?.id && !isValidUUID(item.data.id)) { this.logger.warn('RetryQueue localStorage 加载：丢弃非法 ID', { type: item.type, id: item.data.id }); return false; }
      return true;
    });
    this.logger.info('从 localStorage 加载队列', { count: loadableItems.length });
    return loadableItems;
  }

  private buildIdbFallbackProof(
    items: PersistedRetryQueueItem[],
    savedAt: number,
  ): RetryQueueIdbFallbackProof {
    return { version: 1, ownerUserId: this.getCurrentOwnerUserId(), savedAt, itemCount: items.length, snapshotDigest: this.computeRetryQueueItemDigest(items), recordedAt: Date.now() };
  }

  private readIdbFallbackEnvelopeSnapshot(): RetryQueueIdbFallbackEnvelopeSnapshot | null {
    const envelope = this.readLocalStorageEnvelope({ logErrors: false });
    const proof = this.parseIdbFallbackProof(envelope?.idbFallbackProof);
    if (!envelope || !proof || proof.ownerUserId !== this.getCurrentOwnerUserId()) return null;
    const envelopeItemsDigest = this.computeRetryQueueItemDigest(envelope.items);
    if (proof.savedAt !== envelope.savedAt || proof.itemCount !== envelope.items.length) return null;
    if (proof.snapshotDigest !== envelopeItemsDigest) return null;
    return { envelope, proof, envelopeItemsDigest };
  }

  private parseIdbFallbackProof(proof: unknown): RetryQueueIdbFallbackProof | null {
    const candidate = proof as Partial<RetryQueueIdbFallbackProof>;
    return proof && typeof proof === 'object'
      && candidate.version === 1
      && typeof candidate.ownerUserId === 'string' && candidate.ownerUserId.length > 0
      && Number.isFinite(candidate.savedAt) && Number.isFinite(candidate.itemCount)
      && typeof candidate.snapshotDigest === 'string' && candidate.snapshotDigest.length > 0
      && Number.isFinite(candidate.recordedAt)
      ? { version: 1, ownerUserId: candidate.ownerUserId, savedAt: candidate.savedAt as number, itemCount: candidate.itemCount as number, snapshotDigest: candidate.snapshotDigest, recordedAt: candidate.recordedAt as number }
      : null;
  }

  private computeRetryQueueItemDigest(
    items: Array<PersistedRetryQueueItem | RetryQueueItem>,
  ): string {
    const normalizedItems = items
      .map(item => {
        try {
          return JSON.stringify(this.minifyItem(item as RetryQueueItem));
        } catch {
          return JSON.stringify(item);
        }
      })
      .sort();
    let hash = 2166136261;
    for (const normalizedItem of normalizedItems) {
      for (let index = 0; index < normalizedItem.length; index += 1) {
        hash ^= normalizedItem.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    }
    return `${normalizedItems.length}:${(hash >>> 0).toString(16)}`;
  }

  private async settleSavedIdbFallback(
    db: IDBDatabase,
    snapshot: RetryQueueIdbFallbackEnvelopeSnapshot | null,
    persistedDigest: string | undefined,
  ): Promise<void> {
    if (!snapshot) return;
    await this.clearIdbFallbackProofAfterReadback(db, snapshot, persistedDigest, '当前写入');
  }

  private async clearIdbFallbackProofAfterReadback(
    db: IDBDatabase,
    snapshot: RetryQueueIdbFallbackEnvelopeSnapshot,
    persistedDigest: string | undefined,
    phase: string,
  ): Promise<void> {
    if (!persistedDigest) {
      this.logger.warn(`RetryQueue unresolved IDB fallback ${phase}后缺少持久化摘要，保留 localStorage proof`, { ownerUserId: snapshot.proof.ownerUserId });
      return;
    }
    const reloadedItems = await this.loadFromIdb(db);
    if (reloadedItems === null) {
      this.logger.warn(`RetryQueue unresolved IDB fallback ${phase}后回读失败，保留 localStorage proof`, { ownerUserId: snapshot.proof.ownerUserId });
      return;
    }
    if (this.computeRetryQueueItemDigest(reloadedItems) !== persistedDigest) {
      this.logger.warn(`RetryQueue unresolved IDB fallback ${phase}后回读不一致，保留 localStorage proof`, { ownerUserId: snapshot.proof.ownerUserId });
      return;
    }
    this.replaceIdbFallbackEnvelopeIfCurrent(snapshot, reloadedItems);
  }

  private replaceIdbFallbackEnvelopeIfCurrent(
    snapshot: RetryQueueIdbFallbackEnvelopeSnapshot,
    durableItems: Array<PersistedRetryQueueItem | RetryQueueItem>,
  ): void {
    if (typeof localStorage === 'undefined') return;
    const envelope = this.readLocalStorageEnvelope({ logErrors: false });
    const currentProof = this.parseIdbFallbackProof(envelope?.idbFallbackProof);
    if (!envelope || !currentProof || !this.isSameIdbFallbackProof(currentProof, snapshot.proof)) return;
    if (envelope.version !== snapshot.envelope.version || envelope.savedAt !== snapshot.envelope.savedAt) return;
    if (this.computeRetryQueueItemDigest(envelope.items) !== snapshot.envelopeItemsDigest) return;
    try {
      const settledItems = durableItems.map(item => this.minifyItem(item as RetryQueueItem));
      if (settledItems.length === 0) {
        localStorage.removeItem(this.STORAGE_KEY);
        return;
      }
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
        version: envelope.version,
        items: settledItems,
        savedAt: Date.now(),
      } as RetryQueueLocalStorageEnvelope));
    } catch (error) {
      this.logger.warn('RetryQueue 清理 unresolved IDB fallback proof 失败，保留下次启动恢复能力', error);
    }
  }

  private isSameIdbFallbackProof(
    left: RetryQueueIdbFallbackProof,
    right: RetryQueueIdbFallbackProof,
  ): boolean {
    return left.version === right.version && left.ownerUserId === right.ownerUserId && left.savedAt === right.savedAt
      && left.itemCount === right.itemCount && left.snapshotDigest === right.snapshotDigest && left.recordedAt === right.recordedAt;
  }

  private isMergeableStoredRetryQueueItem(item: PersistedRetryQueueItem): boolean {
    return typeof item.id === 'string'
      && item.id.length > 0
      && typeof item.sourceUserId === 'string'
      && item.sourceUserId.length > 0
      && typeof item.data?.id === 'string'
      && item.data.id.length > 0;
  }

  private mergeRetryQueueItemByEntityKey(
    merged: Map<string, RetryQueueItem>,
    item: RetryQueueItem,
    options: { preferExistingOnTie?: boolean } = {},
  ): void {
    const key = this.getRetryQueueItemStorageKey(item);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, item);
      return;
    }
    merged.set(key, this.selectRetryQueueEntityWinner(existing, item, {
      preferCurrentOnTie: options.preferExistingOnTie,
    }));
  }

  private getRetryQueueItemStorageKey(item: RetryQueueItem): string {
    return [
      this.resolveItemOwnerUserId(item),
      item.type,
      item.data.id,
    ].join('::');
  }

  /**
   * 压缩队列项（移除不必要的数据以节省空间）
   *
   * displayId 是动态计算值，不需要持久化。
   * 通过解构显式排除，避免 `undefined as unknown as string` 类型谎言。
   */
  protected minifyItem(item: RetryQueueItem): RetryQueueItem {
    return minifyItemPure(item);
  }
}
