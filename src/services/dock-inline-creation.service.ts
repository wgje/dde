/**
 * DockInlineCreationService
 * 从 DockEngineService 中提取的内联创建与归档逻辑。
 * 负责：停泊坞内联任务创建、容量检查、归档候选筛选、
 * 归档到活跃项目、任务 ID 重写等。
 */
import { Injectable, Signal, WritableSignal, inject } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';
import {
  CognitiveLoad,
  DockEntry,
  DockLane,
  DockPendingDecision,
} from '../models/parking-dock';
import { BlackBoxFocusMeta } from '../models/focus';
import { sanitizePlannerFields } from '../utils/planner-fields';
import { normalizeNullableNumber } from './dock-snapshot-persistence.service';
import { BlackBoxService } from './black-box.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { ProjectStateService } from './project-state.service';

// ---------------------------------------------------------------------------
//  Context interface — engine 在 constructor 中调用 init() 注入信号引用
// ---------------------------------------------------------------------------

export interface DockInlineCreationContext {
  entries: WritableSignal<DockEntry[]>;
  dockedCount: Signal<number>;
  focusSessionContext: Signal<{ id: string; startedAt: number } | null>;
  softLimitNoticeShown: WritableSignal<boolean>;
  muteWaitTone: Signal<boolean>;
  firstDragIntervened: WritableSignal<boolean>;
  firstMainSelectionWindow: WritableSignal<{ taskId: string; expiresAt: number } | null>;
  suspendChainRootTaskId: WritableSignal<string | null>;
  pendingDecision: WritableSignal<DockPendingDecision | null>;
  highlightedIds: WritableSignal<Set<string>>;
  waitEndNotifiedIds: Set<string>;
  setMainTask: (taskId: string) => void;
  rebalanceAutoZones: () => void;
}

@Injectable({
  providedIn: 'root',
})
export class DockInlineCreationService {
  private readonly blackBoxService = inject(BlackBoxService);
  private readonly logger = inject(LoggerService).category('DockInlineCreation');
  private readonly toast = inject(ToastService);
  private readonly taskOps = inject(TaskOperationAdapterService);
  private readonly projectState = inject(ProjectStateService);

  private _ctx: DockInlineCreationContext | null = null;

  /**
   * 获取上下文——必须在 DockEngineService 构造期间调用 init() 注入。
   * 如未初始化则抛出明确错误，便于定位 DI 顺序问题。
   */
  private get ctx(): DockInlineCreationContext {
    if (!this._ctx) {
      throw new Error(
        'DockInlineCreationService.init() must be called before use. ' +
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
  init(ctx: DockInlineCreationContext): void {
    if (this._ctx) {
      this.logger.warn('init() called again — overwriting previous context');
    }
    this._ctx = ctx;
  }

  // ---------------------------------------------------------------------------
  //  内联创建
  // ---------------------------------------------------------------------------

  createInDock(
    title: string,
    lane: DockLane,
    load: CognitiveLoad = 'low',
    options?: { expectedMinutes?: number | null; waitMinutes?: number | null; detail?: string },
  ): string | null {
    const taskId = crypto.randomUUID();
    const normalizedTitle = title.trim() || 'Untitled task';
    if (!this.ensureDockCapacity(normalizedTitle)) return null;
    const normalizedDetail = options?.detail?.trim() ?? '';
    const plannerFields = sanitizePlannerFields({
      expectedMinutes: options?.expectedMinutes,
      waitMinutes: options?.waitMinutes,
      cognitiveLoad: load,
    });
    const focusMeta: BlackBoxFocusMeta = {
      source: 'focus-console-inline',
      sessionId: this.ctx.focusSessionContext()?.id ?? crypto.randomUUID(),
      title: normalizedTitle,
      detail: normalizedDetail.length > 0 ? normalizedDetail : null,
      lane,
      expectedMinutes: plannerFields.expectedMinutes,
      waitMinutes: plannerFields.waitMinutes,
      cognitiveLoad: plannerFields.cognitiveLoad ?? load,
      dockEntryId: taskId,
    };

    const blackBoxCreate = this.blackBoxService.create({
      projectId: null,
      content: normalizedDetail.length > 0 ? normalizedDetail : normalizedTitle,
      focusMeta,
    });
    const sourceBlackBoxEntryId = blackBoxCreate.ok ? blackBoxCreate.value.id : null;
    const inlineArchiveStatus: DockEntry['inlineArchiveStatus'] = blackBoxCreate.ok ? 'pending' : 'failed';
    if (!blackBoxCreate.ok) {
      this.logger.warn('Inline dock creation persisted locally but black-box create failed', {
        dockEntryId: taskId,
        message: blackBoxCreate.error.message,
      });
    }

    const entry: DockEntry = {
      taskId,
      title: normalizedTitle,
      sourceProjectId: null,
      status: 'pending_start',
      load: plannerFields.cognitiveLoad ?? load,
      expectedMinutes: plannerFields.expectedMinutes,
      waitMinutes: plannerFields.waitMinutes,
      waitStartedAt: null,
      lane,
      zoneSource: 'manual',
      isMain: false,
      dockedOrder: this.ctx.entries().length,
      detail: normalizedDetail,
      sourceKind: 'dock-created',
      sourceBlackBoxEntryId,
      inlineArchiveStatus,
      inlineArchivedTaskId: null,
      systemSelected: false,
      recommendedScore: null,
      sourceSection: 'dock-create',
      manualMainSelected: false,
      recommendationLocked: false,
      snoozeRingMuted: this.ctx.muteWaitTone(),
      relationScore: lane === 'combo-select' ? 100 : 20,
      relationReason: lane === 'combo-select' ? 'manual:create-combo-select' : 'manual:create-backup',
    };
    if (plannerFields.adjusted) {
      this.toast.info('已校正等待/预计时长', `等待时长不能超过预计时长，已同步调整为 ${plannerFields.expectedMinutes ?? 0} 分钟`);
    }
    this.ctx.entries.update(prev => [...prev, entry]);
    if (!this.ctx.firstDragIntervened()) {
      this.ctx.setMainTask(taskId);
      this.ctx.firstDragIntervened.set(true);
    }
    return taskId;
  }

  // ---------------------------------------------------------------------------
  //  容量检查（engine 其他方法也需要调用，因此为非 private）
  // ---------------------------------------------------------------------------

  ensureDockCapacity(entryTitle: string): boolean {
    const count = this.ctx.dockedCount();
    const softLimit = PARKING_CONFIG.DOCK_CONSOLE_SOFT_LIMIT;
    const hardLimit = PARKING_CONFIG.DOCK_CONSOLE_HARD_LIMIT;
    if (count >= hardLimit) {
      this.toast.warning(
        '停泊坞已满',
        `最多可保留 ${hardLimit} 个任务，请先移除部分任务后再添加「${entryTitle}」。`,
      );
      return false;
    }
    if (count + 1 >= softLimit && !this.ctx.softLimitNoticeShown()) {
      this.toast.info(
        '停泊坞接近上限',
        `建议将入坞任务控制在 ${softLimit} 个以内，以保持专注控制台清晰。`,
      );
      this.ctx.softLimitNoticeShown.set(true);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  //  归档候选与归档流程
  // ---------------------------------------------------------------------------

  getInlineArchiveCandidates(): DockEntry[] {
    return this.ctx.entries().filter(entry => entry.sourceKind === 'dock-created');
  }

  archiveInlineEntriesToActiveProject(): { converted: number; failed: number } {
    const candidates = this.getInlineArchiveCandidates();
    if (candidates.length === 0) {
      return { converted: 0, failed: 0 };
    }

    const activeProjectId = this.projectState.activeProjectId();
    if (!activeProjectId) {
      const candidateIds = new Set(candidates.map(entry => entry.taskId));
      this.ctx.entries.update(prev =>
        prev.map(entry =>
          candidateIds.has(entry.taskId)
            ? { ...entry, inlineArchiveStatus: 'failed' }
            : entry,
        ),
      );
      this.logger.warn('Inline archive skipped because no active project');
      return { converted: 0, failed: candidates.length };
    }

    let converted = 0;
    let failed = 0;

    for (const entry of candidates) {
      const archived = this.replaceInlineEntryWithProjectTask(entry, activeProjectId);
      if (archived) {
        converted += 1;
      } else {
        failed += 1;
      }
    }

    if (converted > 0) {
      this.ctx.rebalanceAutoZones();
    }
    return { converted, failed };
  }

  // ---------------------------------------------------------------------------
  //  内部：替换内联条目为项目任务
  // ---------------------------------------------------------------------------

  private replaceInlineEntryWithProjectTask(entry: DockEntry, activeProjectId: string): boolean {
    let blackBoxEntryId = entry.sourceBlackBoxEntryId ?? null;
    if (!blackBoxEntryId) {
      const rebuildResult = this.blackBoxService.create({
        projectId: null,
        content: entry.detail?.trim() ? entry.detail : entry.title,
        focusMeta: {
          source: 'focus-console-inline',
          sessionId: this.ctx.focusSessionContext()?.id ?? crypto.randomUUID(),
          title: entry.title,
          detail: entry.detail?.trim() ? entry.detail : null,
          lane: entry.lane,
          expectedMinutes: normalizeNullableNumber(entry.expectedMinutes),
          waitMinutes: normalizeNullableNumber(entry.waitMinutes),
          cognitiveLoad: entry.load,
          dockEntryId: entry.taskId,
        },
      });

      if (!rebuildResult.ok) {
        this.ctx.entries.update(prev =>
          prev.map(item =>
            item.taskId === entry.taskId
              ? { ...item, inlineArchiveStatus: 'failed' }
              : item,
          ),
        );
        this.logger.warn('Inline archive failed: cannot rebuild source black-box entry', {
          dockEntryId: entry.taskId,
          message: rebuildResult.error.message,
        });
        return false;
      }

      blackBoxEntryId = rebuildResult.value.id;
      this.ctx.entries.update(prev =>
        prev.map(item =>
          item.taskId === entry.taskId
            ? {
                ...item,
                sourceBlackBoxEntryId: blackBoxEntryId,
                inlineArchiveStatus: 'pending',
              }
            : item,
        ),
      );
    }

    this.ctx.entries.update(prev =>
      prev.map(item =>
        item.taskId === entry.taskId
          ? { ...item, inlineArchiveStatus: 'archiving' }
          : item,
      ),
    );

    const createResult = this.taskOps.addTask(entry.title, entry.detail ?? '', null, null, false);
    if (!createResult.ok) {
      this.ctx.entries.update(prev =>
        prev.map(item =>
          item.taskId === entry.taskId
            ? { ...item, inlineArchiveStatus: 'failed' }
            : item,
        ),
      );
      this.logger.warn('Inline archive failed: cannot create project task', {
        dockEntryId: entry.taskId,
        projectId: activeProjectId,
        message: createResult.error.message,
      });
      return false;
    }

    const newTaskId = createResult.value;
    this.taskOps.updateTaskExpectedMinutes(newTaskId, normalizeNullableNumber(entry.expectedMinutes));
    this.taskOps.updateTaskCognitiveLoad(newTaskId, entry.load);
    this.taskOps.updateTaskWaitMinutes(newTaskId, normalizeNullableNumber(entry.waitMinutes));

    if (entry.status === 'completed') {
      this.taskOps.updateTaskStatus(newTaskId, 'completed');
      const completedResult = this.blackBoxService.markAsCompleted(blackBoxEntryId);
      if (!completedResult.ok) {
        this.logger.warn('Inline archive warning: failed to mark source black-box entry completed', {
          dockEntryId: entry.taskId,
          blackBoxEntryId,
          message: completedResult.error.message,
        });
      }
    }

    const archiveResult = this.blackBoxService.archive(blackBoxEntryId);
    if (!archiveResult.ok) {
      this.logger.warn('Inline archive warning: failed to archive source black-box entry', {
        dockEntryId: entry.taskId,
        blackBoxEntryId,
        message: archiveResult.error.message,
      });
    }

    const oldTaskId = entry.taskId;
    this.ctx.entries.update(prev =>
      prev.map(item =>
        item.taskId === oldTaskId
          ? {
              ...item,
              taskId: newTaskId,
              sourceKind: 'project-task',
              sourceProjectId: activeProjectId,
              sourceBlackBoxEntryId: blackBoxEntryId,
              inlineArchiveStatus: 'archived',
              inlineArchivedTaskId: newTaskId,
            }
          : item,
      ),
    );

    this.rewriteDockReferences(oldTaskId, newTaskId);
    return true;
  }

  // ---------------------------------------------------------------------------
  //  内部：重写停泊坞中旧 taskId 引用
  // ---------------------------------------------------------------------------

  private rewriteDockReferences(oldTaskId: string, newTaskId: string): void {
    if (!oldTaskId || oldTaskId === newTaskId) return;

    const pendingWindow = this.ctx.firstMainSelectionWindow();
    if (pendingWindow?.taskId === oldTaskId) {
      this.ctx.firstMainSelectionWindow.set({
        ...pendingWindow,
        taskId: newTaskId,
      });
    }

    if (this.ctx.suspendChainRootTaskId() === oldTaskId) {
      this.ctx.suspendChainRootTaskId.set(newTaskId);
    }

    const pending = this.ctx.pendingDecision();
    if (pending) {
      let touched = false;
      const rootTaskId = pending.rootTaskId === oldTaskId ? newTaskId : pending.rootTaskId;
      if (rootTaskId !== pending.rootTaskId) touched = true;
      const candidateGroups = pending.candidateGroups.map(group => {
        const taskIds = group.taskIds.map(taskId => (taskId === oldTaskId ? newTaskId : taskId));
        if (!touched && taskIds.some((taskId, index) => taskId !== group.taskIds[index])) {
          touched = true;
        }
        return { ...group, taskIds };
      });
      if (touched) {
        this.ctx.pendingDecision.set({
          ...pending,
          rootTaskId,
          candidateGroups,
        });
      }
    }

    const highlighted = this.ctx.highlightedIds();
    if (highlighted.has(oldTaskId)) {
      const next = new Set(highlighted);
      next.delete(oldTaskId);
      next.add(newTaskId);
      this.ctx.highlightedIds.set(next);
    }

    if (this.ctx.waitEndNotifiedIds.has(oldTaskId)) {
      this.ctx.waitEndNotifiedIds.delete(oldTaskId);
      this.ctx.waitEndNotifiedIds.add(newTaskId);
    }
  }
}
