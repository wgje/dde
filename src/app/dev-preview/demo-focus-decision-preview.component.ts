import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { DockPendingDecisionComponent } from '../features/parking/components/dock-pending-decision.component';
import { DockFragmentCountdownComponent } from '../features/parking/components/dock-fragment-countdown.component';
import type { DockPendingDecisionEntry } from '../../models/parking-dock';

@Component({ selector: 'app-demo-focus-decision-preview', standalone: true,
  imports: [DockPendingDecisionComponent, DockFragmentCountdownComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!result) {
      @if (state === 'countdown') {
        <app-dock-fragment-countdown [seconds]="seconds" (accept)="finish('已进入碎片任务推荐')" (skip)="finish('已跳过碎片任务')"></app-dock-fragment-countdown>
      } @else {
        <app-dock-pending-decision reason="主任务等待中，请选择下一项" [remainingMinutes]="15" [entries]="entries" [blocked]="blocked"
          (cancelRecommendation)="finish('已收起推荐')" (chooseCandidate)="choose($event)"></app-dock-pending-decision>
      }
    } @else { <p role="status">{{ result }}</p> }
  `,
  styles: [`:host {display:block;max-width:540px;padding:16px;background:#0f172a;color:#e2e8f0;border-radius:20px;}`],
})
export class DemoFocusDecisionPreviewComponent {
  @Input() blocked = false;
  @Input() state: 'decision' | 'countdown' | string = 'decision';
  @Output() readonly action = new EventEmitter<string>();
  readonly seconds = 5;
  readonly entries: DockPendingDecisionEntry[] = [
    { taskId:crypto.randomUUID(), title:'整理下一步', group:'homologous-advancement', lane:'combo-select', load:'high', expectedMinutes:10, recommendedScore:1 },
    { taskId:crypto.randomUUID(), title:'检查清单', group:'cognitive-downgrade', lane:'backup', load:'low', expectedMinutes:5, recommendedScore:1 },
    { taskId:crypto.randomUUID(), title:'等待构建完成', group:'asynchronous-boot', lane:'backup', load:'low', expectedMinutes:8, recommendedScore:1 },
  ];
  result = '';
  choose(id: string): void { const entry = this.entries.find(entry => entry.taskId === id); if (entry) this.finish(`已选择：${entry.title}`); }
  finish(result: string): void { this.result = result; this.action.emit(result); }
}
