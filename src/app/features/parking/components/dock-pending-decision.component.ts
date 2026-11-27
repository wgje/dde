import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { NgClass } from '@angular/common';
import type { DockPendingDecisionEntry } from '../../../../models/parking-dock';
import { DOCK_GROUP_LABELS, DOCK_GROUP_FALLBACK_LABEL } from '../../../../config/dock-i18n.config';
import { formatDockMinutes } from '../utils/dock-format';

/** Actual pending-decision UI; owning host handles durable decisions. */
@Component({ selector: 'app-dock-pending-decision', standalone: true, imports: [NgClass],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="glass-card rounded-2xl px-4 py-3 border border-indigo-400/25 shadow-2xl" data-testid="dock-v3-pending-decision">
            <div class="flex items-center gap-2 mb-2.5">
              <div class="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></div>
              <div class="text-[10px] text-indigo-300/80 font-mono tracking-wide flex-1">
                {{ reason || '候选任务时长匹配异常，请手动决策' }}
              </div>
              <button
                type="button"
                class="text-[9px] px-2 py-1 rounded border border-slate-600/70 text-slate-300 hover:bg-slate-700/50"
                (click)="cancel()"
                [disabled]="blocked"
                aria-label="收起推荐"
                [attr.aria-disabled]="blocked ? 'true' : null"
                data-testid="dock-v3-pending-cancel">
                收起推荐
              </button>
            </div>
            <div class="text-[10px] text-stone-500 mb-3 font-mono">
              主任务剩余窗口
              <span class="text-stone-400 font-semibold">
                {{ formatTime(remainingMinutes) }}
              </span>
            </div>
            <div class="grid grid-cols-3 gap-2.5">
              @for (entry of entries; track entry.taskId; let i = $index) {
                <button
                  type="button"
                  class="decision-card rounded-xl border px-3.5 py-2.5 text-left transition-colors transition-transform transition-shadow"
                  [ngClass]="i % 3 === 0
                    ? 'border-amber-400/40 bg-amber-500/8 hover:bg-amber-500/15'
                    : (i % 3 === 1
                      ? 'border-indigo-400/40 bg-indigo-500/8 hover:bg-indigo-500/15'
                      : 'border-emerald-400/40 bg-emerald-500/8 hover:bg-emerald-500/15')"
                  (click)="choose(entry.taskId)"
                  [disabled]="blocked"
                  [attr.aria-label]="'选择候选任务：' + entry.title"
                  [attr.aria-disabled]="blocked ? 'true' : null"
                  [attr.data-testid]="'dock-v3-pending-choice-' + i">
                  <div class="text-[10px] font-mono mb-1.5 font-semibold"
                    [class.text-amber-300]="i % 3 === 0"
                    [class.text-indigo-300]="i % 3 === 1"
                    [class.text-emerald-300]="i % 3 === 2">
                    {{ groupLabel(entry.group) }}
                  </div>
                  <div class="text-xs text-stone-100 font-medium truncate mb-1.5">{{ entry.title }}</div>
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="text-[9px] px-1.5 py-0.5 rounded"
                      [ngClass]="entry.lane === 'combo-select'
                        ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20'
                        : 'bg-teal-500/15 text-teal-400 border border-teal-500/20'">
                      {{ entry.lane === 'combo-select' ? '组合选择' : '备选' }}
                    </span>
                    <span class="text-[9px] px-1.5 py-0.5 rounded"
                      [ngClass]="entry.load === 'high'
                        ? 'bg-red-500/15 text-red-400 border border-red-500/20'
                        : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'">
                      {{ entry.load === 'low' ? '低负荷' : '高负荷' }}
                    </span>
                    <span class="text-[9px] text-stone-500 font-mono">
                      {{ entry.expectedMinutes ? formatTime(entry.expectedMinutes) : '—' }}
                    </span>
                  </div>
                </button>
              }
            </div>
  </div>`,
  styles: [`:host { display:block; }
    .glass-card { background:rgba(249,251,254,0.97);color:#172033;border:1px solid rgba(23,32,51,0.11);box-shadow:0 14px 38px rgba(30,41,59,0.15),0 2px 8px rgba(30,41,59,0.06),inset 0 0.5px 0 rgba(255,255,255,0.95);contain:layout style;transition:border-color var(--pk-overlay-exit) var(--pk-ease-standard),box-shadow var(--pk-overlay-exit) var(--pk-ease-standard); } .decision-card { transition:transform var(--pk-card-reorder) var(--pk-ease-enter), background-color var(--pk-card-reorder) var(--pk-ease-standard); } .decision-card:hover { transform:translateY(-2px); } @media(prefers-reduced-motion:reduce) { .decision-card {transition:none;} }`],
})
export class DockPendingDecisionComponent {
  @Input() reason = '';
  @Input() remainingMinutes = 0;
  @Input() entries: DockPendingDecisionEntry[] = [];
  @Input() blocked = false;
  @Output() readonly cancelRecommendation = new EventEmitter<void>();
  @Output() readonly chooseCandidate = new EventEmitter<string>();
  readonly formatTime = formatDockMinutes;
  groupLabel(group: DockPendingDecisionEntry['group']): string { return DOCK_GROUP_LABELS[group] ?? DOCK_GROUP_FALLBACK_LABEL; }
  cancel(): void { if (!this.blocked) this.cancelRecommendation.emit(); }
  choose(id: string): void { if (!this.blocked && this.entries.some(entry => entry.taskId === id)) this.chooseCandidate.emit(id); }
}