import { Injectable, inject } from '@angular/core';

import { AuthService } from '../../../../services/auth.service';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { StartupPlaceholderStateService } from '../../../../services/startup-placeholder-state.service';
import { AUTH_CONFIG } from '../../../../config/auth.config';
import { CACHE_CONFIG } from '../../../../config/sync.config';
import { Project } from '../../../../models';
import {
  getSnapshotByteSize as getSnapshotByteSizePure,
  normalizeOfflineSnapshotProject as normalizeOfflineSnapshotProjectPure,
} from './project-data-projection';

export type StartupOfflineSnapshotSource = 'idb' | 'localStorage' | 'none';

export interface StartupOfflineSnapshotLoadResult {
  source: StartupOfflineSnapshotSource;
  projectCount: number;
  bytes: number;
  migratedLegacy: boolean;
  projects: Project[];
  ownerUserId?: string | null;
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

@Injectable({ providedIn: 'root' })
export class ProjectOfflineSnapshotService {
  private readonly authService = inject(AuthService, { optional: true });
  private readonly logger = inject(LoggerService).category('ProjectData');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly startupPlaceholderState = inject(StartupPlaceholderStateService, { optional: true });

  private readonly OFFLINE_CACHE_KEY = CACHE_CONFIG.OFFLINE_CACHE_KEY;
  private readonly CACHE_VERSION = CACHE_CONFIG.CACHE_VERSION;
  private readonly LEGACY_OFFLINE_SNAPSHOT_RECORD_ID = 'offline-snapshot';

  saveOfflineSnapshot(projects: Project[], ownerUserId?: string | null): void {
    void this.persistOfflineSnapshot(projects, ownerUserId, { requireIndexedDB: false });
  }

  async saveOfflineSnapshotAndWait(projects: Project[], ownerUserId?: string | null): Promise<void> {
    await this.persistOfflineSnapshot(projects, ownerUserId, { requireIndexedDB: true });
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

  private async persistOfflineSnapshot(
    projects: Project[],
    ownerUserId?: string | null,
    options: { requireIndexedDB: boolean } = { requireIndexedDB: false },
  ): Promise<void> {
    if (this.startupPlaceholderState?.isHintOnlyActive()) {
      this.logger.debug('跳过 hint-only 启动占位快照持久化，等待 owner 确认后再写入真实离线快照');
      return;
    }

    const cleanedProjects = projects.map(project => normalizeOfflineSnapshotProjectPure(project));
    const snapshotOwnerUserId = ownerUserId
      ?? this.authService?.currentUserId()
      ?? this.authService?.peekPersistedSessionIdentity?.()?.userId
      ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const payload = JSON.stringify({
      projects: cleanedProjects,
      version: this.CACHE_VERSION,
      ownerUserId: snapshotOwnerUserId,
      savedAt: new Date().toISOString(),
    });

    const sizeKB = Math.round(payload.length / 1024);
    this.logger.debug('离线快照大小', { sizeKB, projectCount: projects.length });

    if (sizeKB > 4096) {
      this.sentryLazyLoader.captureMessage('Offline snapshot exceeds 4MB', {
        level: 'warning',
        tags: { sizeKB: String(sizeKB), projectCount: String(projects.length) },
      });
    }

    const localStorageSaved = this.saveSnapshotToLocalStorage(payload, snapshotOwnerUserId);

    try {
      await this.saveSnapshotToIDB(payload, snapshotOwnerUserId);
    } catch (error) {
      this.logger.warn('离线快照保存失败（IndexedDB）', error);
      if (options.requireIndexedDB && !localStorageSaved) {
        throw error;
      }
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
    return new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readwrite');
      tx.objectStore('snapshots').put({
        id: this.getOfflineSnapshotRecordId(this.normalizeSnapshotOwnerUserId(ownerUserId)),
        ownerUserId: this.normalizeSnapshotOwnerUserId(ownerUserId),
        data: payload,
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
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
    });
  }

  private openSnapshotDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('nanoflow-offline-snapshots', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
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
      const parsed = JSON.parse(raw) as { projects?: Project[]; ownerUserId?: unknown; savedAt?: unknown };
      if (Array.isArray(parsed?.projects)) {
        return {
          projects: parsed.projects.map((project: Project) => normalizeOfflineSnapshotProjectPure(project)),
          ownerUserId: typeof parsed.ownerUserId === 'string' && parsed.ownerUserId.trim().length > 0
            ? parsed.ownerUserId
            : null,
          savedAt: typeof parsed.savedAt === 'string' && parsed.savedAt.trim().length > 0
            ? parsed.savedAt
            : null,
        };
      }
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
    return new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readwrite');
      const store = tx.objectStore('snapshots');
      store.delete(this.getOfflineSnapshotRecordId(ownerUserId));
      if (ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        store.delete(this.LEGACY_OFFLINE_SNAPSHOT_RECORD_ID);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }
}
