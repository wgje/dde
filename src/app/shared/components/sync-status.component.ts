import { Component, inject, signal, computed, input, ChangeDetectionStrategy, output, effect, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActionQueueService } from '../../../services/action-queue.service';
import { SyncStateService } from '../../core/services/sync/sync-state.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { ProjectStateService } from '../../../services/project-state.service';
import { AuthService } from '../../../services/auth.service';
import { ConflictStorageService } from '../../../services/conflict-storage.service';
import { RetryQueueService } from '../../core/services/sync/retry-queue.service';
import { ToastService } from '../../../services/toast.service';
import { LoggerService } from '../../../services/logger.service';
import { SYNC_CONFIG } from '../../../config/sync.config';
import type { QueuedAction } from '../../../services/action-queue.types';

/**
 * 同步状态组件
 * 支持紧凑模式和完整模式
 * - 紧凑模式：仅显示小图标和状态文字，适合侧边栏项目列表
 * - 完整模式：显示详细状态，适合弹出面板
 * 
 * 嵌入模式（embedded）：直接显示在侧边栏中而非弹窗
 * 
 * 冲突仓库功能：
 * - 显示冲突红点提示
 * - 用户点击可进入冲突解决中心
 */
@Component({
  selector: 'app-sync-status',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sync-status.component.html',
})
export class SyncStatusComponent {
  /**
   * 不计入"X 待同步"用户可见计数的后台实体类型。
   *
   * 这些类型由系统在后台自动同步（无用户显式"保存"动作）：
   * - `focus-session`：专注模式后台快照
   * - `preference`：用户偏好/设置自动持久化
   * - `routine-task` / `routine-completion`：例行任务静默同步
   *
   * 真正应被用户感知的"待同步"只剩 `task / project`（连接 `connection` 走 RetryQueue 路径）。
   *
   * 【2026-05-16 根因修复】之前仅过滤 `focus-session` 导致 preference / routine-* 卡死的同步项
   * 会让侧边栏长期显示 "1 待同步"，用户无法理解来源。
   */
  private static readonly BACKGROUND_PENDING_ENTITY_TYPES = new Set<QueuedAction['entityType']>([
    'focus-session',
    'preference',
    'routine-task',
    'routine-completion',
  ]);

  /**
   * `pendingClearTimer` 在窗口内被频繁重置时的兜底阈值。
   * 1.5s 内反复 0↔1 震荡会让 clear timer 永远不到期，UI 卡在 "1 待同步"。
   * 当窗口内重置次数达到该阈值时，强制按最新值落地以打破死锁。
   */
  private static readonly PENDING_CLEAR_MAX_RESETS = 3;

  private actionQueue = inject(ActionQueueService);
  private syncStateService = inject(SyncStateService);
  private authService = inject(AuthService);
  private conflictStorage = inject(ConflictStorageService);
  private syncCoordinator = inject(SyncCoordinatorService);
  private projectState = inject(ProjectStateService);
  private retryQueue = inject(RetryQueueService);
  private toastService = inject(ToastService);
  private readonly logger = inject(LoggerService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly PENDING_CLEAR_DELAY_MS = 1500;
  private pendingClearTimer: ReturnType<typeof setTimeout> | null = null;
  /** 当前 pendingClearTimer 已被重置的次数，达到 PENDING_CLEAR_MAX_RESETS 后强制落地 */
  private pendingClearResetCount = 0;
  
  // 输入属性 - 是否使用紧凑模式
  compact = input(false);
  // 输入属性 - 是否使用嵌入模式（直接显示在侧边栏中）
  embedded = input(false);
  
  // 输出事件 - 打开冲突解决中心
  readonly openConflictCenterEvent = output<void>({ alias: 'openConflictCenter' });
  
  /** 用户是否已登录 */
  readonly isLoggedIn = computed(() => !!this.authService.currentUserId());
  
  // 状态
  showDeadLetters = signal(false);
  isExpanded = signal(false);
  /** 本地重试状态（用于禁用按钮防止重复点击） */
  isRetrying = signal(false);
  /** 重新同步状态 */
  isResyncing = signal(false);
  
  // 从服务获取状态
  /**
   * 用户可感知的待同步数量。
   * `focus-session` 由停泊坞后台自动快照推送周期性产生，不应把状态条抖成“1 待同步”。
   */
  readonly actionQueuePendingCount = computed(() =>
    this.actionQueue.pendingActions().filter(action => this.isUserVisiblePendingAction(action)).length
  );
  readonly retryQueuePendingCount = computed(() => this.syncStateService.syncState().pendingCount);
  /**
   * 是否处于后台重试态。
   *
   * 触发条件：
   * 1. 用户不可见的待同步 (actionQueuePendingCount === 0) + RetryQueue 有积压
   * 2. 或：`backgroundSyncNotice` 非空（partial-handoff 已交接 RetryQueue）
   *
   * 第二条覆盖"RetryQueue 排空但终态项导致 notice 未清"的兜底显示，
   * 避免 partial-handoff notice 仍然显示但状态点错误地变绿。
   */
  readonly isBackgroundRetrying = computed(() =>
    this.actionQueuePendingCount() === 0 &&
    (this.retryQueuePendingCount() > 0 || this.backgroundSyncNotice() !== null)
  );
  readonly pendingCount = signal(0);
  readonly deadLetterCount = this.actionQueue.deadLetterSize;
  readonly deadLetters = this.actionQueue.deadLetterQueue;
  readonly queueFrozen = this.actionQueue.queueFrozen;
  readonly queueFreezeReason = this.actionQueue.queueFreezeReason;
  readonly legacyReviewCount = this.retryQueue.legacyReviewCount;

  constructor() {
    effect(() => this.reconcilePendingCount());

    this.destroyRef.onDestroy(() => this.clearPendingTimers());
  }

  /**
   * 同步 actionQueue / retryQueue 的当前状态到 `pendingCount` 信号。
   *
   * 防抖策略：
   * - 用户本地操作（actionPending > 0）立即反馈，无防抖。
   * - 上行（retryQueue 临时增加）走 1.2s show-timer，过滤短促波动。
   * - 下行（归零）走 1.5s clear-timer；若窗口内被重置 ≥ N 次，强制按当前 next 落地，
   *   打破 0↔1 高频震荡导致的"1 待同步永不归零"死锁。
   */
  private reconcilePendingCount(): void {
    const actionPending = this.actionQueuePendingCount();
    const current = this.pendingCount();
    const next = actionPending;

    if (next === current) {
      return;
    }

    if (actionPending > 0) {
      this.clearPendingTimers();
      this.pendingCount.set(next);
      return;
    }

    this.schedulePendingClearTimer(next);
  }

  private schedulePendingClearTimer(next: number): void {
    // 【2026-05-16 根因修复】防止 0↔1 高频震荡导致 clearTimer 永远被重置：
    // 当窗口内重置次数达到 PENDING_CLEAR_MAX_RESETS 时，立即按当前 next 落地，
    // 由后续 effect 重新驱动状态收敛，确保 UI 不会永久卡在 "1 待同步"。
    if (this.pendingClearTimer !== null) {
      clearTimeout(this.pendingClearTimer);
      this.pendingClearResetCount += 1;
      if (this.pendingClearResetCount >= SyncStatusComponent.PENDING_CLEAR_MAX_RESETS) {
        this.pendingClearTimer = null;
        this.pendingClearResetCount = 0;
        this.pendingCount.set(next);
        return;
      }
    } else {
      this.pendingClearResetCount = 0;
    }
    this.pendingClearTimer = setTimeout(() => {
      this.pendingClearTimer = null;
      this.pendingClearResetCount = 0;
      const latest = this.actionQueuePendingCount();
      if (latest === 0) {
        this.pendingCount.set(0);
      }
    }, this.PENDING_CLEAR_DELAY_MS);
  }

  private clearPendingTimers(): void {
    if (this.pendingClearTimer !== null) {
      clearTimeout(this.pendingClearTimer);
      this.pendingClearTimer = null;
    }
    this.pendingClearResetCount = 0;
  }

  private isUserVisiblePendingAction(action: QueuedAction): boolean {
    return !SyncStatusComponent.BACKGROUND_PENDING_ENTITY_TYPES.has(action.entityType);
  }

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
  
  // 冲突仓库状态
  readonly conflictCount = this.conflictStorage.conflictCount;
  readonly hasUnresolvedConflicts = this.conflictStorage.hasUnresolvedConflicts;

  readonly isOnline = computed(() => this.syncStateService.syncState().isOnline);
  readonly isSyncing = computed(() => this.syncStateService.syncState().isSyncing);
  readonly syncError = computed(() => this.syncStateService.syncState().syncError);
  /**
   * 后台同步提示（信息级，非错误）。
   *
   * 【根因修复 2026-05-16】partial-handoff 不再写入 `syncError` 红错通道，
   * 改走 `backgroundSyncNotice`。状态点不再因 partial-handoff 变红，
   * 详细状态显示"后台同步中..."。
   */
  readonly backgroundSyncNotice = computed(() => this.syncStateService.syncState().backgroundSyncNotice);
  /**
   * visibleSyncError 现在直接等于 syncError。
   *
   * 历史背景：原实现做了 partial-handoff 白名单过滤，避免红条立即显示。
   * 现在 partial-handoff 已经分流到 `backgroundSyncNotice`，`syncError`
   * 本身只承载真错误，无需再过滤。保留 visibleSyncError 别名以保持现有模板/computed 兼容。
   */
  readonly visibleSyncError = computed(() => this.syncError());
  readonly cloudSyncPausedReason = computed(() => this.syncStateService.syncState().cloudSyncPausedReason);
  readonly isCloudSyncPaused = computed(() => this.cloudSyncPausedReason() !== null);
  readonly offlineMode = computed(() => this.syncStateService.syncState().offlineMode);

  /** 状态点颜色（互斥优先级：同步中 > 失败 > 警告 > 正常） */
  readonly statusDotClass = computed(() => {
    if (this.isSyncing()) return 'bg-blue-500';
    if (
      this.deadLetterCount() > 0
      || this.queueFrozen()
      || this.legacyReviewCount() > 0
      || !!this.visibleSyncError()
      || this.conflictCount() > 0
    ) {
      return 'bg-red-500';
    }
    if (this.isBackgroundRetrying()) return 'bg-stone-400';
    if (!this.isOnline() || this.offlineMode() || this.pendingCount() > 0 || !this.isLoggedIn() || this.isCloudSyncPaused()) return 'bg-amber-500';
    return 'bg-green-500';
  });
  
  /** 【新增】后台正在加载云端数据 */
  readonly isLoadingRemote = this.syncCoordinator.isLoadingRemote;
  
  /** 【新增】综合同步状态：正在推送或正在拉取 */
  readonly isAnySyncing = computed(() => this.isSyncing() || this.isLoadingRemote());
  
  // 计算属性 - 是否有需要关注的问题（包括 offlineMode 连接中断状态和冲突）
  readonly hasIssues = computed(() => 
    this.deadLetterCount() > 0 ||
    this.pendingCount() > 0 ||
    this.queueFrozen() ||
    this.legacyReviewCount() > 0 ||
    !!this.visibleSyncError() ||
    this.isCloudSyncPaused() ||
    this.offlineMode() ||
    this.conflictCount() > 0
  );
  
  readonly totalIssues = computed(() => 
    this.deadLetterCount() +
    (this.pendingCount() > 0 ? 1 : 0) +
    (this.queueFrozen() ? 1 : 0) +
    (this.legacyReviewCount() > 0 ? 1 : 0) +
    (this.visibleSyncError() ? 1 : 0) +
    (this.isCloudSyncPaused() ? 1 : 0) +
    (this.offlineMode() ? 1 : 0) +
    this.conflictCount()
  );
  
  /**
   * 【Senior Consultant "Red Phone"】是否处于危险状态
   * 当死信队列有内容或待同步队列超过阈值时，显示紧急警告
   */
  readonly isCriticalState = computed(() => {
    const deadCount = this.deadLetterCount();
    const pendingCount = this.pendingCount();
    const criticalThreshold = Math.floor(SYNC_CONFIG.MAX_RETRY_QUEUE_SIZE * 0.8);
    return deadCount > 0 || pendingCount > criticalThreshold;
  });
  
  /**
   * 【增强】最近成功云同步时间（格式化）
   */
  readonly lastSyncTimeText = computed(() => {
    const lastSync = this.syncStateService.syncState().lastSyncTime;
    if (!lastSync) return null;
    return this.formatDate(lastSync);
  });

  /**
   * 【增强】队列冻结时的内存中操作计数
   * 队列冻结后新入队的操作仅存在于内存中，重启会丢失
   */
  readonly memoryOnlyCount = computed(() => {
    if (!this.queueFrozen()) return 0;
    return this.actionQueue.queueSize();
  });

  readonly queueFreezeStatusText = computed(() => {
    const reason = this.queueFreezeReason();
    return reason
      ? `同步队列已冻结：${reason}`
      : '同步队列已冻结，请释放存储空间';
  });

  /**
   * 【增强】重试队列容量使用百分比
   */
  readonly retryQueueUsagePercent = computed(() => {
    return this.retryQueue.getCapacityPercent();
  });

  /** 详细状态文本 */
  readonly detailedStatus = computed(() => {
    if (this.isLoadingRemote()) {
      return '后台同步中...';
    }
    if (this.isSyncing()) {
      return '正在同步数据...';
    }
    if (this.queueFrozen()) {
      return this.queueFreezeStatusText();
    }
    if (this.legacyReviewCount() > 0) {
      return `${this.legacyReviewCount()} 个旧版离线同步项待确认`;
    }
    if (this.deadLetterCount() > 0) {
      return `${this.deadLetterCount()} 个操作失败`;
    }
    if (this.visibleSyncError()) {
      return '同步错误';
    }
    if (this.isBackgroundRetrying()) {
      // 弱网长重试期间展示积压数：用户能看到数字收敛，而不是无限期的"后台同步中"
      const backlog = this.retryQueuePendingCount();
      return backlog > 0 ? `后台同步中（${backlog} 项待重试）...` : '后台同步中...';
    }
    if (this.conflictCount() > 0) {
      return `${this.conflictCount()} 个冲突待处理`;
    }
    if (this.pendingCount() > 0) {
      return `${this.pendingCount()} 个操作待同步`;
    }
    if (!this.isOnline()) {
      return '离线模式 - 数据保存在本地';
    }
    if (this.isCloudSyncPaused()) {
      return this.cloudSyncPausedReason() === 'refresh-failed'
        ? '本地数据可用 - 重新登录后继续云同步'
        : '本地数据可用 - 登录后继续云同步';
    }
    if (this.offlineMode()) {
      return '连接中断 - 恢复后自动同步';
    }
    if (!this.isLoggedIn()) {
      return '数据保存在本地 - 登录后可同步到云端';
    }
    return '数据已保存到云端';
  });
  
  /**
   * 切换展开状态
   */
  toggleExpand() {
    this.isExpanded.update(v => !v);
  }
  
  /**
   * 立即重试所有待处理操作
   *
   * 【根因修复 2026-04-22】过去只触发 ActionQueue.processQueue，
   * 当待同步项实际全部落在 RetryQueue（batch-sync 失败转交）时，
   * "立即同步" 按钮对 RetryQueue 无效 → 用户看到 "同步中..." 旋转但数字不降。
  * 这里并行触发 RetryQueue.processQueue；真正的 syncError 收口仍交给
  * RetryQueue / ActionQueue 自身的恢复信号链路，避免空队列点击把旧错误误清掉。
   */
  async retryAll() {
    // 防止重复点击
    if (this.isRetrying() || this.isProcessing()) return;

    this.isRetrying.set(true);
    try {
      await this.retryQueue.processQueue(undefined, true);
      await this.actionQueue.processQueue();
    } finally {
      this.isRetrying.set(false);
    }
  }
  
  /**
   * 重试单个死信
   */
  retryDeadLetter(itemId: string) {
    this.actionQueue.retryDeadLetter(itemId);
  }
  
  /**
   * 放弃单个死信
   */
  dismissDeadLetter(itemId: string) {
    this.actionQueue.dismissDeadLetter(itemId);
  }
  
  /**
   * 清空所有死信
   */
  clearAllDeadLetters() {
    this.actionQueue.clearDeadLetterQueue();
    this.showDeadLetters.set(false);
  }
  
  /**
   * 打开冲突解决中心
   * 发出事件让父组件处理（可能是打开模态框或导航到冲突页面）
   */
  openConflictCenter() {
    this.isExpanded.set(false);
    this.openConflictCenterEvent.emit();
  }
  
  /**
   * 重新同步当前项目
   * 智能合并而非暴力覆盖
   */
  async resyncProject() {
    if (this.isResyncing()) return;
    
    this.isResyncing.set(true);
    try {
      const result = await this.syncCoordinator.resyncActiveProject();
      
      if (result.success) {
        if (result.conflictDetected) {
          this.toastService.warning('同步完成', result.message, { duration: 5000 });
        } else {
          this.toastService.success('同步完成', result.message);
        }
      } else {
        this.toastService.error('同步失败', result.message);
      }
    } catch (_e) {
      this.toastService.error('同步错误', '重新同步时发生意外错误');
    } finally {
      this.isResyncing.set(false);
    }
  }
  
  /**
   * 【增强】导出待同步数据（逃生导出）
   */
  exportPendingData() {
    this.actionQueue.downloadEscapeExport();
  }

  /**
   * 获取操作的可读标签
   */
  getActionLabel(action: { type: string; entityType: string; entityId: string }): string {
    const typeLabels: Record<string, string> = {
      'create': '创建',
      'update': '更新',
      'delete': '删除'
    };
    const entityLabels: Record<string, string> = {
      'project': '项目',
      'task': '任务',
      'connection': '连接',
      'preference': '设置'
    };
    
    return `${typeLabels[action.type] || action.type} ${entityLabels[action.entityType] || action.entityType}`;
  }
  
  /**
   * 格式化日期
   */
  formatDate(isoString: string): string {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return '刚刚';
    if (diffMins < 60) return `${diffMins} 分钟前`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} 小时前`;
    
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} 天前`;
  }
  
  /**
   * 【Senior Consultant "Red Phone"】紧急下载备份
   * 当同步严重滞后时，允许用户下载本地数据备份
   */
  async downloadBackup() {
    try {
      // 获取当前项目的本地数据
      const _activeProjectId = this.projectState.activeProjectId() || '';
      
      // 构建备份数据
      const backupData = {
        timestamp: new Date().toISOString(),
        version: '1.0',
        source: 'nanoflow-emergency-backup',
        pendingOperations: this.pendingCount(),
        failedOperations: this.deadLetterCount(),
        // 死信队列中的数据
        deadLetterQueue: this.deadLetters().map(item => ({
          type: item.action.type,
          entityType: item.action.entityType,
          entityId: item.action.entityId,
          failedAt: item.failedAt,
          reason: item.reason
        }))
      };
      
      // 创建下载文件
      const blob = new Blob([JSON.stringify(backupData, null, 2)], { 
        type: 'application/json' 
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nanoflow-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      this.toastService.success('备份已下载', '请妥善保存备份文件');
    } catch (e) {
      this.toastService.error('下载失败', '无法创建备份文件');
      this.logger.error('SyncStatus', 'Backup download failed', e);
    }
  }
}
