import { NgClass } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  output,
  viewChild,
} from '@angular/core';

import { DockPlannerQuickEditService } from '../services/dock-planner-quick-edit.service';
import { formatDockMinutes } from '../utils/dock-format';

@Component({
  selector: 'app-dock-planner-quick-edit-panel',
  standalone: true,
  imports: [NgClass],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (planner.activeEntry(); as plannerEntry) {
      <div
        #plannerPanel
        [ngClass]="planner.panelClasses()"
        [attr.data-presentation]="planner.presentation()"
        tabindex="-1"
        [attr.role]="planner.presentation() === 'sheet' ? 'dialog' : 'region'"
        [attr.aria-modal]="planner.presentation() === 'sheet' ? 'true' : null"
        aria-label="补全任务属性"
        data-testid="dock-v3-planner-panel"
        (click)="$event.stopPropagation()"
        (pointerdown)="$event.stopPropagation()">
        <div class="flex items-start gap-2.5">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="rounded-full border border-amber-400/25 bg-amber-500/12 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-amber-200/90">
                补全
              </span>
              <span class="rounded-full border border-slate-700/70 bg-slate-900/80 px-1.5 py-0.5 text-[9px] text-slate-300">
                {{ plannerEntry.isMain ? '主任务' : (plannerEntry.lane === 'combo-select' ? '副任务' : '备选任务') }}
              </span>
              @if (planner.missingFieldCount() > 0) {
                <span class="rounded-full border border-amber-400/25 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-200">
                  {{ planner.missingFieldCount() }} 项待补
                </span>
              } @else {
                <span class="rounded-full border border-emerald-400/25 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-200">
                  已完整 ✓
                </span>
              }
            </div>
            <div class="mt-2 flex items-start gap-2">
              <h4 class="min-w-0 flex-1 truncate text-sm font-semibold text-slate-50">{{ plannerEntry.title }}</h4>
              <div class="flex flex-wrap items-center justify-end gap-1.5 text-[9px] text-slate-400">
                <span class="rounded-full border border-slate-800/80 bg-slate-900/70 px-1.5 py-0.5">
                  当前负荷
                  <span class="ml-1 font-semibold" [ngClass]="plannerEntry.load === 'high' ? 'text-indigo-200' : 'text-emerald-200'">
                    {{ plannerEntry.load === 'high' ? '高负荷' : '低负荷' }}
                  </span>
                </span>
                <span class="rounded-full border border-slate-800/80 bg-slate-900/70 px-1.5 py-0.5">
                  预计
                  <span class="ml-1 font-semibold text-slate-200">
                    {{ plannerEntry.expectedMinutes === null ? '未设' : formatTime(plannerEntry.expectedMinutes) }}
                  </span>
                </span>
                <span class="rounded-full border border-slate-800/80 bg-slate-900/70 px-1.5 py-0.5">
                  等待
                  <span class="ml-1 font-semibold text-slate-200">
                    {{ plannerEntry.waitMinutes === null ? '未设' : formatTime(plannerEntry.waitMinutes) }}
                  </span>
                </span>
              </div>
            </div>
          </div>
          <button
            type="button"
            class="inline-flex min-h-[32px] shrink-0 items-center justify-center rounded-lg border border-slate-800/80 bg-slate-900/70 px-2.5 text-[10px] font-medium text-slate-300 transition-colors hover:border-slate-600/70 hover:bg-slate-800 hover:text-slate-100"
            (click)="closeRequested.emit()"
            data-testid="dock-v3-planner-close">
            收起
          </button>
        </div>

        <div class="mt-2.5 grid gap-2.5">
          <section class="rounded-2xl border border-indigo-400/16 bg-slate-900/82 p-3">
            <div class="flex items-center justify-between gap-2 text-[10px] text-slate-500">
              <div class="uppercase tracking-[0.18em] text-indigo-100/80">预计投入</div>
              <span class="font-mono text-sm text-slate-100">
                {{ plannerEntry.expectedMinutes === null ? '未设' : formatTime(plannerEntry.expectedMinutes) }}
              </span>
            </div>
            <div class="mt-2 grid grid-cols-3 gap-1.5 sm:grid-cols-6">
              @for (preset of planner.expectedPresets; track preset) {
                <button
                  type="button"
                  class="rounded-xl border px-2 py-2 text-[10px] font-medium transition-colors"
                  [ngClass]="plannerEntry.expectedMinutes === preset
                    ? 'border-indigo-400/45 bg-indigo-500/15 text-indigo-200'
                    : 'border-slate-700/60 bg-slate-800/80 text-slate-300 hover:bg-slate-700'"
                  (click)="planner.setPlannerQuickEditExpected(plannerEntry.taskId, preset)"
                  style="min-height: 36px;"
                  data-testid="dock-v3-planner-expected">
                  {{ formatTime(preset) }}
                </button>
              }
            </div>
          </section>

          <div class="grid gap-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
            <section class="rounded-2xl border border-slate-700/60 bg-slate-900/82 p-3">
              <div class="flex items-center justify-between gap-2 text-[10px] text-slate-500">
                <div class="uppercase tracking-[0.18em]">认知负荷</div>
                <span class="font-semibold" [ngClass]="plannerEntry.load === 'high' ? 'text-indigo-200' : 'text-emerald-200'">
                  {{ plannerEntry.load === 'high' ? '高' : '低' }}
                </span>
              </div>
              <div class="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-1">
                <button
                  type="button"
                  class="rounded-xl border px-2 py-2 text-[10px] font-medium transition-colors"
                  [ngClass]="plannerEntry.load === 'low'
                    ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200'
                    : 'border-slate-700/60 bg-slate-800/80 text-slate-300 hover:bg-slate-700'"
                  (click)="planner.setPlannerQuickEditLoad(plannerEntry.taskId, 'low')"
                  style="min-height: 34px;"
                  data-testid="dock-v3-planner-load-low">
                  低负荷
                </button>
                <button
                  type="button"
                  class="rounded-xl border px-2 py-2 text-[10px] font-medium transition-colors"
                  [ngClass]="plannerEntry.load === 'high'
                    ? 'border-indigo-400/40 bg-indigo-500/15 text-indigo-200'
                    : 'border-slate-700/60 bg-slate-800/80 text-slate-300 hover:bg-slate-700'"
                  (click)="planner.setPlannerQuickEditLoad(plannerEntry.taskId, 'high')"
                  style="min-height: 34px;"
                  data-testid="dock-v3-planner-load-high">
                  高负荷
                </button>
              </div>
            </section>

            <section class="rounded-2xl border border-slate-700/60 bg-slate-900/82 p-3">
              <div class="flex items-center justify-between gap-2 text-[10px] text-slate-500">
                <div class="uppercase tracking-[0.18em]">
                  等待窗口
                  <span class="ml-1 normal-case text-slate-600">选填</span>
                </div>
                <span class="font-mono text-slate-300">
                  {{ plannerEntry.waitMinutes === null ? '未设' : formatTime(plannerEntry.waitMinutes) }}
                </span>
              </div>
              <div class="mt-2 grid grid-cols-4 gap-1.5">
                <button
                  type="button"
                  class="rounded-xl border px-2 py-2 text-[10px] font-medium transition-colors"
                  [ngClass]="plannerEntry.waitMinutes === null
                    ? 'border-amber-400/40 bg-amber-500/15 text-amber-200'
                    : 'border-slate-700/60 bg-slate-800/80 text-slate-300 hover:bg-slate-700'"
                  (click)="planner.setPlannerQuickEditWait(plannerEntry.taskId, null)"
                  style="min-height: 36px;"
                  data-testid="dock-v3-planner-wait-none">
                  无
                </button>
                @for (preset of planner.waitPresets; track preset) {
                  <button
                    type="button"
                    class="rounded-xl border px-2 py-2 text-[10px] font-medium transition-colors"
                    [ngClass]="plannerEntry.waitMinutes === preset
                      ? 'border-amber-400/40 bg-amber-500/15 text-amber-200'
                      : 'border-slate-700/60 bg-slate-800/80 text-slate-300 hover:bg-slate-700'"
                    (click)="planner.setPlannerQuickEditWait(plannerEntry.taskId, preset)"
                    style="min-height: 36px;"
                    data-testid="dock-v3-planner-wait">
                    {{ formatTime(preset) }}
                  </button>
                }
              </div>
            </section>
          </div>
        </div>
      </div>
    }
  `,
})
export class DockPlannerQuickEditPanelComponent {
  readonly planner = inject(DockPlannerQuickEditService);
  readonly closeRequested = output<void>();
  readonly formatTime = formatDockMinutes;

  private readonly hostElement = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly plannerPanel = viewChild<ElementRef<HTMLElement>>('plannerPanel');
  private cachedPanelRef: ElementRef<HTMLElement> | undefined;

  panelElement(): ElementRef<HTMLElement> | undefined {
    const queriedPanel = this.plannerPanel();
    if (queriedPanel) {
      this.cachedPanelRef = queriedPanel;
      return queriedPanel;
    }

    if (this.cachedPanelRef?.nativeElement.isConnected) {
      return this.cachedPanelRef;
    }

    const panel = this.hostElement.nativeElement.querySelector<HTMLElement>('[data-testid="dock-v3-planner-panel"]');
    this.cachedPanelRef = panel ? new ElementRef(panel) : undefined;
    return this.cachedPanelRef;
  }
}
