import { Component, inject, Output, EventEmitter, computed, signal, OnInit, ChangeDetectionStrategy, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActionQueueService } from '../../../services/action-queue.service';
import { SyncStateService } from '../../core/services/sync/sync-state.service';
import { RetryQueueService } from '../../core/services/sync/retry-queue.service';
import { AuthService } from '../../../services/auth.service';
import { ConflictStorageService, ConflictRecord } from '../../../services/conflict-storage.service';
import { ProjectOperationService } from '../../../services/project-operation.service';
import { ToastService } from '../../../services/toast.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { ConflictAutoResolverService, AutoResolutionReport } from '../../../services/conflict-auto-resolver.service';
import { type ConflictResolutionPlan, type TaskResolutionChoice } from '../../../services/conflict-resolution.types';
import {
  captureConflictFingerprint,
  doesStoredConflictMatchFingerprint,
  type ConflictFingerprint,
} from '../../../services/project-operation-conflict-fingerprint';
import type { Connection, Task } from '../../../models';
import { ConflictTaskDiffComponent, TaskResolutionMap } from '../components/conflict-task-diff.component';
import { ProjectStore } from '../../core/state/stores';

type TabKey = 'status' | 'conflicts' | 'queue';
type ConflictAction = 'local' | 'remote' | 'merge' | 'plan';
type OperationConflict = NonNullable<ConflictRecord['operationConflicts']>[number];

interface OperationConflictSummary {
  id: string;
  actionLabel: string;
  reasonLabel: string;
  localSummary: string;
  remoteSummary: string;
  message: string;
}

interface ConflictItem {
  projectId: string; projectName: string; reason: string; reasonLabel: string;
  conflictedAt: string; localTaskCount: number; remoteTaskCount: number;
  /** 本地任务原始数组（供 ConflictTaskDiff 组件使用） */
  localTasks: Task[];
  /** 云端任务原始数组 */
  remoteTasks: Task[];
  /** 操作级冲突证据摘要，用于展示 task/connection 级不可自动合并的写入 */
  operationConflictSummaries: OperationConflictSummary[];
  isResolving: boolean;
  /** 自动解决报告 */
  autoReport?: AutoResolutionReport;
  /** 当前云端快照是否为本轮冲突中新鲜抓取的版本 */
  remoteSnapshotFresh: boolean;
  /** 当前 UI 条目对应的持久化冲突指纹，防止旧建议应用到新冲突 */
  sourceFingerprint?: ConflictFingerprint;
  /** 用户逐任务选择结果 */
  taskResolutions?: TaskResolutionMap;
  /** 是否启用了逐任务选择模式 */
  selectiveMode?: boolean;
  /** 当前正在执行的冲突处理动作 */
  activeResolution?: ConflictAction | null;
  /**
   * 2026-05-15 新增：本地已不再持有的项目（被删除/未同步过来）。
   * 用于显示"项目已删除"标签和"丢弃此冲突记录"按钮，避免状态机永久卡住。
   */
  isOrphan?: boolean;
}

/** 仪表盘模态框 - 展示数据冲突、同步状态，支持内联冲突解决 */
@Component({
  selector: 'app-dashboard-modal',
  standalone: true,
  imports: [CommonModule, ConflictTaskDiffComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard-modal.component.html',
})
export class DashboardModalComponent implements OnInit {
  private actionQueue = inject(ActionQueueService);
  private syncService = inject(SyncStateService);
  private retryQueue = inject(RetryQueueService);
  private authService = inject(AuthService);
  private conflictStorage = inject(ConflictStorageService);
  private projectOps = inject(ProjectOperationService);
  private syncCoordinator = inject(SyncCoordinatorService);
  private autoResolver = inject(ConflictAutoResolverService);
  private toastService = inject(ToastService);
  private projectStore = inject(ProjectStore);

  @Output() close = new EventEmitter<void>();
  @Output() openConflictCenter = new EventEmitter<void>();

  /**
   * 2026-05-15 新增：父组件可通过此输入决定模态打开时落在哪个 Tab，
   * 用于侧边栏冲突计数入口直达 conflicts Tab。
   */
  readonly initialTab = input<TabKey | undefined>(undefined);

  readonly isLoggedIn = computed(() => !!this.authService.currentUserId());

  /** 当前活跃的 Tab */
  activeTab = signal<TabKey>('status');
  showDeadLetters = signal(false);
  isRetrying = signal(false);
  isResyncing = signal(false);

  conflictItems = signal<ConflictItem[]>([]);
  readonly pendingCount = this.actionQueue.queueSize;
  readonly deadLetterCount = this.actionQueue.deadLetterSize;
  readonly deadLetters = this.actionQueue.deadLetterQueue;

  /**
   * 队列是否正在处理（原型方法）
   *
   * 【Bug Fix】从 class field 改为原型方法，与 gate-actions.component.ts 保持一致。
   * 原因：SW 缓存导致 chunk 不一致时，class field 可能未初始化，
   * 模板调用 isProcessing() 报 "n.isProcessing is not a function"。
   */
  isProcessing(): boolean {
    try {
      return this.actionQueue?.isProcessing?.() ?? false;
    } catch {
      return false;
    }
  }

  readonly conflictCount = this.conflictStorage.conflictCount;
  readonly hasUnresolvedConflicts = this.conflictStorage.hasUnresolvedConflicts;
  readonly isOnline = computed(() => this.syncService.syncState().isOnline);
  readonly isSyncing = computed(() => this.syncService.syncState().isSyncing);
  readonly syncError = computed(() => this.syncService.syncState().syncError);
  readonly backgroundSyncNotice = computed(() => this.syncService.syncState().backgroundSyncNotice);
  readonly cloudSyncPausedReason = computed(() => this.syncService.syncState().cloudSyncPausedReason);
  readonly isCloudSyncPaused = computed(() => this.cloudSyncPausedReason() !== null);
  readonly offlineMode = computed(() => this.syncService.syncState().offlineMode);
  readonly hasIssues = computed(() =>
    this.deadLetterCount() > 0 || this.pendingCount() > 0 || !!this.syncError() || this.isCloudSyncPaused() || this.offlineMode() || this.conflictCount() > 0
  );

  readonly detailedStatus = computed(() => {
    if (this.isSyncing()) return '正在同步数据...';
    if (this.deadLetterCount() > 0) return `${this.deadLetterCount()} 个操作失败`;
    if (this.pendingCount() > 0) return `${this.pendingCount()} 个操作待同步`;
    if (!this.isOnline()) return '离线模式 - 数据保存在本地';
    if (this.isCloudSyncPaused()) {
      return this.cloudSyncPausedReason() === 'refresh-failed'
        ? '本地数据可用 - 重新登录后继续云同步'
        : '本地数据可用 - 登录后继续云同步';
    }
    if (this.offlineMode()) return '连接中断 - 恢复后自动同步';
    if (this.syncError()) return '同步错误';
    if (!this.isLoggedIn()) return '数据保存在本地 - 登录后可同步到云端';
    return '数据已保存到云端';
  });

  async retryAll(): Promise<void> {
    if (this.isRetrying() || this.isProcessing()) return;
    this.isRetrying.set(true);
    try {
      await this.retryQueue.processQueue(undefined, true);
      await this.actionQueue.processQueue();
      this.toastService.success('同步完成', '所有待处理操作已成功同步');
    } catch {
      this.toastService.error('同步失败', '部分操作同步失败，请稍后重试');
    } finally {
      this.isRetrying.set(false);
    }
  }

  retryDeadLetter(itemId: string): void { this.actionQueue.retryDeadLetter(itemId); }
  dismissDeadLetter(itemId: string): void { this.actionQueue.dismissDeadLetter(itemId); }

  clearAllDeadLetters(): void {
    this.actionQueue.clearDeadLetterQueue();
    this.toastService.success('已清空', '所有失败记录已清空');
  }

  async resyncProject(): Promise<void> {
    if (this.isResyncing()) return;
    this.isResyncing.set(true);
    try {
      const result = await this.syncCoordinator.resyncActiveProject();
      if (result.success) {
        result.conflictDetected
          ? this.toastService.warning('同步完成', result.message, { duration: 5000 })
          : this.toastService.success('同步完成', result.message);
      } else {
        this.toastService.error('同步失败', result.message);
      }
    } catch {
      this.toastService.error('同步错误', '重新同步时发生意外错误');
    } finally {
      this.isResyncing.set(false);
    }
  }

  getActionLabel(action: { type: string; entityType: string; entityId: string }): string {
    const typeLabels: Record<string, string> = { create: '创建', update: '更新', delete: '删除' };
    const entityLabels: Record<string, string> = { project: '项目', task: '任务', preference: '设置' };
    return `${typeLabels[action.type] || action.type} ${entityLabels[action.entityType] || action.entityType}`;
  }

  formatDate(isoString: string): string {
    const diffMs = Date.now() - new Date(isoString).getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return '刚刚';
    if (diffMins < 60) return `${diffMins} 分钟前`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} 小时前`;
    return `${Math.floor(diffHours / 24)} 天前`;
  }

  formatRelativeTime(isoString: string): string { return this.formatDate(isoString); }

  ngOnInit(): void {
    // 2026-05-15 新增：尊重父组件通过 initialTab 指定的 Tab。
    const requested = this.initialTab();
    if (requested) {
      this.activeTab.set(requested);
    }
    this.loadConflicts();
  }

  /**
   * 2026-05-15 新增：供 WorkspaceModalCoordinatorService 在仪表盘已打开时
   * 命令式切换 Tab（例如从仪表盘内部"去解决冲突"按钮）。
   */
  setActiveTab(tab: TabKey): void {
    this.activeTab.set(tab);
    if (tab === 'conflicts') {
      void this.loadConflicts();
    }
  }

  async loadConflicts(): Promise<void> {
    const conflicts = await this.conflictStorage.getAllConflicts();
    const items: ConflictItem[] = conflicts.map(conflict => this.mapConflictToItem(conflict));
    this.conflictItems.set(items);

    // 有冲突时自动跳转到冲突 tab（仅在未由 initialTab 显式指定时）
    if (items.length > 0 && !this.initialTab()) {
      this.activeTab.set('conflicts');
    }
  }

  private mapConflictToItem(record: ConflictRecord): ConflictItem {
    const localTasks = this.mergeTaskOperationConflictEvidence(
      Array.isArray(record.localProject?.tasks) ? record.localProject.tasks : [],
      record.operationConflicts,
      'local',
    );
    const remoteTasks = this.mergeTaskOperationConflictEvidence(
      Array.isArray(record.remoteProject?.tasks) ? record.remoteProject.tasks : [],
      record.operationConflicts,
      'remote',
    );

    // 生成自动解决报告
    const autoReport = this.autoResolver.analyze(record.projectId, localTasks, remoteTasks);

    // 判断是否为"孤立"冲突：项目本地已被删除/未同步过来
    const localProject = this.projectStore.getProject(record.projectId);
    const isOrphan = !localProject;

    return {
      projectId: record.projectId,
      projectName: record.localProject?.name || record.remoteProject?.name || '未知项目',
      reason: record.reason,
      reasonLabel: this.getReasonLabel(record.reason),
      conflictedAt: record.conflictedAt,
      localTaskCount: localTasks.length,
      remoteTaskCount: remoteTasks.length,
      localTasks,
      remoteTasks,
      operationConflictSummaries: this.mapOperationConflictSummaries(record.operationConflicts),
      isResolving: false,
      activeResolution: null,
      autoReport,
      remoteSnapshotFresh: record.remoteSnapshotFresh === true,
      sourceFingerprint: captureConflictFingerprint(record, null, this.authService.currentUserId()),
      selectiveMode: false,
      isOrphan,
    };
  }

  private mergeTaskOperationConflictEvidence(
    snapshotTasks: Task[],
    operationConflicts: ConflictRecord['operationConflicts'],
    side: 'local' | 'remote',
  ): Task[] {
    if (!operationConflicts?.length) {
      return snapshotTasks;
    }

    const merged = [...snapshotTasks];
    const taskIndexes = new Map(merged.map((task, index) => [task.id, index]));

    for (const conflict of operationConflicts) {
      if (conflict.entityType !== 'task') {
        continue;
      }

      const task = side === 'local'
        ? conflict.localEntity as Task
        : conflict.remoteEntity as Task | undefined;

      if (!task?.id) {
        continue;
      }

      const existingIndex = taskIndexes.get(task.id);
      if (existingIndex === undefined) {
        taskIndexes.set(task.id, merged.length);
        merged.push(task);
      } else {
        merged[existingIndex] = task;
      }
    }

    return merged;
  }

  private mapOperationConflictSummaries(
    operationConflicts: ConflictRecord['operationConflicts'],
  ): OperationConflictSummary[] {
    if (!operationConflicts?.length) {
      return [];
    }

    return operationConflicts.map((conflict, index) => ({
      id: conflict.operationId || conflict.actionId || `${conflict.entityType}:${conflict.entityId}:${index}`,
      actionLabel: this.getOperationConflictActionLabel(conflict.actionType),
      reasonLabel: this.getOperationConflictReasonLabel(conflict.reason),
      localSummary: this.summarizeOperationConflictEntity(conflict.localEntity, conflict.entityType),
      remoteSummary: this.summarizeOperationConflictEntity(conflict.remoteEntity, conflict.entityType),
      message: conflict.message,
    }));
  }

  private getOperationConflictActionLabel(actionType: OperationConflict['actionType']): string {
    const labels: Record<OperationConflict['actionType'], string> = {
      'task:create': '创建任务',
      'task:update': '更新任务',
      'task:delete': '删除任务',
      'connection:create': '创建关联',
      'connection:update': '更新关联',
      'connection:delete': '删除关联',
    };

    return labels[actionType];
  }

  private getOperationConflictReasonLabel(reason: OperationConflict['reason']): string {
    const labels: Record<OperationConflict['reason'], string> = {
      'remote-newer': '云端版本较新',
      'remote-tombstone': '云端已删除',
      version_mismatch: '版本不匹配',
    };

    return labels[reason];
  }

  private summarizeOperationConflictEntity(
    entity: OperationConflict['localEntity'] | OperationConflict['remoteEntity'],
    entityType: OperationConflict['entityType'],
  ): string {
    if (!entity) {
      return '无可用快照';
    }

    if (entityType === 'connection') {
      const connection = entity as Connection;
      const endpoints = `${connection.source || '?'} -> ${connection.target || '?'}`;
      return connection.title ? `${endpoints} · ${connection.title}` : endpoints;
    }

    const task = entity as Task;
    return task.title || task.displayId || task.id;
  }

  /**
   * 2026-05-15 新增：丢弃孤立冲突记录（项目已删除）。
   * 此操作只清理本地 IndexedDB 中的冲突记录，是状态机卡死的兜底出路。
   */
  async discardOrphanConflict(projectId: string): Promise<void> {
    try {
      const ok = await this.conflictStorage.deleteConflict(projectId);
      if (ok) {
        await this.conflictStorage.refreshConflictCount();
        await this.loadConflicts();
        this.toastService.success('已丢弃', '该冲突记录已从本地清除');
      } else {
        this.toastService.error('丢弃失败', '请稍后重试');
      }
    } catch {
      this.toastService.error('丢弃失败', '请稍后重试');
    }
  }

  private getReasonLabel(reason: string): string {
    const labels: Record<string, string> = {
      version_mismatch: '版本不匹配', concurrent_edit: '并发编辑',
      network_recovery: '网络恢复', status_conflict: '状态冲突', field_conflict: '字段冲突',
    };
    return labels[reason] || reason;
  }

  async resolveUseLocal(projectId: string): Promise<void> { await this.resolveConflictWithStrategy(projectId, 'local'); }
  async resolveUseRemote(projectId: string): Promise<void> { await this.resolveConflictWithStrategy(projectId, 'remote'); }

  /** 切换逐任务选择模式 */
  toggleSelectiveMode(projectId: string): void {
    this.conflictItems.update(items =>
      items.map(item => item.projectId === projectId
        ? { ...item, selectiveMode: !item.selectiveMode }
        : item
      )
    );
  }

  /** 接收逐任务选择变更 */
  onTaskSelectionChange(projectId: string, selections: TaskResolutionMap): void {
    this.conflictItems.update(items =>
      items.map(item => item.projectId === projectId
        ? { ...item, taskResolutions: selections }
        : item
      )
    );
  }

  /**
   * 应用系统自动解决建议
   * 将 auto/suggest 的推荐直接应用，manual 的保留用户已有选择
   */
  async applyAutoResolution(conflict: ConflictItem): Promise<void> {
    if (!conflict.autoReport) return;
    if (!conflict.remoteSnapshotFresh) {
      this.toastService.warning('建议暂不可直接应用', '当前云端快照不是本轮最新结果，请先重新同步或逐项确认后再处理');
      return;
    }
    if (!(await this.ensureAutoResolutionConflictIsCurrent(conflict))) {
      return;
    }

    this.setResolving(conflict.projectId, true, 'plan');
    try {
      const plan = this.buildResolutionPlan(conflict);
      const counts = this.countResolutionChoices(plan);
      const resolved = await this.projectOps.resolveConflictWithPlan(conflict.projectId, plan, { backgroundPersist: true });
      await this.loadConflicts();

      if (!resolved) {
        return;
      }

      const totalResolved = Object.keys(plan.taskChoices).length;
      const userSelectionCount = conflict.taskResolutions?.size ?? 0;
      this.toastService.success(
        '智能解决完成',
        `已按逐任务方案处理 ${totalResolved} 个冲突（${counts.local} 项保留本地，${counts.remote} 项采用云端${userSelectionCount > 0 ? `；其中 ${userSelectionCount} 项来自您的明确选择` : ''}）`
      );
    } catch {
      this.toastService.error('错误', '应用系统建议时发生意外错误');
    } finally {
      this.setResolving(conflict.projectId, false);
    }
  }

  private async ensureAutoResolutionConflictIsCurrent(conflict: ConflictItem): Promise<boolean> {
    if (!conflict.sourceFingerprint) {
      return true;
    }

    const latestConflict = await this.conflictStorage.getConflict(conflict.projectId);
    if (
      !latestConflict
      || latestConflict.remoteSnapshotFresh !== true
      || !doesStoredConflictMatchFingerprint(latestConflict, conflict.sourceFingerprint)
    ) {
      await this.loadConflicts();
      this.toastService.warning(
        '冲突已更新',
        '冲突数据已变化，已刷新列表，请基于最新状态重新应用系统建议',
      );
      return false;
    }

    return true;
  }

  async resolveKeepBoth(projectId: string): Promise<void> {
    this.setResolving(projectId, true, 'merge');
    try {
      const conflict = await this.conflictStorage.getConflict(projectId);
      if (!conflict) { this.toastService.error('错误', '未找到冲突数据'); return; }
      const resolved = await this.projectOps.resolveConflict(projectId, 'merge', { backgroundPersist: true });
      await this.loadConflicts();
      if (resolved) { this.toastService.success('已保留两者', '云端版本的任务已作为副本添加'); }
    } catch {
      this.toastService.error('错误', '解决冲突时发生意外错误');
    } finally {
      this.setResolving(projectId, false);
    }
  }

  private async resolveConflictWithStrategy(projectId: string, strategy: 'local' | 'remote'): Promise<void> {
    this.setResolving(projectId, true, strategy);
    try {
      const conflict = await this.conflictStorage.getConflict(projectId);
      if (!conflict) { this.toastService.error('错误', '未找到冲突数据'); return; }
      const resolved = await this.projectOps.resolveConflict(projectId, strategy, { backgroundPersist: true });
      await this.loadConflicts();
      if (!resolved) {
        return;
      }

      if (strategy === 'local') {
        this.toastService.success('已保留本地修改', '冲突已在本地解决，后台会自动同步到云端');
      } else {
        this.toastService.success('已采用云端版本', '当前项目已切换到云端结果');
      }
    } catch {
      this.toastService.error('错误', '解决冲突时发生意外错误');
    } finally {
      this.setResolving(projectId, false);
    }
  }

  private setResolving(projectId: string, isResolving: boolean, activeResolution: ConflictAction | null = null): void {
    this.conflictItems.update(items =>
      items.map(item => item.projectId === projectId ? { ...item, isResolving, activeResolution } : item)
    );
  }

  getActiveResolutionLabel(conflict: ConflictItem): string {
    switch (conflict.activeResolution) {
      case 'local':
        return '正在使用本地结果覆盖云端…';
      case 'remote':
        return '正在使用云端结果覆盖本地…';
      case 'merge':
        return '正在合并两边修改…';
      case 'plan':
        return '正在按系统建议逐任务处理…';
      default:
        return '正在处理冲突…';
    }
  }

  canApplySuggestedResolution(conflict: ConflictItem): boolean {
    if (!conflict.remoteSnapshotFresh) {
      return false;
    }

    return !!conflict.autoReport
      && conflict.autoReport.recommendations.length > 0
      && this.getPendingManualSelections(conflict) === 0;
  }

  getSuggestedResolutionLabel(conflict: ConflictItem): string {
    const userSelectionCount = conflict.taskResolutions?.size ?? 0;
    return userSelectionCount > 0 ? `应用系统建议与 ${userSelectionCount} 项选择` : '应用系统建议';
  }

  getSuggestedResolutionSummary(conflict: ConflictItem): string {
    if (!conflict.autoReport) {
      return '';
    }

    if (!conflict.remoteSnapshotFresh) {
      return '当前展示的云端快照不是本轮冲突中的最新结果，系统建议仅供参考；请先重新同步或逐项确认。';
    }

    const manualPending = this.getPendingManualSelections(conflict);
    const userSelectionCount = conflict.taskResolutions?.size ?? 0;
    if (manualPending > 0) {
      return `系统已完成 ${conflict.autoReport.autoCount + conflict.autoReport.suggestCount} 项判断，仍有 ${manualPending} 项高风险冲突需要您确认。`;
    }

    if (userSelectionCount > 0) {
      return `将优先采用您的 ${userSelectionCount} 项明确选择，其余 ${Math.max(conflict.autoReport.recommendations.length - userSelectionCount, 0)} 项按系统建议处理。`;
    }

    return '系统已完成逐任务判断，应用后会按任务分别保留本地或云端版本。';
  }

  private getPendingManualSelections(conflict: ConflictItem): number {
    const report = conflict.autoReport;
    if (!report) {
      return 0;
    }

    const selections = conflict.taskResolutions ?? new Map<string, 'local' | 'remote'>();
    return report.recommendations.filter(rec => rec.confidence === 'manual' && !selections.has(rec.taskId)).length;
  }

  private buildResolutionPlan(conflict: ConflictItem): ConflictResolutionPlan {
    const taskChoices: Record<string, TaskResolutionChoice> = {};
    const selections = conflict.taskResolutions ?? new Map<string, 'local' | 'remote'>();

    for (const recommendation of conflict.autoReport?.recommendations ?? []) {
      const userChoice = selections.get(recommendation.taskId);
      if (userChoice) {
        taskChoices[recommendation.taskId] = userChoice;
        continue;
      }

      taskChoices[recommendation.taskId] = recommendation.recommendation === 'remote' ? 'remote' : 'local';
    }

    return {
      taskChoices,
      appliedBy: selections.size === 0 ? 'system' : 'mixed',
    };
  }

  private countResolutionChoices(plan: ConflictResolutionPlan): { local: number; remote: number } {
    const counts = { local: 0, remote: 0 };

    for (const choice of Object.values(plan.taskChoices)) {
      if (choice === 'local') {
        counts.local++;
      } else {
        counts.remote++;
      }
    }

    return counts;
  }
}
