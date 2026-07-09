import { DB_CONFIG } from './persistence';

export interface StoreCacheCleanupLogger {
  error(message: string, value?: unknown): void;
  info(message: string, value?: unknown): void;
}

export interface StoreCacheCleanupOptions {
  initDatabase: () => Promise<IDBDatabase>;
  logger: StoreCacheCleanupLogger;
}

export class StoreCacheCleanupController {
  constructor(private readonly options: StoreCacheCleanupOptions) {}

  async deleteProject(projectId: string): Promise<void> {
    try {
      const db = await this.options.initDatabase();
      const transaction = db.transaction(
        [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections],
        'readwrite'
      );

      transaction.objectStore(DB_CONFIG.stores.projects).delete(projectId);
      await this.deleteRecordsByProjectId(transaction.objectStore(DB_CONFIG.stores.tasks), projectId);
      await this.deleteRecordsByProjectId(transaction.objectStore(DB_CONFIG.stores.connections), projectId);
      await this.waitForTransaction(transaction);

      this.options.logger.info('项目本地缓存已删除', { projectId });
    } catch (err) {
      this.logCleanupError('删除项目缓存失败', { projectId, error: err });
    }
  }

  async clearAll(): Promise<void> {
    try {
      const db = await this.options.initDatabase();
      const transaction = db.transaction(
        [
          DB_CONFIG.stores.projects,
          DB_CONFIG.stores.tasks,
          DB_CONFIG.stores.connections,
          DB_CONFIG.stores.meta,
          DB_CONFIG.stores.syncCursors,
        ],
        'readwrite'
      );

      transaction.objectStore(DB_CONFIG.stores.projects).clear();
      transaction.objectStore(DB_CONFIG.stores.tasks).clear();
      transaction.objectStore(DB_CONFIG.stores.connections).clear();
      transaction.objectStore(DB_CONFIG.stores.meta).clear();
      transaction.objectStore(DB_CONFIG.stores.syncCursors).clear();
      await this.waitForTransaction(transaction);

      this.options.logger.info('所有本地缓存已清除');
    } catch (err) {
      this.logCleanupError('清除缓存失败', err);
    }
  }

  private logCleanupError(message: string, value?: unknown): void {
    try {
      this.options.logger.error(message, value);
    } catch {
      // Cache cleanup failures are already isolated; logging must not rethrow them.
    }
  }

  private async deleteRecordsByProjectId(store: IDBObjectStore, projectId: string): Promise<void> {
    const index = store.index('projectId');
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = index.getAllKeys(projectId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    for (const key of keys) {
      store.delete(key);
    }
  }

  private waitForTransaction(transaction: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }
}
