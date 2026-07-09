import { type BlackBoxEntry } from '../models/focus';
import { updateBlackBoxEntry } from '../state/focus-stores';
import { type TablesInsert, type TablesUpdate } from '../types/supabase';
import { supabaseErrorToError } from '../utils/supabase-error';
import { BlackBoxSyncLocalLayer } from './black-box-sync-local.service';
import {
  buildBlackBoxInsertPayload as buildBlackBoxInsertPayloadValue,
  buildBlackBoxUpdatePayload as buildBlackBoxUpdatePayloadValue,
} from './black-box-sync-push-payload.helpers';
import {
  compareBlackBoxPreflightTimestampValues,
  mergeBlackBoxPreflightMonotonicFacts as mergeBlackBoxPreflightMonotonicFactsValue,
} from './black-box-sync-preflight.helpers';
import {
  writeBlackBoxEntryByPreflightState as writeBlackBoxEntryByPreflightStateValue,
} from './black-box-sync-push-write.helpers';
import { BLACKBOX_RPC_REMOTE_NEWER_RECONCILE_REASON, BLACKBOX_RPC_STALE_PAYLOAD_RECONCILE_REASON, type BlackBoxPushGuardOutcome, type BlackBoxPushPreflightConflictOutcome, type BlackBoxPushPreflightDoneOutcome, type BlackBoxPushPreflightOutcome, type BlackBoxPushPreflightRowOutcome, type BlackBoxPushPreparedEntryOutcome, type BlackBoxRemoteReconcileReason, type BlackBoxSupabaseClient, type BlackBoxUpsertWriteResult } from './black-box-sync.types';
import { isBlackBoxPushUuidValid, isValidBlackBoxId, isValidBlackBoxProjectId } from './black-box-sync-push-uuid-guard';
import { BlackBoxRpcWriteAuditRecorder } from './black-box-sync-rpc-write-audit';
import { type SyncRpcResult } from './sync-rpc-client.service';

export abstract class BlackBoxSyncPushLayer extends BlackBoxSyncLocalLayer {
  private readonly blackBoxRpcWriteAudit = new BlackBoxRpcWriteAuditRecorder();

  protected shouldUseSyncRpc(): boolean {
    return this.syncRpcClient?.isFeatureEnabled() === true && this.syncRpcClient.isClientRejected() === false;
  }

  protected async handleBlackBoxSyncRpcResult(
    result: SyncRpcResult,
    entry: BlackBoxEntry,
    client: BlackBoxSupabaseClient,
    sessionUserId: string,
  ): Promise<boolean> {
    if (result.status === 'applied' || result.status === 'idempotent-replay') {
      return await this.handleAppliedBlackBoxSyncRpcResult(result, entry, client, sessionUserId);
    }

    if (result.status === 'remote-newer') {
      return await this.handleRemoteNewerBlackBoxSyncRpcResult(result, entry, client, sessionUserId);
    }

    this.logRejectedBlackBoxSyncRpcResult(result, entry);
    return false;
  }

  protected async handleAppliedBlackBoxSyncRpcResult(
    result: SyncRpcResult,
    entry: BlackBoxEntry,
    client: BlackBoxSupabaseClient,
    sessionUserId: string,
  ): Promise<boolean> {
    const serverUpdatedAt = result.serverUpdatedAt ?? entry.updatedAt;
    if (serverUpdatedAt) {
      this.clockSync.recordServerTimestamp(serverUpdatedAt, entry.id);
    }

    if (result.stalePayload) {
      return await this.reconcileStaleAppliedBlackBoxSyncRpcResult(client, entry, sessionUserId);
    }

    const latestLocalAfterPush = await this.resolveLatestLocalEntry(entry.id);
    if (latestLocalAfterPush && this.isEntryNewer(latestLocalAfterPush, entry)) {
      await this.upgradeEquivalentLatestLocalToSynced(latestLocalAfterPush, entry, serverUpdatedAt, 'rpc');
      return true;
    }

    await this.saveAppliedBlackBoxSyncRpcEntry(entry, serverUpdatedAt);
    return true;
  }

  protected async reconcileStaleAppliedBlackBoxSyncRpcResult(
    client: BlackBoxSupabaseClient,
    entry: BlackBoxEntry,
    sessionUserId: string,
  ): Promise<boolean> {
    const reconciled = await this.reconcileAuthoritativeRemoteEntry(
      client,
      entry,
      sessionUserId,
      BLACKBOX_RPC_STALE_PAYLOAD_RECONCILE_REASON,
    );
    if (reconciled) {
      return true;
    }

    this.logger.warn('黑匣子 RPC stale payload 已应用但远端权威状态未能对账，保留 pending 等待重试', {
      entryId: entry.id,
    });
    return false;
  }

  protected async saveAppliedBlackBoxSyncRpcEntry(
    entry: BlackBoxEntry,
    serverUpdatedAt: string,
  ): Promise<void> {
    const previousSyncStatus = entry.syncStatus ?? 'unknown';
    const synced: BlackBoxEntry = {
      ...entry,
      updatedAt: serverUpdatedAt,
      syncStatus: 'synced',
    };
    await this.saveToLocal(synced);
    updateBlackBoxEntry(synced);
    this.logger.info('黑匣子条目通过 RPC 同步完成', {
      entryId: entry.id,
      previousSyncStatus,
      nextSyncStatus: 'synced',
      previousUpdatedAt: entry.updatedAt,
      serverUpdatedAt,
      pushPath: 'rpc',
    });
  }

  protected async handleRemoteNewerBlackBoxSyncRpcResult(
    result: SyncRpcResult,
    entry: BlackBoxEntry,
    client: BlackBoxSupabaseClient,
    sessionUserId: string,
  ): Promise<boolean> {
    this.logger.warn('黑匣子 RPC CAS 拒绝，远端版本更新', {
      entryId: entry.id,
      remoteUpdatedAt: result.remoteUpdatedAt,
      reason: result.reason,
    });
    this.sentryLazyLoader.captureMessage('sync_rpc_blackbox_remote_newer', {
      level: 'warning',
      tags: { operation: 'pushBlackBoxEntry', entityType: 'blackbox', status: result.status },
      extra: { entryId: entry.id, remoteUpdatedAt: result.remoteUpdatedAt, reason: result.reason },
    });
    return await this.reconcileAuthoritativeRemoteEntry(
      client,
      entry,
      sessionUserId,
      BLACKBOX_RPC_REMOTE_NEWER_RECONCILE_REASON,
    );
  }

  protected logRejectedBlackBoxSyncRpcResult(result: SyncRpcResult, entry: BlackBoxEntry): void {
    this.logger.warn('黑匣子 RPC 拒绝写入', {
      entryId: entry.id,
      status: result.status,
      reason: result.reason,
      minProtocolVersion: result.minProtocolVersion,
    });
    this.sentryLazyLoader.captureMessage('sync_rpc_blackbox_rejected', {
      level: 'warning',
      tags: { operation: 'pushBlackBoxEntry', entityType: 'blackbox', status: result.status },
      extra: { entryId: entry.id, reason: result.reason, minProtocolVersion: result.minProtocolVersion },
    });
  }

  protected async reconcileAuthoritativeRemoteEntry(
    client: BlackBoxSupabaseClient,
    entry: BlackBoxEntry,
    sessionUserId: string,
    reason: BlackBoxRemoteReconcileReason,
  ): Promise<boolean> {
    const remoteEntry = await this.fetchRemoteEntryById(client, entry.id, sessionUserId, reason);
    if (!remoteEntry) {
      return false;
    }

    await this.mergeWithLocal(remoteEntry, false, false, 'authoritative-reconcile');
    const latestLocal = await this.resolveLatestLocalEntry(entry.id);
    const clearedPending = latestLocal?.syncStatus !== 'pending';
    if (!clearedPending) {
      this.logger.debug('黑匣子远端权威对账后仍保留 pending，等待最新本地快照续推', {
        entryId: entry.id,
        reason,
        localUpdatedAt: latestLocal?.updatedAt,
        remoteUpdatedAt: remoteEntry.updatedAt,
      });
    }
    return clearedPending;
  }

  protected async fetchRemoteEntryById(
    client: BlackBoxSupabaseClient,
    entryId: string,
    sessionUserId: string,
    reason: string,
  ): Promise<BlackBoxEntry | null> {
    let remoteEntry: BlackBoxEntry | null = null;
    try {
      const { data, error } = await client
        .from('black_box_entries')
        .select(this.BLACKBOX_ENTRY_SELECT_COLUMNS)
        .eq('user_id', sessionUserId)
        .eq('id', entryId)
        .maybeSingle();
      if (error) {
        this.logger.warn('黑匣子远端权威对账失败，保留 pending 状态', {
          entryId,
          reason,
          message: supabaseErrorToError(error).message,
        });
        return null;
      }
      if (!data) {
        this.logger.warn('黑匣子远端权威对账未找到服务端行，保留 pending 状态', {
          entryId,
          reason,
        });
        return null;
      }

      remoteEntry = this.mapRowToEntry(data as Record<string, unknown>);
    } catch (error) {
      this.logger.warn('黑匣子远端权威对账异常，保留 pending 状态', {
        entryId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return remoteEntry;
  }

  /**
   * 推送到服务器
   *
   * 公开方法：由 RetryQueue 处理器回调调用
   * 返回 boolean 表示是否成功（供 RetryQueue 决定是否重试）
   */
  async pushToServer(entry: BlackBoxEntry, sourceUserId?: string, operationId?: string): Promise<boolean> {
    const guard = await this.guardBlackBoxPush(entry, sourceUserId);
    if (guard.status === 'done') {
      return guard.result;
    }
    const sessionUserId = guard.sessionUserId;

    try {
      const client = await this.supabase.clientAsync();
      if (!client) {
        return false;
      }

      if (await this.cleanupInvalidBlackBoxPushUuidFields(entry)) {
        return true;
      }

      const prepared = await this.prepareBlackBoxEntryForPush(entry, sessionUserId);
      if (prepared.status === 'done') {
        return prepared.result;
      }
      entry = prepared.entry;

      const preflight = await this.runBlackBoxPushPreflight(client, entry, sessionUserId);
      if (preflight.status === 'done') {
        return preflight.result;
      }
      entry = preflight.entry;
      const preflightServerEntry = preflight.preflightServerEntry;
      const syncRpcBaseUpdatedAt = preflight.syncRpcBaseUpdatedAt;

      if (this.shouldUseSyncRpc()) {
        return await this.pushBlackBoxEntryViaSyncRpc(
          client,
          entry,
          sessionUserId,
          sourceUserId,
          operationId,
          syncRpcBaseUpdatedAt,
        );
      }

      if (this.shouldDeferLegacyBlackBoxPush(entry, operationId)) {
        return false;
      }

      return await this.pushBlackBoxEntryWithUpsert(client, entry, sessionUserId, preflightServerEntry);
    } catch (error) {
      this.logger.error('Sync error', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private shouldDeferLegacyBlackBoxPush(entry: BlackBoxEntry, operationId?: string): boolean {
    if (typeof operationId !== 'string' || operationId.length === 0) {
      return false;
    }

    this.logger.warn('黑匣子带 operationId 的推送等待 sync RPC 能力恢复，禁止 legacy direct write', {
      entryId: entry.id,
      operationId,
      featureEnabled: this.syncRpcClient?.isFeatureEnabled() === true,
      clientRejected: this.syncRpcClient?.isClientRejected() === true,
    });
    return true;
  }

  private async cleanupInvalidBlackBoxPushUuidFields(entry: BlackBoxEntry): Promise<boolean> {
    if (isBlackBoxPushUuidValid(entry)) {
      return false;
    }

    this.logger.warn(`终极防线拦截非法 UUID 字段: id="${entry.id}", projectId="${entry.projectId}"`);
    try {
      await this.deleteFromLocal(entry.id);
    } catch {
      // 清理失败不阻塞 RetryQueue 丢弃历史脏数据。
    }
    return true;
  }

  private async pushBlackBoxEntryViaSyncRpc(
    client: BlackBoxSupabaseClient,
    entry: BlackBoxEntry,
    sessionUserId: string,
    sourceUserId: string | undefined,
    operationId: string | undefined,
    syncRpcBaseUpdatedAt: string | null,
  ): Promise<boolean> {
    if (!operationId) {
      this.logger.warn('黑匣子 RPC 推送缺少 operationId，保留 pending 等待队列重试', {
        entryId: entry.id,
        sourceUserId,
        sessionUserId,
      });
      return false;
    }

    const localTimestamp = Date.now();
    const lastSyncTimeBefore = this.lastSyncTime;
    const beforeVersion = entry.updatedAt ?? null;
    const result = await this.syncRpcClient!.upsertBlackboxEntry({
      operationId,
      entry,
      baseUpdatedAt: syncRpcBaseUpdatedAt,
    });
    const pushed = await this.handleBlackBoxSyncRpcResult(result, entry, client, sessionUserId);
    this.blackBoxRpcWriteAudit.record({
      operationId,
      sourceUserId: sourceUserId ?? sessionUserId,
      entry,
      result,
      localTimestamp,
      updatedAtBaseline: syncRpcBaseUpdatedAt,
      beforeVersion,
      enteredRetryQueue: false,
      retryCount: 0,
      lastSyncTimeBefore,
      lastSyncTimeAfter: this.lastSyncTime,
    });
    return pushed;
  }

  protected async guardBlackBoxPush(
    entry: BlackBoxEntry,
    sourceUserId?: string,
  ): Promise<BlackBoxPushGuardOutcome> {
    if (!this.supabase.isConfigured) {
      this.logger.debug('Supabase 未配置，跳过推送');
      return { status: 'done', result: false };
    }
    if (this.isRemoteUnavailable()) {
      this.logger.debug('连接中断模式下跳过黑匣子推送');
      return { status: 'done', result: false };
    }

    const sessionUserId = this.resolveRemoteSessionUserId();
    if (!sessionUserId) {
      this.logger.warn('BlackBox push deferred: session owner unavailable', {
        entryId: entry.id,
        hasEntryUserId: !!entry.userId,
        hasSourceUserId: !!sourceUserId,
      });
      return { status: 'done', result: false };
    }

    if (entry.userId !== sessionUserId || (sourceUserId && sourceUserId !== sessionUserId)) {
      this.logger.warn('BlackBox push rejected: owner mismatch', {
        entryId: entry.id,
        hasSessionUserId: !!sessionUserId,
        hasEntryUserId: !!entry.userId,
        hasSourceUserId: !!sourceUserId,
      });
      await this.selfHealOwnerMismatchedEntry(entry, sessionUserId, sourceUserId);
      return { status: 'done', result: true };
    }

    if (!entry.id || !isValidBlackBoxId(entry.id)) {
      return await this.cleanupInvalidBlackBoxPushEntry(`跳过非法 ID 的条目: "${entry.id}"，从本地清理`, entry.id);
    }

    if (!isValidBlackBoxProjectId(entry.projectId)) {
      return await this.cleanupInvalidBlackBoxPushEntry(
        `跳过非法 projectId 的条目: id="${entry.id}", projectId="${entry.projectId}"，从本地清理`,
        entry.id,
      );
    }

    return { status: 'continue', sessionUserId };
  }

  protected async cleanupInvalidBlackBoxPushEntry(message: string, entryId: string): Promise<BlackBoxPushPreflightDoneOutcome> {
    this.logger.warn(message);
    try {
      await this.deleteFromLocal(entryId);
    } catch {
      // 清理失败不阻塞 RetryQueue 丢弃历史脏数据。
    }
    return { status: 'done', result: true };
  }

  protected async prepareBlackBoxEntryForPush(
    entry: BlackBoxEntry,
    sessionUserId: string,
  ): Promise<BlackBoxPushPreparedEntryOutcome> {
    const latestLocalBeforePush = await this.resolveLatestLocalEntry(entry.id);
    if (this.isEntryNewer(latestLocalBeforePush, entry)) {
      this.logger.debug('跳过过期黑匣子推送：本地已有更新快照', {
        entryId: entry.id,
        queuedUpdatedAt: entry.updatedAt,
        latestLocalUpdatedAt: latestLocalBeforePush?.updatedAt,
      });
      if (latestLocalBeforePush?.syncStatus === 'pending' && latestLocalBeforePush.userId === sessionUserId) {
        await this.ensureLatestLocalEnqueued(latestLocalBeforePush, 'skip-stale-queued-entry');
      }
      return { status: 'done', result: true };
    }

    return {
      status: 'continue',
      entry: this.hydrateBlankContentFromSource(entry, latestLocalBeforePush, 'latest-local'),
    };
  }

  protected async runBlackBoxPushPreflight(
    client: BlackBoxSupabaseClient,
    entry: BlackBoxEntry,
    sessionUserId: string,
  ): Promise<BlackBoxPushPreflightOutcome> {
    try {
      const rowOutcome = await this.fetchBlackBoxPushPreflightRow(client, entry, sessionUserId);
      if (rowOutcome.status === 'done') {
        return rowOutcome;
      }

      if (!rowOutcome.serverRow) {
        return {
          status: 'continue',
          entry,
          preflightServerEntry: null,
          syncRpcBaseUpdatedAt: null,
        };
      }

      return await this.handleBlackBoxPushPreflightServerRow(
        entry,
        this.mapRowToEntry(rowOutcome.serverRow as Record<string, unknown>),
      );
    } catch (preflightException) {
      this.logger.debug('黑匣子推送预检异常，延后推送等待下次对账', {
        entryId: entry.id,
        error: preflightException instanceof Error ? preflightException.message : String(preflightException),
      });
      return { status: 'done', result: false };
    }
  }

  protected async pushBlackBoxEntryWithUpsert(
    client: BlackBoxSupabaseClient,
    entry: BlackBoxEntry,
    sessionUserId: string,
    preflightServerEntry: BlackBoxEntry | null,
  ): Promise<boolean> {
    const { savedRow, error } = await this.writeBlackBoxEntryByPreflightState(
      client,
      entry,
      sessionUserId,
      preflightServerEntry,
    );
    if (!error && !savedRow) {
      return false;
    }
    if (error) {
      const enhanced = supabaseErrorToError(error);
      this.logger.error('Failed to push entry to server', enhanced.message);
      return false;
    }

    const serverUpdatedAt = typeof savedRow?.updated_at === 'string'
      ? savedRow.updated_at
      : entry.updatedAt;
    if (serverUpdatedAt) {
      this.clockSync.recordServerTimestamp(serverUpdatedAt, entry.id);
    }

    const previousSyncStatus = entry.syncStatus ?? 'unknown';
    await this.applyBlackBoxUpsertSuccess(entry, serverUpdatedAt);
    this.logger.info('黑匣子条目通过 upsert 同步完成', {
      entryId: entry.id,
      previousSyncStatus,
      nextSyncStatus: 'synced',
      previousUpdatedAt: entry.updatedAt,
      serverUpdatedAt,
      pushPath: 'upsert',
    });
    return true;
  }

  protected async writeBlackBoxEntryByPreflightState(
    client: BlackBoxSupabaseClient,
    entry: BlackBoxEntry,
    sessionUserId: string,
    preflightServerEntry: BlackBoxEntry | null,
  ): Promise<BlackBoxUpsertWriteResult> {
    return await writeBlackBoxEntryByPreflightStateValue({
      client,
      entry,
      sessionUserId,
      preflightServerEntry,
      logger: this.logger,
      buildInsertPayload: currentEntry => this.buildBlackBoxInsertPayload(currentEntry),
      buildUpdatePayload: currentEntry => this.buildBlackBoxUpdatePayload(currentEntry),
    });
  }

  protected async updateExistingBlackBoxEntryWithCas(
    client: BlackBoxSupabaseClient,
    entry: BlackBoxEntry,
    sessionUserId: string,
    baseUpdatedAt: string,
  ): Promise<BlackBoxUpsertWriteResult> {
    return await writeBlackBoxEntryByPreflightStateValue({
      client,
      entry,
      sessionUserId,
      preflightServerEntry: { ...entry, updatedAt: baseUpdatedAt },
      logger: this.logger,
      buildInsertPayload: currentEntry => this.buildBlackBoxInsertPayload(currentEntry),
      buildUpdatePayload: currentEntry => this.buildBlackBoxUpdatePayload(currentEntry),
    });
  }

  protected async insertNewBlackBoxEntry(
    client: BlackBoxSupabaseClient,
    entry: BlackBoxEntry,
  ): Promise<BlackBoxUpsertWriteResult> {
    return await writeBlackBoxEntryByPreflightStateValue({
      client,
      entry,
      sessionUserId: entry.userId ?? '',
      preflightServerEntry: null,
      logger: this.logger,
      buildInsertPayload: currentEntry => this.buildBlackBoxInsertPayload(currentEntry),
      buildUpdatePayload: currentEntry => this.buildBlackBoxUpdatePayload(currentEntry),
    });
  }

  protected async applyBlackBoxUpsertSuccess(entry: BlackBoxEntry, serverUpdatedAt: string): Promise<void> {
    const latestLocalAfterPush = await this.resolveLatestLocalEntry(entry.id);
    if (latestLocalAfterPush && this.isEntryNewer(latestLocalAfterPush, entry)) {
      await this.upgradeEquivalentLatestLocalToSynced(latestLocalAfterPush, entry, serverUpdatedAt, 'upsert');
      return;
    }

    const synced: BlackBoxEntry = {
      ...entry,
      updatedAt: serverUpdatedAt,
      syncStatus: 'synced',
    };
    await this.saveToLocal(synced);
    updateBlackBoxEntry(synced);
  }

  protected buildBlackBoxInsertPayload(entry: BlackBoxEntry): TablesInsert<'black_box_entries'> {
    return buildBlackBoxInsertPayloadValue(entry);
  }

  protected buildBlackBoxUpdatePayload(entry: BlackBoxEntry): TablesUpdate<'black_box_entries'> {
    return buildBlackBoxUpdatePayloadValue(entry);
  }

  protected async fetchBlackBoxPushPreflightRow(
    client: BlackBoxSupabaseClient,
    entry: BlackBoxEntry,
    sessionUserId: string,
  ): Promise<BlackBoxPushPreflightRowOutcome> {
    let preflightQuery = client
      .from('black_box_entries')
      .select(this.BLACKBOX_ENTRY_SELECT_COLUMNS);
    const eqUserQuery = this.getOptionalQueryMethod<[string, string]>(preflightQuery, 'eq');
    if (!eqUserQuery) {
      this.logger.warn('黑匣子推送预检缺少 user_id 查询能力，延后推送以避免覆盖未对账的服务端状态', {
        entryId: entry.id,
      });
      return { status: 'done', result: false };
    }
    preflightQuery = eqUserQuery('user_id', sessionUserId) as typeof preflightQuery;

    const eqIdQuery = this.getOptionalQueryMethod<[string, string]>(preflightQuery, 'eq');
    if (!eqIdQuery) {
      this.logger.warn('黑匣子推送预检缺少 id 查询能力，延后推送以避免覆盖未对账的服务端状态', {
        entryId: entry.id,
      });
      return { status: 'done', result: false };
    }
    preflightQuery = eqIdQuery('id', entry.id) as typeof preflightQuery;

    const maybeSingleQuery = this.getOptionalQueryMethod<[]>(preflightQuery, 'maybeSingle');
    if (!maybeSingleQuery) {
      this.logger.warn('黑匣子推送预检缺少 maybeSingle 查询能力，延后推送以避免覆盖未对账的服务端状态', {
        entryId: entry.id,
      });
      return { status: 'done', result: false };
    }

    const { data: serverRow, error: preflightError } = await maybeSingleQuery() as { data: unknown; error: unknown };
    if (preflightError) {
      this.logger.debug('黑匣子推送预检 SELECT 失败，延后推送等待下次对账', {
        entryId: entry.id,
        message: supabaseErrorToError(preflightError).message,
      });
      return { status: 'done', result: false };
    }

    return { status: 'continue', serverRow: serverRow ?? null };
  }

  protected async handleBlackBoxPushPreflightServerRow(
    entry: BlackBoxEntry,
    serverEntry: BlackBoxEntry,
  ): Promise<BlackBoxPushPreflightOutcome> {
    const hydratedEntry = this.hydrateBlankContentFromSource(entry, serverEntry, 'server-preflight');
    const conflictOutcome = await this.resolveBlackBoxPushPreflightConflict(hydratedEntry, serverEntry);
    if (conflictOutcome.status === 'done') {
      return conflictOutcome;
    }

    if (conflictOutcome.status === 'merge-local-and-push') {
      return {
        status: 'continue',
        entry: conflictOutcome.mergedEntry,
        preflightServerEntry: serverEntry,
        syncRpcBaseUpdatedAt: serverEntry.updatedAt,
      };
    }

    return {
      status: 'continue',
      entry: hydratedEntry,
      preflightServerEntry: serverEntry,
      syncRpcBaseUpdatedAt: serverEntry.updatedAt,
    };
  }

  protected async resolveBlackBoxPushPreflightConflict(
    entry: BlackBoxEntry,
    serverEntry: BlackBoxEntry,
  ): Promise<BlackBoxPushPreflightConflictOutcome> {
    const timestampState = await this.resolveBlackBoxPreflightTimestampState(entry, serverEntry);
    if (timestampState === 'defer') {
      return { status: 'done', result: false };
    }
    if (timestampState === 'server-arbitrated') {
      return { status: 'continue' };
    }

    const serverIsNewer = timestampState.clockReliable
      ? this.clockSync.compareTimestamps(entry.updatedAt, serverEntry.updatedAt) < 0
      : timestampState.rawServerMs > timestampState.rawLocalMs;
    const mergedEntry = this.mergeBlackBoxPreflightMonotonicFacts(entry, serverEntry, serverIsNewer);
    if (!mergedEntry) {
      return { status: 'continue' };
    }

    if (this.hasEquivalentEntryState(mergedEntry, serverEntry)) {
      return await this.applyBlackBoxPreflightRemoteAuthority(
        entry,
        serverEntry,
        serverIsNewer ? 'server-newer-lww' : 'monotonic-regression',
      );
    }

    return await this.persistBlackBoxPreflightMonotonicMerge(entry, serverEntry, mergedEntry);
  }

  protected async resolveBlackBoxPreflightTimestampState(
    entry: BlackBoxEntry,
    serverEntry: BlackBoxEntry,
  ): Promise<
    | { clockReliable: boolean; rawServerMs: number; rawLocalMs: number }
    | 'defer'
    | 'server-arbitrated'
  > {
    const timestampComparison = compareBlackBoxPreflightTimestampValues(entry.updatedAt, serverEntry.updatedAt);
    const clockSyncResult = timestampComparison.timestampsDiffer
      ? await this.clockSync.ensureSynced().catch(() => null)
      : null;

    if (!timestampComparison.timestampsDiffer || clockSyncResult?.reliable) {
      return {
        clockReliable: Boolean(clockSyncResult?.reliable),
        rawServerMs: timestampComparison.rawServerMs,
        rawLocalMs: timestampComparison.rawLocalMs,
      };
    }

    if (this.shouldUseSyncRpc()) {
      this.logger.info('黑匣子推送预检时钟不可信，降级为服务端 stale-write-protection 仲裁', {
        entryId: entry.id,
        localUpdatedAt: entry.updatedAt,
        serverUpdatedAt: serverEntry.updatedAt,
      });
      return 'server-arbitrated';
    }

    this.logger.warn('黑匣子推送预检检测到不可信时间基线，延后本轮推送避免误判覆盖或回退本地更新', {
      entryId: entry.id,
      localUpdatedAt: entry.updatedAt,
      serverUpdatedAt: serverEntry.updatedAt,
    });
    return 'defer';
  }

  protected mergeBlackBoxPreflightMonotonicFacts(
    entry: BlackBoxEntry,
    serverEntry: BlackBoxEntry,
    serverIsNewer: boolean,
  ): BlackBoxEntry | null {
    return mergeBlackBoxPreflightMonotonicFactsValue(entry, serverEntry, serverIsNewer);
  }

  protected async applyBlackBoxPreflightRemoteAuthority(
    entry: BlackBoxEntry,
    serverEntry: BlackBoxEntry,
    reason: 'server-newer-lww' | 'monotonic-regression',
  ): Promise<BlackBoxPushPreflightDoneOutcome> {
    this.logger.warn('黑匣子 pending 推送预检：跳过对服务端权威状态的回退覆盖', {
      entryId: entry.id,
      reason,
      localPendingUpdatedAt: entry.updatedAt,
      serverUpdatedAt: serverEntry.updatedAt,
      localIsRead: entry.isRead,
      serverIsRead: serverEntry.isRead,
      localIsCompleted: entry.isCompleted,
      serverIsCompleted: serverEntry.isCompleted,
      localDeletedAt: entry.deletedAt,
      serverDeletedAt: serverEntry.deletedAt,
    });
    const latestLocalBeforeApply = await this.resolveLatestLocalEntry(entry.id);
    if (this.isEntryNewer(latestLocalBeforeApply, serverEntry)) {
      this.logger.debug('黑匣子预检命中更晚本地快照，跳过服务端权威状态回写', {
        entryId: entry.id,
        latestLocalUpdatedAt: latestLocalBeforeApply?.updatedAt,
        serverUpdatedAt: serverEntry.updatedAt,
      });
      return { status: 'done', result: true };
    }

    this.clockSync.recordServerTimestamp(serverEntry.updatedAt, entry.id);
    await this.saveToLocal(serverEntry);
    updateBlackBoxEntry(serverEntry);
    return { status: 'done', result: true };
  }

  protected async persistBlackBoxPreflightMonotonicMerge(
    entry: BlackBoxEntry,
    serverEntry: BlackBoxEntry,
    mergedEntry: BlackBoxEntry,
  ): Promise<BlackBoxPushPreflightConflictOutcome> {
    this.logger.warn('黑匣子 pending 推送预检：合并远端单调真值后继续推送本地独有变更', {
      entryId: entry.id,
      localPendingUpdatedAt: entry.updatedAt,
      serverUpdatedAt: serverEntry.updatedAt,
      mergedIsRead: mergedEntry.isRead,
      mergedIsCompleted: mergedEntry.isCompleted,
      mergedDeletedAt: mergedEntry.deletedAt,
    });
    const pendingMerged: BlackBoxEntry = { ...mergedEntry, syncStatus: 'pending' };
    await this.saveToLocal(pendingMerged);
    updateBlackBoxEntry(pendingMerged);
    return { status: 'merge-local-and-push', mergedEntry };
  }
}
