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

  private _ctx: DockEntryFieldContext | null = null;

  private get ctx(): DockEntryFieldContext {
    if (!this._ctx) {
      throw new Error('DockEntryFieldService.init() must be called before use');
    }
    return this._ctx;
  }

  init(ctx: DockEntryFieldContext): void {
    if (this._ctx) {
      console.warn('[DockEntryField] init() called again — overwriting previous context');
    }
    this._ctx = ctx;
  }

  toggleLoad(taskId: string, direction: 'up' | 'down'): void {
    const nextLoad: CognitiveLoad = direction === 'up' ? 'high' : 'low';
    this.ctx.entries.update(prev =>
      prev.map(entry => (entry.taskId === taskId ? { ...entry, load: nextLoad } : entry)),
    );
    this.taskSync.syncTaskPlannerFields(taskId, { cognitive_load: nextLoad });
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
