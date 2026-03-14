import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Input,
  computed,
  output,
  signal,
  viewChild,
} from '@angular/core';

export type DockPlannerQuickEditPresentation = 'popover' | 'sheet';

@Component({
  selector: 'app-dock-planner-quick-edit',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .planner-attention-glow {
      animation: plannerGlow 2s ease-in-out infinite;
    }
  `],
  template: `
    <div class="relative planner-quick-edit" (click)="$event.stopPropagation()" (pointerdown)="$event.stopPropagation()">
      <button
        #plannerTrigger
        type="button"
        class="mt-2 inline-flex min-h-[44px] items-center gap-1 rounded-full border px-2 py-1.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap"
        [ngClass]="buttonToneClasses()"
        [disabled]="disabled()"
        [attr.aria-expanded]="open()"
        [attr.data-planner-task-id]="taskId() || null"
        (click)="onToggle()"
        style="min-height: 44px;"
        data-testid="dock-v3-planner-toggle">
        <span>补全属性</span>
        @if (missingFieldCount() > 0) {
          <span class="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
            待补{{ missingFieldCount() }}
          </span>
        }
      </button>
    </div>
  `,
})
export class DockPlannerQuickEditComponent {
  private readonly openState = signal(false);
  private readonly attentionState = signal(false);
  // TODO: pendingOpen has no timeout — if the parent never responds with an
  // openInput binding update, this flag stays true indefinitely. Consider
  // adding a short timeout (e.g. 500ms) to auto-reset as a safety net.
  private readonly pendingOpen = signal(false);
  private readonly expectedMinutesState = signal<number | null>(null);
  private readonly waitMinutesState = signal<number | null>(null);
  private readonly disabledState = signal(false);
  private readonly taskIdState = signal<string | null>(null);

  private readonly plannerTrigger = viewChild<ElementRef<HTMLButtonElement>>('plannerTrigger');

  @Input({ alias: 'open' })
  set openInput(value: boolean) {
    this.openState.set(!!value);
    this.pendingOpen.set(false);
  }

  @Input({ alias: 'attention' })
  set attentionInput(value: boolean) {
    this.attentionState.set(!!value);
  }

  @Input({ alias: 'expectedMinutes' })
  set expectedMinutesInput(value: number | null) {
    this.expectedMinutesState.set(value);
  }

  @Input({ alias: 'waitMinutes' })
  set waitMinutesInput(value: number | null) {
    this.waitMinutesState.set(value);
  }

  @Input({ alias: 'disabled' })
  set disabledInput(value: boolean) {
    this.disabledState.set(!!value);
  }

  @Input({ alias: 'taskId' })
  set taskIdInput(value: string | null | undefined) {
    this.taskIdState.set(value ?? null);
  }

  readonly open = this.openState.asReadonly();
  readonly attention = this.attentionState.asReadonly();
  readonly expectedMinutes = this.expectedMinutesState.asReadonly();
  readonly waitMinutes = this.waitMinutesState.asReadonly();
  readonly disabled = this.disabledState.asReadonly();
  readonly taskId = this.taskIdState.asReadonly();

  readonly toggleRequested = output<void>();

  readonly missingFieldCount = computed(() => {
    let count = 0;
    if (this.expectedMinutes() === null) count += 1;
    // waitMinutes 为选填，不计入缺失数
    return count;
  });

  readonly buttonToneClasses = computed(() => {
    if (this.disabled()) {
      return 'border-slate-700/50 bg-slate-900/55 text-slate-500';
    }
    const suppressPulse = this.open() || this.pendingOpen();
    if (this.attention() && !suppressPulse) {
      return 'border-amber-400/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 planner-attention-glow';
    }
    if (this.attention()) {
      return 'border-amber-400/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20';
    }
    return 'border-slate-600/40 bg-slate-800/70 text-slate-300 hover:bg-slate-700/80';
  });

  onToggle(): void {
    if (this.disabled()) return;
    if (!this.open()) {
      this.pendingOpen.set(true);
    }
    this.toggleRequested.emit();
  }
}
