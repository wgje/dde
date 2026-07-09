import { AUTH_CONFIG } from '../config/auth.config';
import { type BlackBoxEntry } from '../models/focus';
import { blackBoxEntriesMap, setBlackBoxEntries, updateBlackBoxEntry } from '../state/focus-stores';
import { supabaseErrorToError } from '../utils/supabase-error';
import { isValidUUID } from '../utils/validation';
import { hasEquivalentEntryState as hasEquivalentEntryStatePure } from './black-box-entry-equivalence';
import { BlackBoxSyncBase } from './black-box-sync-base.service';
import { BlackBoxSyncOwnerMismatchController } from './black-box-sync-owner-mismatch.controller';
import {
  resolveBlackBoxLocalHydration,
  resolveBlackBoxLocalVisibleUserId,
  type BlackBoxLocalHydrationLogEvent,
} from './black-box-sync-local-hydration.helpers';
import { BlackBoxSyncQueueRealtimeLayer } from './black-box-sync-queue-realtime.service';
import { type BlackBoxMergeMode, type BlackBoxSupabaseClient, type IDBBlackBoxEntry, type LoadBlackBoxLocalOptions } from './black-box-sync.types';

export abstract class BlackBoxSyncLocalLayer extends BlackBoxSyncQueueRealtimeLayer {
  private readonly ownerMismatchController = new BlackBoxSyncOwnerMismatchController({
    deleteFromLocal: entryId => this.deleteFromLocal(entryId),
    getRetryQueueHandler: () => this.retryQueueHandler,
    getVisibleEntries: () => blackBoxEntriesMap(),
    logger: this.logger,
    markEntrySyncConflict: entry => this.markEntrySyncConflict(entry),
    pushToServer: (entry, sessionUserId) => this.pushToServer(entry, sessionUserId),
    saveToLocal: entry => this.saveToLocal(entry),
    setVisibleEntries: entries => setBlackBoxEntries(entries),
    updateVisibleEntry: entry => updateBlackBoxEntry(entry),
  });

  async saveToLocal(entry: BlackBoxEntry): Promise<void> {
    if (!this.db) {
      await this.initIndexedDB();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('IndexedDB not initialized'));
        return;
      }

      const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);

      const putEntry = (entryToPersist: BlackBoxEntry) => {
        const idbEntry: IDBBlackBoxEntry = {
          ...entryToPersist,
          _localVersion: Date.now()
        };

        const request = store.put(idbEntry);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      };

      const existingRequest = store.get(entry.id);
      existingRequest.onsuccess = () => {
        const result = existingRequest.result as IDBBlackBoxEntry | undefined;
        const existing = result
          ? (({ _localVersion: _localVersion, ...rest }) => rest)(result)
          : null;
        putEntry(this.hydrateBlankContentFromSource(entry, existing, 'local-idb'));
      };
      existingRequest.onerror = () => {
        if (this.isBlankOrMissingContent(entry.content)) {
          reject(existingRequest.error ?? new Error('Unable to read existing BlackBox entry before blank-content write'));
          return;
        }
        putEntry(entry);
      };
    });
  }

  /**
   * 将已被终止云端重放的本地条目标记为 conflict。
   * 仅修正同步元数据，不改变业务字段，避免 UI 长期误报“待同步”。
   */
  async markEntrySyncConflict(entry: BlackBoxEntry): Promise<void> {
    const latestLocal = await this.resolveLatestLocalEntry(entry.id);
    const latestSameOwner = latestLocal?.userId === entry.userId ? latestLocal : null;

    if (latestSameOwner?.syncStatus === 'synced' || latestSameOwner?.syncStatus === 'conflict') {
      return;
    }

    if (latestSameOwner && this.isEntryNewer(latestSameOwner, entry)) {
      this.logger.debug('跳过过期的黑匣子 conflict 修复：本地已有更新快照', {
        entryId: entry.id,
        repairUpdatedAt: entry.updatedAt,
        latestLocalUpdatedAt: latestSameOwner.updatedAt,
      });
      return;
    }

    const baseEntry = latestSameOwner ?? entry;
    const conflictEntry = this.hydrateBlankContentFromSource(
      {
        ...baseEntry,
        syncStatus: 'conflict',
      },
      baseEntry === entry ? latestSameOwner : entry,
      'latest-local',
    );

    await this.saveToLocal(conflictEntry);

    const visibleEntry = blackBoxEntriesMap().get(entry.id);
    if (visibleEntry?.userId === conflictEntry.userId) {
      updateBlackBoxEntry({
        ...visibleEntry,
        ...conflictEntry,
        syncStatus: 'conflict',
      });
    }
  }

  /**
   * 处理 owner-mismatch 的本地 pending 条目，避免 UI 长期显示 待同步。
   * 见 pushToServer / recoverPendingEntries 的调用点。
   *
   * 处理策略：
   * 1. entry.userId === LOCAL_MODE_USER_ID 且当前会话是合法云端 UUID → 改写 owner 后
   *    通过 retryQueueHandler / pushToServer 续推（保护 local→cloud 数据迁移）；
   * 2. entry.userId 不是合法 UUID（"dev-preview" 等历史脏数据） → 物理删除；
   * 3. entry.userId 是合法 UUID 但与当前会话不一致（跨账号残留） → markEntrySyncConflict
   *    把 syncStatus 由 pending 降级为 conflict，让 UI 立即收敛。
   */
  protected async selfHealOwnerMismatchedEntry(
    entry: BlackBoxEntry,
    sessionUserId: string,
    sourceUserId: string | undefined,
  ): Promise<void> {
    await this.ownerMismatchController.selfHealOwnerMismatchedEntry(
      entry,
      sessionUserId,
      sourceUserId,
    );
  }

  protected async rebrandLocalModeOwnerAndRetry(
    entry: BlackBoxEntry,
    sessionUserId: string
  ): Promise<void> {
    await this.ownerMismatchController.rebrandLocalModeOwnerAndRetry(entry, sessionUserId);
  }

  protected async deleteInvalidOwnerEntry(entry: BlackBoxEntry): Promise<void> {
    await this.ownerMismatchController.deleteInvalidOwnerEntry(entry);
  }

  protected async markOwnerMismatchConflict(entry: BlackBoxEntry): Promise<void> {
    await this.ownerMismatchController.markOwnerMismatchConflict(entry);
  }

  /**
   * 当 push 完成时发现 latestLocalAfterPush 比 entry 更晚，按业务字段等价性决定：
   *   - 等价（差异只是 updatedAt 这种同步元数据）→ 升级为 synced，避免 UI 长期 待同步；
   *   - 不等价（latestLocal 含未推送的真实编辑）→ 保留 pending，并主动确保 latestLocal
   *     已经在 RetryQueue / debounce 队列中等待续推（避免孤儿挂死成"长期 待同步"）。
   * 这是「Fix 3·路径 B」的核心收敛点，RPC / 直接 upsert 两条路径共用。
   */
  protected async upgradeEquivalentLatestLocalToSynced(
    latestLocal: BlackBoxEntry,
    pushedEntry: BlackBoxEntry,
    serverUpdatedAt: string,
    pushPath: 'rpc' | 'upsert',
  ): Promise<void> {
    if (this.hasEquivalentEntryState(latestLocal, pushedEntry)) {
      const synced: BlackBoxEntry = {
        ...latestLocal,
        updatedAt: serverUpdatedAt,
        syncStatus: 'synced',
      };
      await this.saveToLocal(synced);
      updateBlackBoxEntry(synced);
      this.logger.debug('黑匣子 push 完成后业务字段等价的更晚本地快照已升级为 synced', {
        entryId: pushedEntry.id,
        pushedUpdatedAt: pushedEntry.updatedAt,
        latestLocalUpdatedAt: latestLocal.updatedAt,
        serverUpdatedAt,
        pushPath,
      });
      return;
    }

    // 【2026-05-16 根因修复·路径 B】保留 pending 时必须主动确保 latestLocal 已被
    // RetryQueue 或 debounce 队列承接。原实现只 debug log 后期望 latestLocal 自己被
    // scheduleSync 续推；但若 latestLocal 来源是 pushToServer 内部 preflight monotonic
    // 合并（pendingMerged）而非 update() 调用链，那条路径不会触达 scheduleSync，会成为
    // "孤儿 pending"——UI 永远显示 待同步 直到下次手动 update。
    this.logger.info('黑匣子推送完成时检测到不等价的更晚本地快照，确保 latestLocal 已入队续推', {
      entryId: pushedEntry.id,
      pushedUpdatedAt: pushedEntry.updatedAt,
      latestLocalUpdatedAt: latestLocal.updatedAt,
      pushPath,
    });
    await this.ensureLatestLocalEnqueued(latestLocal, 'upgrade-non-equivalent');
  }

  /**
   * 确保某个本地 pending 条目已经进入 RetryQueue（优先）或被内联 push 兜底。
   *
   * 调用方包括：
    * - `upgradeEquivalentLatestLocalToSynced` 业务字段非等价分支（push 已完成、保留 pending）
    * - `mergeWithLocal` 远端单调真值合并路径（保留 pending）
    * - `pushToServer` 跳过过期队列快照时发现本地最新快照仍 pending
   *
   * 没有此方法时，"latestLocal 在 push 进行期间被并发更新成不等价的更晚快照"会变成孤儿，
   * 导致 UI 长期显示 待同步。
   *
   * 【2026-05-18 根因修复·阶段 2】仅入队不足以保证内存/IDB/signal store 三方一致。如果
   * latestLocal 来源是 `pushToServer` 内部 preflight 合并的临时对象（pendingMerged），
   * 该对象既未写入 IDB 也未触达 updateBlackBoxEntry，此时只入队 RetryQueue 会让 UI 看到的
   * entry 仍是旧 pending 状态。新增 saveToLocal + updateBlackBoxEntry 兜底，确保 UI 与
   * RetryQueue 看到的 entry 完全一致，避免出现"队列在跑、UI 一直显示 待同步"的错位。
   *
   * 【2026-05-18 根因修复·阶段 0】对短时间内反复进入该方法的同一 entry 做埋点：30s 窗口内
   * 重复次数 ≥3 时升级为 warn，便于在生产排查"修复后仍出现 stuck pending"的回归。
   */
  protected readonly ensureLatestLocalReentry = new Map<string, { count: number; firstAt: number; lastReason: string }>();

  protected async ensureLatestLocalEnqueued(
    latestLocal: BlackBoxEntry,
    reason: 'merge-monotonic' | 'upgrade-non-equivalent' | 'skip-stale-queued-entry',
  ): Promise<void> {
    // 先把 latestLocal 写入 IDB + signal store，避免临时对象在 RetryQueue 兜底前
    // 与 UI 视图脱节（详见上方注释）。失败时只 warn 不抛出，重试由队列承接。
    void this.saveToLocal(latestLocal).catch(err => {
      this.logger.warn('黑匣子 ensureLatestLocalEnqueued 持久化 latestLocal 失败，等待 RetryQueue 兜底', {
        entryId: latestLocal.id,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    const currentInMemory = blackBoxEntriesMap().get(latestLocal.id);
    if (!currentInMemory || this.isEntryNewer(latestLocal, currentInMemory) || currentInMemory.syncStatus !== latestLocal.syncStatus) {
      updateBlackBoxEntry(latestLocal);
    }

    // 重入计数（阶段 0 取证）
    const now = Date.now();
    const existing = this.ensureLatestLocalReentry.get(latestLocal.id);
    if (!existing || now - existing.firstAt > BlackBoxSyncBase.ENSURE_LATEST_LOCAL_REENTRY_WINDOW_MS) {
      this.ensureLatestLocalReentry.set(latestLocal.id, { count: 1, firstAt: now, lastReason: reason });
    } else {
      existing.count += 1;
      existing.lastReason = reason;
      if (existing.count >= BlackBoxSyncBase.ENSURE_LATEST_LOCAL_REENTRY_WARN_THRESHOLD) {
        this.logger.warn('黑匣子条目在短时间内被反复保留 pending，疑似收敛失败', {
          entryId: latestLocal.id,
          windowMs: BlackBoxSyncBase.ENSURE_LATEST_LOCAL_REENTRY_WINDOW_MS,
          reentryCount: existing.count,
          lastReason: existing.lastReason,
          syncStatus: latestLocal.syncStatus,
          updatedAt: latestLocal.updatedAt,
        });
      }
    }

    if (this.retryQueueHandler) {
      await this.enqueueLatestLocalRetry(latestLocal, reason);
      return;
    }
    void this.pushLatestLocalInlineOrKeepPending(latestLocal, reason);
    this.logger.debug('黑匣子 ensureLatestLocalEnqueued 无 retryQueueHandler，降级走内联 push', {
      entryId: latestLocal.id,
      reason,
    });
  }

  private async enqueueLatestLocalRetry(
    latestLocal: BlackBoxEntry,
    reason: 'merge-monotonic' | 'upgrade-non-equivalent' | 'skip-stale-queued-entry',
  ): Promise<void> {
    if (!this.retryQueueHandler) {
      return;
    }

    const enqueued = await this.retryQueueHandler(latestLocal);
    if (!enqueued) {
      this.logger.warn('黑匣子 ensureLatestLocalEnqueued RetryQueue 持久化失败，保留 pending 等待恢复', {
        entryId: latestLocal.id,
        reason,
      });
    }
  }

  private async pushLatestLocalInlineOrKeepPending(
    latestLocal: BlackBoxEntry,
    reason: 'merge-monotonic' | 'upgrade-non-equivalent' | 'skip-stale-queued-entry',
  ): Promise<void> {
    try {
      const pushed = await this.pushToServer(latestLocal);
      if (pushed) {
        return;
      }
      this.keepEntryPendingForRetry(latestLocal);
      this.logger.warn('黑匣子 ensureLatestLocalEnqueued 内联续推返回 false，保留 pending 等待恢复', {
        entryId: latestLocal.id,
        reason,
      });
    } catch (err) {
      this.keepEntryPendingForRetry(latestLocal);
      this.logger.error(
        '黑匣子 ensureLatestLocalEnqueued 内联续推失败',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * 从本地 IndexedDB 删除指定条目
   * 用于清理脏数据（如非法 ID 的条目）
   */
  async deleteFromLocal(id: string): Promise<void> {
    if (!this.db) {
      await this.initIndexedDB();
    }

    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('IndexedDB not initialized'));
        return;
      }

      const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  protected async loadEntryFromLocal(id: string): Promise<BlackBoxEntry | null> {
    let initFailed = false;
    try {
      if (!this.db) {
        await this.initIndexedDB();
      }
    } catch {
      initFailed = true;
    }

    if (initFailed) {
      return null;
    }

    if (!this.db) {
      return null;
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.get(id);

      request.onsuccess = () => {
        const result = request.result as IDBBlackBoxEntry | undefined;
        if (!result) {
          resolve(null);
          return;
        }

        const { _localVersion, ...entry } = result;
        resolve(entry);
      };
      request.onerror = () => resolve(null);
    });
  }

  protected isEntryNewer(
    candidate: Pick<BlackBoxEntry, 'updatedAt'> | null | undefined,
    baseline: Pick<BlackBoxEntry, 'updatedAt'> | null | undefined,
  ): boolean {
    if (!candidate?.updatedAt || !baseline?.updatedAt) {
      return false;
    }

    return this.clockSync.isLocalNewer(candidate.updatedAt, baseline.updatedAt);
  }

  protected async resolveLatestLocalEntry(id: string): Promise<BlackBoxEntry | null> {
    const inMemory = blackBoxEntriesMap().get(id) ?? null;
    const persisted = await this.loadEntryFromLocal(id);

    if (!persisted) {
      return inMemory;
    }

    if (!inMemory || this.isEntryNewer(persisted, inMemory)) {
      return persisted;
    }

    return inMemory;
  }

  protected hasMeaningfulContent(content: unknown): content is string {
    return typeof content === 'string' && content.trim().length > 0;
  }

  protected isBlankOrMissingContent(content: unknown): boolean {
    return typeof content !== 'string' || content.trim().length === 0;
  }

  protected hydrateBlankContentFromSource(
    entry: BlackBoxEntry,
    source: BlackBoxEntry | null | undefined,
    sourceLabel: 'latest-local' | 'server-preflight' | 'local-merge' | 'local-idb',
  ): BlackBoxEntry {
    if (!this.isBlankOrMissingContent(entry.content) || !this.hasMeaningfulContent(source?.content)) {
      return entry;
    }

    this.logger.warn('黑匣子推送检测到空正文 payload，已从权威快照补回正文以避免覆盖数据库内容', {
      entryId: entry.id,
      source: sourceLabel,
      entryUpdatedAt: entry.updatedAt,
      sourceUpdatedAt: source?.updatedAt,
    });

    return {
      ...entry,
      content: source.content,
    };
  }

  protected isExpectedRealtimeContextCurrent(
    expectedUserId?: string,
    expectedRealtimeGeneration?: number,
  ): boolean {
    if (!expectedUserId && expectedRealtimeGeneration == null) {
      return true;
    }

    if (
      expectedRealtimeGeneration != null
      && expectedRealtimeGeneration !== this.realtimeSubscriptionGeneration
    ) {
      return false;
    }

    if (expectedUserId && this.resolveRemoteSessionUserId() !== expectedUserId) {
      return false;
    }

    return true;
  }

  protected getPendingEntriesForRemoteReconciliation(entries?: BlackBoxEntry[]): BlackBoxEntry[] {
    const remoteSessionUserId = this.resolveRemoteSessionUserId();
    if (!remoteSessionUserId) {
      return [];
    }

    return (entries ?? Array.from(blackBoxEntriesMap().values())).filter(entry => {
      return entry.syncStatus === 'pending'
        && entry.userId === remoteSessionUserId
        && isValidUUID(entry.id);
    });
  }

  protected hasSameInstant(left: string | null | undefined, right: string | null | undefined): boolean {
    const normalizedLeft = left ?? null;
    const normalizedRight = right ?? null;
    if (normalizedLeft === normalizedRight) {
      return true;
    }

    if (!normalizedLeft || !normalizedRight) {
      return false;
    }

    const leftMs = new Date(normalizedLeft).getTime();
    const rightMs = new Date(normalizedRight).getTime();
    const leftValid = Number.isFinite(leftMs);
    const rightValid = Number.isFinite(rightMs);
    if (!leftValid || !rightValid) {
      this.logger.debug('黑匣子时间戳等价比较失败：时间格式无效', {
        left: normalizedLeft,
        right: normalizedRight,
      });
      return false;
    }

    return leftMs === rightMs;
  }

  protected hasEquivalentEntryState(local: BlackBoxEntry, remote: BlackBoxEntry): boolean {
    return hasEquivalentEntryStatePure(local, remote, (left, right) => this.hasSameInstant(left, right));
  }

  protected async reconcilePendingEntriesWithServer(
    client: BlackBoxSupabaseClient,
    preferRemoteForSyncedLocalDuringPull: boolean,
    repairingFutureCursor: boolean,
    expectedUserId?: string,
    expectedRealtimeGeneration?: number,
    sourcePendingEntries?: BlackBoxEntry[],
    mergeMode: BlackBoxMergeMode = 'remote-pull',
  ): Promise<void> {
    if (!client) {
      return;
    }

    if (!this.canStartPendingReconciliation(expectedUserId, expectedRealtimeGeneration)) {
      return;
    }

    const pendingEntries = this.getPendingEntriesForRemoteReconciliation(sourcePendingEntries);
    if (pendingEntries.length === 0) {
      return;
    }

    const pendingIds = pendingEntries.map(entry => entry.id);
    const batchSize = 50;
    const sourcePendingEntryMap = sourcePendingEntries ? new Map(sourcePendingEntries.map(entry => [entry.id, entry])) : null;

    this.logger.debug('黑匣子存在 pending 本地条目，开始按 ID 对账远端权威状态', {
      pendingCount: pendingIds.length,
    });

    for (let offset = 0; offset < pendingIds.length; offset += batchSize) {
      if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
        this.logger.info('黑匣子 pending 对账中止：Realtime 订阅上下文已变化');
        return;
      }

      const rows = await this.fetchPendingReconcileRows(client, expectedUserId, pendingIds.slice(offset, offset + batchSize));
      if (!rows) {
        return;
      }

      for (const row of rows) {
        if (!this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
          this.logger.info('黑匣子 pending 对账停止写入：Realtime 订阅上下文已变化');
          return;
        }

        await this.reconcilePendingRemoteRow(
          row,
          sourcePendingEntryMap,
          preferRemoteForSyncedLocalDuringPull,
          repairingFutureCursor,
          mergeMode,
        );
      }
    }
  }

  protected canStartPendingReconciliation(
    expectedUserId: string | undefined,
    expectedRealtimeGeneration?: number,
  ): expectedUserId is string {
    if (!expectedUserId) {
      this.logger.warn('黑匣子 pending 对账缺少用户作用域，跳过远端对账以避免跨用户误判');
      return false;
    }

    if (this.isExpectedRealtimeContextCurrent(expectedUserId, expectedRealtimeGeneration)) {
      return true;
    }

    this.logger.info('黑匣子 pending 对账在会话切换后取消，避免旧用户数据写回当前会话');
    return false;
  }

  protected async fetchPendingReconcileRows(
    client: BlackBoxSupabaseClient,
    expectedUserId: string,
    batchIds: string[],
  ): Promise<unknown[] | null> {
    let query = client
      .from('black_box_entries')
      .select(this.BLACKBOX_ENTRY_SELECT_COLUMNS);
    const eqQuery = this.getOptionalQueryMethod<[string, string]>(query, 'eq');
    if (!eqQuery) {
      this.logger.warn('黑匣子 pending 对账缺少 user_id 查询能力，跳过远端对账以避免跨用户误判', {
        batchSize: batchIds.length,
      });
      return null;
    }
    query = eqQuery('user_id', expectedUserId) as typeof query;

    const inQuery = this.getOptionalQueryMethod<[string, string[]]>(query, 'in');
    if (!inQuery) {
      this.logger.warn('黑匣子 pending 对账缺少 in 查询能力，保留本地 pending 状态', {
        batchSize: batchIds.length,
      });
      return null;
    }

    const { data, error } = await inQuery('id', batchIds) as { data: unknown[] | null; error: unknown };
    if (!error) {
      return data ?? [];
    }

    const enhanced = supabaseErrorToError(error);
    this.logger.warn('黑匣子 pending 对账失败，保留本地 pending 状态', {
      message: enhanced.message,
      batchSize: batchIds.length,
    });
    return null;
  }

  protected async reconcilePendingRemoteRow(
    row: unknown,
    sourcePendingEntryMap: Map<string, BlackBoxEntry> | null,
    preferRemoteForSyncedLocalDuringPull: boolean,
    repairingFutureCursor: boolean,
    mergeMode: BlackBoxMergeMode,
  ): Promise<void> {
    const remoteEntry = this.mapRowToEntry(row as Record<string, unknown>);
    const localEntry = sourcePendingEntryMap?.get(remoteEntry.id) ?? blackBoxEntriesMap().get(remoteEntry.id);
    if (localEntry?.syncStatus === 'pending' && this.hasEquivalentEntryState(localEntry, remoteEntry)) {
      await this.saveToLocal(remoteEntry);
      updateBlackBoxEntry(remoteEntry);
      return;
    }

    await this.mergeWithLocal(remoteEntry, preferRemoteForSyncedLocalDuringPull, repairingFutureCursor, mergeMode);
  }

  /**
   * 从本地 IndexedDB 加载
   */
  async loadFromLocal(options: LoadBlackBoxLocalOptions = {}): Promise<BlackBoxEntry[]> {
    if (!this.db) {
      await this.initIndexedDB();
    }

    const entries = await this.readAllLocalEntries();
    return this.hydrateLocalEntriesForVisibleUser(entries, options);
  }

  protected readAllLocalEntries(): Promise<BlackBoxEntry[]> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('IndexedDB not initialized'));
        return;
      }

      const tx = this.db.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => resolve(this.stripLocalEntryVersions(request.result as IDBBlackBoxEntry[]));
      request.onerror = () => reject(request.error);
    });
  }

  protected stripLocalEntryVersions(entries: IDBBlackBoxEntry[]): BlackBoxEntry[] {
    return entries.map(e => {
      const { _localVersion, ...entry } = e;
      return entry;
    });
  }

  protected async hydrateLocalEntriesForVisibleUser(
    entries: BlackBoxEntry[],
    options: LoadBlackBoxLocalOptions,
  ): Promise<BlackBoxEntry[]> {
    const result = resolveBlackBoxLocalHydration({
      entries,
      options,
      visibleUserId: this.resolveVisibleUserId(),
      currentUserId: this.auth.currentUserId(),
      sessionInitialized: this.auth.sessionInitialized(),
      authSettling: this.isAuthSettling(),
      localModeCacheKey: this.readLocalModeCacheKey(),
      inMemoryEntries: Array.from(blackBoxEntriesMap().values()),
      isEntryNewer: (candidate, baseline) => this.isEntryNewer(candidate, baseline),
      hasEquivalentEntryState: (local, remote) => this.hasEquivalentEntryState(local, remote),
      hasSameInstant: (left, right) => this.hasSameInstant(left, right),
    });

    this.logLocalHydrationEvents(result.events);

    if (!result.commitToStore) {
      return result.entries;
    }

    setBlackBoxEntries(result.entries);
    await this.persistLocalHydrationRepairs(result.hydrationRepairs);
    return result.entries;
  }

  protected resolveVisibleUserId(): string | null {
    const authSettling = this.isAuthSettling();
    return resolveBlackBoxLocalVisibleUserId({
      currentUserId: this.auth.currentUserId(),
      authConfigured: this.auth.isConfigured,
      isBrowser: typeof window !== 'undefined',
      authSettling,
      persistedSessionUserId: authSettling
        ? (this.auth.peekPersistedSessionIdentity()?.userId ?? null)
        : null,
      persistedOwnerHint: authSettling && typeof this.auth.peekPersistedOwnerHint === 'function'
        ? this.auth.peekPersistedOwnerHint()
        : null,
      localModeCacheKey: this.readLocalModeCacheKey(),
    });
  }

  private async persistLocalHydrationRepairs(entries: BlackBoxEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    for (const entry of entries) {
      try {
        await this.saveToLocal(entry);
      } catch (error) {
        this.logger.debug('黑匣子本地缓存同步状态修复持久化失败，保留内存归一化结果', {
          entryId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private logLocalHydrationEvents(events: BlackBoxLocalHydrationLogEvent[]): void {
    for (const event of events) {
      this.logger[event.level](event.message, event.context);
    }
  }

  /**
   * 读取 LOCAL_MODE_CACHE_KEY，封装 try/catch 以在 storage 禁用时沉默返回 null。
   * 单独抽出便于 loadFromLocal 警告日志复用和测试驱动。
   */
  protected readLocalModeCacheKey(): string | null {
    try {
      return localStorage.getItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY);
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- localStorage 访问异常时静默返回 null
      return null;
    }
  }

  protected isAuthSettling(): boolean {
    return !this.auth.sessionInitialized()
      || this.auth.authState().isCheckingSession
      || this.auth.runtimeState() === 'pending';
  }

  protected resolveRemoteSessionUserId(): string | null {
    const currentUserId = this.auth.currentUserId();
    if (currentUserId) {
      return currentUserId;
    }

    return this.isAuthSettling()
      ? (this.auth.peekPersistedSessionIdentity()?.userId ?? null)
      : null;
  }

}
