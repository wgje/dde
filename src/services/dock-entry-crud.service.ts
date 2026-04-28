/**
 * DockEntryCrudService
 * 从 DockEngineService 中提取的条目 CRUD 操作逻辑。
 * 负责：任务入坞、主任务设置、雷达区插入/淘汰、顺序重排、切换操作、
 * 清理操作等纯 entries 状态管理逻辑。
 */
import { Injectable, WritableSignal, inject } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';
import { DOCK_TOAST } from '../config/dock-i18n.config';
import { 
  CognitiveLoad, 
  DockEntry, 
  DockLane, 
  DockPendingDecision, 
  DockSourceSection, 
  DockZoneSource 
} from '../models/parking-dock';
import { TaskStore } from '../core-bridge';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { DockInlineCreationService } from './dock-inline-creation.service';
import { DockTaskSyncService } from './dock-task-sync.service';
import { DockZoneService } from './dock-zone.service';
import { DockPromotionService } from './dock-promotion.service';
import { DockCompletionFlowService } from './dock-completion-flow.service';
import { DockFragmentRestService } from './dock-fragment-rest.service';
import { DockEngineLifecycleService } from './dock-engine-lifecycle.service';
import { sanitizePlannerFields } from '../utils/planner-fields';
import { 
  buildConsoleVisibleOrderHint, 
  buildDockEntry, 
  findConsoleEvictionCandidate, 
  patchAllEntries, 
  patchEntryByTaskId 
} from './dock-engine.utils';
import { TimerHandle } from '../utils/timer-handle';

// ---------------------------------------------------------------------------
//  Context interface — engine 在 constructor 中调用 init() 注入信号引用
// ---------------------------------------------------------------------------

export interface DockEntryCrudContext {
  // WritableSignals
  entries: WritableSignal<DockEntry[]>;
  focusMode: WritableSignal<boolean>;
  muteWaitTone: WritableSignal<boolean>;
  dockExpanded: WritableSignal<boolean>;
  focusScrimOn: WritableSignal<boolean>;
  firstDragIntervened: WritableSignal<boolean>;
  pendingDecision: WritableSignal<DockPendingDecision | null>;
  highlightedIds: WritableSignal<Set<string>>;
  suspendRecommendationLocked: WritableSignal<boolean>;
  suspendChainRootTaskId: WritableSignal<string | null>;
  lastRadarInsertedTaskId: WritableSignal<string | null>;
  lastRadarEvictedTaskId: WritableSignal<string | null>;
  pendingRadarEviction: WritableSignal<string | null>;
  lastConsoleDemotedTaskId: WritableSignal<string | null>;
  consoleVisibleOrderHint: WritableSignal<string[]>;
  firstMainSelectionWindow: WritableSignal<{ taskId: string; expiresAt: number } | null>;
  waitEndNotifiedIds: Set<string>;
  
  // Computed signal readers
  focusingEntry: () => DockEntry | null;
  consoleEntries: () => DockEntry[];
  consoleVisibleEntries: () => DockEntry[];
  
  // Callbacks to engine methods that stay
  switchToTask: (taskId: string) => void;
  completeTask: (taskId: string) => void;
  rebalanceAutoZones: () => void;
  clearFirstMainSelectionWindow: () => void;
  startFirstMainSelectionWindow: (taskId: string) => void;
}

@Injectable({
  providedIn: 'root',
})
export class DockEntryCrudService {
  private readonly taskStore = inject(TaskStore);
  private readonly logger = inject(LoggerService).category('DockEntryCrud');
  private readonly toast = inject(ToastService);
  private readonly inlineCreation = inject(DockInlineCreationService);
  private readonly taskSync = inject(DockTaskSyncService);
  private readonly zoneService = inject(DockZoneService);
  private readonly promotionService = inject(DockPromotionService);
  private readonly completionFlow = inject(DockCompletionFlowService);
  private readonly fragmentRest = inject(DockFragmentRestService);
  private readonly lifecycle = inject(DockEngineLifecycleService);

  private _ctx: DockEntryCrudContext | null = null;

  /** 安全超时：如果动画未触发 flushRadarEviction，强制清除 pendingRadarEviction */
  private readonly radarEvictionTimeout = new TimerHandle();

  /**
   * 获取上下文——必须在 DockEngineService 构造期间调用 init() 注入。
   * 如未初始化则抛出明确错误，便于定位 DI 顺序问题。
   */
  private get ctx(): DockEntryCrudContext {
    if (!this._ctx) {
      throw new Error(
        'DockEntryCrudService.init() must be called before use. ' +
        'Ensure DockEngineService is constructed before accessing this service.',
      );
    }
    return this._ctx;
  }

  /**
   * 由 DockEngineService 在其构造函数中调用，注入共享信号引用。
   * 此服务使用手动上下文注入而非 Angular DI，因为所需信号是 DockEngineService 的私有成员，
   * 无法通过常规注入获取。这是有意的架构权衡：以运行时初始化检查换取信号封装性。
   */
  init(ctx: DockEntryCrudContext): void {
    if (this._ctx) {
      this.logger.warn('init() called again — overwriting previous context');
    }
    this._ctx = ctx;
  }

  /**
   * 清理资源——在 DockEngineService 析构时调用
   */
  destroy(): void {
    this.radarEvictionTimeout.cancel();
  }

  // ---------------------------------------------------------------------------
  //  Entry CRUD Operations
  // ---------------------------------------------------------------------------

  dockTask(
    taskId: string,
    lane?: DockLane,
    options?: {
      sourceKind?: DockEntry['sourceKind'];
      sourceSection?: DockSourceSection;
      load?: CognitiveLoad;
      expectedMinutes?: number | null;
      waitMinutes?: number | null;
      detail?: string;
      zoneSource?: DockZoneSource;
    },
  ): boolean {
    if (this.ctx.entries().some(entry => entry.taskId === taskId)) return false;

    const task = this.taskStore.getTask(taskId);
    if (!task || task.status !== 'active') {
      this.logger.warn(`Task ${taskId} is missing or not active; reject docking.`);
      return false;
    }
    if (!this.inlineCreation.ensureDockCapacity(task.title || 'Untitled task')) return false;

    const sourceProjectId = this.taskSync.resolveTaskProjectId(taskId);
    const zoneSource: DockZoneSource = options?.zoneSource ?? (lane ? 'manual' : 'auto');
    const inferredRelation = lane
      ? {
          lane,
          relationScore: lane === 'combo-select' ? PARKING_CONFIG.ZONE_MANUAL_COMBO_SCORE : PARKING_CONFIG.ZONE_MANUAL_BACKUP_SCORE,
          relationReason: lane === 'combo-select' ? 'manual:combo-select' : 'manual:backup',
        }
      : this.zoneService.inferAutoLaneForTask(task, sourceProjectId, taskId);
    const inheritedLoad: CognitiveLoad = task.cognitive_load === 'high' ? 'high' : 'low';
    const plannerFields = sanitizePlannerFields({
      expectedMinutes: options?.expectedMinutes ?? task.expected_minutes,
      waitMinutes: options?.waitMinutes ?? task.wait_minutes,
      cognitiveLoad: options?.load ?? task.cognitive_load,
    });
    const entry = buildDockEntry({
      taskId,
      title: task.title || 'Untitled task',
      content: task.content ?? null,
      sourceProjectId,
      currentEntryCount: this.ctx.entries().length,
      lane: inferredRelation.lane,
      zoneSource,
      relationScore: inferredRelation.relationScore,
      relationReason: inferredRelation.relationReason,
      plannerFields,
      inheritedLoad,
      muteWaitTone: this.ctx.muteWaitTone(),
      options: {
        sourceKind: options?.sourceKind,
        sourceSection: options?.sourceSection,
        detail: options?.detail,
      },
    });

    if (plannerFields.adjusted) {
      this.toast.info(DOCK_TOAST.WAIT_CORRECTION_TITLE, DOCK_TOAST.waitCorrectionBody(plannerFields.expectedMinutes ?? 0));
    }

    this.ctx.entries.update(prev => [...prev, entry]);
    this.ctx.rebalanceAutoZones();
    this.taskSync.syncTaskPlannerFields(taskId, {
      expected_minutes: entry.expectedMinutes,
      cognitive_load: entry.load,
      wait_minutes: entry.waitMinutes,
    });

    if (!this.ctx.firstDragIntervened()) {
      this.setMainTask(taskId);
      this.ctx.firstDragIntervened.set(true);
    }
    return true;
  }

  /**
   * 统一外部拖拽入坞策略：
   * 文本/流程图拖拽默认进入备选区（backup），并视为手动分区。
   */
  dockTaskFromExternalDrag(taskId: string, sourceSection?: Extract<DockSourceSection, 'text' | 'flow'>): boolean {
    return this.dockTask(taskId, 'backup', {
      sourceSection,
      zoneSource: 'manual',
    });
  }

  setMainTask(taskId: string): void {
    if (this.ctx.focusMode()) {
      const alreadyInCommandCenter = this.ctx.consoleVisibleEntries()
        .some(entry => entry.taskId === taskId);
      if (alreadyInCommandCenter) {
        this.ctx.switchToTask(taskId);
      } else {
        this.insertToConsoleFromRadar(taskId);
      }
      return;
    }

    this.ctx.entries.update(prev =>
      prev.map(entry =>
        entry.taskId === taskId
          ? { ...entry, isMain: true, systemSelected: false, manualMainSelected: true }
          : { ...entry, isMain: false },
      ),
    );
    this.promotionService.clearPendingDecisionIfMatched(taskId);
    this.ctx.rebalanceAutoZones();
  }

  /**
   * 从雷达区（备选/组合选择）点选任务插入到主控台 C 位。
   * 不改变主任务标记（isMain），仅切换 focusing 状态。
   * 超出 CONSOLE_STACK_VISIBLE_MAX 的末尾卡片回到备选区。
   * 主任务不可被淘汰——如果溢出位是主任务，则淘汰其前一张非主任务卡片。
   *
   * @returns 被淘汰回备选区的 taskId，null 表示无淘汰
   */
  insertToConsoleFromRadar(taskId: string): string | null {
    this.fragmentRest.stopFragmentEntryCountdown();
    this.fragmentRest.setFragmentDismissed(false);

    const target = this.ctx.entries().find(e => e.taskId === taskId && e.status !== 'completed');
    if (!target) return null;

    const currentFocusId = this.ctx.focusingEntry()?.taskId ?? null;
    const preVisible = this.ctx.consoleVisibleEntries();
    let evictedTaskId: string | null = null;

    // 点击背景任务时，以"切换前可见 4 卡"决定淘汰对象。
    // 这样可以保证：
    // 1. 旧 C 位稳定后推到第二张
    // 2. 主任务永不被退回备选区
    // 3. 动画窗口内不会临时出现第 5 张卡
    if (preVisible.length >= PARKING_CONFIG.CONSOLE_STACK_VISIBLE_MAX) {
      evictedTaskId = findConsoleEvictionCandidate(preVisible, currentFocusId);
    }

    this.applyRadarInsertEntries(taskId, currentFocusId);
    this.ctx.consoleVisibleOrderHint.set(
      buildConsoleVisibleOrderHint(preVisible, taskId, evictedTaskId),
    );

    // 设置协调信号：inserted 供 console-stack 触发 C 位入场动画，
    // evictedTaskId 由动画结束后 flushRadarEviction() 执行。
    this.ctx.lastRadarInsertedTaskId.set(taskId);
    this.ctx.pendingRadarEviction.set(evictedTaskId);

    // 安全超时：如果动画未在窗口期内调用 flushRadarEviction，强制清除
    if (evictedTaskId) {
      this.radarEvictionTimeout.schedule(() => {
        if (this.ctx.pendingRadarEviction() === evictedTaskId) {
          this.flushRadarEviction(evictedTaskId);
        }
      }, PARKING_CONFIG.DOCK_ANIMATION_MS * 3);
    }

    this.promotionService.clearPendingDecisionIfMatched(taskId);
    this.lifecycle.scheduleSwitchMaintenance();
    return evictedTaskId;
  }

  /** 雷达区插入时的 entries 状态更新：target → focusing，原焦点 → stalled */
  private applyRadarInsertEntries(taskId: string, currentFocusId: string | null): void {
    this.ctx.entries.update(prev =>
      prev.map(entry => {
        if (entry.taskId === taskId) {
          return {
            ...entry,
            lane: 'combo-select',
            status: 'focusing',
            waitMinutes: null,
            waitStartedAt: null,
            systemSelected: false,
            recommendationLocked: false,
          };
        }
        if (currentFocusId && entry.taskId === currentFocusId) {
          return { ...entry, status: 'stalled' };
        }
        return entry;
      }),
    );
    if (currentFocusId && currentFocusId !== taskId) {
      this.ctx.lastConsoleDemotedTaskId.set(currentFocusId);
    }
  }

  /**
   * Phase 2: 将指定任务从主控台淘汰回备选区。
   * 由 console-stack 组件在动画窗口结束时调用，确保 DOM 退出过渡已完成。
   * 完成后设置 lastRadarEvictedTaskId 信号，触发雷达区返回入场动画。
   */
  flushRadarEviction(taskId: string): void {
    this.radarEvictionTimeout.cancel();
    const entry = this.ctx.entries().find(e => e.taskId === taskId);
    if (!entry) return;
    // 安全检查：只淘汰仍在 console 中且非 focusing/主任务的卡片
    if (entry.status === 'focusing' || entry.isMain) return;
    this.ctx.entries.update(prev =>
      patchEntryByTaskId(prev, taskId, {
        status: 'pending_start',
        lane: 'backup',
        zoneSource: 'auto',
        relationReason: 'auto:evicted-from-console',
      }),
    );
    this.ctx.pendingRadarEviction.set(null);
    // 淘汰实际生效后触发雷达区返回入场动画
    this.ctx.lastRadarEvictedTaskId.set(taskId);
  }

  overrideFirstMainTask(taskId: string): void {
    const pending = this.ctx.firstMainSelectionWindow();
    if (!pending) {
      this.setMainTask(taskId);
      return;
    }
    const exists = this.ctx.entries().some(entry => entry.taskId === taskId && entry.status !== 'completed');
    if (!exists) return;
    if (!this.ctx.focusMode()) {
      this.setMainTask(taskId);
      this.ctx.clearFirstMainSelectionWindow();
      return;
    }

    const currentFocusId = this.ctx.focusingEntry()?.taskId ?? null;
    this.ctx.entries.update(prev =>
      prev.map(entry => {
        if (entry.taskId === taskId) {
          const promoted: DockEntry = {
            ...entry,
            isMain: true,
            status: 'focusing',
            waitMinutes: null,
            waitStartedAt: null,
            systemSelected: false,
            recommendationLocked: false,
            manualMainSelected: true,
          };
          return promoted;
        }
        if (entry.taskId === currentFocusId) {
          return {
            ...entry,
            isMain: false,
            status: this.completionFlow.deriveBackgroundStatus(entry),
            systemSelected: false,
            recommendationLocked: false,
          };
        }
        return entry.isMain
          ? { ...entry, isMain: false }
          : entry;
      }),
    );
    if (currentFocusId && currentFocusId !== taskId) {
      this.ctx.lastConsoleDemotedTaskId.set(currentFocusId);
    }
    this.ctx.clearFirstMainSelectionWindow();
  }

  clearDockForExit(): void {
    this.ctx.entries.set([]);
    this.ctx.highlightedIds.set(new Set());
    this.ctx.suspendRecommendationLocked.set(false);
    this.ctx.suspendChainRootTaskId.set(null);
    this.ctx.waitEndNotifiedIds.clear();
    this.ctx.firstDragIntervened.set(false);
    this.ctx.clearFirstMainSelectionWindow();
    this.ctx.pendingRadarEviction.set(null);
    this.ctx.lastConsoleDemotedTaskId.set(null);
    this.ctx.consoleVisibleOrderHint.set([]);
  }

  reorderDockEntries(sourceTaskId: string, targetTaskId: string): void {
    if (!sourceTaskId || !targetTaskId || sourceTaskId === targetTaskId) return;

    this.ctx.entries.update(prev => {
      const activeEntries = prev.filter(entry => entry.status !== 'completed');
      const sourceIndex = activeEntries.findIndex(entry => entry.taskId === sourceTaskId);
      const targetIndex = activeEntries.findIndex(entry => entry.taskId === targetTaskId);
      if (sourceIndex < 0 || targetIndex < 0) return prev;

      const reordered = [...activeEntries];
      const [moved] = reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, moved);

      const orderByTaskId = new Map<string, number>();
      reordered.forEach((entry, index) => {
        orderByTaskId.set(entry.taskId, index);
      });

      // completed entries 保留原样但 dockedOrder 推到尾部，避免与 active 序号冲突
      const completedBaseOrder = reordered.length;
      let completedOffset = 0;
      let changed = false;
      const next = prev.map(entry => {
        const nextOrder = orderByTaskId.get(entry.taskId);
        if (nextOrder !== undefined) {
          if (entry.dockedOrder === nextOrder && entry.manualOrder === nextOrder) return entry;
          changed = true;
          return { ...entry, dockedOrder: nextOrder, manualOrder: nextOrder };
        }
        // completed 或非活跃 entry：序号推到活跃 entries 之后
        const tailOrder = completedBaseOrder + completedOffset++;
        if (entry.dockedOrder === tailOrder) return entry;
        changed = true;
        return { ...entry, dockedOrder: tailOrder };
      });
      return changed ? next : prev;
    });
  }

  toggleMuteWaitTone(): void {
    const next = !this.ctx.muteWaitTone();
    this.ctx.muteWaitTone.set(next);
    this.ctx.entries.update(prev => patchAllEntries(prev, { snoozeRingMuted: next }));
  }

  setDockExpanded(expanded: boolean): void {
    this.ctx.dockExpanded.set(expanded);
  }

  /**
   * 外部完成状态调和：一次性快照 entries，过滤后批量入队。
   * 避免循环内反复读取 entries() 导致与异步 drainCompletionQueue 产生竞态。
   */
  reconcileExternallyCompletedTasks(taskIds: string[]): void {
    const currentEntries = this.ctx.entries();
    const entryMap = new Map(currentEntries.map(item => [item.taskId, item]));
    for (const taskId of taskIds) {
      const entry = entryMap.get(taskId);
      const task = this.taskStore.getTask(taskId);
      if (!entry || entry.status === 'completed' || task?.status !== 'completed') continue;
      this.ctx.completeTask(taskId);
    }
  }
}
