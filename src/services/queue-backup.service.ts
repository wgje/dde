/**
 * QueueBackupService — IndexedDB 队列备份服务
 *
 * 职责：
 * - IndexedDB 备份数据库管理
 * - 队列备份写入与恢复
 * - Legacy 备份迁移处理
 *
 * 从 ActionQueueStorageService 抽离（2026-05-13）
 */
import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import type {
  DeadLetterItem,
  QueuedAction,
  QueueBackupPersonalRestoreAbandonCommandV2,
  QueueBackupPersonalRestoreCommand,
  QueueBackupPersonalRestoreCommandV2,
  QueueBackupPersonalRestoreIdentityStateV2,
  QueueBackupPersonalRestoreResultV2,
  QueueBackupPersonalRestoreResult,
  QueueBackupPersonalRestoreTransition,
  QueueBackupPersonalRestoreTransitionV2,
} from './action-queue.types';
import { inspectLocalHandoffProtection } from './action-queue-held-action.controller';
import {
  canonicalizePersistedValue,
  getQueueBackupPersonalRestoreReceiptId,
  isQueueBackupPersonalRestoreTransition,
  planQueueBackupPersonalRestore,
  preservesPreparedRestoreActions,
  type QueueBackupPersonalRestorePlan,
} from './action-queue-identity.helpers';
import {
  createQueueBackupPersonalRestoreAuthority,
  getQueueBackupPersonalRestoreCatalogId,
  isQueueBackupPersonalRestoreTransitionV2,
  preservesPreparedRestoreActionsV2,
  validateQueueBackupPersonalRestoreIdentity,
  type QueueBackupPersonalRestorePlanV2,
  type QueueBackupPersonalRestoreSnapshotV2,
} from './queue-backup-personal-restore-transition.helpers';
import {
  createQueueBackupRestoreProviderRawSnapshot,
  projectQueueBackupRestoreProviderEvidence,
  projectQueueBackupRestoreUnreadableEvidence,
  validateQueueBackupRestoreProviderAccess,
  type QueueBackupRestoreProviderResult,
  type QueueBackupRestoreProviderUnreadableReason,
} from './queue-backup-restore-provider.helpers';
export const QUEUE_BACKUP_DB_NAME = 'nanoflow-queue-backup';
export const QUEUE_BACKUP_DB_VERSION = 1;
export const QUEUE_BACKUP_STORE_NAME = 'queue-backup';
export const QUEUE_BACKUP_NO_WRITE = Symbol('queue-backup-no-write');
export function preserveQueueBackupWithoutWrite(queue: QueuedAction[]): QueuedAction[] {
  Object.defineProperty(queue, QUEUE_BACKUP_NO_WRITE, {
    value: true,
    configurable: true,
  });
  return queue;
}
function consumeQueueBackupNoWriteDecision(queue: QueuedAction[]): boolean {
  if (!Reflect.has(queue, QUEUE_BACKUP_NO_WRITE)) {
    return false;
  }
  Reflect.deleteProperty(queue, QUEUE_BACKUP_NO_WRITE);
  return true;
}

/**
 * 队列备份记录
 */
export interface QueueBackupRecord {
  id: string;
  ownerUserId: string;
  actions: QueuedAction[];
  savedAt: string;
  personalRestoreTransition?: QueueBackupPersonalRestoreTransition | QueueBackupPersonalRestoreTransitionV2;
}
export interface DeadLetterBackupRecord {
  id: string;
  ownerUserId: string;
  deadLetters: DeadLetterItem[];
  savedAt: string;
}
export interface QueueBackupUpdateContext {
  /** True when the owner already has an IndexedDB record, even if that record contains an empty queue. */
  recordFound: boolean;
}

export interface QueueBackupRestoreSnapshot {
  recordFound: boolean;
  actions: QueuedAction[];
  savedAt: string | null;
}

export type QueueBackupProtectedHandoffReason =
  | 'required'
  | 'reserved'
  | 'effects-applied'
  | 'malformed';

export type QueueBackupStrictUpdateResult =
  | { status: 'committed'; queue: QueuedAction[] }
  | { status: 'no-write'; queue: QueuedAction[] }
  | { status: 'protected-restore' }
  | {
    status: 'protected-handoff';
    reason: QueueBackupProtectedHandoffReason;
    actionIds: string[];
  }
  | { status: 'storage-failed' };

type QueueBackupMutationIntent = 'normal' | 'explicit-full-wipe';

/**
 * Legacy 队列审查条目
 */
export interface LegacyQueueReviewItem {
  action: QueuedAction;
  source: 'legacy-global-queue' | 'legacy-idb-backup';
  capturedAt: string;
  ownerUserId: string;
}

const LEGACY_QUEUE_BACKUP_RECORD_ID = 'nanoflow-queue-backup-v1';
const LEGACY_UNKNOWN_OWNER_USER_ID = '__legacy_unknown__';

@Injectable({ providedIn: 'root' })
export class QueueBackupService {
  private readonly logger = inject(LoggerService).category('QueueBackup');
  private readonly personalRestoreAuthority = createQueueBackupPersonalRestoreAuthority();

  /**
   * 生成用户专属的备份记录 ID
   */
  getQueueBackupRecordId(ownerUserId: string): string {
    return `queue-backup:${ownerUserId}`;
  }

  getDeadLetterBackupRecordId(ownerUserId: string): string {
    return `dead-letter-backup:${ownerUserId}`;
  }

  /**
   * 备份队列到 IndexedDB
   */
  async backupQueue(queue: QueuedAction[], ownerUserId: string): Promise<boolean> {
    const result = await this.updateQueueWithIntent(ownerUserId, () => queue, 'normal');
    return result.status === 'committed';
  }

  async backupDeadLetters(deadLetters: DeadLetterItem[], ownerUserId: string): Promise<boolean> {
    if (typeof indexedDB === 'undefined') return false;

    try {
      const recordId = this.getDeadLetterBackupRecordId(ownerUserId);
      const db = await this.openQueueBackupDb();
      return new Promise((resolve) => {
        const transaction = db.transaction([QUEUE_BACKUP_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(QUEUE_BACKUP_STORE_NAME);
        const record: DeadLetterBackupRecord = {
          id: recordId,
          ownerUserId,
          deadLetters,
          savedAt: new Date().toISOString(),
        };
        const putRequest = store.put(record);

        putRequest.onerror = () => {
          this.logger.error('IndexedDB 死信队列写入失败', putRequest.error);
        };

        transaction.oncomplete = () => {
          db.close();
          this.logger.info('死信队列已备份到 IndexedDB', { count: deadLetters.length, ownerUserId });
          resolve(true);
        };

        const failTransaction = () => {
          db.close();
          this.logger.error('IndexedDB 死信队列写入事务失败或中止', transaction.error ?? putRequest.error);
          resolve(false);
        };
        transaction.onerror = failTransaction;
        transaction.onabort = failTransaction;
      });
    } catch (e) {
      this.logger.error('IndexedDB 死信队列备份异常', e);
      return false;
    }
  }

  /**
   * 在同一个 IndexedDB readwrite transaction 中更新 owner 队列。
   *
   * 这条路径用于 Outbox 的 read-modify-write 场景：追加、合并、收口都必须基于
   * 最新持久化队列计算，不能先 restore 再 backup，否则多标签页或并发操作会互相覆盖。
   */
  async updateQueue(
    ownerUserId: string,
    updater: (queue: QueuedAction[], context: QueueBackupUpdateContext) => QueuedAction[],
  ): Promise<QueuedAction[] | null> {
    const result = await this.updateQueueStrictly(ownerUserId, updater);
    return result.status === 'committed' || result.status === 'no-write'
      ? result.queue
      : null;
  }

  updateQueueStrictly(
    ownerUserId: string,
    updater: (queue: QueuedAction[], context: QueueBackupUpdateContext) => QueuedAction[],
  ): Promise<QueueBackupStrictUpdateResult> {
    return this.updateQueueWithIntent(ownerUserId, updater, 'normal');
  }

  async clearQueueForFullWipe(ownerUserId: string): Promise<boolean> {
    const result = await this.updateQueueWithIntent(
      ownerUserId,
      () => [],
      'explicit-full-wipe',
    );
    return result.status === 'committed';
  }

  async applyPersonalBackupRestoreTransition(
    ownerUserId: string,
    command: QueueBackupPersonalRestoreCommand,
  ): Promise<QueueBackupPersonalRestoreResult> {
    if (typeof indexedDB === 'undefined') return { status: 'storage-failed' };
    const recordId = this.getQueueBackupRecordId(ownerUserId);
    const receiptId = getQueueBackupPersonalRestoreReceiptId(ownerUserId, command.token);
    let db: IDBDatabase | undefined;
    try {
      db = await this.openQueueBackupDb();
      const snapshot = await this.readPersonalRestoreSnapshot(db, recordId, receiptId);
      const record = snapshot.record;
      if (record !== undefined && (!this.isQueueBackupRecordForOwner(record, recordId, ownerUserId))) {
        return { status: 'rejected', reason: 'malformed-record' };
      }
      const plan = await planQueueBackupPersonalRestore({
        ownerUserId,
        command,
        currentActions: record?.actions ?? [],
        transition: record?.personalRestoreTransition,
        receipt: snapshot.receipt,
      });
      if (!plan.nextActions) return plan.result;
      return await this.commitPersonalRestorePlan(db, recordId, receiptId, ownerUserId, snapshot, plan)
        ? plan.result
        : { status: 'storage-failed' };
    } catch (error) {
      this.logger.error('IndexedDB personal restore transition 失败', error);
      return { status: 'storage-failed' };
    } finally {
      db?.close();
    }
  }

  async readPersonalRestoreIdentityState(
    identity: QueueBackupPersonalRestoreCommandV2['identity'],
    authenticatedOwnerUserId: string | null,
  ): Promise<QueueBackupPersonalRestoreIdentityStateV2> {
    if (!authenticatedOwnerUserId || authenticatedOwnerUserId !== identity.ownerUserId) {
      return { status: 'unknown', reason: 'auth-unavailable' };
    }
    if (!await validateQueueBackupPersonalRestoreIdentity(identity)) {
      return { status: 'unknown', reason: 'malformed-evidence' };
    }
    if (typeof indexedDB === 'undefined') return { status: 'unknown', reason: 'storage-unavailable' };
    let db: IDBDatabase | undefined;
    try {
      db = await this.openQueueBackupDb();
      const snapshot = await this.readPersonalRestoreSnapshotV2(db, identity);
      const evidence = await this.personalRestoreAuthority.inspect(identity, snapshot);
      if (evidence.status === 'absent') {
        return {
          status: 'absent-for-identity', identity,
          absenceProof: evidence.absenceProof,
        };
      }
      if (evidence.status === 'active') {
        return { status: 'active', transition: evidence.transition as QueueBackupPersonalRestoreTransitionV2 };
      }
      if (evidence.status === 'terminal') return { status: 'terminal', receipt: evidence.receipt };
      return { status: 'unknown', reason: 'malformed-evidence' };
    } catch {
      return { status: 'unknown', reason: 'storage-unavailable' };
    } finally { db?.close(); }
  }

  async readPersonalRestoreProviderEvidence(
    identity: QueueBackupPersonalRestoreCommandV2['identity'],
    authenticatedOwnerUserId: string | null,
  ): Promise<QueueBackupRestoreProviderResult> {
    const access = await validateQueueBackupRestoreProviderAccess(identity, authenticatedOwnerUserId);
    if (access.status === 'REJECTED') return access;
    if (typeof indexedDB === 'undefined') {
      return projectQueueBackupRestoreUnreadableEvidence(access.identity, 'STORAGE_UNAVAILABLE');
    }
    let db: IDBDatabase | undefined;
    try {
      db = await this.openQueueBackupRestoreProviderDb() ?? undefined;
      if (!db) {
        return projectQueueBackupRestoreProviderEvidence(
          access.identity, createQueueBackupRestoreProviderRawSnapshot([]), 'CONFIRMED_EMPTY',
        );
      }
      const values = await this.readQueueBackupStoreValues(db, [
        access.identity.recordId, this.getDeadLetterBackupRecordId(access.identity.ownerUserId),
        getQueueBackupPersonalRestoreCatalogId(access.identity.ownerUserId), access.identity.receiptId,
      ]);
      return projectQueueBackupRestoreProviderEvidence(
        access.identity, createQueueBackupRestoreProviderRawSnapshot(values),
      );
    } catch (error) {
      const named = error instanceof Error ? error.message : '';
      const reason: QueueBackupRestoreProviderUnreadableReason =
        named === 'VERSION_MISMATCH' || named === 'STORE_MISSING'
          ? named : db ? 'TRANSACTION_FAILED' : 'OPEN_FAILED';
      return projectQueueBackupRestoreUnreadableEvidence(access.identity, reason);
    } finally { db?.close(); }
  }

  applyPersonalBackupRestoreTransitionV2(
    command: QueueBackupPersonalRestoreCommandV2,
    authenticatedOwnerUserId: string | null,
  ): Promise<QueueBackupPersonalRestoreResultV2> {
    return this.executePersonalRestoreV2(command, authenticatedOwnerUserId);
  }

  abandonPersonalRestoreBeforePrepare(
    command: QueueBackupPersonalRestoreAbandonCommandV2,
    authenticatedOwnerUserId: string | null,
  ): Promise<QueueBackupPersonalRestoreResultV2> {
    return this.executePersonalRestoreV2(command, authenticatedOwnerUserId);
  }

  private async executePersonalRestoreV2(
    command: QueueBackupPersonalRestoreCommandV2 | QueueBackupPersonalRestoreAbandonCommandV2,
    authenticatedOwnerUserId: string | null,
  ): Promise<QueueBackupPersonalRestoreResultV2> {
    if (!authenticatedOwnerUserId || authenticatedOwnerUserId !== command.identity.ownerUserId) {
      return { status: 'aborted', reason: 'auth-unavailable' };
    }
    if (!await validateQueueBackupPersonalRestoreIdentity(command.identity)) {
      return { status: 'rejected', reason: 'malformed-evidence' };
    }
    if (typeof indexedDB === 'undefined') return { status: 'aborted', reason: 'transaction-aborted' };
    let db: IDBDatabase | undefined;
    try {
      db = await this.openQueueBackupDb();
      const snapshot = await this.readPersonalRestoreSnapshotV2(db, command.identity);
      const plan = await this.personalRestoreAuthority.plan(snapshot, command);
      return plan.write
        ? await this.commitPersonalRestorePlanV2(db, command.identity, snapshot, plan)
        : plan.result;
    } catch (error) {
      this.logger.error('IndexedDB personal restore V2 transition failed', error);
      return { status: 'aborted', reason: 'transaction-aborted' };
    } finally { db?.close(); }
  }

  private async updateQueueWithIntent(
    ownerUserId: string,
    updater: (queue: QueuedAction[], context: QueueBackupUpdateContext) => QueuedAction[],
    intent: QueueBackupMutationIntent,
  ): Promise<QueueBackupStrictUpdateResult> {
    if (typeof indexedDB === 'undefined') return { status: 'storage-failed' };
    let db: IDBDatabase | undefined;
    try {
      const recordId = this.getQueueBackupRecordId(ownerUserId);
      db = await this.openQueueBackupDb();
      const snapshot = await this.readPersonalRestoreSnapshot(db, recordId, '');
      const observedTransition = snapshot.record?.personalRestoreTransition;
      const validatedV2 = observedTransition?.schemaVersion === 2
        ? await isQueueBackupPersonalRestoreTransitionV2(observedTransition, snapshot.record?.actions) ? observedTransition : null
        : undefined;
      return await this.updateQueueRecord(db, recordId, ownerUserId, updater, intent, validatedV2);
    } catch (error) {
      this.logger.error('IndexedDB 原子更新异常', error);
      return { status: 'storage-failed' };
    } finally { db?.close(); }
  }

  private updateQueueRecord(
    db: IDBDatabase,
    recordId: string,
    ownerUserId: string,
    updater: (queue: QueuedAction[], context: QueueBackupUpdateContext) => QueuedAction[],
    intent: QueueBackupMutationIntent,
    validatedV2: QueueBackupPersonalRestoreTransitionV2 | null | undefined,
  ): Promise<QueueBackupStrictUpdateResult> {
    return new Promise((resolve) => {
      const state = {
        nextActions: null as QueuedAction[] | null, rejection: null as QueueBackupStrictUpdateResult | null,
        noWriteRequested: false,
      };
      const transaction = db.transaction([QUEUE_BACKUP_STORE_NAME], 'readwrite');
      const store = transaction.objectStore(QUEUE_BACKUP_STORE_NAME);
      const getRequest = store.get(recordId);

      getRequest.onsuccess = () => this.applyQueueUpdate(
        getRequest.result as QueueBackupRecord | undefined, recordId, ownerUserId, updater,
        intent, validatedV2, state, transaction, store,
      );
      getRequest.onerror = () => {
        this.logger.error('IndexedDB 原子更新读取失败', getRequest.error);
        transaction.abort();
      };
      transaction.oncomplete = () => {
        const queue = state.nextActions ?? [];
        if (state.noWriteRequested) {
          resolve({ status: 'no-write', queue });
          return;
        }
        this.logger.info('队列已原子更新到 IndexedDB', { count: queue.length, ownerUserId });
        resolve({ status: 'committed', queue });
      };
      const failTransaction = () => {
        this.logger.error('IndexedDB 原子更新事务失败或中止', transaction.error);
        resolve(state.rejection ?? { status: 'storage-failed' });
      };
      transaction.onerror = failTransaction;
      transaction.onabort = failTransaction;
    });
  }

  private applyQueueUpdate(
    existingRecord: QueueBackupRecord | undefined, recordId: string, ownerUserId: string,
    updater: (queue: QueuedAction[], context: QueueBackupUpdateContext) => QueuedAction[],
    intent: QueueBackupMutationIntent,
    validatedV2: QueueBackupPersonalRestoreTransitionV2 | null | undefined,
    state: {
      nextActions: QueuedAction[] | null; rejection: QueueBackupStrictUpdateResult | null;
      noWriteRequested: boolean;
    },
    transaction: IDBTransaction, store: IDBObjectStore,
  ): void {
    const currentActions = Array.isArray(existingRecord?.actions) ? existingRecord.actions : [];
    try {
      const nextActions = updater(currentActions, { recordFound: existingRecord !== undefined });
      state.nextActions = nextActions;
      if (consumeQueueBackupNoWriteDecision(currentActions)) {
        state.nextActions = currentActions;
        state.noWriteRequested = true;
        return;
      }
      const transition = existingRecord?.personalRestoreTransition;
      const preservesRestore = transition?.schemaVersion === 2
        ? validatedV2 !== null && validatedV2 !== undefined
          && canonicalizePersistedValue(transition) === canonicalizePersistedValue(validatedV2)
          && preservesPreparedRestoreActionsV2(currentActions, nextActions, transition)
        : validatedV2 === undefined && transition !== undefined && isQueueBackupPersonalRestoreTransition(transition)
          && transition.ownerUserId === ownerUserId
          && preservesPreparedRestoreActions(currentActions, nextActions, transition);
      state.rejection = !preservesRestore && [validatedV2, transition].some(value => value !== undefined) ? { status: 'protected-restore' } : null;
      state.rejection ??= intent === 'explicit-full-wipe'
        ? null
        : this.findProtectedHandoffRemoval(currentActions, nextActions);
      if (state.rejection) { transaction.abort(); return; }
      store.put({
        ...existingRecord, id: recordId, ownerUserId, actions: nextActions,
        savedAt: new Date().toISOString(),
      } satisfies QueueBackupRecord);
    } catch (error) {
      this.logger.error('IndexedDB 原子更新 updater 失败', error);
      transaction.abort();
    }
  }

  private isQueueBackupRecordForOwner(
    value: unknown,
    recordId: string,
    ownerUserId: string,
  ): value is QueueBackupRecord {
    if (value === null || typeof value !== 'object') return false;
    const record = value as Partial<QueueBackupRecord>;
    return record.id === recordId
      && record.ownerUserId === ownerUserId
      && Array.isArray(record.actions)
      && typeof record.savedAt === 'string';
  }

  private readPersonalRestoreSnapshot(
    db: IDBDatabase,
    recordId: string,
    receiptId: string,
  ): Promise<{ record?: QueueBackupRecord; receipt?: unknown }> {
    return this.readQueueBackupStoreValues(db, [recordId, receiptId]).then(([record, receipt]) => ({
      record: record as QueueBackupRecord | undefined,
      receipt,
    }));
  }

  private commitPersonalRestorePlan(
    db: IDBDatabase, recordId: string, receiptId: string,
    ownerUserId: string, snapshot: { record?: QueueBackupRecord; receipt?: unknown },
    plan: QueueBackupPersonalRestorePlan,
  ): Promise<boolean> {
    const nextRecord: QueueBackupRecord = {
      ...(snapshot.record ?? {} as QueueBackupRecord),
      id: recordId,
      ownerUserId,
      actions: plan.nextActions ?? [],
      savedAt: new Date().toISOString(),
    };
    if (plan.nextTransition === null) delete nextRecord.personalRestoreTransition;
    else if (plan.nextTransition) nextRecord.personalRestoreTransition = plan.nextTransition;
    return new Promise((resolve) => {
      let pendingReads = 2;
      let settled = false;
      let currentRecord: unknown;
      let currentReceipt: unknown;
      const transaction = db.transaction(QUEUE_BACKUP_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(QUEUE_BACKUP_STORE_NAME);
      const recordRequest = store.get(recordId);
      const receiptRequest = store.get(receiptId);
      const settle = (value: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const writeAfterReads = (): void => {
        if (--pendingReads !== 0) return;
        if (canonicalizePersistedValue(currentRecord) !== canonicalizePersistedValue(snapshot.record)
          || canonicalizePersistedValue(currentReceipt) !== canonicalizePersistedValue(snapshot.receipt)) {
          transaction.abort();
          return;
        }
        store.put(nextRecord);
        if (plan.receipt) store.add(plan.receipt);
      };
      recordRequest.onsuccess = () => { currentRecord = recordRequest.result; writeAfterReads(); };
      receiptRequest.onsuccess = () => { currentReceipt = receiptRequest.result; writeAfterReads(); };
      transaction.oncomplete = () => {
        void this.readPersonalRestoreSnapshot(db, recordId, receiptId).then(readback => {
          settle(canonicalizePersistedValue(readback.record) === canonicalizePersistedValue(nextRecord)
            && canonicalizePersistedValue(readback.receipt) === canonicalizePersistedValue(plan.receipt));
        }, () => settle(false));
      };
      transaction.onerror = () => settle(false);
      transaction.onabort = () => settle(false);
    });
  }

  private readPersonalRestoreSnapshotV2(
    db: IDBDatabase,
    identity: QueueBackupPersonalRestoreCommandV2['identity'],
  ): Promise<QueueBackupPersonalRestoreSnapshotV2> {
    return this.readQueueBackupStoreValues(db, [
      identity.recordId, getQueueBackupPersonalRestoreCatalogId(identity.ownerUserId), identity.receiptId,
    ]).then(([record, catalog, receipt]) => ({
      record: record as QueueBackupPersonalRestoreSnapshotV2['record'], catalog, receipt,
    }));
  }

  private readQueueBackupStoreValues(db: IDBDatabase, ids: string[]): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(QUEUE_BACKUP_STORE_NAME, 'readonly');
      const store = transaction.objectStore(QUEUE_BACKUP_STORE_NAME);
      const requests = ids.map(id => store.get(id));
      transaction.oncomplete = () => resolve(requests.map(request => request.result));
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Queue backup read aborted'));
    });
  }

  private commitPersonalRestorePlanV2(
    db: IDBDatabase,
    identity: QueueBackupPersonalRestoreCommandV2['identity'],
    snapshot: QueueBackupPersonalRestoreSnapshotV2,
    plan: QueueBackupPersonalRestorePlanV2,
  ): Promise<QueueBackupPersonalRestoreResultV2> {
    return new Promise((resolve) => {
      let reads = 3;
      let settled = false;
      let stale = false;
      const current: QueueBackupPersonalRestoreSnapshotV2 = {};
      const tx = db.transaction(QUEUE_BACKUP_STORE_NAME, 'readwrite');
      const store = tx.objectStore(QUEUE_BACKUP_STORE_NAME);
      const record = store.get(identity.recordId);
      const catalog = store.get(getQueueBackupPersonalRestoreCatalogId(identity.ownerUserId));
      const receipt = store.get(identity.receiptId);
      const settle = (result: QueueBackupPersonalRestoreResultV2): void => {
        if (!settled) { settled = true; resolve(result); }
      };
      const write = (): void => {
        if (--reads !== 0) return;
        if (canonicalizePersistedValue(current) !== canonicalizePersistedValue(snapshot)) {
          stale = true; tx.abort(); return;
        }
        try {
          if (plan.nextRecord) store.put(plan.nextRecord);
          if (plan.nextCatalog) store.put(plan.nextCatalog);
          if (plan.receipt) store.add(plan.receipt);
        } catch { tx.abort(); }
      };
      record.onsuccess = () => { current.record = record.result; write(); };
      catalog.onsuccess = () => { current.catalog = catalog.result; write(); };
      receipt.onsuccess = () => { current.receipt = receipt.result; write(); };
      tx.oncomplete = () => {
        void this.readPersonalRestoreSnapshotV2(db, identity).then(readback => {
          const expected = {
            record: plan.nextRecord ?? snapshot.record,
            catalog: plan.nextCatalog ?? snapshot.catalog,
            receipt: plan.receipt ?? snapshot.receipt,
          };
          settle(canonicalizePersistedValue(readback) === canonicalizePersistedValue(expected)
            ? plan.result : { status: 'ambiguous' });
        }, () => settle({ status: 'ambiguous' }));
      };
      tx.onerror = () => settle(stale
        ? { status: 'rejected', reason: 'state-changed' }
        : { status: 'aborted', reason: 'transaction-aborted' });
      tx.onabort = tx.onerror;
    });
  }

  private findProtectedHandoffRemoval(
    currentActions: QueuedAction[],
    nextActions: QueuedAction[],
  ): QueueBackupStrictUpdateResult | null {
    const retained = new Set(nextActions.map(action => `${action.id}\u0000${action.operationId}`));
    for (const action of currentActions) {
      if (retained.has(`${action.id}\u0000${action.operationId}`) || action.localHandoff === undefined) {
        continue;
      }
      const protection = inspectLocalHandoffProtection(action);
      if (protection.status === 'protected-handoff') return protection;
    }
    return null;
  }

  /**
   * 从 IndexedDB 恢复队列
   * 优先恢复当前用户的备份，若无则检查 legacy 备份
   *
   * @returns 恢复的队列数据；若无备份或读取失败返回 null
   *          legacy 备份会被隔离到审查队列，不直接返回
   */
  async restoreQueue(
    ownerUserId: string,
    onLegacyFound?: (items: LegacyQueueReviewItem[]) => void
  ): Promise<QueuedAction[] | null> {
    const snapshot = await this.restoreQueueSnapshot(ownerUserId, onLegacyFound);
    return snapshot?.recordFound ? snapshot.actions : null;
  }

  async restoreQueueSnapshot(
    ownerUserId: string,
    onLegacyFound?: (items: LegacyQueueReviewItem[]) => void,
  ): Promise<QueueBackupRestoreSnapshot | null> {
    if (typeof indexedDB === 'undefined') return null;

    try {
      const recordId = this.getQueueBackupRecordId(ownerUserId);
      const db = await this.openQueueBackupDb();

      return new Promise((resolve) => {
        const transaction = db.transaction([QUEUE_BACKUP_STORE_NAME], 'readonly');
        const store = transaction.objectStore(QUEUE_BACKUP_STORE_NAME);
        const request = store.get(recordId);

        request.onsuccess = () => {
          const data = request.result as QueueBackupRecord | undefined;
          if (Array.isArray(data?.actions)) {
            db.close();
            this.logger.info('从 IndexedDB 恢复队列备份', {
              count: data.actions.length,
              savedAt: data.savedAt,
            });
            resolve({ recordFound: true, actions: data.actions, savedAt: data.savedAt });
            return;
          }
          this.resolveLegacyBackupSnapshot(store, db, resolve, onLegacyFound);
        };

        request.onerror = () => {
          db.close();
          this.logger.warn('从 IndexedDB 读取备份失败', request.error);
          resolve(null);
        };
      });
    } catch (e) {
      this.logger.warn('IndexedDB 恢复异常', e);
    }
    return null;
  }

  async restoreDeadLetters(ownerUserId: string): Promise<DeadLetterItem[] | null> {
    if (typeof indexedDB === 'undefined') return null;
    let db: IDBDatabase | undefined;
    try {
      const recordId = this.getDeadLetterBackupRecordId(ownerUserId);
      db = await this.openQueueBackupDb();
      const [value] = await this.readQueueBackupStoreValues(db, [recordId]);
      const data = value as DeadLetterBackupRecord | undefined;
      if (!Array.isArray(data?.deadLetters)) return null;
      this.logger.info('从 IndexedDB 恢复死信队列备份', {
        count: data.deadLetters.length, savedAt: data.savedAt,
      });
      return data.deadLetters;
    } catch (e) {
      this.logger.warn('IndexedDB 死信队列恢复异常', e);
    } finally { db?.close(); }
    return null;
  }

  private resolveLegacyBackupSnapshot(
    store: IDBObjectStore,
    db: IDBDatabase,
    resolve: (snapshot: QueueBackupRestoreSnapshot | null) => void,
    onLegacyFound?: (items: LegacyQueueReviewItem[]) => void,
  ): void {
    const legacyRequest = store.get(LEGACY_QUEUE_BACKUP_RECORD_ID);

    legacyRequest.onsuccess = () => {
      const legacyData = legacyRequest.result as QueueBackupRecord | undefined;
      db.close();
      this.emitLegacyReviewItems(legacyData, onLegacyFound);
      resolve({ recordFound: false, actions: [], savedAt: null });
    };

    legacyRequest.onerror = () => {
      db.close();
      this.logger.warn('从 IndexedDB 读取 legacy 备份失败', legacyRequest.error);
      resolve(null);
    };
  }

  private emitLegacyReviewItems(
    legacyData: QueueBackupRecord | undefined,
    onLegacyFound?: (items: LegacyQueueReviewItem[]) => void,
  ): void {
    if (!legacyData?.actions?.length) return;

    this.logger.warn('检测到 legacy 队列备份，已隔离待审查', {
      count: legacyData.actions.length,
      savedAt: legacyData.savedAt,
    });

    const reviewItems: LegacyQueueReviewItem[] = legacyData.actions.map((action) => ({
      action,
      source: 'legacy-idb-backup' as const,
      capturedAt: legacyData.savedAt,
      ownerUserId: LEGACY_UNKNOWN_OWNER_USER_ID,
    }));

    onLegacyFound?.(reviewItems);
  }

  /**
   * 打开队列备份数据库
   */
  private openQueueBackupDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(QUEUE_BACKUP_DB_NAME, QUEUE_BACKUP_DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(QUEUE_BACKUP_STORE_NAME)) {
          db.createObjectStore(QUEUE_BACKUP_STORE_NAME, { keyPath: 'id' });
        }
      };
    });
  }

  private openQueueBackupRestoreProviderDb(): Promise<IDBDatabase | null> {
    return new Promise((resolve, reject) => {
      let confirmedEmpty = false;
      const request = indexedDB.open(QUEUE_BACKUP_DB_NAME);
      request.onupgradeneeded = event => {
        confirmedEmpty = (event as IDBVersionChangeEvent).oldVersion === 0;
        request.transaction?.abort();
      };
      request.onerror = event => {
        if (confirmedEmpty) { event.preventDefault(); resolve(null); }
        else reject(request.error ?? new Error('OPEN_FAILED'));
      };
      request.onblocked = () => {
        request.onsuccess = () => request.result.close();
        reject(new Error('OPEN_FAILED'));
      };
      request.onsuccess = () => {
        const db = request.result;
        const failure = db.version !== QUEUE_BACKUP_DB_VERSION ? 'VERSION_MISMATCH'
          : !db.objectStoreNames.contains(QUEUE_BACKUP_STORE_NAME) ? 'STORE_MISSING' : null;
        if (failure) { db.close(); reject(new Error(failure)); return; }
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
  }
}
