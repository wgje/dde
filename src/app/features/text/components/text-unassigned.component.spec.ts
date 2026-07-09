import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextUnassignedComponent } from './text-unassigned.component';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ToastService } from '../../../../services/toast.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { ParkingService } from '../../../../services/parking.service';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { SimpleReminderService } from '../../../../services/simple-reminder.service';
import { UserSessionService } from '../../../../services/user-session.service';
import type { Task } from '../../../../models';

describe('TextUnassignedComponent', () => {
  let fixture: ComponentFixture<TextUnassignedComponent>;
  let component: TextUnassignedComponent;

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: '原始标题',
    content: '',
    status: 'active',
    stage: null,
    order: 0,
    parentId: null,
    rank: 0,
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    displayId: '1,a',
    attachments: [],
    tags: [],
    parkingMeta: null,
    ...overrides,
  });

  const tasks = signal<Task[]>([]);
  const mockTaskAdapter = {
    updateTaskTitle: vi.fn(),
    updateTaskContent: vi.fn(),
    updateTaskDraft: vi.fn(),
    deleteTask: vi.fn(),
    moveTaskToStage: vi.fn(() => ({ ok: true })),
  };
  const mockUiState = {
    isTextSidebarVisible: signal(true),
    isTextUnassignedOpen: signal(true),
    toggleTextUnassignedOpen: vi.fn(),
    setTextUnassignedOpen: vi.fn((open: boolean) => mockUiState.isTextUnassignedOpen.set(open)),
    hasTextUnassignedOpenPreference: vi.fn(() => true),
  };
  const mockProjectState = {
    unassignedTasks: tasks,
    getTask: vi.fn((taskId: string) => tasks().find(task => task.id === taskId) ?? null),
  };
  const mockParkingService = {
    parkTask: vi.fn().mockResolvedValue(true),
  };
  const mockDockEngine = {
    dockTask: vi.fn(() => true),
  };
  const mockReminderService = {
    setReminder: vi.fn().mockResolvedValue(true),
    cancelReminder: vi.fn().mockResolvedValue(true),
  };
  const mockToast = {
    info: vi.fn(),
    warning: vi.fn(),
  };
  const mockUserSession = {
    isHintOnlyStartupPlaceholderVisible: vi.fn(() => false),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tasks.set([createTask()]);
    mockTaskAdapter.updateTaskTitle.mockResolvedValue(true);
    mockTaskAdapter.updateTaskContent.mockResolvedValue(true);
    mockTaskAdapter.updateTaskDraft.mockResolvedValue(true);
    mockTaskAdapter.deleteTask.mockResolvedValue(true);
    mockTaskAdapter.moveTaskToStage.mockResolvedValue({ ok: true });
    mockUiState.isTextSidebarVisible.set(true);
    mockUiState.isTextUnassignedOpen.set(true);
    mockUiState.toggleTextUnassignedOpen.mockImplementation(() => {
      mockUiState.isTextUnassignedOpen.set(!mockUiState.isTextUnassignedOpen());
    });
    mockUiState.setTextUnassignedOpen.mockImplementation((open: boolean) => {
      mockUiState.isTextUnassignedOpen.set(open);
    });
    mockUiState.hasTextUnassignedOpenPreference.mockReturnValue(true);
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(false);
    mockProjectState.getTask.mockImplementation((taskId: string) => tasks().find(task => task.id === taskId) ?? null);
    mockReminderService.setReminder.mockResolvedValue(true);
    mockReminderService.cancelReminder.mockResolvedValue(true);
    mockParkingService.parkTask.mockResolvedValue(true);

    await TestBed.configureTestingModule({
      imports: [TextUnassignedComponent],
      providers: [
        { provide: TaskOperationAdapterService, useValue: mockTaskAdapter },
        { provide: UiStateService, useValue: mockUiState },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: ParkingService, useValue: mockParkingService },
        { provide: DockEngineService, useValue: mockDockEngine },
        { provide: SimpleReminderService, useValue: mockReminderService },
        { provide: ToastService, useValue: mockToast },
        { provide: UserSessionService, useValue: mockUserSession },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(TextUnassignedComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('成功的待分配重挂载不应重放合成 dragStart（避免拖拽状态永不结束）', async () => {
    const dragged = createTask({ id: 'drag-source', stage: null });
    const target = createTask({ id: 'drop-target', stage: null });
    tasks.set([dragged, target]);
    const dragStartSpy = vi.fn();
    component.dragStart.subscribe(dragStartSpy);

    const dataTransfer = {
      getData: vi.fn((mime: string) => {
        if (mime === 'application/x-nanoflow-task' || mime === 'application/json') {
          return JSON.stringify({
            v: 1,
            type: 'task',
            taskId: 'drag-source',
            projectId: 'project-1',
            source: 'text',
          });
        }
        return '';
      }),
    };
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      dataTransfer,
    } as unknown as DragEvent;

    await (component as unknown as {
      handleDropUnassigned: (event: DragEvent) => Promise<void>;
    }).handleDropUnassigned(event);

    expect(mockTaskAdapter.moveTaskToStage).toHaveBeenCalledWith('drag-source', null, undefined, 'drop-target');
    // 合成 dragStart 会被父组件当成真实拖拽开始：重挂 document dragover 监听并
    // 以 clientY=0 启动自动滚动，而且没有 dragend 收尾——严禁重放
    expect(dragStartSpy).not.toHaveBeenCalled();
  });

  it('parkTaskNow should persist draft edits before parking and sync the dock', async () => {
    const task = tasks()[0]!;
    const internal = component as unknown as {
      editingTaskId: { set: (value: string | null) => void; (): string | null };
      isEditMode: { set: (value: boolean) => void; (): boolean };
      localTitle: { set: (value: string) => void };
      localContent: { set: (value: string) => void };
      reminderMenuTaskId: { set: (value: string | null) => void; (): string | null };
    };

    internal.editingTaskId.set(task.id);
    internal.isEditMode.set(true);
    internal.localTitle.set('停泊前标题');
    internal.localContent.set('停泊前正文');
    internal.reminderMenuTaskId.set(task.id);
    fixture.detectChanges();

    await (component as unknown as { parkTaskNow: (task: Task) => Promise<void> })
      .parkTaskNow(task);

    expect(mockTaskAdapter.updateTaskDraft).toHaveBeenCalledWith(task.id, {
      title: '停泊前标题',
      content: '停泊前正文',
    });
    expect(mockTaskAdapter.updateTaskTitle).not.toHaveBeenCalled();
    expect(mockTaskAdapter.updateTaskContent).not.toHaveBeenCalled();
    expect(mockParkingService.parkTask).toHaveBeenCalledWith(task.id);
    expect(mockDockEngine.dockTask).toHaveBeenCalledWith(task.id, undefined, {
      sourceSection: 'text',
      zoneSource: 'auto',
    });
    expect(internal.editingTaskId()).toBeNull();
    expect(internal.isEditMode()).toBe(false);
    expect(internal.reminderMenuTaskId()).toBeNull();
  });

  it('should persist active draft before destroy clears edit state', () => {
    const task = tasks()[0]!;
    const internal = component as unknown as {
      editingTaskId: { set: (value: string | null) => void };
      isEditMode: { set: (value: boolean) => void };
      localTitle: { set: (value: string) => void };
      localContent: { set: (value: string) => void };
    };

    internal.editingTaskId.set(task.id);
    internal.isEditMode.set(true);
    internal.localTitle.set('销毁前标题');
    internal.localContent.set('销毁前正文');

    component.ngOnDestroy();

    expect(mockTaskAdapter.updateTaskDraft).toHaveBeenCalledWith(task.id, {
      title: '销毁前标题',
      content: '销毁前正文',
    });
    expect(mockTaskAdapter.updateTaskTitle).not.toHaveBeenCalled();
    expect(mockTaskAdapter.updateTaskContent).not.toHaveBeenCalled();
  });

  it('resetEditState should persist active draft before clearing edit state', async () => {
    const task = tasks()[0]!;
    const internal = component as unknown as {
      editingTaskId: { set: (value: string | null) => void; (): string | null };
      isEditMode: { set: (value: boolean) => void; (): boolean };
      localTitle: { set: (value: string) => void };
      localContent: { set: (value: string) => void };
    };

    internal.editingTaskId.set(task.id);
    internal.isEditMode.set(true);
    internal.localTitle.set('重置前标题');
    internal.localContent.set('重置前正文');

    const cleared = await component.resetEditState();

    expect(cleared).toBe(true);
    expect(mockTaskAdapter.updateTaskDraft).toHaveBeenCalledWith(task.id, {
      title: '重置前标题',
      content: '重置前正文',
    });
    expect(mockTaskAdapter.updateTaskTitle).not.toHaveBeenCalled();
    expect(mockTaskAdapter.updateTaskContent).not.toHaveBeenCalled();
    expect(internal.editingTaskId()).toBeNull();
    expect(internal.isEditMode()).toBe(false);
  });

  it('should disable the park button when the task is already parked', () => {
    tasks.set([
      createTask({
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      }),
    ]);
    const task = tasks()[0]!;
    const internal = component as unknown as {
      editingTaskId: { set: (value: string | null) => void };
      isEditMode: { set: (value: boolean) => void };
    };
    internal.editingTaskId.set(task.id);
    internal.isEditMode.set(true);
    fixture.detectChanges();

    const parkButton = fixture.nativeElement.querySelector('[data-testid="text-unassigned-park-button"]') as HTMLButtonElement | null;
    expect(parkButton?.disabled).toBe(true);
  });

  it('should preserve the unassigned panel preference when task count changes', () => {
    mockUiState.isTextUnassignedOpen.set(true);
    tasks.set([]);
    fixture.detectChanges();

    expect(mockUiState.isTextUnassignedOpen()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('无待分配任务');

    mockUiState.isTextUnassignedOpen.set(false);

    tasks.set([createTask({ id: 'restored-task' })]);
    fixture.detectChanges();

    expect(mockUiState.isTextUnassignedOpen()).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-unassigned-task="restored-task"]')).toBeNull();
  });

  it('should open the unassigned panel for creation without storing a panel preference', () => {
    const internal = component as unknown as {
      createUnassigned: { emit: () => void };
    };
    const emitSpy = vi.spyOn(internal.createUnassigned, 'emit');
    mockUiState.isTextUnassignedOpen.set(false);
    fixture.detectChanges();

    const createButton = fixture.nativeElement.querySelector('[data-testid="add-task-btn"]') as HTMLButtonElement | null;
    createButton?.click();

    expect(mockUiState.isTextUnassignedOpen()).toBe(true);
    expect(mockUiState.setTextUnassignedOpen).not.toHaveBeenCalled();
    expect(mockUiState.toggleTextUnassignedOpen).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledOnce();
  });

  it('should block parking while hint-only startup placeholder is read-only', () => {
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

    (component as unknown as {
      parkTaskNow: (task: Task) => void;
    }).parkTaskNow(tasks()[0]!);

    expect(mockParkingService.parkTask).not.toHaveBeenCalled();
    expect(mockDockEngine.dockTask).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '停泊任务暂不可用，owner 确认完成前保持只读');
  });

  it('should block reminder changes while hint-only startup placeholder is read-only', async () => {
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

    await (component as unknown as {
      setReminderPreset: (taskId: string, minutes: number) => Promise<void>;
    }).setReminderPreset('task-1', 5);

    expect(mockReminderService.setReminder).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '设置提醒暂不可用，owner 确认完成前保持只读');
  });

  it('should persist active draft before setting a reminder', async () => {
    const task = createTask({
      parkingMeta: {
        state: 'parked',
        parkedAt: new Date().toISOString(),
        lastVisitedAt: new Date().toISOString(),
        contextSnapshot: null,
        reminder: null,
        pinned: false,
      },
    });
    tasks.set([task]);
    const internal = component as unknown as {
      setReminderPreset: (taskId: string, minutes: number) => Promise<void>;
      editingTaskId: { set: (value: string | null) => void; (): string | null };
      isEditMode: { set: (value: boolean) => void; (): boolean };
      localTitle: { set: (value: string) => void; (): string };
      localContent: { set: (value: string) => void; (): string };
      reminderMenuTaskId: { set: (value: string | null) => void; (): string | null };
    };

    internal.editingTaskId.set(task.id);
    internal.isEditMode.set(true);
    internal.localTitle.set('提醒前标题');
    internal.localContent.set('提醒前正文');
    internal.reminderMenuTaskId.set(task.id);

    await internal.setReminderPreset(task.id, 5);

    expect(mockTaskAdapter.updateTaskDraft).toHaveBeenCalledWith(task.id, {
      title: '提醒前标题',
      content: '提醒前正文',
    });
    expect(mockTaskAdapter.updateTaskTitle).not.toHaveBeenCalled();
    expect(mockTaskAdapter.updateTaskContent).not.toHaveBeenCalled();
    expect(mockReminderService.setReminder).toHaveBeenCalledWith(task.id, expect.any(String));
    expect(internal.editingTaskId()).toBe(task.id);
    expect(internal.isEditMode()).toBe(true);
    expect(internal.localTitle()).toBe('提醒前标题');
    expect(internal.localContent()).toBe('提醒前正文');
    expect(internal.reminderMenuTaskId()).toBeNull();
  });

  it('should not set a reminder when active draft persistence fails', async () => {
    mockTaskAdapter.updateTaskDraft.mockResolvedValueOnce(false);
    const task = createTask({
      parkingMeta: {
        state: 'parked',
        parkedAt: new Date().toISOString(),
        lastVisitedAt: new Date().toISOString(),
        contextSnapshot: null,
        reminder: null,
        pinned: false,
      },
    });
    tasks.set([task]);
    const internal = component as unknown as {
      setReminderPreset: (taskId: string, minutes: number) => Promise<void>;
      editingTaskId: { set: (value: string | null) => void; (): string | null };
      isEditMode: { set: (value: boolean) => void; (): boolean };
      localTitle: { set: (value: string) => void; (): string };
      localContent: { set: (value: string) => void; (): string };
      reminderMenuTaskId: { set: (value: string | null) => void; (): string | null };
    };

    internal.editingTaskId.set(task.id);
    internal.isEditMode.set(true);
    internal.localTitle.set('提醒失败标题');
    internal.localContent.set('提醒失败正文');
    internal.reminderMenuTaskId.set(task.id);

    await internal.setReminderPreset(task.id, 5);

    expect(mockTaskAdapter.updateTaskDraft).toHaveBeenCalledWith(task.id, {
      title: '提醒失败标题',
      content: '提醒失败正文',
    });
    expect(mockTaskAdapter.updateTaskTitle).not.toHaveBeenCalled();
    expect(mockTaskAdapter.updateTaskContent).not.toHaveBeenCalled();
    expect(mockReminderService.setReminder).not.toHaveBeenCalled();
    expect(internal.editingTaskId()).toBe(task.id);
    expect(internal.isEditMode()).toBe(true);
    expect(internal.localTitle()).toBe('提醒失败标题');
    expect(internal.localContent()).toBe('提醒失败正文');
    expect(internal.reminderMenuTaskId()).toBe(task.id);
  });

  it('should block entering edit mode while hint-only startup placeholder is read-only', () => {
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

    (component as unknown as {
      enterEdit: (task: Task) => void;
      editingTaskId: { (): string | null };
      isEditMode: { (): boolean };
    }).enterEdit(tasks()[0]!);

    const internal = component as unknown as {
      editingTaskId: { (): string | null };
      isEditMode: { (): boolean };
    };
    expect(internal.editingTaskId()).toBeNull();
    expect(internal.isEditMode()).toBe(false);
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '编辑任务暂不可用，owner 确认完成前保持只读');
  });

  it('should keep local draft visible when save is blocked by hint-only startup placeholder', async () => {
    mockUserSession.isHintOnlyStartupPlaceholderVisible.mockReturnValue(true);

    const internal = component as unknown as {
      saveTask: (task: Task) => Promise<boolean>;
      editingTaskId: { set: (value: string | null) => void; (): string | null };
      isEditMode: { set: (value: boolean) => void; (): boolean };
      localTitle: { set: (value: string) => void; (): string };
      localContent: { set: (value: string) => void; (): string };
    };

    internal.editingTaskId.set('task-1');
    internal.isEditMode.set(true);
    internal.localTitle.set('未保存标题');
    internal.localContent.set('未保存正文');

    const saved = await internal.saveTask(tasks()[0]!);

    expect(saved).toBe(false);
    expect(mockTaskAdapter.updateTaskDraft).not.toHaveBeenCalled();
    expect(mockTaskAdapter.updateTaskTitle).not.toHaveBeenCalled();
    expect(mockTaskAdapter.updateTaskContent).not.toHaveBeenCalled();
    expect(internal.editingTaskId()).toBe('task-1');
    expect(internal.isEditMode()).toBe(true);
    expect(internal.localTitle()).toBe('未保存标题');
    expect(internal.localContent()).toBe('未保存正文');
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '编辑任务暂不可用，owner 确认完成前保持只读');
  });

  it('should keep local draft visible when durable save fails', async () => {
    mockTaskAdapter.updateTaskDraft.mockResolvedValueOnce(false);

    const internal = component as unknown as {
      saveTask: (task: Task) => Promise<boolean>;
      editingTaskId: { set: (value: string | null) => void; (): string | null };
      isEditMode: { set: (value: boolean) => void; (): boolean };
      localTitle: { set: (value: string) => void; (): string };
      localContent: { set: (value: string) => void; (): string };
    };

    internal.editingTaskId.set('task-1');
    internal.isEditMode.set(true);
    internal.localTitle.set('离线失败标题');
    internal.localContent.set('离线失败正文');

    const saved = await internal.saveTask(tasks()[0]!);

    expect(saved).toBe(false);
    expect(mockTaskAdapter.updateTaskDraft).toHaveBeenCalledWith('task-1', {
      title: '离线失败标题',
      content: '离线失败正文',
    });
    expect(mockTaskAdapter.updateTaskTitle).not.toHaveBeenCalled();
    expect(mockTaskAdapter.updateTaskContent).not.toHaveBeenCalled();
    expect(internal.editingTaskId()).toBe('task-1');
    expect(internal.isEditMode()).toBe(true);
    expect(internal.localTitle()).toBe('离线失败标题');
    expect(internal.localContent()).toBe('离线失败正文');
  });

  it('should park only after draft edits are durably saved', async () => {
    mockTaskAdapter.updateTaskDraft.mockResolvedValueOnce(false);
    const task = tasks()[0]!;
    const internal = component as unknown as {
      parkTaskNow: (task: Task) => Promise<boolean>;
      editingTaskId: { set: (value: string | null) => void; (): string | null };
      isEditMode: { set: (value: boolean) => void; (): boolean };
      localTitle: { set: (value: string) => void };
      localContent: { set: (value: string) => void };
    };

    internal.editingTaskId.set(task.id);
    internal.isEditMode.set(true);
    internal.localTitle.set('停泊前标题');
    internal.localContent.set('停泊前正文');

    const parked = await internal.parkTaskNow(task);

    expect(parked).toBe(false);
    expect(mockTaskAdapter.updateTaskDraft).toHaveBeenCalledWith(task.id, {
      title: '停泊前标题',
      content: '停泊前正文',
    });
    expect(mockTaskAdapter.updateTaskTitle).not.toHaveBeenCalled();
    expect(mockTaskAdapter.updateTaskContent).not.toHaveBeenCalled();
    expect(mockParkingService.parkTask).not.toHaveBeenCalled();
    expect(mockDockEngine.dockTask).not.toHaveBeenCalled();
    expect(internal.editingTaskId()).toBe(task.id);
    expect(internal.isEditMode()).toBe(true);
  });

  it('should keep edit state when delete local persistence fails', async () => {
    mockTaskAdapter.deleteTask.mockResolvedValueOnce(false);
    const internal = component as unknown as {
      deleteTask: (taskId: string) => Promise<boolean>;
      editingTaskId: { set: (value: string | null) => void; (): string | null };
      isEditMode: { set: (value: boolean) => void; (): boolean };
      localTitle: { set: (value: string) => void; (): string };
      localContent: { set: (value: string) => void; (): string };
    };

    internal.editingTaskId.set('task-1');
    internal.isEditMode.set(true);
    internal.localTitle.set('删除前标题');
    internal.localContent.set('删除前正文');

    const deleted = await internal.deleteTask('task-1');

    expect(deleted).toBe(false);
    expect(mockTaskAdapter.deleteTask).toHaveBeenCalledWith('task-1');
    expect(internal.editingTaskId()).toBe('task-1');
    expect(internal.isEditMode()).toBe(true);
    expect(internal.localTitle()).toBe('删除前标题');
    expect(internal.localContent()).toBe('删除前正文');
  });

  it('should report todo checkbox durable persistence failure without entering edit mode', async () => {
    const task = createTask({ content: '- [ ] 本地优先' });
    tasks.set([task]);
    mockTaskAdapter.updateTaskContent.mockResolvedValueOnce(false);
    const internal = component as unknown as {
      onContentPreviewClick: (event: MouseEvent, task: Task) => Promise<boolean>;
      editingTaskId: { (): string | null };
      isEditMode: { (): boolean };
    };
    const checkbox = document.createElement('span');
    checkbox.setAttribute('data-todo-index', '0');
    const stopPropagation = vi.fn();

    const saved = await internal.onContentPreviewClick(
      { target: checkbox, stopPropagation } as unknown as MouseEvent,
      task,
    );

    expect(saved).toBe(false);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(mockTaskAdapter.updateTaskContent).toHaveBeenCalledWith('task-1', '- [x] 本地优先');
    expect(internal.editingTaskId()).toBeNull();
    expect(internal.isEditMode()).toBe(false);
  });

  it('should emit openLinkedTask when clicking a task markdown link in preview', () => {
    const internal = component as unknown as {
      onContentPreviewClick: (event: MouseEvent, task: Task) => void;
      editingTaskId: { (): string | null };
      openLinkedTask: { emit: ReturnType<typeof vi.fn> };
    };
    const emitSpy = vi.spyOn(internal.openLinkedTask, 'emit');
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#task:linked-task');
    anchor.setAttribute('data-link-kind', 'task');
    anchor.setAttribute('data-task-link-id', 'linked-task');
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();
    const event = { target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent;

    internal.onContentPreviewClick(event, tasks()[0]!);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith({ taskId: 'linked-task', event });
    expect(internal.editingTaskId()).toBeNull();
  });

  it('should keep preview mode when clicking an external markdown link in preview', () => {
    const internal = component as unknown as {
      onContentPreviewClick: (event: MouseEvent, task: Task) => void;
      editingTaskId: { (): string | null };
    };
    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'https://example.com');
    anchor.setAttribute('data-link-kind', 'external');
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();

    internal.onContentPreviewClick({ target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent, tasks()[0]!);

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(internal.editingTaskId()).toBeNull();
  });

  it('should block unsafe markdown links without entering edit mode', () => {
    const internal = component as unknown as {
      onContentPreviewClick: (event: MouseEvent, task: Task) => void;
      editingTaskId: { (): string | null };
      openLinkedTask: { emit: ReturnType<typeof vi.fn> };
    };
    const emitSpy = vi.spyOn(internal.openLinkedTask, 'emit');
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#__nf_blocked__');
    anchor.setAttribute('data-link-kind', 'blocked');
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();

    internal.onContentPreviewClick({ target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent, tasks()[0]!);

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(emitSpy).not.toHaveBeenCalled();
    expect(internal.editingTaskId()).toBeNull();
  });

  it('should handle local markdown links without entering edit mode', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      const internal = component as unknown as {
        onContentPreviewClick: (event: MouseEvent, task: Task) => void;
        editingTaskId: { (): string | null };
      };
      const anchor = document.createElement('a');
      anchor.setAttribute('href', '#local-path');
      anchor.setAttribute('data-link-kind', 'local');
      anchor.setAttribute('data-local-link-path', 'C:\\Docs\\Plan.md');
      const stopPropagation = vi.fn();
      const preventDefault = vi.fn();

      internal.onContentPreviewClick({ target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent, tasks()[0]!);
      await Promise.resolve();

      expect(stopPropagation).toHaveBeenCalledTimes(1);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(internal.editingTaskId()).toBeNull();
      expect(writeText).toHaveBeenCalledWith('C:\\Docs\\Plan.md');
      expect(clickSpy).toHaveBeenCalled();
    } finally {
      clickSpy.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        Reflect.deleteProperty(navigator as object, 'clipboard');
      }
    }
  });
});
