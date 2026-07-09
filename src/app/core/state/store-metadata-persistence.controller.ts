import { DB_CONFIG } from './persistence';

const STORAGE_VERSION = 1;

export interface StoreMeta {
  key: string;
  version: number;
  lastSyncTime: string;
  activeProjectId: string | null;
  lastAuthenticatedUser?: {
    userId: string;
    email: string | null;
  } | null;
}

export interface StoreMetadataPersistenceLogger {
  debug(message: string, value?: unknown): void;
  error(message: string, value?: unknown): void;
  info(message: string, value?: unknown): void;
}

export interface StoreMetadataPersistenceSentry {
  captureException(error: unknown, context?: unknown): void;
}

export interface StoreMetadataPersistenceOptions {
  initDatabase: () => Promise<IDBDatabase>;
  isRestoring: () => boolean;
  activeProjectId: () => string | null;
  logger: StoreMetadataPersistenceLogger;
  sentryLazyLoader: StoreMetadataPersistenceSentry;
}

export class StoreMetadataPersistenceController {
  constructor(private readonly options: StoreMetadataPersistenceOptions) {}

  async saveMeta(): Promise<void> {
    if (this.options.isRestoring()) return;

    try {
      const db = await this.options.initDatabase();
      const meta: StoreMeta = {
        key: 'meta',
        version: STORAGE_VERSION,
        lastSyncTime: new Date().toISOString(),
        activeProjectId: this.options.activeProjectId(),
      };

      await this.putMeta(db, meta);
    } catch (err) {
      this.options.logger.error('保存元数据失败', err);
      this.options.sentryLazyLoader.captureException(err, { tags: { operation: 'saveMeta' } });
    }
  }

  async loadMeta(): Promise<StoreMeta | null> {
    let meta: StoreMeta | null = null;
    try {
      const db = await this.options.initDatabase();
      meta = await this.getFromStore<StoreMeta>(db, DB_CONFIG.stores.meta, 'meta');
    } catch (err) {
      this.options.logger.error('加载元数据失败', err);
    }
    return meta;
  }

  async setMetadata(metadata: Partial<StoreMeta>): Promise<void> {
    if (this.options.isRestoring()) return;

    try {
      const db = await this.options.initDatabase();
      const existingMeta = await this.getFromStore<StoreMeta>(db, DB_CONFIG.stores.meta, 'meta');
      const nextMeta: StoreMeta = {
        key: 'meta',
        version: existingMeta?.version ?? STORAGE_VERSION,
        lastSyncTime: metadata.lastSyncTime ?? existingMeta?.lastSyncTime ?? new Date().toISOString(),
        activeProjectId: Object.prototype.hasOwnProperty.call(metadata, 'activeProjectId')
          ? (metadata.activeProjectId ?? null)
          : (existingMeta?.activeProjectId ?? null),
        lastAuthenticatedUser: Object.prototype.hasOwnProperty.call(metadata, 'lastAuthenticatedUser')
          ? (metadata.lastAuthenticatedUser ?? null)
          : (existingMeta?.lastAuthenticatedUser ?? null),
      };

      await this.putMeta(db, nextMeta);
    } catch (err) {
      this.options.logger.error('保存元数据失败', err);
      throw err;
    }
  }

  async getLastActiveProjectId(availableProjectIds: string[]): Promise<string | null> {
    try {
      const meta = await this.loadMeta();
      const lastActiveId = meta?.activeProjectId;

      if (!lastActiveId) {
        this.options.logger.debug('没有保存的 lastActiveProjectId');
        return availableProjectIds[0] ?? null;
      }

      if (availableProjectIds.includes(lastActiveId)) {
        this.options.logger.debug('恢复上次活动项目', { projectId: lastActiveId });
        return lastActiveId;
      }

      this.options.logger.info('上次活动的项目已不存在，回退到第一个可用项目', {
        lastActiveId,
        availableCount: availableProjectIds.length,
      });
      return availableProjectIds[0] ?? null;
    } catch (err) {
      this.options.logger.error('获取 lastActiveProjectId 失败', err);
      return availableProjectIds[0] ?? null;
    }
  }

  async saveActiveProjectId(projectId: string | null): Promise<void> {
    if (this.options.isRestoring()) return;

    try {
      const db = await this.options.initDatabase();
      const existingMeta = await this.getFromStore<StoreMeta>(db, DB_CONFIG.stores.meta, 'meta');

      const meta: StoreMeta = {
        key: 'meta',
        version: existingMeta?.version ?? STORAGE_VERSION,
        lastSyncTime: existingMeta?.lastSyncTime ?? new Date().toISOString(),
        activeProjectId: projectId,
      };

      await this.putMeta(db, meta);
      this.options.logger.debug('activeProjectId 已保存', { projectId });
    } catch (err) {
      this.options.logger.error('保存 activeProjectId 失败', err);
    }
  }

  private async putMeta(db: IDBDatabase, meta: StoreMeta): Promise<void> {
    const transaction = db.transaction(DB_CONFIG.stores.meta, 'readwrite');
    transaction.objectStore(DB_CONFIG.stores.meta).put(meta);
    await this.waitForTransaction(transaction);
  }

  private async getFromStore<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);

      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  private waitForTransaction(transaction: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }
}
