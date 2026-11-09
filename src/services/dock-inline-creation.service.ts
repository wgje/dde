/**
 * DockInlineCreationService
 * 从 DockEngineService 中提取的内联创建与归档逻辑。
 * 负责：停泊坞内联任务创建、容量检查、归档候选筛选、
 * 归档到活跃项目、任务 ID 重写等。
 */
import { Injectable, Injector, Signal, WritableSignal, inject } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';
import { DOCK_TOAST } from '../config/dock-i18n.config';
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

type InlineCreateOptions = {
  expectedMinutes?: number | null;
  waitMinutes?: number | null;
  detail?: string;
};

type InlineCreateDraft = {
  taskId: string;
  title: string;
  detail: string;
  lane: DockLane;
  load: CognitiveLoad;
  plannerFields: ReturnType<typeof sanitizePlannerFields>;
};

type InlineBlackBoxCreateResult = {
  sourceBlackBoxEntryId: string | null;
  inlineArchiveStatus: DockEntry['inlineArchiveStatus'];
};

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
  private readonly injector = inject(Injector);
  private readonly blackBoxService = inject(BlackBoxService);
  private readonly logger = inject(LoggerService).category('DockInlineCreation');
  private readonly toast = inject(ToastService);
  private readonly projectState = inject(ProjectStateService);

  private _ctx: DockInlineCreationContext | null = null;

  private get taskOps(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }

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

  async createInDock(
    title: string,
    lane: DockLane,
    load: CognitiveLoad = 'low',
    options?: InlineCreateOptions,
  ): Promise<string | null> {
    const normalizedTitle = title.trim() || 'Untitled task';
    if (!this.ensureDockCapacity(normalizedTitle)) return null;

    const draft = this.createInlineDraft(normalizedTitle, lane, load, options);
    const blackBoxResult = await this.createInlineBlackBoxEntry(draft);
    if (!blackBoxResult.sourceBlackBoxEntryId) {
      return null;
    }
    const entry = this.createDockEntryDraft(draft, blackBoxResult);
    this.notifyPlannerCorrectionIfNeeded(draft);
    this.ctx.entries.update(prev => [...prev, entry]);
    this.promoteFirstInlineEntryIfNeeded(draft.taskId);
    return draft.taskId;
  }

  private createInlineDraft(
    normalizedTitle: string,
    lane: DockLane,
    load: CognitiveLoad,
    options?: InlineCreateOptions
  ): InlineCreateDraft {
    return {
      taskId: crypto.randomUUID(),
      title: normalizedTitle,
      detail: options?.detail?.trim() ?? '',
      lane,
      load,
      plannerFields: sanitizePlannerFields({
        expectedMinutes: options?.expectedMinutes,
        waitMinutes: options?.waitMinutes,
        cognitiveLoad: load,
      }),
    };
  }

  private async createInlineBlackBoxEntry(draft: InlineCreateDraft): Promise<InlineBlackBoxCreateResult> {
    const focusMeta: BlackBoxFocusMeta = {
      source: 'focus-console-inline',
      sessionId: this.ctx.focusSessionContext()?.id ?? crypto.randomUUID(),
      title: draft.title,
      detail: draft.detail.length > 0 ? draft.detail : null,
      lane: draft.lane,
      expectedMinutes: draft.plannerFields.expectedMinutes,
      waitMinutes: draft.plannerFields.waitMinutes,
      cognitiveLoad: draft.plannerFields.cognitiveLoad ?? draft.load,
      dockEntryId: draft.taskId,
    };
    const blackBoxCreate = await this.blackBoxService.createDurably({
      projectId: null,
      content: draft.detail.length > 0 ? draft.detail : draft.title,
      focusMeta,
    });
    if (!blackBoxCreate.ok) {
      this.logger.warn('Inline dock creation persisted locally but black-box create failed', {
        dockEntryId: draft.taskId,
        message: blackBoxCreate.error.message,
      });
    }

    return {
      sourceBlackBoxEntryId: blackBoxCreate.ok ? blackBoxCreate.value.id : null,
      inlineArchiveStatus: blackBoxCreate.ok ? 'pending' : 'failed',
    };
  }

  private createDockEntryDraft(
    draft: InlineCreateDraft,
    blackBoxResult: InlineBlackBoxCreateResult
  ): DockEntry {
    return {
      taskId: draft.taskId,
      title: draft.title,
      sourceProjectId: null,
      status: 'pending_start',
      load: draft.plannerFields.cognitiveLoad ?? draft.load,
      expectedMinutes: draft.plannerFields.expectedMinutes,
      waitMinutes: draft.plannerFields.waitMinutes,
      waitStartedAt: null,
      lane: draft.lane,
      zoneSource: 'manual',
      isMain: false,
      dockedOrder: this.ctx.entries().length,
      detail: draft.detail,
      sourceKind: 'dock-created',
      sourceBlackBoxEntryId: blackBoxResult.sourceBlackBoxEntryId,
      inlineArchiveStatus: blackBoxResult.inlineArchiveStatus,
      inlineArchivedTaskId: null,
      systemSelected: false,
      recommendedScore: null,
      sourceSection: 'dock-create',
      manualMainSelected: false,
      recommendationLocked: false,
      snoozeRingMuted: this.ctx.muteWaitTone(),
      relationScore: draft.lane === 'combo-select'
        ? PARKING_CONFIG.ZONE_MANUAL_COMBO_SCORE
        : PARKING_CONFIG.ZONE_MANUAL_BACKUP_SCORE,
      relationReason: draft.lane === 'combo-select' ? 'manual:create-combo-select' : 'manual:create-backup',
    };
  }

  private notifyPlannerCorrectionIfNeeded(draft: InlineCreateDraft): void {
    if (draft.plannerFields.adjusted) {
      this.toast.info(
        DOCK_TOAST.WAIT_CORRECTION_TITLE,
        DOCK_TOAST.waitCorrectionBody(draft.plannerFields.expectedMinutes ?? 0)
      );
    }
  }

  private promoteFirstInlineEntryIfNeeded(taskId: string): void {
    if (!this.ctx.firstDragIntervened()) {
      this.ctx.setMainTask(taskId);
      this.ctx.firstDragIntervened.set(true);
    }
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
        DOCK_TOAST.DOCK_FULL_TITLE,
        DOCK_TOAST.dockFullBody(hardLimit, entryTitle),
      );
      return false;
    }
    if (count + 1 >= softLimit && !this.ctx.softLimitNoticeShown()) {
      this.toast.info(
        DOCK_TOAST.DOCK_NEAR_LIMIT_TITLE,
        DOCK_TOAST.dockNearLimitBody(softLimit),
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

  async archiveInlineEntriesToActiveProject(): Promise<{ converted: number; failed: number }> {
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
      const archived = await this.replaceInlineEntryWithProjectTask(entry, activeProjectId);
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

  private async replaceInlineEntryWithProjectTask(entry: DockEntry, activeProjectId: string): Promise<boolean> {
    const blackBoxEntryId = await this.ensureArchiveBlackBoxEntry(entry);
    if (!blackBoxEntryId) return false;

    const newTaskId = await this.createArchivedProjectTask(entry, activeProjectId);
    if (!newTaskId) return false;

    if (entry.status === 'completed') {
      const completed = await this.completeArchivedProjectTask(entry, newTaskId, blackBoxEntryId);
      if (!completed) return false;
    }

    await this.archiveSourceBlackBoxEntry(entry, blackBoxEntryId);
    this.rewriteArchivedDockEntry(entry, newTaskId, activeProjectId, blackBoxEntryId);
    this.rewriteDockReferences(entry.taskId, newTaskId);
    return true;
  }

  private async ensureArchiveBlackBoxEntry(entry: DockEntry): Promise<string | null> {
    const blackBoxEntryId = entry.sourceBlackBoxEntryId ?? null;
    if (blackBoxEntryId) {
      this.setInlineArchiveStatus(entry.taskId, 'archiving');
      return blackBoxEntryId;
    }

    const rebuildResult = await this.blackBoxService.createDurably({
      projectId: null,
      content: entry.detail?.trim() ? entry.detail : entry.title,
      focusMeta: this.createArchiveFocusMeta(entry),
    });

    if (!rebuildResult.ok) {
      this.setInlineArchiveStatus(entry.taskId, 'failed');
      this.logger.warn('Inline archive failed: cannot rebuild source black-box entry', {
        dockEntryId: entry.taskId,
        message: rebuildResult.error.message,
      });
      return null;
    }

    this.ctx.entries.update(prev =>
      prev.map(item =>
        item.taskId === entry.taskId
          ? {
              ...item,
              sourceBlackBoxEntryId: rebuildResult.value.id,
              inlineArchiveStatus: 'archiving',
            }
          : item,
      ),
    );
    return rebuildResult.value.id;
  }

  private createArchiveFocusMeta(entry: DockEntry): BlackBoxFocusMeta {
    return {
      source: 'focus-console-inline',
      sessionId: this.ctx.focusSessionContext()?.id ?? crypto.randomUUID(),
      title: entry.title,
      detail: entry.detail?.trim() ? entry.detail : null,
      lane: entry.lane,
      expectedMinutes: normalizeNullableNumber(entry.expectedMinutes),
      waitMinutes: normalizeNullableNumber(entry.waitMinutes),
      cognitiveLoad: entry.load,
      dockEntryId: entry.taskId,
    };
  }

  private async createArchivedProjectTask(entry: DockEntry, activeProjectId: string): Promise<string | null> {
    const createResult = await this.taskOps.addTask(entry.title, entry.detail ?? '', null, null, false);
    if (!createResult.ok) {
      this.setInlineArchiveStatus(entry.taskId, 'failed');
      this.logger.warn('Inline archive failed: cannot create project task', {
        dockEntryId: entry.taskId,
        projectId: activeProjectId,
        message: createResult.error.message,
      });
      return null;
    }

    const newTaskId = createResult.value;
    const plannerSaved = await this.persistArchivedTaskPlannerFields(entry, newTaskId, activeProjectId);
    if (!plannerSaved) {
      return null;
    }
    return newTaskId;
  }

  private async completeArchivedProjectTask(
    entry: DockEntry,
    newTaskId: string,
    blackBoxEntryId: string
  ): Promise<boolean> {
    const statusSaved = await this.taskOps.updateTaskStatus(newTaskId, 'completed');
    if (!statusSaved) {
      this.setInlineArchiveStatus(entry.taskId, 'failed');
      this.logger.warn('Inline archive failed: cannot mark created project task completed', {
        dockEntryId: entry.taskId,
        newTaskId,
        blackBoxEntryId,
      });
      return false;
    }

    const completedResult = await this.blackBoxService.markAsCompletedDurably(blackBoxEntryId);
    if (!completedResult.ok) {
      this.logger.warn('Inline archive warning: failed to mark source black-box entry completed', {
        dockEntryId: entry.taskId,
        blackBoxEntryId,
        message: completedResult.error.message,
      });
    }
    return true;
  }

  private async persistArchivedTaskPlannerFields(
    entry: DockEntry,
    newTaskId: string,
    activeProjectId: string,
  ): Promise<boolean> {
    const expectedSaved = await this.taskOps.updateTaskExpectedMinutes(
      newTaskId,
      normalizeNullableNumber(entry.expectedMinutes),
    );
    const loadSaved = await this.taskOps.updateTaskCognitiveLoad(newTaskId, entry.load);
    const waitSaved = await this.taskOps.updateTaskWaitMinutes(
      newTaskId,
      normalizeNullableNumber(entry.waitMinutes),
    );

    if (expectedSaved && loadSaved && waitSaved) {
      return true;
    }

    this.setInlineArchiveStatus(entry.taskId, 'failed');
    this.logger.warn('Inline archive failed: cannot persist created project task planner fields', {
      dockEntryId: entry.taskId,
      projectId: activeProjectId,
      newTaskId,
      expectedSaved,
      loadSaved,
      waitSaved,
    });
    return false;
  }

  private async archiveSourceBlackBoxEntry(entry: DockEntry, blackBoxEntryId: string): Promise<void> {
    const archiveResult = await this.blackBoxService.archiveDurably(blackBoxEntryId);
    if (!archiveResult.ok) {
      this.logger.warn('Inline archive warning: failed to archive source black-box entry', {
        dockEntryId: entry.taskId,
        blackBoxEntryId,
        message: archiveResult.error.message,
      });
    }
  }

  private setInlineArchiveStatus(
    taskId: string,
    inlineArchiveStatus: DockEntry['inlineArchiveStatus']
  ): void {
    this.ctx.entries.update(prev =>
      prev.map(item =>
        item.taskId === taskId
          ? { ...item, inlineArchiveStatus }
          : item,
      ),
    );
  }

  private rewriteArchivedDockEntry(
    entry: DockEntry,
    newTaskId: string,
    activeProjectId: string,
    blackBoxEntryId: string
  ): void {
    this.ctx.entries.update(prev =>
      prev.map(item =>
        item.taskId === entry.taskId
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
