import { Injectable, inject } from '@angular/core';

import { AuthService } from '../../../../services/auth.service';
import { DataSafetyWriteAuditService } from '../../../../services/data-safety-write-audit.service';
import { LoggerService } from '../../../../services/logger.service';
import {
  getLocalBackupUiRestoreQuiescenceSentinelStorageKey,
  LocalBackupUiRestoreWriterPausedError,
} from '../../../../services/local-backup-ui-restore-writer-quiescence-tracker';
import { localBackupUiRestoreWriterQuiescence } from '../../../../services/local-backup-ui-restore-writer-quiescence.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { StartupPlaceholderStateService } from '../../../../services/startup-placeholder-state.service';
import { AUTH_CONFIG } from '../../../../config/auth.config';
import { CACHE_CONFIG } from '../../../../config/sync.config';
import { Project } from '../../../../models';
import {
  getSnapshotByteSize as getSnapshotByteSizePure,
  normalizeOfflineSnapshotProject as normalizeOfflineSnapshotProjectPure,
} from './project-data-projection';
import { validateOfflineSnapshotProjects } from './project-offline-snapshot-validation';
import { createSyncOperationId } from '../../../../utils/sync-operation-id';

export type StartupOfflineSnapshotSource = 'idb' | 'localStorage' | 'none';

export interface StartupOfflineSnapshotLoadResult {
  source: StartupOfflineSnapshotSource;
  projectCount: number;
  bytes: number;
  migratedLegacy: boolean;
  projects: Project[];
  ownerUserId?: string | null;
}

export interface OfflineSnapshotWriteOptions {
  restoreWriterContinuation?: boolean;
}

export interface OfflineSnapshotLoadOptions {
  allowOwnerHint?: boolean;
  ownerUserId?: string | null;
}

interface ParsedOfflineSnapshotEnvelope {
  projects: Project[];
  ownerUserId: string | null;
  savedAt: string | null;
}

type StartupSnapshotCandidate = {
  source: 'idb' | 'localStorage';
  raw: string;
  snapshot: ParsedOfflineSnapshotEnvelope;
};

interface PreparedOfflineSnapshotWrite {
  ownerUserId: string;
  payload: string;
  savedAt: string;
  requestId: number;
}

interface DeferredOfflineSnapshotWrite {
  snapshot: PreparedOfflineSnapshotWrite;
  quiescenceStartedAt: number | null;
  retryDelayMs: number;
}

const OFFLINE_SNAPSHOT_DB_OPEN_TIMEOUT_MS = 5000;
const OFFLINE_SNAPSHOT_RETRY_DELAY_MS = 100;
const OFFLINE_SNAPSHOT_RETRY_MAX_DELAY_MS = 30_000;

@Injectable({ providedIn: 'root' })
export class ProjectOfflineSnapshotService {
  private readonly authService = inject(AuthService, { optional: true });
  private readonly logger = inject(LoggerService).category('ProjectData');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly startupPlaceholderState = inject(StartupPlaceholderStateService, { optional: true });
  private readonly dataSafetyWriteAudit = new DataSafetyWriteAuditService();

  private readonly OFFLINE_CACHE_KEY = CACHE_CONFIG.OFFLINE_CACHE_KEY;
  private readonly CACHE_VERSION = CACHE_CONFIG.CACHE_VERSION;
  private readonly LEGACY_OFFLINE_SNAPSHOT_RECORD_ID = 'offline-snapshot';
  private readonly deferredOfflineSnapshotWrites = new Map<string, DeferredOfflineSnapshotWrite>();
  private readonly deferredOfflineSnapshotRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private offlineSnapshotRequestId = 0;

  saveOfflineSnapshot(projects: Project[], ownerUserId?: string | null): void {
    if (this.startupPlaceholderState?.isHintOnlyActive()) {
      this.logger.debug('跳过 hint-only 启动占位快照持久化，等待 owner 确认后再写入真实离线快照');
      return;
    }

    let snapshot: PreparedOfflineSnapshotWrite;
    try {
      snapshot = this.prepareOfflineSnapshot(projects, ownerUserId);
    } catch (error) {
      this.logger.warn('离线快照准备失败', error);
      return;
    }

    void this.persistPreparedOfflineSnapshot(snapshot, { requireIndexedDB: false })
      .catch(error => this.handleFireAndForgetSnapshotFailure(snapshot, error));
  }

  async saveOfflineSnapshotAndWait(
    projects: Project[],
    ownerUserId?: string | null,
    options: OfflineSnapshotWriteOptions = {},
  ): Promise<void> {
    if (this.startupPlaceholderState?.isHintOnlyActive()) {
      this.logger.debug('跳过 hint-only 启动占位快照持久化，等待 owner 确认后再写入真实离线快照');
      return;
    }

    const snapshot = this.prepareOfflineSnapshot(projects, ownerUserId);
    await this.persistPreparedOfflineSnapshot(snapshot, {
      requireIndexedDB: true,
      restoreWriterContinuation: options.restoreWriterContinuation,
    });
  }

  loadOfflineSnapshot(options?: OfflineSnapshotLoadOptions): Project[] | null {
    return this.loadOfflineSnapshotFromLocalStorage(options);
  }

  async loadOfflineSnapshotAsync(options?: OfflineSnapshotLoadOptions): Promise<Project[] | null> {
    const snapshot = await this.loadStartupOfflineSnapshot(options);
    return snapshot.projectCount > 0 ? snapshot.projects : null;
  }

  async loadStartupOfflineSnapshot(options?: OfflineSnapshotLoadOptions): Promise<StartupOfflineSnapshotLoadResult> {
    const startupOptions: OfflineSnapshotLoadOptions = {
      allowOwnerHint: true,
      ...options,
    };

    const resolvedOwnerUserId = this.resolveSnapshotVisibleOwnerUserId(startupOptions);
    const idbPayload = await this.loadSnapshotFromIDB(startupOptions).catch((error) => {
      this.logger.warn('启动快照加载失败（IndexedDB）', error);
      return null;
    });
    const idbSnapshot = idbPayload ? this.parseSnapshotEnvelope(idbPayload) : null;
    const localStoragePayload = this.loadSnapshotFromLocalStorageRaw(startupOptions);
    const localStorageSnapshot = localStoragePayload ? this.parseSnapshotEnvelope(localStoragePayload) : null;

    this.hydrateParsedSnapshotOwner(idbSnapshot, resolvedOwnerUserId);
    this.hydrateParsedSnapshotOwner(localStorageSnapshot, resolvedOwnerUserId);

    const preferredSnapshot = this.pickPreferredStartupSnapshot(
      idbPayload,
      idbSnapshot,
      localStoragePayload,
      localStorageSnapshot,
    );

    const alternateSnapshot = this.pickAlternateStartupSnapshot(
      preferredSnapshot,
      idbPayload,
      idbSnapshot,
      localStoragePayload,
      localStorageSnapshot,
    );

    const selectedSnapshot = this.selectVisibleStartupSnapshot(
      preferredSnapshot,
      alternateSnapshot,
      startupOptions,
    );

    return this.buildSelectedStartupSnapshotResult(
      selectedSnapshot,
      resolvedOwnerUserId,
      localStoragePayload,
    );
  }

  clearOfflineSnapshot(ownerUserId?: string | null): void {
    const resolvedOwnerUserId = this.normalizeSnapshotOwnerUserId(
      ownerUserId ?? this.authService?.currentUserId(),
    );
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(this.getOfflineSnapshotStorageKey(resolvedOwnerUserId));
        if (resolvedOwnerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
          localStorage.removeItem(this.OFFLINE_CACHE_KEY);
        }
      }
      this.logger.info('离线快照已清除', { ownerUserId: resolvedOwnerUserId });
    } catch (error) {
      this.logger.warn('清除离线快照失败', error);
    }

    void this.clearSnapshotFromIDB(resolvedOwnerUserId).catch((error) => {
      this.logger.warn('清除离线快照失败（IndexedDB）', error);
    });
  }

  private prepareOfflineSnapshot(
    projects: Project[],
    ownerUserId?: string | null,
  ): PreparedOfflineSnapshotWrite {
    const cleanedProjects = projects.map(project => normalizeOfflineSnapshotProjectPure(project));
    const snapshotOwnerUserId = ownerUserId
      ?? this.authService?.currentUserId()
      ?? this.authService?.peekPersistedSessionIdentity?.()?.userId
      ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const savedAt = new Date().toISOString();
    const payload = JSON.stringify({
      projects: cleanedProjects,
      version: this.CACHE_VERSION,
      ownerUserId: snapshotOwnerUserId,
      savedAt,
    });

    const sizeKB = Math.round(payload.length / 1024);
    this.logger.debug('离线快照大小', { sizeKB, projectCount: projects.length });

    if (sizeKB > 4096) {
      this.sentryLazyLoader.captureMessage('Offline snapshot exceeds 4MB', {
        level: 'warning',
        tags: { sizeKB: String(sizeKB), projectCount: String(projects.length) },
      });
    }

    return {
      ownerUserId: snapshotOwnerUserId,
      payload,
      savedAt,
      requestId: ++this.offlineSnapshotRequestId,
    };
  }

  private async persistPreparedOfflineSnapshot(
    snapshot: PreparedOfflineSnapshotWrite,
    options: { requireIndexedDB: boolean; restoreWriterContinuation?: boolean },
  ): Promise<void> {
    const write = () => this.persistPreparedOfflineSnapshotUnlocked(snapshot, {
      requireIndexedDB: options.requireIndexedDB,
    });
    const persist = options.restoreWriterContinuation
      ? localBackupUiRestoreWriterQuiescence.runContinuationAsync(
        snapshot.ownerUserId,
        'offline-snapshot',
        write,
      )
      : localBackupUiRestoreWriterQuiescence.runAsync(
        snapshot.ownerUserId,
        'offline-snapshot',
        write,
      );
    await persist;
  }

  private async persistPreparedOfflineSnapshotUnlocked(
    snapshot: PreparedOfflineSnapshotWrite,
    options: { requireIndexedDB: boolean },
  ): Promise<void> {
    const { ownerUserId, payload, savedAt } = snapshot;

    const localStorageSaved = this.saveSnapshotToLocalStorage(payload, ownerUserId);
    let indexedDbSaved = false;

    try {
      await this.saveSnapshotToIDB(payload, ownerUserId);
      indexedDbSaved = true;
    } catch (error) {
      this.logger.warn('离线快照保存失败（IndexedDB）', error);
      if (options.requireIndexedDB && !localStorageSaved) {
        throw error;
      }
    }

    if (localStorageSaved || indexedDbSaved) {
      this.recordOfflineSnapshotWriteAudit(ownerUserId, savedAt, {
        localStorage: localStorageSaved ? 'saved' : 'failed',
        indexedDB: indexedDbSaved ? 'saved' : 'failed',
      });
    }
  }

  private handleFireAndForgetSnapshotFailure(
    snapshot: PreparedOfflineSnapshotWrite,
    error: unknown,
  ): void {
    if (error instanceof LocalBackupUiRestoreWriterPausedError
      || isWriterLeaseStorageFailure(error)
      || this.readQuiescenceSentinel(snapshot.ownerUserId).present) {
      this.deferOfflineSnapshotWrite(snapshot);
      return;
    }
    this.logger.warn('离线快照保存失败', error);
  }

  private deferOfflineSnapshotWrite(snapshot: PreparedOfflineSnapshotWrite): void {
    const ownerUserId = snapshot.ownerUserId;
    const current = this.deferredOfflineSnapshotWrites.get(ownerUserId);
    if (current && current.snapshot.requestId > snapshot.requestId) return;

    this.deferredOfflineSnapshotWrites.set(ownerUserId, {
      snapshot,
      quiescenceStartedAt: this.readQuiescenceSentinel(ownerUserId).startedAt,
      retryDelayMs: OFFLINE_SNAPSHOT_RETRY_DELAY_MS,
    });
    this.scheduleDeferredOfflineSnapshotRetry(ownerUserId, OFFLINE_SNAPSHOT_RETRY_DELAY_MS);
  }

  private scheduleDeferredOfflineSnapshotRetry(ownerUserId: string, delayMs: number): void {
    if (this.deferredOfflineSnapshotRetryTimers.has(ownerUserId)) return;
    const timer = setTimeout(() => {
      this.deferredOfflineSnapshotRetryTimers.delete(ownerUserId);
      void this.retryDeferredOfflineSnapshot(ownerUserId);
    }, delayMs);
    this.deferredOfflineSnapshotRetryTimers.set(ownerUserId, timer);
  }

  private async retryDeferredOfflineSnapshot(ownerUserId: string): Promise<void> {
    const pending = this.deferredOfflineSnapshotWrites.get(ownerUserId);
    if (!pending) return;

    if (this.readQuiescenceSentinel(ownerUserId).present) {
      this.scheduleDeferredOfflineSnapshotRetry(ownerUserId, pending.retryDelayMs);
      return;
    }

    if (pending.quiescenceStartedAt !== null
      && await this.hasSnapshotPersistedSince(ownerUserId, pending.quiescenceStartedAt)) {
      if (this.deferredOfflineSnapshotWrites.get(ownerUserId) === pending) {
        this.deferredOfflineSnapshotWrites.delete(ownerUserId);
      }
      this.logger.debug('跳过已被恢复事务较新快照覆盖的延迟离线快照');
      return;
    }

    try {
      await this.persistPreparedOfflineSnapshot(pending.snapshot, { requireIndexedDB: false });
      if (this.deferredOfflineSnapshotWrites.get(ownerUserId) === pending) {
        this.deferredOfflineSnapshotWrites.delete(ownerUserId);
      }
    } catch (error) {
      if (error instanceof LocalBackupUiRestoreWriterPausedError) {
        const quiescence = this.readQuiescenceSentinel(ownerUserId);
        const retryDelayMs = OFFLINE_SNAPSHOT_RETRY_DELAY_MS;
        this.deferredOfflineSnapshotWrites.set(ownerUserId, {
          ...pending,
          quiescenceStartedAt: quiescence.startedAt ?? pending.quiescenceStartedAt,
          retryDelayMs,
        });
        this.scheduleDeferredOfflineSnapshotRetry(ownerUserId, retryDelayMs);
        return;
      }

      this.logger.warn('延迟离线快照保存失败，将保留请求并稍后重试', error);
      const retryDelayMs = Math.min(
        Math.max(pending.retryDelayMs * 2, OFFLINE_SNAPSHOT_RETRY_DELAY_MS),
        OFFLINE_SNAPSHOT_RETRY_MAX_DELAY_MS,
      );
      this.deferredOfflineSnapshotWrites.set(ownerUserId, { ...pending, retryDelayMs });
      this.scheduleDeferredOfflineSnapshotRetry(ownerUserId, retryDelayMs);
    }
  }

  private readQuiescenceSentinel(ownerUserId: string): { present: boolean; startedAt: number | null } {
    if (typeof localStorage === 'undefined') return { present: true, startedAt: null };
    let raw: string | null;
    try {
      raw = localStorage.getItem(getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId));
    } catch {
      return { present: true, startedAt: null };
    }
    if (raw === null) return { present: false, startedAt: null };
    try {
      const value = JSON.parse(raw) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { present: true, startedAt: null };
      }
      const record = value as Record<string, unknown>;
      if (record['ownerUserId'] !== ownerUserId || typeof record['createdAt'] !== 'string') {
        return { present: true, startedAt: null };
      }
      const startedAt = Date.parse(record['createdAt']);
      return { present: true, startedAt: Number.isFinite(startedAt) ? startedAt : null };
    } catch {
      return { present: true, startedAt: null };
    }
  }

  private async hasSnapshotPersistedSince(ownerUserId: string, timestamp: number): Promise<boolean> {
    const options: OfflineSnapshotLoadOptions = { allowOwnerHint: false, ownerUserId };
    const idbPromise = this.loadSnapshotFromIDB(options).catch(() => null);
    const localStoragePayload = this.loadSnapshotFromLocalStorageRaw(options);
    const payloads = await Promise.all([idbPromise, Promise.resolve(localStoragePayload)]);
    return payloads.some(payload => {
      if (payload === null) return false;
      const snapshot = this.parseSnapshotEnvelope(payload);
      if (!snapshot || snapshot.savedAt === null) return false;
      const snapshotOwner = snapshot.ownerUserId ?? (
        ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID ? AUTH_CONFIG.LOCAL_MODE_USER_ID : null
      );
      return snapshotOwner === ownerUserId && Date.parse(snapshot.savedAt) >= timestamp;
    });
  }

  private recordOfflineSnapshotWriteAudit(
    ownerUserId: string,
    savedAt: string,
    settlement: { localStorage: 'saved' | 'failed'; indexedDB: 'saved' | 'failed' },
  ): void {
    const normalizedOwnerUserId = this.normalizeSnapshotOwnerUserId(ownerUserId);
    try {
      this.dataSafetyWriteAudit.recordWrite({
        ownerUserId: normalizedOwnerUserId,
        operationId: createSyncOperationId(),
        sourceUserId: normalizedOwnerUserId,
        entityType: 'offline-snapshot',
        entityId: this.getOfflineSnapshotRecordId(normalizedOwnerUserId),
        operation: 'replace',
        localTimestamp: Date.parse(savedAt),
        updatedAtBaseline: null,
        beforeVersion: null,
        rpcResult: {
          status: 'applied',
          reason: 'offline-snapshot-settled',
          decision: 'local-offline-snapshot-replaced',
          entityId: this.getOfflineSnapshotRecordId(normalizedOwnerUserId),
          raw: { settlement },
        },
        enteredRetryQueue: false,
        retryCount: 0,
        lastSyncTimeBefore: null,
        lastSyncTimeAfter: null,
      });
    } catch (error) {
      this.logger.warn('离线快照 DataSafety 写入审计记录失败', error);
    }
  }

  private normalizeSnapshotOwnerUserId(ownerUserId?: string | null): string {
    return typeof ownerUserId === 'string' && ownerUserId.length > 0
      ? ownerUserId
      : AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private getOfflineSnapshotStorageKey(ownerUserId: string = AUTH_CONFIG.LOCAL_MODE_USER_ID): string {
    return `${this.OFFLINE_CACHE_KEY}.${ownerUserId}`;
  }

  private getOfflineSnapshotRecordId(ownerUserId: string = AUTH_CONFIG.LOCAL_MODE_USER_ID): string {
    return `${this.LEGACY_OFFLINE_SNAPSHOT_RECORD_ID}:${ownerUserId}`;
  }

  private saveSnapshotToLocalStorage(payload: string, ownerUserId: string): boolean {
    if (typeof localStorage === 'undefined') return false;
    try {
      const normalizedOwnerUserId = this.normalizeSnapshotOwnerUserId(ownerUserId);
      localStorage.setItem(this.getOfflineSnapshotStorageKey(normalizedOwnerUserId), payload);
      if (normalizedOwnerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        localStorage.removeItem(this.OFFLINE_CACHE_KEY);
      }
      return true;
    } catch (error) {
      this.logger.warn('离线快照保存失败（localStorage）', error);
      return false;
    }
  }

  private async saveSnapshotToIDB(payload: string, ownerUserId: string): Promise<void> {
    const db = await this.openSnapshotDB();
    await this.runSnapshotWriteTransaction(db, store => {
      store.put({
        id: this.getOfflineSnapshotRecordId(this.normalizeSnapshotOwnerUserId(ownerUserId)),
        ownerUserId: this.normalizeSnapshotOwnerUserId(ownerUserId),
        data: payload,
      });
    });
  }

  private runSnapshotWriteTransaction(
    db: IDBDatabase,
    write: (store: IDBObjectStore) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const close = (): void => {
        try {
          db.close();
        } catch {
          // A close failure must not replace the transaction outcome.
        }
      };
      const resolveOnce = (): void => {
        if (settled) return;
        settled = true;
        close();
        resolve();
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        close();
        reject(error);
      };

      let tx: IDBTransaction;
      try {
        tx = db.transaction('snapshots', 'readwrite');
      } catch (error) {
        rejectOnce(error);
        return;
      }

      tx.oncomplete = resolveOnce;
      tx.onerror = () => rejectOnce(
        tx.error ?? new DOMException('Offline snapshot transaction failed', 'UnknownError'),
      );
      tx.onabort = () => rejectOnce(
        tx.error ?? new DOMException('Offline snapshot transaction aborted', 'AbortError'),
      );

      try {
        write(tx.objectStore('snapshots'));
      } catch (error) {
        try {
          tx.abort();
        } catch {
          // The transaction may already be inactive; preserve the original error.
        }
        rejectOnce(error);
      }
    });
  }

  private async loadSnapshotFromIDB(options?: OfflineSnapshotLoadOptions): Promise<string | null> {
    const db = await this.openSnapshotDB();
    const ownerUserId = this.resolveSnapshotVisibleOwnerUserId(options);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readonly');
      const store = tx.objectStore('snapshots');
      const scopedReq = store.get(this.getOfflineSnapshotRecordId(ownerUserId));
      scopedReq.onsuccess = () => {
        const scopedPayload = scopedReq.result?.data ?? null;
        if (scopedPayload || ownerUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
          db.close();
          resolve(scopedPayload);
          return;
        }

        const legacyReq = store.get(this.LEGACY_OFFLINE_SNAPSHOT_RECORD_ID);
        legacyReq.onsuccess = () => {
          db.close();
          resolve(legacyReq.result?.data ?? null);
        };
        legacyReq.onerror = () => {
          db.close();
          reject(legacyReq.error);
        };
      };
      scopedReq.onerror = () => {
        db.close();
        reject(scopedReq.error);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new DOMException('Offline snapshot read aborted', 'AbortError'));
      };
    });
  }

  private openSnapshotDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('nanoflow-offline-snapshots', 1);
      let settled = false;
      const timeoutId = setTimeout(() => {
        rejectOnce(new DOMException(
          'Offline snapshot IndexedDB open timed out',
          'TimeoutError',
        ));
      }, OFFLINE_SNAPSHOT_DB_OPEN_TIMEOUT_MS);
      const resolveOnce = (db: IDBDatabase): void => {
        if (settled) {
          try {
            db.close();
          } catch {
            // A timed-out or blocked request may still succeed later; close it.
          }
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        resolve(db);
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      };
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolveOnce(request.result);
      request.onerror = () => rejectOnce(
        request.error ?? new DOMException('Offline snapshot IndexedDB open failed', 'UnknownError'),
      );
      request.onblocked = () => rejectOnce(new DOMException(
        'Offline snapshot IndexedDB open blocked by another connection',
        'InvalidStateError',
      ));
    });
  }

  private async buildSelectedStartupSnapshotResult(
    selectedSnapshot: StartupSnapshotCandidate | null,
    resolvedOwnerUserId: string,
    localStoragePayload: string | null,
  ): Promise<StartupOfflineSnapshotLoadResult> {
    if (selectedSnapshot?.source === 'idb') {
      return this.buildStartupSnapshotResult('idb', selectedSnapshot.raw, selectedSnapshot.snapshot, false);
    }

    if (selectedSnapshot?.source === 'localStorage') {
      const migratedLegacy = await this.migrateLegacySnapshotToIDB(
        selectedSnapshot.raw,
        resolvedOwnerUserId,
      );
      return this.buildStartupSnapshotResult('localStorage', selectedSnapshot.raw, selectedSnapshot.snapshot, migratedLegacy);
    }

    return this.buildEmptyStartupSnapshotResult(localStoragePayload ? null : undefined);
  }

  private buildEmptyStartupSnapshotResult(ownerUserId?: string | null): StartupOfflineSnapshotLoadResult {
    const result: StartupOfflineSnapshotLoadResult = {
      source: 'none',
      projectCount: 0,
      bytes: 0,
      migratedLegacy: false,
      projects: [],
    };

    if (ownerUserId !== undefined) {
      result.ownerUserId = ownerUserId;
    }

    return result;
  }

  private loadSnapshotFromLocalStorageRaw(options?: OfflineSnapshotLoadOptions): string | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const ownerUserId = this.resolveSnapshotVisibleOwnerUserId(options);
      const scopedPayload = localStorage.getItem(this.getOfflineSnapshotStorageKey(ownerUserId));
      if (scopedPayload !== null) {
        return scopedPayload;
      }

      if (ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        return localStorage.getItem(this.OFFLINE_CACHE_KEY);
      }

      return null;
    } catch (error) {
      this.logger.warn('离线快照加载失败（localStorage）', error);
      // eslint-disable-next-line no-restricted-syntax -- localStorage 访问异常时返回 null 触发上层降级
      return null;
    }
  }

  private loadOfflineSnapshotFromLocalStorage(options?: OfflineSnapshotLoadOptions): Project[] | null {
    const cached = this.loadSnapshotFromLocalStorageRaw(options);
    if (!cached) {
      return null;
    }

    const snapshot = this.parseSnapshotEnvelope(cached);
    if (!snapshot) {
      return null;
    }

    if (!this.isSnapshotVisibleToCurrentOwner(snapshot.ownerUserId, 'sync-load', options)) {
      return null;
    }

    return snapshot.projects;
  }

  private resolveSnapshotVisibleOwnerUserId(options?: OfflineSnapshotLoadOptions): string {
    if (typeof options?.ownerUserId === 'string' && options.ownerUserId.length > 0) {
      return options.ownerUserId;
    }

    const currentOwnerUserId = this.authService?.currentUserId();
    if (typeof currentOwnerUserId === 'string' && currentOwnerUserId.length > 0) {
      return currentOwnerUserId;
    }

    const persistedSessionUserId = this.authService?.peekPersistedSessionIdentity?.()?.userId ?? null;
    if (typeof persistedSessionUserId === 'string' && persistedSessionUserId.length > 0) {
      return persistedSessionUserId;
    }

    if (options?.allowOwnerHint) {
      const persistedOwnerHint = typeof this.authService?.peekPersistedOwnerHint === 'function'
        ? this.authService.peekPersistedOwnerHint()
        : null;
      if (typeof persistedOwnerHint === 'string' && persistedOwnerHint.length > 0) {
        return persistedOwnerHint;
      }
    }

    return AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private isSnapshotVisibleToCurrentOwner(
    ownerUserId: string | null,
    stage: 'sync-load',
    options?: OfflineSnapshotLoadOptions,
  ): boolean {
    const currentOwnerUserId = this.resolveSnapshotVisibleOwnerUserId(options);

    if (!ownerUserId) {
      this.logger.warn('同步快照缺少 owner 元数据，已忽略本次读取', {
        stage,
        currentOwnerUserId,
      });
      return false;
    }

    if (ownerUserId !== currentOwnerUserId) {
      this.logger.warn('同步快照 owner 不匹配，已忽略本次读取', {
        stage,
        snapshotOwnerUserId: ownerUserId,
        currentOwnerUserId,
      });
      return false;
    }

    return true;
  }

  private parseSnapshotEnvelope(raw: string): ParsedOfflineSnapshotEnvelope | null {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.logger.warn('快照数据结构校验失败', { errors: ['snapshot envelope must be an object'] });
        return null;
      }

      const envelope = parsed as Record<string, unknown>;
      const validation = validateOfflineSnapshotProjects(envelope['projects']);
      if (!validation.valid) {
        this.logger.warn('快照数据结构校验失败', { errors: validation.errors });
        return null;
      }

      return {
        projects: validation.projects.map(project => normalizeOfflineSnapshotProjectPure(project)),
        ownerUserId: typeof envelope['ownerUserId'] === 'string' && envelope['ownerUserId'].trim().length > 0
          ? envelope['ownerUserId']
          : null,
        savedAt: typeof envelope['savedAt'] === 'string' && envelope['savedAt'].trim().length > 0
          ? envelope['savedAt']
          : null,
      };
    } catch (error) {
      this.logger.warn('快照数据解析失败', error);
    }
    return null;
  }

  private buildStartupSnapshotResult(
    source: StartupOfflineSnapshotSource,
    raw: string,
    snapshot: ParsedOfflineSnapshotEnvelope,
    migratedLegacy: boolean,
  ): StartupOfflineSnapshotLoadResult {
    return {
      source,
      projectCount: snapshot.projects.length,
      bytes: getSnapshotByteSizePure(raw),
      migratedLegacy,
      projects: snapshot.projects,
      ownerUserId: snapshot.ownerUserId,
    };
  }

  private getSnapshotSavedAtTimestamp(snapshot: ParsedOfflineSnapshotEnvelope | null): number {
    if (!snapshot?.savedAt) {
      return 0;
    }

    const timestamp = new Date(snapshot.savedAt).getTime();
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }

  private hydrateParsedSnapshotOwner(snapshot: ParsedOfflineSnapshotEnvelope | null, resolvedOwnerUserId: string): void {
    if (snapshot && !snapshot.ownerUserId && resolvedOwnerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      snapshot.ownerUserId = resolvedOwnerUserId;
    }
  }

  private pickPreferredStartupSnapshot(
    idbRaw: string | null,
    idbSnapshot: ParsedOfflineSnapshotEnvelope | null,
    localStorageRaw: string | null,
    localStorageSnapshot: ParsedOfflineSnapshotEnvelope | null,
  ): StartupSnapshotCandidate | null {
    if (idbSnapshot && localStorageSnapshot && idbRaw && localStorageRaw) {
      const idbSavedAt = this.getSnapshotSavedAtTimestamp(idbSnapshot);
      const localStorageSavedAt = this.getSnapshotSavedAtTimestamp(localStorageSnapshot);

      if (localStorageSavedAt > idbSavedAt) {
        return {
          source: 'localStorage',
          raw: localStorageRaw,
          snapshot: localStorageSnapshot,
        };
      }

      return {
        source: 'idb',
        raw: idbRaw,
        snapshot: idbSnapshot,
      };
    }

    if (idbSnapshot && idbRaw) {
      return {
        source: 'idb',
        raw: idbRaw,
        snapshot: idbSnapshot,
      };
    }

    if (localStorageSnapshot && localStorageRaw) {
      return {
        source: 'localStorage',
        raw: localStorageRaw,
        snapshot: localStorageSnapshot,
      };
    }

    return null;
  }

  private pickAlternateStartupSnapshot(
    preferredSnapshot: StartupSnapshotCandidate | null,
    idbRaw: string | null,
    idbSnapshot: ParsedOfflineSnapshotEnvelope | null,
    localStorageRaw: string | null,
    localStorageSnapshot: ParsedOfflineSnapshotEnvelope | null,
  ): StartupSnapshotCandidate | null {
    if (!preferredSnapshot) {
      return null;
    }

    if (preferredSnapshot.source === 'idb' && localStorageRaw && localStorageSnapshot) {
      return {
        source: 'localStorage',
        raw: localStorageRaw,
        snapshot: localStorageSnapshot,
      };
    }

    if (preferredSnapshot.source === 'localStorage' && idbRaw && idbSnapshot) {
      return {
        source: 'idb',
        raw: idbRaw,
        snapshot: idbSnapshot,
      };
    }

    return null;
  }

  private selectVisibleStartupSnapshot(
    preferredSnapshot: StartupSnapshotCandidate | null,
    alternateSnapshot: StartupSnapshotCandidate | null,
    options?: OfflineSnapshotLoadOptions,
  ): StartupSnapshotCandidate | null {
    if (
      preferredSnapshot
      && this.isSnapshotVisibleToCurrentOwner(preferredSnapshot.snapshot.ownerUserId, 'sync-load', options)
    ) {
      return preferredSnapshot;
    }

    if (
      alternateSnapshot
      && this.isSnapshotVisibleToCurrentOwner(alternateSnapshot.snapshot.ownerUserId, 'sync-load', options)
    ) {
      return alternateSnapshot;
    }

    return null;
  }

  private async migrateLegacySnapshotToIDB(payload: string, ownerUserId: string): Promise<boolean> {
    try {
      await this.saveSnapshotToIDB(payload, ownerUserId);
      return true;
    } catch (error) {
      this.logger.warn('legacy 离线快照迁移到 IndexedDB 失败', error);
      return false;
    }
  }

  private async clearSnapshotFromIDB(ownerUserId: string): Promise<void> {
    const db = await this.openSnapshotDB();
    await this.runSnapshotWriteTransaction(db, store => {
      store.delete(this.getOfflineSnapshotRecordId(ownerUserId));
      if (ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        store.delete(this.LEGACY_OFFLINE_SNAPSHOT_RECORD_ID);
      }
    });
  }
}

function isWriterLeaseStorageFailure(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'QuotaExceededError' || error.name === 'SecurityError';
  }
  return error instanceof Error
    && error.message === 'local backup UI restore writer tracking requires localStorage';
}
