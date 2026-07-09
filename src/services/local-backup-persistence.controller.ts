import { del, get, set } from 'idb-keyval';

import { LOCAL_BACKUP_CONFIG } from '../config/local-backup.config';

const IDB_KEYS = {
  DIRECTORY_HANDLE: 'nanoflow.local-backup.directory-handle',
} as const;

export interface LocalBackupPersistedState {
  lastBackupTime: string | null;
  autoBackupEnabled: boolean;
  autoBackupIntervalMs: number;
  directoryName: string | null;
  hasSavedHandle: boolean;
}

export interface LocalBackupStateToPersist {
  lastBackupTime: string | null;
  autoBackupEnabled: boolean;
  autoBackupIntervalMs: number;
  directoryName: string | null;
}

export interface LocalBackupPersistenceLogger {
  debug(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export interface LocalBackupPersistenceAdapters {
  logger: LocalBackupPersistenceLogger;
  idbGet?<T = unknown>(key: string): Promise<T | undefined>;
  idbSet?<T = unknown>(key: string, value: T): Promise<void>;
  idbDel?(key: string): Promise<void>;
}

export class LocalBackupPersistenceController {
  constructor(private readonly adapters: LocalBackupPersistenceAdapters) {}

  loadState(): LocalBackupPersistedState {
    try {
      const directoryName = localStorage.getItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.DIRECTORY_HANDLE);
      return {
        lastBackupTime: localStorage.getItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.LAST_BACKUP_TIME),
        autoBackupEnabled: localStorage.getItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.AUTO_BACKUP_ENABLED) === 'true',
        autoBackupIntervalMs: this.loadBackupIntervalMs(),
        directoryName,
        hasSavedHandle: !!directoryName,
      };
    } catch (error) {
      this.warnPersistenceFailure('加载本地备份持久化状态失败', error);
      return {
        lastBackupTime: null,
        autoBackupEnabled: false,
        autoBackupIntervalMs: LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS,
        directoryName: null,
        hasSavedHandle: false,
      };
    }
  }

  saveState(state: LocalBackupStateToPersist): void {
    try {
      this.setOrRemove(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.LAST_BACKUP_TIME, state.lastBackupTime);
      localStorage.setItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.AUTO_BACKUP_ENABLED, String(state.autoBackupEnabled));
      localStorage.setItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.AUTO_BACKUP_INTERVAL, String(state.autoBackupIntervalMs));
      this.setOrRemove(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.DIRECTORY_HANDLE, state.directoryName);
    } catch (error) {
      this.warnPersistenceFailure('保存本地备份持久化状态失败', error);
    }
  }

  clearState(): void {
    try {
      Object.values(LOCAL_BACKUP_CONFIG.STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
    } catch (error) {
      this.warnPersistenceFailure('清除本地备份持久化状态失败', error);
    }
  }

  clearDirectoryHandleName(): void {
    try {
      localStorage.removeItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.DIRECTORY_HANDLE);
    } catch (error) {
      this.warnPersistenceFailure('清除本地备份目录名称失败', error);
    }
  }

  async saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    try {
      await (this.adapters.idbSet ?? set)(IDB_KEYS.DIRECTORY_HANDLE, handle);
      this.adapters.logger.debug('DirectoryHandle 已保存到 IndexedDB');
    } catch (error) {
      this.warnPersistenceFailure('保存 DirectoryHandle 到 IndexedDB 失败', error);
    }
  }

  async restoreDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
    let restoredHandle: FileSystemDirectoryHandle | null = null;
    try {
      restoredHandle = await (this.adapters.idbGet ?? get)<FileSystemDirectoryHandle>(IDB_KEYS.DIRECTORY_HANDLE) ?? null;
    } catch (error) {
      this.warnPersistenceFailure('从 IndexedDB 恢复 DirectoryHandle 失败', error);
    }
    return restoredHandle;
  }

  async clearDirectoryHandle(): Promise<void> {
    try {
      await (this.adapters.idbDel ?? del)(IDB_KEYS.DIRECTORY_HANDLE);
      this.adapters.logger.debug('DirectoryHandle 已从 IndexedDB 清除');
    } catch (error) {
      this.warnPersistenceFailure('清除 IndexedDB 中的 DirectoryHandle 失败', error);
    }
  }

  private loadBackupIntervalMs(): number {
    const interval = localStorage.getItem(LOCAL_BACKUP_CONFIG.STORAGE_KEYS.AUTO_BACKUP_INTERVAL);
    if (!interval) {
      return LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS;
    }

    const parsed = Number.parseInt(interval, 10);
    return Number.isFinite(parsed) ? parsed : LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS;
  }

  private setOrRemove(key: string, value: string | null): void {
    if (value && value.length > 0) {
      localStorage.setItem(key, value);
      return;
    }
    localStorage.removeItem(key);
  }

  private warnPersistenceFailure(message: string, error: unknown): void {
    try {
      this.adapters.logger.warn(message, error);
    } catch {
      // Persistence fallback paths must keep their original swallow/return behavior.
    }
  }
}
