import { del, get, set } from 'idb-keyval';

import { LOCAL_BACKUP_CONFIG } from '../config/local-backup.config';

const OWNER_KEY_VERSION = 'owner-v1';
const DIRECTORY_HANDLE_ENVELOPE_VERSION = 1;

export type LocalBackupOwnerScope =
  | { kind: 'authenticated'; userId: string }
  | { kind: 'local' };

export interface LocalBackupOwnerContext {
  scope: LocalBackupOwnerScope;
  epoch: number;
}

export type LocalBackupPermissionMode = 'query' | 'query-and-request' | 'request';

export type LocalBackupPermissionResult =
  | { kind: 'permission'; permission: PermissionState }
  | { kind: 'stale' }
  | { kind: 'error'; error: unknown };

interface LocalBackupDirectoryHandleEnvelope {
  version: typeof DIRECTORY_HANDLE_ENVELOPE_VERSION;
  ownerScope: LocalBackupOwnerScope;
  handle: FileSystemDirectoryHandle;
}

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
  private ownerEpoch = 0;
  private activeOwnerContext: LocalBackupOwnerContext | null = null;

  constructor(private readonly adapters: LocalBackupPersistenceAdapters) {}

  activateOwnerScope(scope: LocalBackupOwnerScope): LocalBackupOwnerContext {
    const context = { scope: this.copyScope(scope), epoch: ++this.ownerEpoch };
    this.activeOwnerContext = context;
    return context;
  }

  detachOwnerScope(): void {
    this.ownerEpoch += 1;
    this.activeOwnerContext = null;
  }

  captureOwnerContext(): LocalBackupOwnerContext | null {
    return this.activeOwnerContext;
  }

  isOwnerContextCurrent(context: LocalBackupOwnerContext): boolean {
    return this.activeOwnerContext?.epoch === context.epoch
      && this.scopesEqual(this.activeOwnerContext.scope, context.scope);
  }

  loadState(context: LocalBackupOwnerContext): LocalBackupPersistedState {
    if (!this.isOwnerContextCurrent(context)) return this.emptyState();
    try {
      const directoryName = localStorage.getItem(this.stateKey(context, 'DIRECTORY_HANDLE'));
      return {
        lastBackupTime: localStorage.getItem(this.stateKey(context, 'LAST_BACKUP_TIME')),
        autoBackupEnabled: localStorage.getItem(this.stateKey(context, 'AUTO_BACKUP_ENABLED')) === 'true',
        autoBackupIntervalMs: this.loadBackupIntervalMs(context),
        directoryName,
        hasSavedHandle: !!directoryName,
      };
    } catch (error) {
      this.warnPersistenceFailure('加载本地备份持久化状态失败', error);
      return this.emptyState();
    }
  }

  saveState(context: LocalBackupOwnerContext, state: LocalBackupStateToPersist): void {
    if (!this.isOwnerContextCurrent(context)) return;
    try {
      this.setOrRemove(this.stateKey(context, 'LAST_BACKUP_TIME'), state.lastBackupTime);
      localStorage.setItem(this.stateKey(context, 'AUTO_BACKUP_ENABLED'), String(state.autoBackupEnabled));
      localStorage.setItem(this.stateKey(context, 'AUTO_BACKUP_INTERVAL'), String(state.autoBackupIntervalMs));
      this.setOrRemove(this.stateKey(context, 'DIRECTORY_HANDLE'), state.directoryName);
    } catch (error) {
      this.warnPersistenceFailure('保存本地备份持久化状态失败', error);
    }
  }

  clearState(context: LocalBackupOwnerContext): void {
    if (!this.isOwnerContextCurrent(context)) return;
    try {
      Object.keys(LOCAL_BACKUP_CONFIG.STORAGE_KEYS).forEach(key => {
        localStorage.removeItem(this.stateKey(context, key as keyof typeof LOCAL_BACKUP_CONFIG.STORAGE_KEYS));
      });
    } catch (error) {
      this.warnPersistenceFailure('清除本地备份持久化状态失败', error);
    }
  }

  clearDirectoryHandleName(context: LocalBackupOwnerContext): void {
    if (!this.isOwnerContextCurrent(context)) return;
    try {
      localStorage.removeItem(this.stateKey(context, 'DIRECTORY_HANDLE'));
    } catch (error) {
      this.warnPersistenceFailure('清除本地备份目录名称失败', error);
    }
  }

  async saveDirectoryHandle(
    context: LocalBackupOwnerContext,
    handle: FileSystemDirectoryHandle,
  ): Promise<void> {
    if (!this.isOwnerContextCurrent(context)) return;
    const envelope: LocalBackupDirectoryHandleEnvelope = {
      version: DIRECTORY_HANDLE_ENVELOPE_VERSION,
      ownerScope: this.copyScope(context.scope),
      handle,
    };
    try {
      await (this.adapters.idbSet ?? set)(this.directoryHandleKey(context), envelope);
      this.adapters.logger.debug('DirectoryHandle 已保存到 IndexedDB');
    } catch (error) {
      this.warnPersistenceFailure('保存 DirectoryHandle 到 IndexedDB 失败', error);
    }
  }

  async restoreDirectoryHandle(context: LocalBackupOwnerContext): Promise<FileSystemDirectoryHandle | null> {
    if (!this.isOwnerContextCurrent(context)) return null;
    let restoredHandle: FileSystemDirectoryHandle | null = null;
    try {
      const value = await (this.adapters.idbGet ?? get)<unknown>(this.directoryHandleKey(context));
      if (this.isOwnerContextCurrent(context) && this.isDirectoryHandleEnvelope(value, context.scope)) {
        restoredHandle = value.handle;
      }
    } catch (error) {
      this.warnPersistenceFailure('从 IndexedDB 恢复 DirectoryHandle 失败', error);
    }
    return restoredHandle;
  }

  async clearDirectoryHandle(context: LocalBackupOwnerContext): Promise<void> {
    if (!this.isOwnerContextCurrent(context)) return;
    try {
      await (this.adapters.idbDel ?? del)(this.directoryHandleKey(context));
      this.adapters.logger.debug('DirectoryHandle 已从 IndexedDB 清除');
    } catch (error) {
      this.warnPersistenceFailure('清除 IndexedDB 中的 DirectoryHandle 失败', error);
    }
  }

  async resolveDirectoryPermission(
    context: LocalBackupOwnerContext,
    handle: FileSystemDirectoryHandle,
    mode: LocalBackupPermissionMode,
  ): Promise<LocalBackupPermissionResult> {
    if (!this.isOwnerContextCurrent(context)) return { kind: 'stale' };
    try {
      let permission: PermissionState;
      if (mode === 'request') {
        permission = await handle.requestPermission({ mode: 'readwrite' });
      } else {
        permission = await handle.queryPermission({ mode: 'readwrite' });
        if (!this.isOwnerContextCurrent(context)) return { kind: 'stale' };
        if (permission !== 'granted' && mode === 'query-and-request') {
          permission = await handle.requestPermission({ mode: 'readwrite' });
        }
      }
      return this.isOwnerContextCurrent(context)
        ? { kind: 'permission', permission }
        : { kind: 'stale' };
    } catch (error) {
      return this.isOwnerContextCurrent(context) ? { kind: 'error', error } : { kind: 'stale' };
    }
  }

  private stateKey(
    context: LocalBackupOwnerContext,
    key: keyof typeof LOCAL_BACKUP_CONFIG.STORAGE_KEYS,
  ): string {
    return `${LOCAL_BACKUP_CONFIG.STORAGE_KEYS[key]}.${OWNER_KEY_VERSION}.${this.scopeKey(context.scope)}`;
  }

  private directoryHandleKey(context: LocalBackupOwnerContext): string {
    return `nanoflow.local-backup.directory-handle.${OWNER_KEY_VERSION}.${this.scopeKey(context.scope)}`;
  }

  private scopeKey(scope: LocalBackupOwnerScope): string {
    return scope.kind === 'local' ? 'local' : `authenticated.${encodeURIComponent(scope.userId)}`;
  }

  private loadBackupIntervalMs(context: LocalBackupOwnerContext): number {
    const interval = localStorage.getItem(this.stateKey(context, 'AUTO_BACKUP_INTERVAL'));
    if (!interval) return LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS;
    const parsed = Number.parseInt(interval, 10);
    return Number.isFinite(parsed) ? parsed : LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS;
  }

  private emptyState(): LocalBackupPersistedState {
    return {
      lastBackupTime: null,
      autoBackupEnabled: false,
      autoBackupIntervalMs: LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS,
      directoryName: null,
      hasSavedHandle: false,
    };
  }

  private isDirectoryHandleEnvelope(
    value: unknown,
    scope: LocalBackupOwnerScope,
  ): value is LocalBackupDirectoryHandleEnvelope {
    if (!value || typeof value !== 'object') return false;
    const envelope = value as Partial<LocalBackupDirectoryHandleEnvelope>;
    const handle = envelope.handle as Partial<FileSystemDirectoryHandle> | undefined;
    return envelope.version === DIRECTORY_HANDLE_ENVELOPE_VERSION
      && !!envelope.ownerScope
      && this.scopesEqual(envelope.ownerScope, scope)
      && !!handle
      && handle.kind === 'directory'
      && typeof handle.name === 'string';
  }

  private scopesEqual(left: LocalBackupOwnerScope, right: LocalBackupOwnerScope): boolean {
    return left.kind === right.kind
      && (left.kind === 'local' || (right.kind === 'authenticated' && left.userId === right.userId));
  }

  private copyScope(scope: LocalBackupOwnerScope): LocalBackupOwnerScope {
    return scope.kind === 'local' ? { kind: 'local' } : { kind: 'authenticated', userId: scope.userId };
  }

  private setOrRemove(key: string, value: string | null): void {
    if (value && value.length > 0) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  }

  private warnPersistenceFailure(message: string, error: unknown): void {
    try {
      this.adapters.logger.warn(message, error);
    } catch {
      // Persistence fallback paths must keep their original swallow/return behavior.
    }
  }
}
