/** ChangeTrackerService - 变更追踪服务，实现增量更新：脏标记 + 项目级聚合 + 变更合并 */
import { Injectable, computed, inject, signal } from '@angular/core';
import { Task, Connection } from '../models';
import { SYNC_CONFIG } from '../config';
import { AUTH_CONFIG } from '../config/auth.config';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import {
  EntityType,
  ChangeRecord,
  ProjectChangeSummary,
  ChangeValidationResult,
  DataLossRiskSummary,
} from './change-tracker.types';
import {
  buildChangeReport,
  collectDataLossRisks,
  validateProjectChanges,
} from './change-tracker-validation.helpers';
import {
  CHANGE_TRACKER_FIELD_LOCKS_STORAGE_KEY,
  CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY,
  getChangeRecordRevision,
  restoreFieldLocks,
  restorePendingChangeRecords,
  serializeFieldLocks,
  serializePendingChanges,
} from './change-tracker-persistence.helpers';
import { ChangeTrackerFieldLockController } from './change-tracker-field-lock.controller';
import type { FieldLockValue } from './change-tracker-field-lock.helpers';
import { collectProjectChangeBuckets } from './change-tracker-project-change-buckets';
// 重新导出类型以保持向后兼容
export type {
  ChangeType,
  EntityType,
  ChangeRecord,
  ConnectionDeleteSummary,
  ProjectChangeSummary,
  FieldLockData,
  ChangeValidationResult,
  DataLossRisk,
  DataLossRiskSummary
} from './change-tracker.types';

@Injectable({
  providedIn: 'root'
})
export class ChangeTrackerService {
  private readonly authService = inject(AuthService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ChangeTracker');
  
  /** 待同步的变更记录，Key: `${projectId}:${entityType}:${entityId}` */
  private readonly pendingChangesState = new Map<string, ChangeRecord>();
  /** 单调递增修订号：区分同一毫秒内的多次本地编辑 */
  private changeRevision = 0;
  /** 字段级操作锁，防止用户操作期间被远程更新覆盖。Key: `${projectId}:${taskId}:${field}` */
  private readonly fieldLocks = new Map<string, FieldLockValue>();
  private readonly activeOwnerUserId = signal<string | null>(null);
  /** 字段锁超时（30s）- 弱网环境兑底 */
  private static readonly FIELD_LOCK_TIMEOUT_MS = 30000;
  private readonly fieldLockController = new ChangeTrackerFieldLockController({
    fieldLocks: this.fieldLocks,
    logger: this.logger,
    persistFieldLocks: () => this.persistFieldLocks(),
    defaultLockTimeoutMs: ChangeTrackerService.FIELD_LOCK_TIMEOUT_MS,
  });
  private changeCount = signal(0);
  readonly pendingChangeCount = computed(() =>
    this.resolveExpectedSyncOwnerUserId() === this.activeOwnerUserId() ? this.changeCount() : 0
  );
  private lastChangeAt = signal(0);
  readonly lastChangeTimestamp = computed(() =>
    this.resolveExpectedSyncOwnerUserId() === this.activeOwnerUserId() ? this.lastChangeAt() : 0
  );

  constructor() { this.activateOwnerScope(this.resolveExpectedSyncOwnerUserId()); }

  private get pendingChanges(): Map<string, ChangeRecord> {
    this.ensureExpectedOwnerScope();
    return this.pendingChangesState;
  }

  /** 标记任务创建 */
  trackTaskCreate(projectId: string, task: Task): void {
    const key = this.makeKey(projectId, 'task', task.id);
    
    // 如果之前有删除记录，变为更新
    const existing = this.pendingChanges.get(key);
    if (existing?.changeType === 'delete') {
      this.pendingChanges.set(key, {
        entityId: task.id,
        entityType: 'task',
        changeType: 'update',
        projectId,
        ...this.createChangeStamp(),
        data: task
      });
    } else {
      this.pendingChanges.set(key, {
        entityId: task.id,
        entityType: 'task',
        changeType: 'create',
        projectId,
        ...this.createChangeStamp(),
        data: task
      });
    }
    
    this.updateCounters();
    this.logger.debug('追踪任务创建', { projectId, taskId: task.id });
  }
  /** 标记任务更新 */
  trackTaskUpdate(projectId: string, task: Task, changedFields?: string[]): void {
    const key = this.makeKey(projectId, 'task', task.id);
    
    const existing = this.pendingChanges.get(key);
    
    // 如果是新创建的任务，保持 create 类型
    if (existing?.changeType === 'create') {
      this.pendingChanges.set(key, {
        ...existing,
        ...this.createChangeStamp(),
        data: task,
        changedFields: this.mergeFields(existing.changedFields, changedFields)
      });
    } else {
      // 合并已有的变更字段
      const mergedFields = this.mergeFields(existing?.changedFields, changedFields);
      
      this.pendingChanges.set(key, {
        entityId: task.id,
        entityType: 'task',
        changeType: 'update',
        projectId,
        ...this.createChangeStamp(),
        changedFields: mergedFields,
        data: task
      });
    }
    
    this.updateCounters();
    this.logger.debug('追踪任务更新', { projectId, taskId: task.id, fields: changedFields });
  }
  /** 标记任务删除 */
  trackTaskDelete(projectId: string, taskId: string, taskBeforeDelete?: Task): void {
    const key = this.makeKey(projectId, 'task', taskId);
    
    const existing = this.pendingChanges.get(key);
    
    // 如果是新创建后又删除，直接移除记录（等于没发生过）
    if (existing?.changeType === 'create') {
      this.pendingChanges.delete(key);
    } else {
      this.pendingChanges.set(key, {
        entityId: taskId,
        entityType: 'task',
        changeType: 'delete',
        projectId,
        ...this.createChangeStamp(),
        data: taskBeforeDelete,
      });
    }
    
    this.updateCounters();
    this.logger.debug('追踪任务删除', { projectId, taskId });
  }
  /** 批量标记任务更新 */
  trackTasksUpdate(projectId: string, tasks: Task[], changedFields?: string[]): void {
    for (const task of tasks) {
      this.trackTaskUpdate(projectId, task, changedFields);
    }
  }
  /** 标记连接创建 */
  trackConnectionCreate(projectId: string, connection: Connection): void {
    const connectionId = this.tryGetConnectionId(connection, 'create');
    if (!connectionId) return;
    const key = this.makeKey(projectId, 'connection', connectionId);
    
    const existing = this.pendingChanges.get(key);
    if (existing?.changeType === 'delete') {
      // 删除后重新创建 = 更新
      this.pendingChanges.set(key, {
        entityId: connectionId,
        entityType: 'connection',
        changeType: 'update',
        projectId,
        ...this.createChangeStamp(),
        data: connection
      });
    } else {
      this.pendingChanges.set(key, {
        entityId: connectionId,
        entityType: 'connection',
        changeType: 'create',
        projectId,
        ...this.createChangeStamp(),
        data: connection
      });
    }
    
    this.updateCounters();
    this.logger.debug('追踪连接创建', { projectId, source: connection.source, target: connection.target });
  }
  /** 标记连接更新 */
  trackConnectionUpdate(projectId: string, connection: Connection): void {
    const connectionId = this.tryGetConnectionId(connection, 'update');
    if (!connectionId) return;
    const key = this.makeKey(projectId, 'connection', connectionId);
    
    const existing = this.pendingChanges.get(key);
    
    if (existing?.changeType === 'create') {
      // 创建后更新，保持 create
      this.pendingChanges.set(key, {
        ...existing,
        ...this.createChangeStamp(),
        data: connection
      });
    } else {
      this.pendingChanges.set(key, {
        entityId: connectionId,
        entityType: 'connection',
        changeType: 'update',
        projectId,
        ...this.createChangeStamp(),
        data: connection
      });
    }
    
    this.updateCounters();
    this.logger.debug('追踪连接更新', { projectId, source: connection.source, target: connection.target });
  }
  /** 标记连接删除 */
  trackConnectionDelete(projectId: string, connection: Pick<Connection, 'id' | 'source' | 'target'>): void {
    const connectionId = this.tryGetConnectionId(connection, 'delete');
    if (!connectionId) return;
    const key = this.makeKey(projectId, 'connection', connectionId);
    
    const existing = this.pendingChanges.get(key);
    
    if (existing?.changeType === 'create') {
      // 创建后删除 = 没发生过
      this.pendingChanges.delete(key);
    } else {
      this.pendingChanges.set(key, {
        entityId: connectionId,
        entityType: 'connection',
        changeType: 'delete',
        projectId,
        ...this.createChangeStamp(),
        data: {
          id: connection.id,
          source: connection.source,
          target: connection.target,
        } as Connection
      });
    }
    
    this.updateCounters();
    this.logger.debug('追踪连接删除', {
      projectId,
      connectionId,
      source: connection.source,
      target: connection.target,
    });
  }
  /** 获取项目的变更摘要 */
  getProjectChanges(projectId: string): ProjectChangeSummary {
    const buckets = collectProjectChangeBuckets(
      projectId,
      this.pendingChanges,
      ({ record }) => {
        this.logger.error('连接删除记录缺少显式 id，已丢弃非法待同步项', {
          projectId,
          entityId: record.entityId,
        });
      },
    );

    if (buckets.invalidConnectionDeleteKeys.length > 0) {
      for (const invalidKey of buckets.invalidConnectionDeleteKeys) {
        this.pendingChanges.delete(invalidKey);
      }
      this.updateCounters();
    }
    
    const totalChanges = 
      buckets.tasksToCreate.length + buckets.tasksToUpdate.length + buckets.taskIdsToDelete.length +
      buckets.connectionsToCreate.length + buckets.connectionsToUpdate.length + buckets.connectionsToDelete.length;
    
    return {
      projectId,
      tasksToCreate: buckets.tasksToCreate,
      tasksToUpdate: buckets.tasksToUpdate,
      taskIdsToDelete: buckets.taskIdsToDelete,
      taskDeleteBaseUpdatedAtMap: buckets.taskDeleteBaseUpdatedAtMap,
      connectionsToCreate: buckets.connectionsToCreate,
      connectionsToUpdate: buckets.connectionsToUpdate,
      connectionsToDelete: buckets.connectionsToDelete,
      hasChanges: totalChanges > 0,
      totalChanges,
      taskUpdateFieldsById: buckets.taskUpdateFieldsById
    };
  }

  /** 检查项目是否有待同步的变更 */
  hasProjectChanges(projectId: string): boolean {
    return this.getProjectChanges(projectId).hasChanges;
  }
  /** 清除项目的所有变更记录 */
  clearProjectChanges(projectId: string): number {
    const keysToDelete: string[] = [];
    
    this.pendingChanges.forEach((record, key) => {
      if (record.projectId === projectId) {
        keysToDelete.push(key);
      }
    });
    
    for (const key of keysToDelete) {
      this.pendingChanges.delete(key);
    }
    
    this.updateCounters();
    this.logger.debug('清除项目变更记录', { projectId, clearedCount: keysToDelete.length });
    return keysToDelete.length;
  }
  /** 清除特定任务的变更记录 */
  clearTaskChange(projectId: string, taskId: string): void {
    const key = this.makeKey(projectId, 'task', taskId);
    this.pendingChanges.delete(key);
    this.updateCounters();
  }
  /**
   * 【根因修复 2026-04-20】按时间戳安全地清除单项变更记录。
   *
   * batch-sync 在任务/连接上行成功后会调用这里清掉已确认的脏记录，
   * 以避免"全或无"策略导致成功项继续被重推。
   * 为保护并发编辑：只有当记录不晚于 `notNewerThan`（通常是批次启动时间）时才清理，
   * 否则说明用户在同步期间又改了本地，必须保留以便下一轮再推。
   *
   * @returns true 表示记录已清（或本来就不存在），false 表示存在更新的本地编辑已保留。
   */
  clearTaskChangeIfFresh(projectId: string, taskId: string, notNewerThanRevision: number): boolean {
    const key = this.makeKey(projectId, 'task', taskId);
    const record = this.pendingChanges.get(key);
    if (!record) return true;
    if (getChangeRecordRevision(record) > notNewerThanRevision) {
      return false;
    }
    this.pendingChanges.delete(key);
    this.updateCounters();
    return true;
  }
  /** 清除特定连接的变更记录（保护并发编辑语义与 clearTaskChangeIfFresh 一致）。 */
  clearConnectionChangeIfFresh(projectId: string, connectionId: string, notNewerThanRevision: number): boolean {
    const key = this.makeKey(projectId, 'connection', connectionId);
    const record = this.pendingChanges.get(key);
    if (!record) return true;
    if (getChangeRecordRevision(record) > notNewerThanRevision) {
      return false;
    }
    this.pendingChanges.delete(key);
    this.updateCounters();
    return true;
  }
  /** 清除所有变更记录 */
  clearAllChanges(): void {
    this.pendingChanges.clear();
    this.updateCounters();
    this.logger.debug('清除所有变更记录');
  }
  /** 获取所有有变更的项目ID */
  getChangedProjectIds(): string[] {
    const projectIds = new Set<string>();
    this.pendingChanges.forEach(record => {
      projectIds.add(record.projectId);
    });
    return Array.from(projectIds);
  }
  /** 导出所有待同步变更 */
  exportPendingChanges(): ChangeRecord[] {
    return Array.from(this.pendingChanges.values());
  }

  getCurrentChangeRevision(): number {
    this.ensureExpectedOwnerScope();
    return this.changeRevision;
  }

  /** 获取单个实体的待同步变更；超龄记录自动清理。 */
  getPendingChange(
    projectId: string,
    entityType: EntityType,
    entityId: string,
    maxAgeMs = SYNC_CONFIG.DIRTY_PROTECTION_WINDOW_MS
  ): ChangeRecord | undefined {
    const key = this.makeKey(projectId, entityType, entityId);
    const record = this.pendingChanges.get(key);
    if (!record) {
      return undefined;
    }

    if (Date.now() - record.timestamp > maxAgeMs) {
      this.pendingChanges.delete(key);
      this.updateCounters();
      this.logger.info('脏字段保护窗口过期，已清理变更记录', {
        projectId,
        entityType,
        entityId,
        maxAgeMs
      });
      return undefined;
    }

    return record;
  }

  /** 清理超龄记录，同时允许 durable queue 认领仍需保护的记录。 */
  pruneExpiredChanges(
    maxAgeMs = SYNC_CONFIG.DIRTY_PROTECTION_WINDOW_MS,
    preserveExpired: (record: ChangeRecord) => boolean = () => false,
  ): number {
    const now = Date.now();
    let cleaned = 0;
    const keysToDelete: string[] = [];
    this.pendingChanges.forEach((record, key) => {
      if (now - record.timestamp > maxAgeMs && !preserveExpired(record)) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach(key => {
      this.pendingChanges.delete(key);
      cleaned++;
    });
    if (cleaned > 0) {
      this.updateCounters();
      this.logger.info('批量清理过期脏记录', { cleaned, maxAgeMs });
    }
    return cleaned;
  }

  /**
   * 统计最老脏记录的年龄（毫秒）
   */
  getOldestChangeAgeMs(projectId?: string): number {
    let oldestTimestamp = 0;
    this.pendingChanges.forEach(record => {
      if (projectId && record.projectId !== projectId) {
        return;
      }
      if (oldestTimestamp === 0 || record.timestamp < oldestTimestamp) {
        oldestTimestamp = record.timestamp;
      }
    });
    return oldestTimestamp === 0 ? 0 : Math.max(0, Date.now() - oldestTimestamp);
  }
  /** 导入变更记录 */
  importPendingChanges(changes: ChangeRecord[]): void {
    for (const record of changes) {
      const key = this.makeKey(record.projectId, record.entityType, record.entityId);
      const normalizedRecord: ChangeRecord = {
        ...record,
        revision: getChangeRecordRevision(record),
      };
      this.changeRevision = Math.max(this.changeRevision, normalizedRecord.revision ?? 0);
      this.pendingChanges.set(key, normalizedRecord);
    }
    this.updateCounters();
    this.logger.info('导入变更记录', { count: changes.length });
  }

  /** 验证增量变更是否会导致数据丢失 */
  validateChanges(
    projectId: string,
    currentTasks: Task[],
    _currentConnections: Connection[]
  ): ChangeValidationResult {
    const changes = this.getProjectChanges(projectId);
    const validation = validateProjectChanges(changes, currentTasks);
    this.logValidationResult(projectId, changes.totalChanges, validation.warnings, validation.errors);
    return validation;
  }

  private logValidationResult(
    projectId: string,
    changeCount: number,
    warnings: string[],
    errors: string[],
  ): void {
    if (errors.length > 0) {
      this.logger.error('变更验证失败', {
        projectId,
        errors,
        warnings,
        changes: changeCount
      });
    } else if (warnings.length > 0) {
      this.logger.warn('变更验证通过但有警告', {
        projectId,
        warnings,
        changes: changeCount
      });
    }
  }

  /**
   * 生成变更摘要报告（用于日志和调试）
   */
  generateChangeReport(projectId: string): string {
    const changes = this.getProjectChanges(projectId);
    return buildChangeReport(changes);
  }

  /**
   * 检测潜在的数据丢失风险
   */
  detectDataLossRisks(
    projectId: string,
    currentTasks: Task[],
    currentConnections: Connection[]
  ): DataLossRiskSummary {
    const changes = this.getProjectChanges(projectId);
    const risks = collectDataLossRisks(changes, currentTasks, currentConnections);
    const hasRisk = risks.some(r => r.severity === 'high' || r.severity === 'medium');

    if (hasRisk) {
      this.logger.warn('检测到数据丢失风险', {
        projectId,
        riskCount: risks.length,
        highRisks: risks.filter(r => r.severity === 'high').length,
        mediumRisks: risks.filter(r => r.severity === 'medium').length
      });
    }

    return { hasRisk, risks };
  }
  
  /** 文本输入场景的字段锁超时（1小时），blur 解锁，时间锁只是防死锁兑底 */
  static readonly TEXT_INPUT_LOCK_TIMEOUT_MS = 3600000;

  /** 锁定任务的特定字段（用户开始操作时调用） */
  lockTaskField(taskId: string, projectId: string, field: string, durationMs?: number): void {
    this.ensureExpectedOwnerScope();
    this.fieldLockController.lockTaskField(taskId, projectId, field, durationMs);
  }

  /** 解锁任务的特定字段 */
  unlockTaskField(taskId: string, projectId: string, field: string): void {
    this.ensureExpectedOwnerScope();
    this.fieldLockController.unlockTaskField(taskId, projectId, field);
  }

  /** 解锁任务的所有字段 */
  unlockAllTaskFields(taskId: string, projectId: string): void {
    this.ensureExpectedOwnerScope();
    this.fieldLockController.unlockAllTaskFields(taskId, projectId);
  }

  /** 检查任务的特定字段是否被锁定（考虑超时自动解锁） */
  isTaskFieldLocked(taskId: string, projectId: string, field: string): boolean {
    this.ensureExpectedOwnerScope();
    return this.fieldLockController.isTaskFieldLocked(taskId, projectId, field);
  }

  /** 获取任务被锁定的字段列表 */
  getLockedFields(taskId: string, projectId: string): string[] {
    this.ensureExpectedOwnerScope();
    return this.fieldLockController.getLockedFields(taskId, projectId);
  }

  /** 清理项目的所有字段锁 */
  clearProjectFieldLocks(projectId: string): void {
    this.ensureExpectedOwnerScope();
    this.fieldLockController.clearProjectFieldLocks(projectId);
  }
  // ========== 辅助方法 ==========

  private createChangeStamp(): Pick<ChangeRecord, 'timestamp' | 'revision'> {
    return {
      timestamp: Date.now(),
      revision: this.nextChangeRevision(),
    };
  }

  private nextChangeRevision(): number {
    this.changeRevision += 1;
    return this.changeRevision;
  }

  private resolveExpectedSyncOwnerUserId(): string {
    return this.authService.currentUserId()?.trim()
      || this.authService.persistedOwnerHint?.()?.trim()
      || AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private ensureExpectedOwnerScope(): string {
    const ownerUserId = this.resolveExpectedSyncOwnerUserId();
    this.activateOwnerScope(ownerUserId);
    return ownerUserId;
  }

  private activateOwnerScope(ownerUserId: string): void {
    const previousOwnerUserId = this.activeOwnerUserId();
    if (previousOwnerUserId === ownerUserId) return;
    this.reportLegacyOwnerlessSnapshots();
    if (previousOwnerUserId) {
      this.persistPendingChangesForOwner(previousOwnerUserId);
      this.persistFieldLocksForOwner(previousOwnerUserId);
    }
    this.pendingChangesState.clear();
    this.fieldLocks.clear();
    this.changeRevision = 0;
    this.activeOwnerUserId.set(ownerUserId);
    this.restorePendingChanges(ownerUserId);
    this.restoreFieldLocks(ownerUserId);
    this.refreshOwnerCountersAfterRestore();
  }

  private restorePendingChanges(ownerUserId: string): void {
    const storage = this.getLocalStorage();
    const storageKey = this.getOwnerStorageKey(CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY, ownerUserId);
    const raw = storage?.getItem(storageKey);
    if (!storage || !raw) return;
    try {
      if (!this.validateSnapshotOwner(storage, storageKey, raw, ownerUserId)) return;
      const { changes, maxRevision } = restorePendingChangeRecords(raw);
      for (const normalizedRecord of changes) {
        this.pendingChangesState.set(
          this.makeKey(normalizedRecord.projectId, normalizedRecord.entityType, normalizedRecord.entityId),
          normalizedRecord,
        );
      }
      this.changeRevision = Math.max(this.changeRevision, maxRevision);
      if (changes.length > 0) {
        this.logger.info('恢复 owner-scoped 待同步变更记录', { ownerUserId, count: changes.length });
      }
    } catch (error) {
      this.logger.warn('恢复 owner-scoped 待同步变更记录失败', { ownerUserId, error });
    }
  }

  private restoreFieldLocks(ownerUserId: string): void {
    const storage = this.getLocalStorage();
    const storageKey = this.getOwnerStorageKey(CHANGE_TRACKER_FIELD_LOCKS_STORAGE_KEY, ownerUserId);
    const raw = storage?.getItem(storageKey);
    if (!storage || !raw) return;
    try {
      if (!this.validateSnapshotOwner(storage, storageKey, raw, ownerUserId)) return;
      const { locks } = restoreFieldLocks(raw, Date.now(), ChangeTrackerService.FIELD_LOCK_TIMEOUT_MS);
      for (const [key, lockData] of locks) this.fieldLocks.set(key, lockData);
      if (locks.length > 0) {
        this.logger.info('恢复 owner-scoped 字段锁记录', { ownerUserId, count: locks.length });
      } else {
        storage.removeItem(storageKey);
      }
    } catch (error) {
      this.logger.warn('恢复 owner-scoped 字段锁记录失败', { ownerUserId, error });
    }
  }

  private persistPendingChangesForOwner(ownerUserId: string): void {
    const storage = ownerUserId === this.activeOwnerUserId() ? this.getLocalStorage() : null;
    if (!storage) return;
    const storageKey = this.getOwnerStorageKey(CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY, ownerUserId);
    try {
      const changes = Array.from(this.pendingChangesState.values());
      if (changes.length === 0) {
        storage.removeItem(storageKey);
        return;
      }
      storage.setItem(
        storageKey,
        this.serializeOwnerScopedSnapshot(ownerUserId, serializePendingChanges(changes)),
      );
    } catch (error) {
      this.logger.warn('owner-scoped 待同步变更持久化失败', { ownerUserId, error });
    }
  }

  private persistFieldLocks(): void {
    this.persistFieldLocksForOwner(this.ensureExpectedOwnerScope());
  }

  private persistFieldLocksForOwner(ownerUserId: string): void {
    const storage = ownerUserId === this.activeOwnerUserId() ? this.getLocalStorage() : null;
    if (!storage) return;
    const storageKey = this.getOwnerStorageKey(CHANGE_TRACKER_FIELD_LOCKS_STORAGE_KEY, ownerUserId);
    try {
      if (this.fieldLocks.size === 0) {
        storage.removeItem(storageKey);
        return;
      }
      storage.setItem(
        storageKey,
        this.serializeOwnerScopedSnapshot(
          ownerUserId,
          serializeFieldLocks(this.fieldLocks, ChangeTrackerService.FIELD_LOCK_TIMEOUT_MS),
        ),
      );
    } catch (error) {
      this.logger.warn('owner-scoped 字段锁持久化失败', { ownerUserId, error });
    }
  }

  private getOwnerStorageKey(baseKey: string, ownerUserId: string): string { return `${baseKey}.${ownerUserId}`; }

  private serializeOwnerScopedSnapshot(ownerUserId: string, serializedSnapshot: string): string {
    return JSON.stringify({ ...(JSON.parse(serializedSnapshot) as Record<string, unknown>), ownerUserId });
  }

  private validateSnapshotOwner(
    storage: Storage,
    storageKey: string,
    raw: string,
    expectedOwnerUserId: string,
  ): boolean {
    const snapshot = JSON.parse(raw) as { ownerUserId?: unknown };
    if (snapshot?.ownerUserId === expectedOwnerUserId) return true;
    this.logger.warn('ChangeTracker owner-scoped 快照 owner 不匹配，保留原始字节并 fail closed', {
      storageKey,
      expectedOwnerUserId,
      actualOwnerUserId: snapshot?.ownerUserId,
    });
    return false;
  }

  private reportLegacyOwnerlessSnapshots(): void {
    const storage = this.getLocalStorage();
    if (!storage) return;
    try {
      const retainedKeys = [
        CHANGE_TRACKER_PENDING_CHANGES_STORAGE_KEY,
        CHANGE_TRACKER_FIELD_LOCKS_STORAGE_KEY,
      ].filter(storageKey => storage.getItem(storageKey) !== null);
      if (retainedKeys.length > 0) {
        this.logger.warn('存在 ownerless ChangeTracker legacy 快照；保留原始字节且不归属给当前 owner', {
          retainedKeys,
        });
      }
    } catch (error) {
      this.logger.warn('检查 ownerless ChangeTracker legacy 快照失败', { error });
    }
  }

  private refreshOwnerCountersAfterRestore(): void {
    this.changeCount.set(this.pendingChangesState.size); this.lastChangeAt.set(this.pendingChangesState.size > 0 ? Date.now() : 0);
  }

  private getLocalStorage(): Storage | null {
    let storage: Storage | null = null;
    try {
      if (typeof globalThis.localStorage !== 'undefined') {
        storage = globalThis.localStorage;
      }
    } catch {
      storage = null;
    }
    return storage;
  }

  // ========== 其他辅助方法 ==========
  
  private makeKey(projectId: string, entityType: EntityType, entityId: string): string {
    return `${projectId}:${entityType}:${entityId}`;
  }

  private tryGetConnectionId(
    connection: Pick<Connection, 'id' | 'source' | 'target'>,
    changeType: 'create' | 'update' | 'delete',
  ): string | null {
    if (!connection.id) {
      this.logger.error('连接缺少 id，已拒绝追踪变更', {
        changeType,
        source: connection.source,
        target: connection.target,
      });
      return null;
    }

    return connection.id;
  }
  
  private mergeFields(existing?: string[], added?: string[]): string[] | undefined {
    if (!existing && !added) return undefined;
    const set = new Set<string>([...(existing || []), ...(added || [])]);
    return Array.from(set);
  }
  
  private updateCounters(): void {
    const ownerUserId = this.ensureExpectedOwnerScope();
    this.changeCount.set(this.pendingChangesState.size);
    this.lastChangeAt.set(Date.now());
    this.persistPendingChangesForOwner(ownerUserId);
  }
}
