import {
  AfterViewInit, ChangeDetectionStrategy, Component, Input, ViewChild, computed, inject, signal,
} from '@angular/core';
import type { Task } from '../../models';
import { TaskStore, ProjectStore, ConnectionStore } from '../core/state/stores';
import { ProjectStateService } from '../../services/project-state.service';
import { LayoutService } from '../../services/layout.service';
import { UiStateService } from '../../services/ui-state.service';
import { TaskOperationAdapterService } from '../../services/task-operation-adapter.service';
import { SimpleReminderService } from '../../services/simple-reminder.service';
import { UserSessionService } from '../../services/user-session.service';
import { SyncCoordinatorService } from '../../services/sync-coordinator.service';
import { FlowTaskOperationsService } from '../features/flow/services/flow-task-operations.service';
import { TextStagesComponent } from '../features/text/components/text-stages.component';
import { TextUnassignedComponent } from '../features/text/components/text-unassigned.component';
import { TextUnfinishedComponent } from '../features/text/components/text-unfinished.component';
import { AuthService } from '../../services/auth.service';
import { DockEngineService } from '../../services/dock-engine.service';
import { ParkingService } from '../../services/parking.service';
import { ToastService } from '../../services/toast.service';
import { LoggerService } from '../../services/logger.service';
import { ExternalSourceLinkService } from '../core/external-sources/external-source-link.service';
import { SiyuanPreviewService } from '../core/external-sources/siyuan/siyuan-preview.service';
import { TextViewTaskOpsService } from '../features/text/services/text-view-task-ops.service';

function createPreviewTask(): Task {
  return {
    id: crypto.randomUUID(), title: '归档任务演示', content: '', stage: 1,
    parentId: null, order: 1, rank: 1000, status: 'active', x: 0, y: 0,
    displayId: '1', createdDate: '2026-11-28T00:00:00.000Z',
  };
}

// Component-scoped substitutes keep all preview interactions away from durable user state.
const ARCHIVE_PREVIEW_LOCAL_PROVIDERS = [
  { provide: AuthService, useValue: { currentUserId: () => null, captureAuthIdentityFence: () => null } },
  { provide: DockEngineService, useFactory: () => ({ dockedTaskIds: signal(new Set<string>()), focusingEntry: signal(null) }) },
  { provide: ParkingService, useValue: { parkTask: async () => false } },
  { provide: ToastService, useValue: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} } },
  { provide: LoggerService, useFactory: () => {
    const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, category: () => logger };
    return logger;
  } },
  { provide: ExternalSourceLinkService, useFactory: () => ({ links: signal([]), activeLinksForTask: () => [] }) },
  { provide: SiyuanPreviewService, useValue: { preview: async () => ({ status: 'unavailable' }) } },
  { provide: TextViewTaskOpsService, useValue: { armContainerClickGuard: () => {} } },
];

function createPreviewUiState() {
  const stageFilter = signal<'all' | number>('all');
  const stageViewRootFilter = signal('all');
  const unassignedOpen = signal(true);
  const unfinishedOpen = signal(true);
  return {
    filterMode: signal('all'), stageFilter, stageViewRootFilter,
    setStageFilter: (stage: 'all' | number) => stageFilter.set(stage),
    setStageViewRootFilter: (root: string) => stageViewRootFilter.set(root),
    isTextSidebarVisible: () => true,
    hasTextUnassignedOpenPreference: () => true,
    hasTextUnfinishedOpenPreference: () => true,
    isTextUnassignedOpen: unassignedOpen, isTextUnfinishedOpen: unfinishedOpen,
    toggleTextUnassignedOpen: () => unassignedOpen.update(open => !open),
    toggleTextUnfinishedOpen: () => unfinishedOpen.update(open => !open),
    markEditing: () => {},
  };
}

function createMemoryTaskAdapter() {
  const tasks = inject(TaskStore);
  const state = inject(ProjectStateService);
  const patch = async (id: string, fields: Partial<Task>): Promise<boolean> => {
    const task = tasks.getTask(id);
    const projectId = state.activeProjectId();
    if (!task || !projectId) return false;
    tasks.setTask({ ...task, ...fields }, projectId);
    return true;
  };
  return {
    updateTaskStatus: (id: string, status: Task['status']) => patch(id, { status }),
    updateTaskDraft: (id: string, fields: Partial<Task>) => patch(id, fields),
    updateTaskContent: (id: string, content: string) => patch(id, { content }),
    core: {
      completeUnfinishedItem: (id: string, index: number) => {
        const task = tasks.getTask(id);
        if (!task) return;
        let todoIndex = -1;
        const content = task.content.replace(/^(\s*[-*+]\s+\[)([ xX])(\])/gm, (match, start, _checked, end) => {
          todoIndex += 1;
          return todoIndex === index ? `${start}x${end}` : match;
        });
        void patch(id, { content });
      },
    },
  };
}

@Component({
  selector: 'app-demo-task-archive-preview', standalone: true,
  imports: [TextStagesComponent, TextUnassignedComponent, TextUnfinishedComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    ...ARCHIVE_PREVIEW_LOCAL_PROVIDERS,
    TaskStore, ProjectStore, ConnectionStore, ProjectStateService, FlowTaskOperationsService,
    { provide: LayoutService, useValue: {} },
    { provide: UiStateService, useFactory: createPreviewUiState },
    { provide: TaskOperationAdapterService, useFactory: createMemoryTaskAdapter },
    { provide: SimpleReminderService, useValue: { setReminder: async () => true, cancelReminder: async () => true } },
    { provide: UserSessionService, useValue: { isHintOnlyStartupPlaceholderVisible: () => false } },
    { provide: SyncCoordinatorService, useValue: { isLoadingRemote: () => false } },
  ],
  template: `
    <section aria-label="归档任务跨视图演示" class="archive-preview">
      <div class="archive-action">
        <button type="button" data-testid="preview-archive-task" [disabled]="busy()" (click)="toggleArchive()">
          {{ task()?.status === 'archived' ? '取消归档' : '在流程图归档任务' }}
        </button>
        <p role="status">{{ task()?.status === 'archived' ? '已归档，文本栏已隐藏此任务。' : '任务在文本栏中可见。' }}</p>
        <p>未完成事项：{{ state.taskTodoStats().pending }}</p>
      </div>
      <div class="archive-text">
        <app-text-stages />
        <aside><app-text-unassigned /><app-text-unfinished /></aside>
      </div>
    </section>
  `,
  styles: [`
    :host{display:block;min-width:0}.archive-preview{display:grid;gap:16px}
    .archive-action{display:grid;gap:8px;padding:16px;border:1px solid #d6d3d1;border-radius:12px}
    .archive-action button{justify-self:start;padding:8px 14px;border-radius:8px;background:#0f766e;color:white}
    .archive-text{display:grid;grid-template-columns:minmax(0,2fr) minmax(230px,1fr);gap:16px;min-height:300px}
    aside{display:grid;gap:12px;align-content:start;min-width:0}
    @media(max-width:640px){.archive-text{grid-template-columns:minmax(0,1fr)}}
  `],
})
export class DemoTaskArchivePreviewComponent implements AfterViewInit {
  readonly state = inject(ProjectStateService);
  private readonly tasks = inject(TaskStore);
  private readonly projects = inject(ProjectStore);
  private readonly flow = inject(FlowTaskOperationsService);
  private readonly taskId = signal('');
  readonly task = computed(() => this.state.getTask(this.taskId()));
  readonly busy = signal(false);
  @ViewChild(TextStagesComponent) private stages?: TextStagesComponent;

  @Input() set previewState(value: string) {
    const item: Task = {
      ...createPreviewTask(), title: '这项任务归档后应从文本栏消失',
      content: '- [ ] 归档后不再计入未完成事项',
      stage: value.startsWith('unassigned') ? null : 1,
      status: value.endsWith('-archived') ? 'archived' : 'active',
    };
    const projectId = crypto.randomUUID();
    this.tasks.clear();
    this.projects.setProjects([{
      id: projectId, name: '归档任务隔离演示', description: '',
      createdDate: item.createdDate, tasks: [item], connections: [],
    }]);
    this.projects.activeProjectId.set(projectId);
    this.tasks.setTasks([item], projectId);
    this.taskId.set(item.id);
    this.expandStages();
  }

  ngAfterViewInit(): void { this.expandStages(); }

  async toggleArchive(): Promise<void> {
    const item = this.task();
    if (!item || this.busy()) return;
    this.busy.set(true);
    try {
      await this.flow.archiveTask(item);
      this.expandStages();
    } finally {
      this.busy.set(false);
    }
  }

  private expandStages(): void {
    queueMicrotask(() => this.stages?.collapsedStages.set(new Set()));
  }
}