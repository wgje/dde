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
}

@Injectable({
  providedIn: 'root',
})
export class DockEntryFieldService {
  private readonly taskSync = inject(DockTaskSyncService);
  private readonly toast = inject(ToastService);
  private readonly logger = inject(LoggerService);

  private _ctx: DockEntryFieldContext | null = null;

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

  toggleLoad(taskId: string, direction: 'up' | 'down'): void {
    const nextLoad: CognitiveLoad = direction === 'up' ? 'high' : 'low';
    const exists = this.ctx.entries().some(entry => entry.taskId === taskId);
    this.ctx.entries.update(prev =>
      prev.map(entry => (entry.taskId === taskId ? { ...entry, load: nextLoad } : entry)),
    );
    if (exists) {
      this.taskSync.syncTaskPlannerFields(taskId, { cognitive_load: nextLoad });
    }
  }

  setExpectedTime(taskId: string, minutes: number | null): void {
    const currentEntry = this.ctx.entries().find(entry => entry.taskId === taskId) ?? null;
    const plannerFields = sanitizePlannerFields({
      expectedMinutes: minutes,
      waitMinutes: currentEntry?.waitMinutes ?? null,
      cognitiveLoad: currentEntry?.load ?? null,
    });
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
    this.taskSync.syncTaskPlannerFields(taskId, {
      expected_minutes: plannerFields.expectedMinutes,
      wait_minutes: plannerFields.waitMinutes,
    });
  }

  setWaitTime(taskId: string, minutes: number | null): void {
    const currentEntry = this.ctx.entries().find(entry => entry.taskId === taskId) ?? null;
    const plannerFields = sanitizePlannerFields({
      expectedMinutes: currentEntry?.expectedMinutes ?? null,
      waitMinutes: minutes,
      cognitiveLoad: currentEntry?.load ?? null,
    });
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
    this.taskSync.syncTaskPlannerFields(taskId, {
      expected_minutes: plannerFields.expectedMinutes,
      wait_minutes: plannerFields.waitMinutes,
    });
  }

  setDetail(taskId: string, detail: string): void {
    this.ctx.entries.update(prev =>
      prev.map(entry => (entry.taskId === taskId ? { ...entry, detail } : entry)),
    );
    this.taskSync.syncTaskDetail(taskId, detail, {
      entries: this.ctx.entries(),
      focusSessionContext: this.ctx.focusSessionContext(),
    });
  }

  setLane(taskId: string, lane: DockLane, zoneSource: DockZoneSource = 'manual'): void {
    this.ctx.entries.update(prev =>
      prev.map(entry => (entry.taskId === taskId ? { ...entry, lane, zoneSource } : entry)),
    );
    if (zoneSource === 'auto') {
      this.ctx.rebalanceAutoZones();
    }
  }
}
