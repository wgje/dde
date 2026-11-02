import { CommonModule } from '@angular/common';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LoggerService } from '../../../../services/logger.service';
import type { Task } from '../../../../models';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { FlowBatchDeleteService } from '../services/flow-batch-delete.service';
import { FlowCascadeAssignService } from '../services/flow-cascade-assign.service';
import { FlowCommandService } from '../services/flow-command.service';
import { FlowDiagramEffectsService } from '../services/flow-diagram-effects.service';
import { FlowDiagramRetryService } from '../services/flow-diagram-retry.service';
import { FlowDiagramService } from '../services/flow-diagram.service';
import { FlowDragDropService } from '../services/flow-drag-drop.service';
import { FlowEventRegistrationService } from '../services/flow-event-registration.service';
import { FlowKeyboardService } from '../services/flow-keyboard.service';
import { FlowLayoutService } from '../services/flow-layout.service';
import { FlowLinkService } from '../services/flow-link.service';
import { FlowLogicExportService } from '../services/flow-logic-export.service';
import { FlowMobileDrawerService } from '../services/flow-mobile-drawer.service';
import { FlowPaletteResizeService } from '../services/flow-palette-resize.service';
import { FlowSelectionService } from '../services/flow-selection.service';
import { FlowSelectModeService } from '../services/flow-select-mode.service';
import { FlowSwipeGestureService } from '../services/flow-swipe-gesture.service';
import { FlowTaskOperationsService } from '../services/flow-task-operations.service';
import { FlowTouchService } from '../services/flow-touch.service';
import { FlowViewCleanupService } from '../services/flow-view-cleanup.service';
import { FlowViewCloudSaveService } from '../services/flow-view-cloud-save.service';
import { FlowZoomService } from '../services/flow-zoom.service';
import { FlowViewComponent } from './flow-view.component';

afterEach(() => {
  TestBed.resetTestingModule();
});

function createTask(id: string, parentId: string | null = null): Task {
  return {
    id, title: id, content: '', stage: 1, parentId, order: 1, rank: 1000,
    status: 'active', x: 0, y: 0, createdDate: '2026-07-29T00:00:00.000Z', displayId: id,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolver => { resolve = resolver; });
  return { promise, resolve };
}

describe('FlowViewComponent readiness', () => {
  it('应由当前项目的 FlowCommandService 就绪信号因果驱动桌面流程图 aria-busy', async () => {
    const activeProjectId = signal<string | null>('project-a');
    let activeProjectGeneration = 1;
    const switchProject = (projectId: string): void => {
      activeProjectGeneration += 1;
      activeProjectId.set(projectId);
    };
    const taskA = createTask('task-a');
    const taskB = createTask('task-b');
    const tasks = signal<Task[]>([taskA]);
    const uiState = {
      activeView: signal<'text' | 'flow'>('flow'),
      isFlowDetailOpen: signal(false),
      isMobile: signal(false),
    };
    const diagram = {
      diagramInstance: null,
      error: signal<string | null>(null),
      isInitialized: false,
      updateDiagram: vi.fn(),
    };
    const link = {
      activate: vi.fn(),
      connectionEditorData: signal(null),
      connectionEditorPos: signal({ x: 0, y: 0 }),
      getConnectionTasks: vi.fn(() => []),
      isHintOnlyStartupReadOnly: signal(false),
      isLinkMode: signal(false),
      linkActionMenu: signal(null),
      linkDeleteHint: signal(null),
      linkSourceTask: signal(null),
      linkTypeDialog: signal(null),
    };
    const effectRef = { destroy: vi.fn() };
    const diagramEffects = {
      createCenterCommandEffect: vi.fn(() => effectRef),
      createConnectionsEffect: vi.fn(() => effectRef),
      createExternalSourceLinksEffect: vi.fn(() => effectRef),
      createRelationDisplayEffect: vi.fn(() => effectRef),
      createRetryCommandEffect: vi.fn(() => effectRef),
      createSearchEffect: vi.fn(() => effectRef),
      createSelectionSyncEffect: vi.fn(() => effectRef),
      createTasksEffect: vi.fn(() => effectRef),
      createThemeEffect: vi.fn(() => effectRef),
      scheduleRafDiagramUpdate: vi.fn(),
    };
    const addChild = deferred<string | null>();
    const archive = deferred<'active' | 'archived' | null>();
    const remove = deferred<boolean>();
    const taskOps = {
      addChildTask: vi.fn(() => addChild.promise),
      addSiblingTask: vi.fn(async () => 'sibling-a'),
      archiveTask: vi.fn(() => archive.promise),
      deleteTask: vi.fn(() => remove.promise),
      focusTitleInput: vi.fn(),
      hasChildren: vi.fn(() => false),
    };

    await TestBed.configureTestingModule({
      imports: [FlowViewComponent],
      providers: [
        { provide: UiStateService, useValue: uiState },
        {
          provide: ProjectStateService,
          useValue: {
            activeProjectId,
            getTask: vi.fn(() => taskA),
            tasks,
            captureActiveProjectOwner: () => ({ projectId: activeProjectId(), generation: activeProjectGeneration }),
            isActiveProjectOwnerCurrent: (owner: { projectId: string | null; generation: number }) => (
              owner.projectId === activeProjectId() && owner.generation === activeProjectGeneration
            ),
          },
        },
        { provide: LoggerService, useValue: { category: vi.fn(() => ({ debug: vi.fn(), warn: vi.fn() })) } },
        { provide: FlowDiagramService, useValue: diagram },
        { provide: FlowLogicExportService, useValue: {} },
        { provide: FlowZoomService, useValue: {} },
        { provide: FlowSelectionService, useValue: { markDestroyed: vi.fn() } },
        { provide: FlowLayoutService, useValue: {} },
        { provide: FlowDragDropService, useValue: { isDropTargetActive: signal(false) } },
        {
          provide: FlowTouchService,
          useValue: { activate: vi.fn(), draggingId: signal(null), uninstallDiagramDragGhostListeners: vi.fn() },
        },
        { provide: FlowLinkService, useValue: link },
        { provide: FlowTaskOperationsService, useValue: taskOps },
        { provide: FlowSwipeGestureService, useValue: {} },
        { provide: FlowCascadeAssignService, useValue: { dialogData: signal(null) } },
        { provide: FlowKeyboardService, useValue: {} },
        { provide: FlowPaletteResizeService, useValue: {} },
        { provide: FlowBatchDeleteService, useValue: { dialogData: signal(null) } },
        { provide: FlowSelectModeService, useValue: { isSelectMode: signal(false) } },
        { provide: FlowMobileDrawerService, useValue: { setupDrawerEffects: vi.fn(() => []) } },
        { provide: FlowDiagramEffectsService, useValue: diagramEffects },
        { provide: FlowEventRegistrationService, useValue: {} },
        { provide: FlowViewCleanupService, useValue: { performCleanup: vi.fn() } },
        {
          provide: FlowDiagramRetryService,
          useValue: {
            getIdleInitHandle: vi.fn(() => null),
            hasReachedRetryLimit: signal(false),
            isRetrying: signal(false),
            resetState: vi.fn(),
            scheduleDiagramInit: vi.fn(),
          },
        },
        { provide: FlowViewCloudSaveService, useValue: {} },
      ],
    })
      .overrideComponent(FlowViewComponent, {
        set: {
          imports: [CommonModule, FormsModule],
          schemas: [NO_ERRORS_SCHEMA],
        },
      })
      .compileComponents();

    const flowCommand = TestBed.inject(FlowCommandService);
    flowCommand.markViewDestroyed();
    const fixture = TestBed.createComponent(FlowViewComponent);
    fixture.detectChanges();

    const diagramHost = fixture.nativeElement.querySelector('[data-testid="flow-diagram"]') as HTMLElement | null;
    expect(diagramHost).not.toBeNull();
    expect(diagramHost?.getAttribute('aria-busy')).toBe('true');

    flowCommand.markViewReady();
    fixture.detectChanges();

    expect(diagramHost?.getAttribute('aria-busy')).toBe('false');

    switchProject('project-b');
    fixture.detectChanges();

    expect(diagramHost?.getAttribute('aria-busy')).toBe('true');

    flowCommand.markViewReady({ projectId: 'project-a', generation: 1 });
    fixture.detectChanges();

    expect(diagramHost?.getAttribute('aria-busy')).toBe('true');

    flowCommand.markViewReady({ projectId: 'project-b', generation: activeProjectGeneration });
    fixture.detectChanges();

    expect(diagramHost?.getAttribute('aria-busy')).toBe('false');

    flowCommand.markViewDestroyed();
    fixture.detectChanges();

    expect(diagramHost?.getAttribute('aria-busy')).toBe('true');

    switchProject('project-a');
    tasks.set([taskA]);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    component.selectedTaskId.set(taskA.id);
    component.deleteTask(taskA);
    component.deleteKeepChildren.set(true);
    switchProject('project-b');
    tasks.set([taskB]);
    fixture.detectChanges();

    expect.soft(component.selectedTaskId()).toBeNull();
    expect.soft(component.selectedTask()).toBeNull();
    expect.soft(component.deleteConfirmTask()).toBeNull();
    expect.soft(component.deleteKeepChildren()).toBe(false);

    activeProjectId.set('project-a');
    tasks.set([taskA, taskB]);
    fixture.detectChanges();
    component.selectedTaskId.set(taskA.id);
    const addPending = component.addChildTask(taskA);
    component.selectedTaskId.set(taskB.id);
    await component.addSiblingTask(taskA);
    component.selectedTaskId.set(taskA.id);
    addChild.resolve('child-a');
    await addPending;

    expect.soft(component.selectedTaskId()).toBe(taskA.id);
    expect.soft(taskOps.focusTitleInput).not.toHaveBeenCalled();
    expect.soft(taskOps.addSiblingTask).not.toHaveBeenCalled();

    component.selectedTaskId.set(taskA.id);
    const archivePending = component.archiveTask(taskA);
    component.deleteTask(taskA);
    const deletePending = component.confirmDelete(false);
    component.selectedTaskId.set(taskB.id);
    component.deleteTask(taskB);
    const replacementA = { ...taskA, title: 'Current A' };
    tasks.set([replacementA, taskB]);
    component.selectedTaskId.set(replacementA.id);
    component.deleteTask(replacementA);
    archive.resolve('archived');
    remove.resolve(true);
    await Promise.all([archivePending, deletePending]);

    expect.soft(component.selectedTaskId()).toBe(replacementA.id);
    expect.soft(component.deleteConfirmTask()).toBe(replacementA);
    expect.soft(diagram.updateDiagram).not.toHaveBeenCalled();
    component.selectedTaskId.set(taskB.id);
    component.parkTaskAction(taskA);
    expect.soft(component.selectedTaskId()).toBe(taskB.id);
    component.parkTaskAction(taskB);
    expect.soft(component.selectedTaskId()).toBeNull();
    fixture.destroy();
  });
});

describe('flow-view.component.html', () => {
  it('应在移动端/桌面端条件分支之外共享渲染连接浮层宿主', () => {
    const templatePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.html');
    const template = readFileSync(templatePath, 'utf8');
    const sharedMarker = '<!-- 共享连接浮层（移动端与桌面端共用） -->';
    const sharedMarkerIndex = template.indexOf(sharedMarker);

    expect(template).toMatch(/<\/div>\s*\n}\s*\n\s*<!-- 共享连接浮层（移动端与桌面端共用） -->/);
    expect(sharedMarkerIndex).toBeGreaterThan(-1);

    const sharedSection = template.slice(sharedMarkerIndex);
    expect(sharedSection).toContain('<app-flow-link-delete-hint');
    expect(sharedSection).toContain('<app-flow-link-action-menu');
    expect(sharedSection).toContain('<app-flow-connection-editor');
    expect(sharedSection).toContain('(close)="requestConnectionEditorClose()"');
    expect(sharedSection).toContain('<app-flow-link-type-dialog');
    expect(template.match(/\(parkTask\)="parkTaskAction\(\$event\)"/g) ?? []).toHaveLength(2);
  });

  it('应把 hint-only 只读态透传给连接编辑器', () => {
    const templatePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.html');
    const template = readFileSync(templatePath, 'utf8');

    expect(template).toContain('[readOnly]="link.isHintOnlyStartupReadOnly()"');
  });

  it('应将 flow 侧任务链接输出绑定到中心定位逻辑', () => {
    const templatePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.html');
    const template = readFileSync(templatePath, 'utf8');

    expect(template).toContain('(openLinkedTask)="centerOnNode($event)"');
    expect(template).toContain('(openTask)="centerOnNode($event)"');
  });

  it('应将两个任务详情僚机注意输出绑定到保存链路', () => {
    const templatePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.html');
    const template = readFileSync(templatePath, 'utf8');
    const attentionBindings = template.match(/\(attentionChange\)="taskDetailPersistence\.persistAttentionItems\(\$event\)"/g) ?? [];

    expect(attentionBindings).toHaveLength(2);
  });

  it('任务详情可变更输出不应在模板中直接丢弃异步持久化结果', () => {
    const templatePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.html');
    const template = readFileSync(templatePath, 'utf8');

    expect(template).not.toMatch(/\)="taskOps\.(updateTaskTitle|updateTaskContent|updateTaskPriority|updateTaskDueDate|addTaskTag|removeTaskTag|toggleTaskStatus|addQuickTodo|addTaskAttachment|removeTaskAttachment|updateTaskAttachments)\(/);
    expect(template.match(/\(titleChange\)="taskDetailPersistence\.persistTitle\(\$event\)"/g) ?? []).toHaveLength(2);
    expect(template.match(/\(contentChange\)="taskDetailPersistence\.persistContent\(\$event\)"/g) ?? []).toHaveLength(2);
    expect(template.match(/\(quickTodoAdd\)="taskDetailPersistence\.persistQuickTodo\(\$event\)"/g) ?? []).toHaveLength(2);
    expect(template.match(/\(attachmentsChange\)="taskDetailPersistence\.persistAttachments\(\$event\)"/g) ?? []).toHaveLength(2);
  });

  it('移动端与桌面端应复用统一 Overview 面板，不再复制小地图外壳', () => {
    const templatePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.html');
    const template = readFileSync(templatePath, 'utf8');

    expect(template.match(/<app-flow-overview-panel/g) ?? []).toHaveLength(2);
    expect(template).not.toContain('<app-flow-minimap');
    expect(template).not.toContain('#overviewDiv');
    expect(template.match(/\(legacyOverviewHostChange\)="onLegacyOverviewHostChange\(\$event\)"/g) ?? [])
      .toHaveLength(2);
    expect(template).toContain('(close)="requestConnectionEditorClose()"');
  });
});

describe('flow-view.component.ts', () => {
  it('应仅在连接操作成功时刷新流程图', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('private readonly linkActions = new FlowViewLinkActionsController');
    expect(source).toContain('refreshDiagram: () => this.refreshDiagram()');
    expect(source).toContain('getConnectionEditorSessionIdentity: () => this.connectionEditor()?.sessionIdentity() ?? null');
    expect(source).toContain('this.linkActions.confirmParentChildLink();');
    expect(source).toContain('await this.linkActions.saveConnectionDescription(data);');
  });

  it('任务详情保存应委托给专用持久化 controller', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('readonly taskDetailPersistence = new FlowViewTaskDetailPersistenceController');
    expect(source).not.toMatch(/this\.taskOps\.(updateTaskAttentionItems|updateTaskTitle|updateTaskContent|updateTaskPriority|updateTaskDueDate|addTaskTag|removeTaskTag|toggleTaskStatus|addQuickTodo|addTaskAttachment|removeTaskAttachment|updateTaskAttachments)\(/);
    expect(source).not.toContain('private async persistTaskDetailMutation');
  });

  it('应把流程图链接跳转委托给导航 controller', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain('private readonly navigation = new FlowViewNavigationController');
    expect(source).toContain('getTask: taskId => this.projectState.getTask(taskId)');
    expect(source).toContain('warn: (message, context) => this.logger.warn(message, context)');
    expect(source).toContain('this.navigation.centerOnNode(taskId, openDetail);');
  });

  it('重建 Flow 视图时应重新激活被清理的 root 单例交互服务', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');
    const afterViewInit = source.match(/ngAfterViewInit\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

    expect(afterViewInit).toContain('this.touch.activate();');
    expect(afterViewInit).toContain('this.link.activate();');
  });

  it('待分配 touch 未成功启动时不应安装 document 级全局监听', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');
    const handler = source.match(/onUnassignedTouchStart\(event: TouchEvent, task: Task\): void \{[\s\S]*?\n  \}/)?.[0] ?? '';

    expect(handler).toContain('if (!this.touch.startTouch(event, task)) {');
    expect(handler).toMatch(/if \(!this\.touch\.startTouch\(event, task\)\) \{[\s\S]*?return;[\s\S]*?\}\s*this\.unassignedTouchDrop\.installGlobalListeners\(\);/);
  });

  it('快捷键触发的流程图刷新应等待异步操作完成', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');
    const handler = source.match(/handleDiagramShortcut\(event: KeyboardEvent\): void \{[\s\S]*?\n  \}/)?.[0] ?? '';

    expect(handler).toContain("if (result.status !== 'handled') {");
    expect(handler).toContain('void result.completed.then(');
    expect(handler).not.toContain("result === 'handled'");
  });

  it('应把统一面板交付的 legacy 容器转交给生命周期 controller', () => {
    const sourcePath = join(process.cwd(), 'src/app/features/flow/components/flow-view.component.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).toContain("import { FlowOverviewPanelComponent } from './flow-overview-panel.component';");
    expect(source).toContain('readonly legacyOverviewHost = signal<ElementRef | undefined>(undefined);');
    expect(source).toContain('overviewDiv: () => this.legacyOverviewHost()');
    expect(source).toContain('this.diagramLifecycle.handleLegacyOverviewHostChange(host);');
  });
});
