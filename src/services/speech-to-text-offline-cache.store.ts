import type { OfflineAudioCacheEntry } from '../models/focus';

export type OfflineAudioCacheState = 'owned' | 'quarantined';
export type OfflineAudioCacheSaveResult = {
  id: string;
  state: OfflineAudioCacheState;
};

type SpeechToTextOfflineCacheStoreOptions = {
  dbProvider: () => IDBDatabase | null;
  storeName: string;
  unknownOwnerUserId: string;
};

export class SpeechToTextOfflineCacheStore {
  private readonly dbProvider: () => IDBDatabase | null;
  private readonly storeName: string;
  private readonly unknownOwnerUserId: string;

  constructor(options: SpeechToTextOfflineCacheStoreOptions) {
    this.dbProvider = options.dbProvider;
    this.storeName = options.storeName;
    this.unknownOwnerUserId = options.unknownOwnerUserId;
  }

  save(blob: Blob, ownerUserId: string | null): Promise<OfflineAudioCacheSaveResult> {
    const db = this.requireDb();
    const normalizedOwnerUserId = ownerUserId ?? this.unknownOwnerUserId;
    const cacheState = normalizedOwnerUserId === this.unknownOwnerUserId ? 'quarantined' : 'owned';
    const entry: OfflineAudioCacheEntry = {
      id: crypto.randomUUID(),
      ownerUserId: normalizedOwnerUserId,
      blob,
      createdAt: new Date().toISOString(),
      mimeType: blob.type,
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const request = tx.objectStore(this.storeName).add(entry);
      let requestCompleted = false;

      request.onsuccess = () => {
        requestCompleted = true;
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => {
        if (requestCompleted) {
          resolve({ id: entry.id, state: cacheState });
          return;
        }
        reject(new Error('Offline audio cache save did not complete'));
      };
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () => reject(tx.error ?? request.error);
    });
  }

  readAll(): Promise<OfflineAudioCacheEntry[]> {
    const db = this.dbProvider();
    if (!db) {
      return Promise.resolve([]);
    }

    return new Promise((resolve, reject) => {
      const request = db.transaction(this.storeName, 'readonly')
        .objectStore(this.storeName)
        .getAll();

      request.onsuccess = () => resolve(request.result as OfflineAudioCacheEntry[]);
      request.onerror = () => reject(request.error);
    });
  }

  delete(id: string): Promise<void> {
    const db = this.dbProvider();
    if (!db) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const request = tx.objectStore(this.storeName).delete(id);
      let requestCompleted = false;

      request.onsuccess = () => {
        requestCompleted = true;
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => {
        if (requestCompleted) {
          resolve();
          return;
        }
        reject(new Error('Offline audio cache delete did not complete'));
      };
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () => reject(tx.error ?? request.error);
    });
  }

  async countOwnedBy(ownerUserId: string | null): Promise<number> {
    if (!ownerUserId) {
      return 0;
    }

    const items = await this.readAll();
    return items.filter(item => item.ownerUserId === ownerUserId).length;
  }

  /**
   * 把单条录音重新标记为 unknown owner（隔离）：
   * 用于转写服务永久拒绝（非可重试错误）的录音——保留音频数据（可导出/可恢复），
   * 但不再进入自动重放批次，避免毒化 batch 预算造成 15s 无限重放循环
   */
  quarantine(id: string): Promise<boolean> {
    const db = this.dbProvider();
    if (!db) {
      return Promise.resolve(false);
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const request = store.get(id);
      let quarantined = false;

      request.onsuccess = () => {
        const item = request.result as OfflineAudioCacheEntry | undefined;
        if (!item) {
          return;
        }

        store.put({
          ...item,
          ownerUserId: this.unknownOwnerUserId,
        });
        quarantined = true;
      };

      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(quarantined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? request.error);
    });
  }

  migrateLegacyOwners(): Promise<number> {
    const db = this.dbProvider();
    if (!db) {
      return Promise.resolve(0);
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const request = store.getAll();
      let migratedCount = 0;

      request.onsuccess = () => {
        const items = request.result as OfflineAudioCacheEntry[];
        for (const item of items) {
          if (item.ownerUserId) {
            continue;
          }

          store.put({
            ...item,
            ownerUserId: this.unknownOwnerUserId,
          });
          migratedCount += 1;
        }
      };

      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(migratedCount);
      tx.onerror = () => reject(tx.error);
    });
  }

  private requireDb(): IDBDatabase {
    const db = this.dbProvider();
    if (!db) {
      throw new Error('IndexedDB not initialized');
    }
    return db;
  }
}
