/**
 * DockEntryFieldService
 * 从 DockEngineService 提取的 entry 字段修改逻辑：
 * 认知负荷切换、预计时长、等待时长、详情文本、lane 设置。
 */
import { Injectable, WritableSignal, inject } from '@angular/core';
import {
  CognitiveLoad,
  DockEntry,
  DockLane,
  DockZoneSource,
} from '../models/parking-dock';
import { sanitizePlannerFields } from '../utils/planner-fields';
import { DockTaskSyncService } from './dock-task-sync.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';

// ---------------------------------------------------------------------------
//  Context interface — engine 在 constructor 中调用 init() 注入信号引用
// ---------------------------------------------------------------------------

export interface DockEntryFieldContext {
  entries: WritableSignal<DockEntry[]>;
  focusSessionContext: () => { id: string; startedAt: number } | null;
  rebalanceAutoZones: () => void;
  persistDockSnapshotNow: (entries: DockEntry[]) => Promise<boolean>;
}

@Injectable({
  providedIn: 'root',
})
export class DockEntryFieldService {
  private readonly taskSync = inject(DockTaskSyncService);
  private readonly toast = inject(ToastService);
  private readonly logger = inject(LoggerService);

  private _ctx: DockEntryFieldContext | null = null;
  private readonly taskFieldOperationChains = new Map<string, Promise<void>>();

  /**
   * 获取上下文——必须在 DockEngineService 构造期间调用 init() 注入。
   * 如未初始化则抛出明确错误，便于定位 DI 顺序问题。
   */
  private get ctx(): DockEntryFieldContext {
    if (!this._ctx) {
      throw new Error(
        'DockEntryFieldService.init() must be called before use. ' +
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
  init(ctx: DockEntryFieldContext): void {
    if (this._ctx) {
      this.logger.category('DockEntryField').warn('init() called again — overwriting previous context');
    }
    this._ctx = ctx;
  }

  async toggleLoad(taskId: string, direction: 'up' | 'down'): Promise<boolean> {
    return this.runTaskFieldOperation(taskId, async () => {
      const nextLoad: CognitiveLoad = direction === 'up' ? 'high' : 'low';
      const currentEntry = this.ctx.entries().find(entry => entry.taskId === taskId) ?? null;
      if (!currentEntry) return false;
      if (currentEntry.load === nextLoad) return true;

      const saved = await this.taskSync.syncTaskPlannerFields(taskId, { cognitive_load: nextLoad });
      if (!saved) return false;

      this.ctx.entries.update(prev =>
        prev.map(entry => {
          if (entry.taskId !== taskId) return entry;
          return { ...entry, load: nextLoad };
        }),
      );
      return true;
    });
  }

  async setExpectedTime(taskId: string, minutes: number | null): Promise<boolean> {
    return this.runTaskFieldOperation(taskId, async () => {
      const currentEntry = this.ctx.entries().find(entry => entry.taskId === taskId) ?? null;
      if (!currentEntry) return false;
      const plannerFields = sanitizePlannerFields({
        expectedMinutes: minutes,
        waitMinutes: currentEntry.waitMinutes,
        cognitiveLoad: currentEntry.load,
      });

      const saved = await this.taskSync.syncTaskPlannerFields(taskId, {
        expected_minutes: plannerFields.expectedMinutes,
        wait_minutes: plannerFields.waitMinutes,
      });
      if (!saved) return false;

      this.ctx.entries.update(prev =>
        prev.map(entry =>
          entry.taskId === taskId
            ? {
                ...entry,
                expectedMinutes: plannerFields.expectedMinutes,
                waitMinutes: plannerFields.waitMinutes,
              }
            : entry,
        ),
      );
      if (plannerFields.adjusted) {
        this.toast.info('已校正等待/预计时长', `等待时长不能超过预计时长，已同步调整为 ${plannerFields.expectedMinutes ?? 0} 分钟`);
      }
      return true;
    });
  }

  async setWaitTime(taskId: string, minutes: number | null): Promise<boolean> {
    return this.runTaskFieldOperation(taskId, async () => {
      const currentEntry = this.ctx.entries().find(entry => entry.taskId === taskId) ?? null;
      if (!currentEntry) return false;
      const plannerFields = sanitizePlannerFields({
        expectedMinutes: currentEntry.expectedMinutes,
        waitMinutes: minutes,
        cognitiveLoad: currentEntry.load,
      });

      const saved = await this.taskSync.syncTaskPlannerFields(taskId, {
        expected_minutes: plannerFields.expectedMinutes,
        wait_minutes: plannerFields.waitMinutes,
      });
      if (!saved) return false;

      this.ctx.entries.update(prev =>
        prev.map(entry =>
          entry.taskId === taskId
            ? {
                ...entry,
                expectedMinutes: plannerFields.expectedMinutes,
                waitMinutes: plannerFields.waitMinutes,
              }
            : entry,
        ),
      );
      if (plannerFields.adjusted) {
        this.toast.info('已校正等待/预计时长', `等待时长不能超过预计时长，已同步调整为 ${plannerFields.expectedMinutes ?? 0} 分钟`);
      }
      return true;
    });
  }

  async setDetail(taskId: string, detail: string): Promise<boolean> {
    return this.runTaskFieldOperation(taskId, async () => {
      const currentEntry = this.ctx.entries().find(entry => entry.taskId === taskId) ?? null;
      if (!currentEntry) return false;
      const saved = await this.taskSync.syncTaskDetail(taskId, detail, {
        entries: this.ctx.entries(),
        focusSessionContext: this.ctx.focusSessionContext(),
      });
      if (!saved) return false;

      this.ctx.entries.update(prev =>
        prev.map(entry => (entry.taskId === taskId ? { ...entry, detail } : entry)),
      );
      return true;
    });
  }

  async setLane(taskId: string, lane: DockLane, zoneSource: DockZoneSource = 'manual'): Promise<boolean> {
    return this.runTaskFieldOperation(taskId, async () => {
      const current = this.ctx.entries();
      let changed = false;
      const next = current.map(entry => {
        if (entry.taskId !== taskId) return entry;
        if (entry.lane === lane && entry.zoneSource === zoneSource) return entry;
        changed = true;
        return { ...entry, lane, zoneSource };
      });
      if (!changed) return false;

      const persisted = await this.ctx.persistDockSnapshotNow(next);
      if (!persisted) return false;

      this.ctx.entries.set(next);
      if (zoneSource === 'auto') {
        this.ctx.rebalanceAutoZones();
      }
      return true;
    });
  }

  private runTaskFieldOperation<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskFieldOperationChains.get(taskId);
    const run = previous ? previous.then(operation) : operation();
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.taskFieldOperationChains.set(taskId, settled);
    void settled.finally(() => {
      if (this.taskFieldOperationChains.get(taskId) === settled) {
        this.taskFieldOperationChains.delete(taskId);
      }
    });
    return run;
  }
}
