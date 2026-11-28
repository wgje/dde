import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { DemoKnowledgePreviewComponent } from './demo-knowledge-preview.component';
import { TextTaskEditorComponent } from '../features/text/components/text-task-editor.component';
import { TextTaskCardComponent } from '../features/text/components/text-task-card.component';
import { DEMO_TASK_PREVIEW_PROVIDERS, DemoTaskPreviewMemory } from './demo-task-preview.providers';

@Component({
  selector: 'app-demo-task-preview', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TextTaskEditorComponent, TextTaskCardComponent, DemoKnowledgePreviewComponent], providers: DEMO_TASK_PREVIEW_PROVIDERS,
  template: `
    <section class="demo-task-preview" aria-label="任务卡演示">
      @if (state() === 'sidecar-expanded') {
        <app-text-task-editor [task]="memory.task()" [initialPreview]="false" [userId]="memory.userId" [projectId]="memory.projectId"
          (addSibling)="memory.addRelative(memory.task(), false)" (addChild)="memory.addRelative(memory.task(), true)"
          (deleteTask)="deletePrimary()" (parkTask)="memory.park(memory.task().id)" />
      } @else if (!removed()) { <app-text-task-card [task]="memory.task()" [isSelected]="selected()"
        [isMobile]="state() === 'siyuan'" [userId]="memory.userId" [projectId]="memory.projectId" [stageNumber]="1"
        (select)="selected.set(true)" (addSibling)="memory.addRelative(memory.task(), false)"
        (addChild)="memory.addRelative(memory.task(), true)" (deleteTask)="deletePrimary()"
        (parkTask)="memory.park(memory.task().id)" (attachmentError)="memory.message.set($event)">
      </app-text-task-card> }
      @for (task of memory.additionalTasks(); track task.id) {
        <app-text-task-card [task]="task" [isSelected]="additionalSelectedId() === task.id"
          [userId]="memory.userId" [projectId]="memory.projectId" [stageNumber]="task.stage ?? 0"
          (select)="additionalSelectedId.set(task.id)" (addSibling)="memory.addRelative(task, false)"
          (addChild)="memory.addRelative(task, true)" (deleteTask)="memory.remove(task.id)"
          (parkTask)="memory.park(task.id)" (attachmentError)="memory.message.set($event)">
        </app-text-task-card>
      }
      @if (state() === 'siyuan') { <app-demo-knowledge-preview state="preview" /> }
      @if (removed()) { <p role="status">这条虚拟任务已删除。刷新即可恢复样例。</p> }
      @if (memory.message()) { <p role="status">{{ memory.message() }}</p> }
      <div class="demo-task-preview-actions">
        <button type="button" (click)="selected.set(!selected())">{{ selected() ? '收起任务' : '展开任务' }}</button>
        <button type="button" (click)="toggleCompleted()">{{ memory.task().status === 'completed' ? '恢复为进行中' : '标为完成' }}</button>
      </div>
    </section>
  `,
  styles: [`.demo-task-preview { max-width: 900px; padding: 16px; } .demo-task-preview-actions { display:flex; gap:12px; margin-top:12px; } .demo-task-preview-actions button { border:1px solid #a8a29e; border-radius:8px; padding:8px 12px; }`],
})
export class DemoTaskPreviewComponent {
  readonly state = input('active');
  readonly memory = inject(DemoTaskPreviewMemory);
  readonly selected = signal(false);
  readonly removed = signal(false);
  readonly additionalSelectedId = signal<string | null>(null);
  constructor() {
    effect(() => { this.memory.reset(this.state()); this.selected.set(this.state() === 'sidecar'); this.removed.set(false); this.additionalSelectedId.set(null); });
  }
  deletePrimary(): void { this.memory.remove(this.memory.task().id); this.removed.set(true); }
  toggleCompleted(): void {
    this.memory.dockedTaskIds.update(ids => new Set([...ids].filter(id => id !== this.memory.task().id)));
    void this.memory.patch(this.memory.task().id, { status: this.memory.task().status === 'completed' ? 'active' : 'completed', parkingMeta: null });
  }
}
