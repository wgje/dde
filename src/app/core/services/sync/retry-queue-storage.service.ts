import { SYNC_CONFIG } from '../../../../config';
import { isValidUUID } from '../../../../utils/validation';
import { minifyItem as minifyItemPure } from './retry-queue-fingerprint';
import type {
  DbInitFinalize,
  PersistedRetryQueueItem,
  RetryQueueItem,
  RetryQueueStorageLoadToken,
} from './retry-queue.types';
import { RetryQueueRunnerLayer } from './retry-queue-runner.service';

export abstract class RetryQueueStorageLayer extends RetryQueueRunnerLayer {
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
    const db = await this.initDb();
    if (!this.isStorageLoadTokenCurrent(loadToken)) {
      this.logStaleStorageLoad(loadToken, 'loadFromStorage:init-db');
      return;
    }

    if (db && await this.tryLoadQueueFromIdb(db, loadToken)) return;
    this.loadQueueFromLocalStorage(loadToken);
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

    const { safeItems, removedCount, repairedOperationIdCount } = this.sanitizeLoadedItems(items);
    if (!this.isStorageLoadTokenCurrent(loadToken)) {
      this.logStaleStorageLoad(loadToken, 'loadFromStorage:idb-sanitized');
      return true;
    }

    const duplicateRemovedCount = this.applyLoadedItems(safeItems);
    this.logger.info('从 IndexedDB 加载队列', {
      count: items.length,
      visibleCount: this.queue.length,
      hiddenCount: this.hiddenQueueItems.length,
      removedCount: removedCount + duplicateRemovedCount,
      repairedOperationIdCount,
      ownerUserId: this.getCurrentOwnerUserId(),
    });
    this.finishLoadedQueueItems(removedCount + duplicateRemovedCount, repairedOperationIdCount);
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
  
  /**
   * 从 IndexedDB 加载
   *
   * 使用 readonly 事务，避免不必要的排他锁阻塞并发读写。
   * 若存在脏条目需要清理，单独开启 readwrite 事务处理。
   */
  protected async loadFromIdb(db: IDBDatabase): Promise<PersistedRetryQueueItem[] | null> {
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction(this.DB_CONFIG.storeName, 'readonly');
        const store = transaction.objectStore(this.DB_CONFIG.storeName);
        const request = store.getAll();
        
        request.onsuccess = () => {
          const raw = request.result || [];
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

          // 从 IDB 中物理删除脏条目（使用独立 readwrite 事务）
          if (dirtyKeys.length > 0) {
            this.logger.warn('RetryQueue 启动清理：从 IDB 删除脏条目', { keys: dirtyKeys });
            this.logger.info('RetryQueue 加载：已过滤脏数据', { removed: dirtyKeys.length });
            try {
              const delTx = db.transaction(this.DB_CONFIG.storeName, 'readwrite');
              const delStore = delTx.objectStore(this.DB_CONFIG.storeName);
              for (const key of dirtyKeys) {
                delStore.delete(key);
              }
            } catch (delErr) {
              this.logger.error('RetryQueue：删除脏条目失败', delErr);
            }
          }

          this.logger.debug('从 IndexedDB 加载', { count: clean.length });
          resolve(clean);
        };
        
        request.onerror = () => {
          this.logger.error('IndexedDB 加载失败', request.error);
          resolve(null);
        };
      } catch (err) {
        this.logger.error('IndexedDB 读取异常', err);
        resolve(null);
      }
    });
  }
  
  /**
   * 从 localStorage 加载
   */
  protected loadFromLocalStorage(): PersistedRetryQueueItem[] {
    if (typeof localStorage === 'undefined') return [];
    
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      if (!data) return [];
      
      const parsed = JSON.parse(data);
      if (parsed.version === this.VERSION && Array.isArray(parsed.items)) {
        // 过滤过期项 + 非法 ID 脏数据
        const now = Date.now();
        const items = parsed.items.filter((item: PersistedRetryQueueItem) => {
          if (now - item.createdAt >= this.MAX_ITEM_AGE || item.retryCount >= this.MAX_RETRIES) {
            // 降级加载路径的终态项同样不得静默丢弃（§5.6）：
            // 隔离保留证据后再从活动队列剔除（业务边界：不再自动回放）
            void this.persistTerminalRetryEvidence(
              this.ensureLoadedItemOperationId({ ...item, data: { ...item.data } }),
              now - item.createdAt >= this.MAX_ITEM_AGE ? 'expired-on-load' : 'max-retries-on-load',
            );
            return false;
          }
          // 过滤非法 ID 的脏数据
          if (item.data?.id && !isValidUUID(item.data.id)) {
            this.logger.warn('RetryQueue localStorage 加载：丢弃非法 ID', { type: item.type, id: item.data.id });
            return false;
          }
          return true;
        });
        this.logger.info('从 localStorage 加载队列', { count: items.length });
        return items;
      }
    } catch (e) {
      this.logger.error('localStorage 加载失败', e);
    }

    return [];
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
    const saveDebounceTimer = setTimeout(() => {
      if (this.saveDebounceTimer !== saveDebounceTimer) return;
      this.saveDebounceTimer = null;
      try {
        void this.saveToStorageImmediate().catch(error => {
          this.logger.warn('RetryQueue 防抖保存失败', error);
        });
      } catch (error) {
        this.logger.warn('RetryQueue 防抖保存失败', error);
      }
    }, this.SAVE_DEBOUNCE_MS);
    this.saveDebounceTimer = saveDebounceTimer;
  }

  async persistNow(): Promise<boolean> {
    if (this.saveDebounceTimer !== null) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
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
    try {
      const db = await this.initDb();
      
      if (db) {
        const success = await this.saveToIdb(db);
        if (success) {
          if ((this.queuePressureReason() ?? '').startsWith('storage_')) {
            this.clearPressureMode();
          }
          return true;
        }
      }
      
      // 降级到 localStorage
      return this.saveToLocalStorage();
    } catch (e) {
      this.logger.warn('saveToStorage 失败，降级到 localStorage', e);
      try {
        return this.saveToLocalStorage();
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
    // IndexedDB 不支持同步操作，只能保存到 localStorage
    this.saveToLocalStorage();
  }
  
  /**
   * 保存到 IndexedDB
   */
  protected async saveToIdb(db: IDBDatabase): Promise<boolean> {
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
  protected saveToLocalStorage(): boolean {
    if (typeof localStorage === 'undefined') return false;
    
    try {
      const items = this.mergeLocalStorageItemsForFallback(this.getPersistedItems());
      const data = {
        version: this.VERSION,
        items: items.map(item => this.minifyItem(item)),
        savedAt: Date.now()
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
      this.mergeRetryQueueItemByEntityKey(merged, item, { preferIncoming: true });
    }

    return Array.from(merged.values()).sort((a, b) => a.createdAt - b.createdAt);
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
    options: { preferIncoming?: boolean } = {},
  ): void {
    const key = this.getRetryQueueItemStorageKey(item);
    const existing = merged.get(key);
    if (options.preferIncoming || !existing || item.createdAt >= existing.createdAt) {
      merged.set(key, item);
    }
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
