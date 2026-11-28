import { ChangeDetectionStrategy, Component, inject, Input, signal } from '@angular/core';
import { DEMO_TASK_PREVIEW_PROVIDERS, DemoTaskPreviewMemory } from './demo-task-preview.providers';
import { FlowTaskDetailComponent } from '../features/flow/components/flow-task-detail.component';
import { UiStateService } from '../../services/ui-state.service';
import { ProjectStateService } from '../../services/project-state.service';
import { UserSessionService } from '../../services/user-session.service';
import { FlowTaskOperationsService } from '../features/flow/services/flow-task-operations.service';
import type { TaskAttentionDraftItem, Task } from '../../models';
import { TaskOperationAdapterService } from '../../services/task-operation-adapter.service';
import { SimpleReminderService } from '../../services/simple-reminder.service';
@Component({
  selector: 'app-demo-flow-detail-preview', standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush, imports: [FlowTaskDetailComponent],
  providers: [
    ...DEMO_TASK_PREVIEW_PROVIDERS,
    { provide: UiStateService, useFactory: () => ({ isMobile: signal(false), isFlowDetailOpen: signal(true), activeView: signal('flow'), markEditing: () => {} }) },
    { provide: ProjectStateService, useFactory: () => {
      const memory = inject(DemoTaskPreviewMemory);
      return { activeProjectId: () => memory.projectId, activeProject: () => ({id:memory.projectId,name:'虚拟流程项目',tasks:[memory.task()],connections:[]}), tasks: () => [memory.task(), ...memory.additionalTasks()],
        getTask: (id: string) => memory.getTask(id), compressDisplayId: (id: string) => id,
        getTaskConnections: () => ({ incoming: [], outgoing: [] }) };
    } },
    { provide: UserSessionService, useFactory: () => { const memory = inject(DemoTaskPreviewMemory); return {currentUserId: () => memory.userId}; } },
    { provide: FlowTaskOperationsService, useFactory: () => {
      const memory = inject(DemoTaskPreviewMemory);
      return { parkTask: async (task: { id: string }) => { memory.park(task.id); return true; },
        addQuickTodo: (id: string, text: string) => memory.patch(id, {content: `${memory.task().content}\n- [ ] ${text}`}) };
    } },
    { provide: SimpleReminderService, useValue: { setReminder: async () => true, cancelReminder: async () => true } },
  ],
  template: `<section class="detail" data-testid="demo-flow-detail"><app-flow-task-detail [task]="memory.task()" [position]="position()"
    (positionChange)="position.set($event)" (titleChange)="memory.patch($event.taskId, { title: $event.title })"
    (contentChange)="memory.patch($event.taskId, { content: $event.content })"
    (attentionChange)="saveAttention($event.taskId, $event.items)" (toggleStatus)="toggleStatus($event)"
    (addSibling)="memory.addRelative($event, false)" (addChild)="memory.addRelative($event, true)"
    (archiveTask)="memory.patch($event.id, { status: 'archived' })"
    (deleteTask)="memory.patch($event.id, { deletedAt: deletedDate })" />
    <p role="status">{{ memory.message() }}</p></section>`,
  styles: [`:host{display:block;min-width:0}.detail{position:relative;transform:translateZ(0);min-height:470px}p{font-size:12px}`],
})
export class DemoFlowDetailPreviewComponent {
  readonly memory = inject(DemoTaskPreviewMemory);
  readonly position = signal({x:16,y:16});
  readonly deletedDate = new Date().toISOString();
  private readonly adapter = inject(TaskOperationAdapterService);
  @Input() set state(value: string) { this.memory.reset(value === 'completed' || value === 'detail-completed' ? 'completed' : 'sidecar'); }
  saveAttention(taskId: string, items: TaskAttentionDraftItem[]): void { void this.adapter.updateTaskAttentionItems(taskId, items); }
  toggleStatus(task: Task): void { void this.memory.patch(task.id, { status: task.status === 'completed' ? 'active' : 'completed' }); }
}