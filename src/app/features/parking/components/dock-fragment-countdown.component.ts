import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

/** Display-only countdown; no timer or global focus state belongs to this leaf. */
@Component({ selector: 'app-dock-fragment-countdown', standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush, template: `          <div class="fragment-countdown-card rounded-2xl border border-emerald-500/30 bg-slate-900/95 px-6 py-5 text-center shadow-2xl max-w-[320px]">
            <div class="text-emerald-400 text-[11px] font-semibold tracking-widest mb-2 uppercase">碎片时间</div>
            <div class="text-slate-100 text-sm mb-3">
              检测到短暂空闲，即将进入碎片任务推荐
            </div>
            <div class="text-3xl font-mono text-emerald-300 mb-4" data-testid="fragment-countdown-number">
              {{ seconds }}s
            </div>
            <div class="flex gap-3 justify-center">
              <button
                type="button"
                class="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors"
                (click)="accept.emit()"
                aria-label="立即进入碎片任务"
                data-testid="fragment-countdown-accept">
                立即进入
              </button>
              <button
                type="button"
                class="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs transition-colors"
                (click)="skip.emit()"
                aria-label="跳过碎片任务"
                data-testid="fragment-countdown-skip">
                跳过
              </button>
            </div>
          </div>`, styles: [`:host {display:block;}`],
})
export class DockFragmentCountdownComponent {
  @Input() seconds = 0;
  @Output() readonly accept = new EventEmitter<void>();
  @Output() readonly skip = new EventEmitter<void>();
}