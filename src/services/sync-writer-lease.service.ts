/**
 * SyncWriterLeaseService - 同步写入者租约
 *
 * 计划 §6.5：多标签 single-writer 门禁。
 *
 * 职责：
 * - 任何标签页都可以本地写 IndexedDB 并即时更新 UI；
 * - 但只有持有 sync writer lease 的标签页可以执行 cloud push、flush
 *   RetryQueue/ActionQueue、提交 `lastSyncTime`。
 *
 * 实现策略（按优先级降级）：
 * 1. Web Locks API（最佳）：锁名 `nanoflow-sync:<env>:<userId>:<projectId>`，
 *    `requestLeaseWithSignal` 内部用 `AbortSignal` 取消等待；
 * 2. IndexedDB lease + BroadcastChannel heartbeat（降级）：
 *    lease record 包含 `ownerTabId` / `expiresAt` / `lastHeartbeatAt`；
 *    `lease_ttl_ms` 内未续期视为过期，其他标签可抢占；
 * 3. 都不可用时：每标签页只能 single-flush（基于内存 mutex），
 *    并上报 Sentry breadcrumb，不可作为生产模式。
 *
 * 默认 flag：`NG_APP_SYNC_LEASE_ENABLED=false`。本 PR 仅落服务与 spec，
 * 切换 RetryQueue/ActionQueue 真实写入路径必须由独立 PR 完成并配套 e2e。
 *
 * 【非边界】Web Locks 按 origin 隔离，**不能**解决新旧 origin 双写。
 *           origin 迁移仍依赖 §7 Canonical Origin Gate 与 export-only 策略。
 */

import { Injectable, computed, inject, signal } from '@angular/core';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { environment } from '../environments/environment';

export type LeaseAcquisitionMode = 'weblocks' | 'idb-lease' | 'memory-only';

export interface LeaseHandle {
  /** 唯一会话 ID（debug + 抢占判定）。 */
  readonly tabId: string;
  /** 锁名（含 env / userId / projectId）。 */
  readonly lockName: string;
  /** 实际生效的获取模式。 */
  readonly mode: LeaseAcquisitionMode;
  /** 释放当前持有的 lease；幂等。 */
  release(): Promise<void>;
}

export interface LeaseRequestOptions {
  userId: string;
  projectId: string;
  /** 取消等待 lease 的 AbortSignal。 */
  signal?: AbortSignal;
  /** lease 持有 TTL（仅对 IndexedDB 降级路径有意义）。 */
  ttlMs?: number;
}

/** IndexedDB lease record. */
interface LeaseRecord {
  ownerTabId: string;
  expiresAt: number;
  lastHeartbeatAt: number;
  acquiredAt: number;
}

const DEFAULT_LEASE_TTL_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const LEASE_DB_NAME = 'nanoflow-sync-lease';
const LEASE_STORE_NAME = 'leases';

interface SyncLeaseEnvironmentSlice {
  syncLeaseEnabled?: boolean;
  sentryEnvironment?: string;
}

@Injectable({ providedIn: 'root' })
export class SyncWriterLeaseService {
  private readonly logger = inject(LoggerService).category('SyncLease');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);

  private readonly tabId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  /** Feature flag：默认关闭。 */
  private readonly featureEnabled = signal<boolean>(this.readFeatureFlag());

  /** 当前是否持有 lease（仅本服务 instance 内可信，跨标签需走 lockName）。 */
  private readonly holding = signal<LeaseHandle | null>(null);

  /** Web Locks API 是否可用。 */
  private readonly webLocksAvailable = signal<boolean>(
    typeof navigator !== 'undefined' && typeof (navigator as Navigator & { locks?: unknown }).locks !== 'undefined',
  );

  readonly currentMode = computed<LeaseAcquisitionMode | null>(() => {
    const handle = this.holding();
    return handle?.mode ?? null;
  });

  readonly isHolder = computed<boolean>(() => this.holding() !== null);

  readonly isFeatureEnabled = computed<boolean>(() => this.featureEnabled());

  /**
   * 请求 sync writer lease。
   *
   * - feature 关闭时返回伪 lease（mode='memory-only'，立即可用），保持向后兼容；
   * - feature 开启时优先 Web Locks，失败降级 IndexedDB lease；
   * - `signal` 触发 abort 时 reject(`AbortError`)。
   *
   * 调用方契约：用完必须 `await handle.release()`，且必须在 `signal` aborted
   * 时认为 lease 已无效。
   */
  async requestLease(options: LeaseRequestOptions): Promise<LeaseHandle> {
    if (!this.featureEnabled()) {
      // 默认关闭：返回 noop lease，调用方不应基于 mode 做强一致假设。
      const noop = this.buildNoopHandle(options);
      this.holding.set(noop);
      return noop;
    }

    if (this.holding() !== null) {
      throw new Error('SyncWriterLease 已持有 lease；同一服务实例禁止重入');
    }

    const lockName = this.buildLockName(options.userId, options.projectId);

    if (this.webLocksAvailable()) {
      try {
        return await this.acquireViaWebLocks(lockName, options);
      } catch (err) {
        if (this.isAbortError(err)) throw err;
        this.logger.warn(`web_locks_failed: ${(err as Error)?.message ?? err}; 降级到 IndexedDB lease`);
        this.addLeaseBreadcrumb('sync_writer_lease_fallback', 'warning', lockName, 'idb-lease', {
          from: 'weblocks',
          reason: (err as Error)?.message ?? String(err),
        });
        // 一旦失败标记不可用，避免每次都 fallback。
        this.webLocksAvailable.set(false);
      }
    }

    try {
      return await this.acquireViaIndexedDb(lockName, options);
    } catch (err) {
      if (this.isAbortError(err)) throw err;
      this.logger.warn(`idb_lease_failed: ${(err as Error)?.message ?? err}; 降级到 memory-only`);
      const noop = this.buildNoopHandle(options, 'memory-only');
      this.holding.set(noop);
      this.addLeaseBreadcrumb('sync_writer_lease_fallback', 'warning', noop.lockName, 'memory-only', {
        from: 'idb-lease',
        reason: (err as Error)?.message ?? String(err),
      });
      return noop;
    }
  }

  // ---------------- Web Locks 路径 ----------------

  private acquireViaWebLocks(lockName: string, options: LeaseRequestOptions): Promise<LeaseHandle> {
    const locks = (navigator as Navigator & { locks: LockManager }).locks;

    return new Promise<LeaseHandle>((resolve, reject) => {
      let releaseFn: (() => void) | null = null;
      let alreadyResolved = false;

      const lockPromise = locks.request(
        lockName,
        { signal: options.signal },
        () => new Promise<void>(innerResolve => {
          // 进入这里说明已成功持有锁。
          releaseFn = innerResolve;
          if (alreadyResolved) return;
          alreadyResolved = true;
          const handle: LeaseHandle = {
            tabId: this.tabId,
            lockName,
            mode: 'weblocks',
            release: async () => {
              if (releaseFn) {
                const fn = releaseFn;
                releaseFn = null;
                fn();
              }
              this.holding.set(null);
              this.addLeaseBreadcrumb('sync_writer_lease_released', 'info', lockName, 'weblocks');
            },
          };
          this.holding.set(handle);
          this.addLeaseBreadcrumb('sync_writer_lease_acquired', 'info', lockName, 'weblocks');
          resolve(handle);
        }),
      );

      lockPromise.catch((err: unknown) => {
        if (alreadyResolved) return;
        reject(err);
      });
    });
  }

  // ---------------- IndexedDB lease 路径 ----------------

  private async acquireViaIndexedDb(lockName: string, options: LeaseRequestOptions): Promise<LeaseHandle> {
    const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    const db = await this.openLeaseDb();

    // 尝试抢占：只有当 lockName 不存在或当前持有者已过期时才能 take ownership。
    while (!options.signal?.aborted) {
      const taken = await this.tryTakeIndexedDbLease(db, lockName, ttlMs);
      if (taken) {
        // 启动 heartbeat 定时器维持 lease。
        const heartbeatTimer = this.startHeartbeat(db, lockName, ttlMs);
        const handle: LeaseHandle = {
          tabId: this.tabId,
          lockName,
          mode: 'idb-lease',
          release: async () => {
            clearInterval(heartbeatTimer);
            await this.releaseIndexedDbLease(db, lockName);
            this.holding.set(null);
            this.addLeaseBreadcrumb('sync_writer_lease_released', 'info', lockName, 'idb-lease');
          },
        };
        this.holding.set(handle);
        this.addLeaseBreadcrumb('sync_writer_lease_acquired', 'info', lockName, 'idb-lease');
        return handle;
      }
      // 等待一小段再尝试；abort 时立即跳出。
      await this.sleepWithAbort(500, options.signal);
    }

    throw new DOMException('Sync writer lease acquisition aborted', 'AbortError');
  }

  private async tryTakeIndexedDbLease(db: IDBDatabase, lockName: string, ttlMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction([LEASE_STORE_NAME], 'readwrite');
      const store = tx.objectStore(LEASE_STORE_NAME);
      const getReq = store.get(lockName);
      getReq.onsuccess = () => {
        const now = Date.now();
        const existing = getReq.result as LeaseRecord | undefined;
        const expired = !existing || existing.expiresAt <= now;
        if (!expired) {
          resolve(false);
          return;
        }
        const next: LeaseRecord = {
          ownerTabId: this.tabId,
          expiresAt: now + ttlMs,
          lastHeartbeatAt: now,
          acquiredAt: now,
        };
        const putReq = store.put(next, lockName);
        putReq.onsuccess = () => resolve(true);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  private startHeartbeat(db: IDBDatabase, lockName: string, ttlMs: number): ReturnType<typeof setInterval> {
    return setInterval(() => {
      void this.heartbeatIndexedDbLease(db, lockName, ttlMs).catch(err => {
        this.logger.debug(`lease_heartbeat_failed: ${(err as Error)?.message ?? err}`);
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private heartbeatIndexedDbLease(db: IDBDatabase, lockName: string, ttlMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([LEASE_STORE_NAME], 'readwrite');
      const store = tx.objectStore(LEASE_STORE_NAME);
      const getReq = store.get(lockName);
      getReq.onsuccess = () => {
        const existing = getReq.result as LeaseRecord | undefined;
        if (!existing || existing.ownerTabId !== this.tabId) {
          resolve();
          return;
        }
        const now = Date.now();
        const next: LeaseRecord = {
          ...existing,
          expiresAt: now + ttlMs,
          lastHeartbeatAt: now,
        };
        const putReq = store.put(next, lockName);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  private releaseIndexedDbLease(db: IDBDatabase, lockName: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([LEASE_STORE_NAME], 'readwrite');
      const store = tx.objectStore(LEASE_STORE_NAME);
      const getReq = store.get(lockName);
      getReq.onsuccess = () => {
        const existing = getReq.result as LeaseRecord | undefined;
        // 仅在自己仍是 owner 时才删除，避免误删他人 lease。
        if (!existing || existing.ownerTabId !== this.tabId) {
          resolve();
          return;
        }
        const delReq = store.delete(lockName);
        delReq.onsuccess = () => resolve();
        delReq.onerror = () => reject(delReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  private openLeaseDb(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(LEASE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(LEASE_STORE_NAME)) {
          db.createObjectStore(LEASE_STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---------------- helpers ----------------

  private buildLockName(userId: string, projectId: string): string {
    const env = environment as unknown as SyncLeaseEnvironmentSlice;
    const envName = env.sentryEnvironment ?? 'unknown';
    return `nanoflow-sync:${envName}:${userId}:${projectId}`;
  }

  private buildNoopHandle(options: LeaseRequestOptions, mode: LeaseAcquisitionMode = 'memory-only'): LeaseHandle {
    return {
      tabId: this.tabId,
      lockName: this.buildLockName(options.userId, options.projectId),
      mode,
      release: async () => {
        this.holding.set(null);
        this.addLeaseBreadcrumb('sync_writer_lease_released', 'info', this.buildLockName(options.userId, options.projectId), mode);
      },
    };
  }

  private addLeaseBreadcrumb(
    message: string,
    level: 'info' | 'warning',
    lockName: string,
    mode: LeaseAcquisitionMode,
    extra: Record<string, unknown> = {},
  ): void {
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync.lease',
      level,
      message,
      data: {
        lockName,
        mode,
        tabId: this.tabId,
        ...extra,
      },
    });
  }

  private isAbortError(err: unknown): boolean {
    return err instanceof DOMException && err.name === 'AbortError';
  }

  private async sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        timer = null;
        resolve();
      }, ms);
      signal?.addEventListener('abort', () => {
        if (timer !== null) clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  private readFeatureFlag(): boolean {
    const env = environment as unknown as SyncLeaseEnvironmentSlice;
    return env.syncLeaseEnabled === true;
  }
}
