import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { FlowTaskDetailComponent } from './flow-task-detail.component';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { LoggerService } from '../../../../services/logger.service';
import { FlowTaskOperationsService } from '../services/flow-task-operations.service';
import { disablePollutionGuard, enablePollutionGuard } from '../../../../test-setup.mocks';
import { Task } from '../../../../models';

describe('FlowTaskDetailComponent - Task Switching Fix', () => {
  let component: FlowTaskDetailComponent;
  let fixture: ComponentFixture<FlowTaskDetailComponent>;
  let mockUiState: any;
  let mockProjectState: any;
  let mockUserSession: any;
  let mockChangeTracker: any;
  let mockFlowTaskOps: any;
  const defaultRequestAnimationFrame: typeof globalThis.requestAnimationFrame =
    typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : ((callback: FrameRequestCallback): number =>
          setTimeout(() => callback(Date.now()), 16) as unknown as number);
  const defaultCancelAnimationFrame: typeof globalThis.cancelAnimationFrame =
    typeof globalThis.cancelAnimationFrame === 'function'
      ? globalThis.cancelAnimationFrame.bind(globalThis)
      : ((id: number): void => {
          clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
        });
  const ensureAnimationFramePolyfill = (): void => {
    if (typeof globalThis.requestAnimationFrame !== 'function') {
      globalThis.requestAnimationFrame = defaultRequestAnimationFrame;
    }
    if (typeof globalThis.cancelAnimationFrame !== 'function') {
      globalThis.cancelAnimationFrame = defaultCancelAnimationFrame;
    }
  };

  const createMockTask = (id: string, title: string, content: string): Task => ({
    id,
    title,
    content,
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1,
    status: 'active',
    x: 0,
    y: 0,
    displayId: id,
    createdDate: '2025-12-31',
    updatedAt: '2025-12-31T00:00:00Z',
  });

  const createClickEvent = (timeStamp: number, target: HTMLElement = document.createElement('div')): MouseEvent => {
    const event = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(event, 'target', { value: target });
    Object.defineProperty(event, 'timeStamp', { value: timeStamp });
    return event;
  };

  beforeAll(() => {
    disablePollutionGuard();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockUiState = {
      markEditing: vi.fn(),
      isMobile: signal(false),
      isFlowDetailOpen: signal(true),
      activeView: signal<'text' | 'flow' | null>('flow'),
    };

    mockProjectState = {
      compressDisplayId: vi.fn((id: string) => id),
      activeProjectId: signal('project-1'),
      activeProject: signal({
        id: 'project-1',
        name: 'Test Project',
        description: '',
        tasks: [],
        connections: [],
      }),
      getTask: vi.fn((taskId: string) => {
        const proj = mockProjectState.activeProject();
        return proj?.tasks.find((t: any) => t.id === taskId) ?? null;
      }),
    };

    mockUserSession = {
      currentUserId: signal('user-1'),
    };

    mockChangeTracker = {
      lockTaskField: vi.fn(),
      unlockTaskField: vi.fn(),
    };
    (mockChangeTracker as any).constructor = { TEXT_INPUT_LOCK_TIMEOUT_MS: 3600000 };

    mockFlowTaskOps = {
      parkTask: vi.fn(),
    };

    const mockLoggerService = {
      category: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    };

    ensureAnimationFramePolyfill();

    TestBed.configureTestingModule({
      imports: [FlowTaskDetailComponent],
      providers: [
        { provide: UiStateService, useValue: mockUiState },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: UserSessionService, useValue: mockUserSession },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: FlowTaskOperationsService, useValue: mockFlowTaskOps },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    mockProjectState.activeProject.set({
      id: 'project-1',
      name: 'Test Project',
      description: '',
      tasks: [],
      connections: [],
    });

    fixture = TestBed.createComponent(FlowTaskDetailComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    if (typeof vi.isFakeTimers === 'function' && vi.isFakeTimers()) {
      if (typeof vi.clearAllTimers === 'function') {
        vi.clearAllTimers();
      }
      vi.useRealTimers();
    }

    globalThis.requestAnimationFrame = defaultRequestAnimationFrame;
    globalThis.cancelAnimationFrame = defaultCancelAnimationFrame;

    try {
      fixture?.destroy();
    } catch {
      // noop
    }
  });

  afterAll(() => {
    enablePollutionGuard();
  });

  describe('任务切换时的状态重置', () => {
    it('应该在任务 ID 变化时强制更新 localTitle 和 localContent', () => {
      const taskA = createMockTask('task-a', 'Task A', 'Content A');
      const taskB = createMockTask('task-b', 'Task B', 'Content B');

      // 手动更新输入信号并触发变更检测
      (component as any)['task'] = signal(taskA);
      fixture.detectChanges();

      expect(component['localTitle']()).toBe('Task A');
      expect(component['localContent']()).toBe('Content A');

      // 切换到任务 B
      (component as any)['task'].set(taskB);
      fixture.detectChanges();

      // 验证状态已更新
      expect(component['localTitle']()).toBe('Task B');
      expect(component['localContent']()).toBe('Content B');
    });

    it('应该在任务切换时解锁旧任务的字段', () => {
      const taskA = createMockTask('task-a', 'Task A', 'Content A');
      const taskB = createMockTask('task-b', 'Task B', 'Content B');

      // 设置任务 A
      (component as any)['task'] = signal(taskA);
      fixture.detectChanges();

      // 重置mock计数
      vi.clearAllMocks();

      // 切换到任务 B
      (component as any)['task'].set(taskB);
      fixture.detectChanges();

      // 验证旧任务的字段已解锁
      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledWith('task-a', 'project-1', 'title');
      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledWith('task-a', 'project-1', 'content');
    });

    it('应该在任务切换时清理解锁定时器', () => {
      const taskA = createMockTask('task-a', 'Task A', 'Content A');
      const taskB = createMockTask('task-b', 'Task B', 'Content B');

      // 设置任务 A
      (component as any)['task'] = signal(taskA);
      fixture.detectChanges();

      // 模拟聚焦并创建定时器
      component.onInputFocus('title');
      component.onInputBlur('title');

      // 验证定时器已创建
      expect(component.formService['unlockTimers'].size).toBe(1);

      // 切换到任务 B
      (component as any)['task'].set(taskB);
      fixture.detectChanges();

      // 验证定时器已清理
      expect(component.formService['unlockTimers'].size).toBe(0);
    });

    it('应该在任务变为 null 时重置所有状态', () => {
      const taskA = createMockTask('task-a', 'Task A', 'Content A');

      // 设置任务 A
      (component as any)['task'] = signal(taskA);
      fixture.detectChanges();

      expect(component['localTitle']()).toBe('Task A');
      expect(component['localContent']()).toBe('Content A');

      vi.clearAllMocks();

      // 设置为 null
      (component as any)['task'].set(null);
      fixture.detectChanges();

      // 验证状态已重置
      expect(component['localTitle']()).toBe('');
      expect(component['localContent']()).toBe('');
      expect(component.formService['currentTaskId']).toBeNull();
      
      // 验证字段已解锁
      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledWith('task-a', 'project-1', 'title');
      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledWith('task-a', 'project-1', 'content');
    });
    
    it('🔴 关键测试：任务切换期间不应发射变更事件（防止数据丢失）', () => {
      const taskA = createMockTask('task-a', 'Task A', 'Content A');
      const taskB = createMockTask('task-b', '', ''); // 空任务

      // 设置任务 A
      (component as any)['task'] = signal(taskA);
      fixture.detectChanges();

      // 订阅变更事件
      let titleEmitCount = 0;
      let contentEmitCount = 0;
      let lastTitleEvent: any;
      let lastContentEvent: any;
      
      component.titleChange.subscribe((event) => {
        titleEmitCount++;
        lastTitleEvent = event;
      });
      component.contentChange.subscribe((event) => {
        contentEmitCount++;
        lastContentEvent = event;
      });

      // 切换到空任务 B - 这会在 effect 中设置 isTaskSwitching = true
      // 然后设置 localTitle = '' 和 localContent = ''
      // 如果没有保护机制，ngModelChange 会发射 { taskId: 'task-b', title: '' }
      (component as any)['task'].set(taskB);
      fixture.detectChanges();

      // 验证：在任务切换期间，不应该发射任何变更事件
      // 如果这个测试失败，说明任务切换时空值被错误地发射给了新任务
      expect(titleEmitCount).toBe(0);
      expect(contentEmitCount).toBe(0);
    });
    
    it('🔴 关键测试：任务切换完成后应正常发射变更事件', async () => {
      const taskA = createMockTask('task-a', 'Task A', 'Content A');
      const taskB = createMockTask('task-b', 'Task B', 'Content B');

      // 设置任务 A
      (component as any)['task'] = signal(taskA);
      fixture.detectChanges();

      // 切换到任务 B
      (component as any)['task'].set(taskB);
      fixture.detectChanges();
      
      // 等待 queueMicrotask 完成
      await Promise.resolve();

      // 订阅变更事件
      let emittedEvent: any;
      component.titleChange.subscribe((event) => {
        emittedEvent = event;
      });

      // 现在应该可以正常发射事件
      component.onLocalTitleChange('User Input');

      expect(emittedEvent).toEqual({ taskId: 'task-b', title: 'User Input' });
    });
  });

  describe('同一任务的更新', () => {
    it('应该在内容更新且未聚焦时同步 localContent', () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');

      // 初始设置
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      expect(component['localContent']()).toBe('Content A');

      // 更新任务内容（同一任务 ID）
      const updatedTask = { ...task, content: 'Updated Content A' };
      (component as any)['task'].set(updatedTask);
      fixture.detectChanges();

      // 验证内容已同步（因为未聚焦）
      expect(component['localContent']()).toBe('Updated Content A');
    });

    it('应该在内容更新但已聚焦时保持 localContent 不变', () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');

      // 初始设置
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      // 聚焦内容输入框
      component.onInputFocus('content');
      component['localContent'].set('Local Edit');

      // 更新任务内容（模拟远程更新）
      const updatedTask = { ...task, content: 'Remote Update' };
      (component as any)['task'].set(updatedTask);
      fixture.detectChanges();

      // 验证 localContent 保持用户编辑的值（Split-Brain 防护）
      expect(component['localContent']()).toBe('Local Edit');
    });
  });

  describe('编辑模式切换', () => {
    it('应该正确切换编辑模式', async () => {
      // 使用 fake timers 避免等待真实的 350ms
      vi.useFakeTimers();
      
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      expect(component.isEditMode()).toBe(false);

      component.toggleEditMode();
      expect(component.isEditMode()).toBe(true);

      // 使用 fake timers 快进节流时间（300ms + 余量）
      await vi.advanceTimersByTimeAsync(350);

      component.toggleEditMode();
      expect(component.isEditMode()).toBe(false);
      
      vi.useRealTimers();
    });

    it('应该防止快速连续切换（节流保护）', () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      component.toggleEditMode();
      expect(component.isEditMode()).toBe(true);
      expect(component['isTogglingMode']()).toBe(true);

      // 快速再次点击应被忽略
      component.toggleEditMode();
      expect(component.isEditMode()).toBe(true); // 仍然是 true
    });

    it('编辑切换按钮只应在节流窗口内禁用', async () => {
      vi.useFakeTimers();

      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      const editButton = fixture.nativeElement.querySelector('[data-testid="flow-edit-toggle-btn"]') as HTMLButtonElement | null;
      expect(editButton?.disabled).toBe(false);

      component.toggleEditMode();
      fixture.detectChanges();
      expect(editButton?.disabled).toBe(true);

      await vi.advanceTimersByTimeAsync(300);
      fixture.detectChanges();
      expect(editButton?.disabled).toBe(false);

      vi.clearAllTimers();
      vi.useRealTimers();
    });

    it('任务切换后立刻点击预览区不应进入编辑态或卡住节流', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-11T00:00:00.000Z'));

      const taskA = createMockTask('task-a', 'Task A', 'Content A');
      const taskB = createMockTask('task-b', 'Task B', 'Content B');

      (component as any)['task'] = signal(taskA);
      fixture.detectChanges();

      (component as any)['task'].set(taskB);
      fixture.detectChanges();

      component.onPreviewClick(createClickEvent(100));

      expect(component.isEditMode()).toBe(false);
      expect(component['isTogglingMode']()).toBe(false);

      vi.useRealTimers();
    });

    it('预览区主动进入编辑态时，同一点击不应被 document:click 立即撤销', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-11T00:00:00.000Z'));

      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      vi.advanceTimersByTime(181);

      const previewClick = createClickEvent(200);
      component.onPreviewClick(previewClick);
      component.onDocumentClick(previewClick);

      expect(component.isEditMode()).toBe(true);

      vi.useRealTimers();
    });

    it('任务刚切换后的编辑按钮应确保保留编辑态，而不是把意外编辑态切回预览', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-11T00:00:00.000Z'));

      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      component.isEditMode.set(true);
      component['isTogglingMode'].set(true);

      component.onEditToggleClick();

      expect(component.isEditMode()).toBe(true);
      expect(component['isTogglingMode']()).toBe(false);

      vi.useRealTimers();
    });

    it('后续新的 document:click 仍应正常退出编辑态', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-11T00:00:00.000Z'));

      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      vi.advanceTimersByTime(181);

      component.onPreviewClick(createClickEvent(300));
      expect(component.isEditMode()).toBe(true);

      component.onDocumentClick(createClickEvent(301));
      expect(component.isEditMode()).toBe(false);
      expect(component['isTogglingMode']()).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('输入处理', () => {
    it('应该在标题变更时发射事件', async () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();
      
      // 🔴 等待 queueMicrotask 完成，确保 isTaskSwitching 标志被重置
      await Promise.resolve();

      let emittedEvent: any;
      component.titleChange.subscribe((event) => {
        emittedEvent = event;
      });

      component.onLocalTitleChange('New Title');

      expect(emittedEvent).toEqual({ taskId: 'task-a', title: 'New Title' });
      expect(component['localTitle']()).toBe('New Title');
    });

    it('应该在内容变更时发射事件', async () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();
      
      // 🔴 等待 queueMicrotask 完成，确保 isTaskSwitching 标志被重置
      await Promise.resolve();

      let emittedEvent: any;
      component.contentChange.subscribe((event) => {
        emittedEvent = event;
      });

      component.onLocalContentChange('New Content');

      expect(emittedEvent).toEqual({ taskId: 'task-a', content: 'New Content' });
      expect(component['localContent']()).toBe('New Content');
    });

    it('应该在聚焦时锁定字段', () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      component.onInputFocus('title');

      expect(mockChangeTracker.lockTaskField).toHaveBeenCalledWith(
        'task-a',
        'project-1',
        'title',
        expect.any(Number)
      );
      expect(component.formService.isTitleFocused).toBe(true);
    });

    it('点击停泊按钮时应发射 parkTask 事件', () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      let emittedTask: any = null;
      component.parkTask.subscribe((event) => {
        emittedTask = event;
      });

      const parkButton = fixture.nativeElement.querySelector('[data-testid="flow-task-park-button"]') as HTMLButtonElement | null;
      parkButton?.click();

      expect(mockFlowTaskOps.parkTask).toHaveBeenCalledWith(task);
      expect(emittedTask?.id).toBe('task-a');
    });

    it('未停泊任务点击提醒按钮时应先发射 parkTask 事件并打开提醒菜单', () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      let emittedTask: any = null;
      component.parkTask.subscribe((event) => {
        emittedTask = event;
      });

      const reminderButton = fixture.nativeElement.querySelector('[data-testid="flow-task-reminder-trigger"]') as HTMLButtonElement | null;
      reminderButton?.click();
      fixture.detectChanges();

      expect(mockFlowTaskOps.parkTask).toHaveBeenCalledWith(task);
      expect(emittedTask?.id).toBe('task-a');
      expect(component.showReminderMenu()).toBe(true);
    });

    it('应该在失焦时延迟解锁字段', async () => {
      // 使用 fake timers 加速测试
      vi.useFakeTimers();

      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      component.onInputFocus('title');
      component.onInputBlur('title');

      // 验证定时器已创建
      expect(component.formService['unlockTimers'].size).toBe(1);
      expect(component.formService.isTitleFocused).toBe(true); // 仍然为 true（延迟解锁）

      // 使用 fake timers 快进 10.1 秒
      await vi.advanceTimersByTimeAsync(10100);

      expect(component.formService.isTitleFocused).toBe(false);
      expect(component.formService['unlockTimers'].size).toBe(0);
      
      vi.useRealTimers();
    }, 5000);

    it('点击任务 markdown 链接时应发射 openLinkedTask，而不是进入编辑态', () => {
      const emitSpy = vi.spyOn(component.openLinkedTask, 'emit');
      const anchor = document.createElement('a');
      anchor.setAttribute('href', '#task:linked-task');
      anchor.setAttribute('data-link-kind', 'task');
      anchor.setAttribute('data-task-link-id', 'linked-task');
      const stopPropagation = vi.fn();
      const preventDefault = vi.fn();

      component.onPreviewClick({ target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent);

      expect(stopPropagation).toHaveBeenCalled();
      expect(preventDefault).toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalledWith('linked-task');
      expect(component.isEditMode()).toBe(false);
    });

    it('点击外链时应保持预览态', () => {
      const anchor = document.createElement('a');
      anchor.setAttribute('href', 'https://example.com');
      anchor.setAttribute('data-link-kind', 'external');
      const stopPropagation = vi.fn();
      const preventDefault = vi.fn();

      component.onPreviewClick({ target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent);

      expect(stopPropagation).toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(component.isEditMode()).toBe(false);
    });

    it('点击 blocked 链接时应阻止默认行为并保持预览态', () => {
      const emitSpy = vi.spyOn(component.openLinkedTask, 'emit');
      const anchor = document.createElement('a');
      anchor.setAttribute('href', '#__nf_blocked__');
      anchor.setAttribute('data-link-kind', 'blocked');
      const stopPropagation = vi.fn();
      const preventDefault = vi.fn();

      component.onPreviewClick({ target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent);

      expect(stopPropagation).toHaveBeenCalled();
      expect(preventDefault).toHaveBeenCalled();
      expect(emitSpy).not.toHaveBeenCalled();
      expect(component.isEditMode()).toBe(false);
    });

    it('点击本地路径链接时应尝试打开并保持预览态', async () => {
      const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      const writeText = vi.fn().mockResolvedValue(undefined);
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });

      try {
        const anchor = document.createElement('a');
        anchor.setAttribute('href', '#local-path');
        anchor.setAttribute('data-link-kind', 'local');
        anchor.setAttribute('data-local-link-path', 'C:\\Docs\\Plan.md');
        const stopPropagation = vi.fn();
        const preventDefault = vi.fn();

        component.onPreviewClick({ target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent);
        await Promise.resolve();

        expect(stopPropagation).toHaveBeenCalled();
        expect(preventDefault).toHaveBeenCalled();
        expect(component.isEditMode()).toBe(false);
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

  describe('移动端抽屉高度自适应', () => {
    it('自动高度模式下不应隐藏操作区（删除按钮必须可见）', () => {
      (component as any)['autoHeightEnabled'] = signal(true);
      (component as any)['drawerHeight'] = signal(8.5);

      expect(component.isCompactMode()).toBe(false);
    });

    it('手动拖拽模式下允许进入紧凑态', () => {
      (component as any)['autoHeightEnabled'] = signal(false);
      (component as any)['drawerHeight'] = signal(8.5);

      expect(component.isCompactMode()).toBe(true);
    });

    it('任务无关字段变化不应重复触发重测签名', () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      (component as any)['autoHeightEnabled'] = signal(true);
      mockUiState.isMobile.set(true);
      mockUiState.isFlowDetailOpen.set(true);
      fixture.detectChanges();

      const signature = (component as any).lastAutoHeightSignature;
      (component as any)['task'].set({ ...task, x: 88, y: 99 });
      fixture.detectChanges();

      expect((component as any).lastAutoHeightSignature).toBe(signature);
    });

    it('幂等算法：重复调用 measureAndEmitHeight 不应多次 emit', async () => {
      vi.useFakeTimers();
      const originalRaf = globalThis.requestAnimationFrame;
      const originalCancelRaf = globalThis.cancelAnimationFrame;

      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
        cb(0);
        return 1;
      }) as typeof requestAnimationFrame;
      globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;

      try {
        mockUiState.isMobile.set(true);
        mockUiState.isFlowDetailOpen.set(true);

        const task = createMockTask('task-a', 'Task A', 'Short content');
        (component as any)['task'] = signal(task);

        const viewportHeight = window.innerHeight || 844;
        (component as any)['drawerHeight'] = signal(12);
        (component as any)['autoHeightEnabled'] = signal(true);

        fixture.detectChanges();

        // 构建 mock DOM 元素
        const container = document.createElement('div');
        const title = document.createElement('div');
        const content = document.createElement('div');
        const handle = document.createElement('div');
        const contentChild = document.createElement('div');
        content.appendChild(contentChild);

        Object.defineProperty(title, 'offsetHeight', { configurable: true, get: () => 20 });
        Object.defineProperty(handle, 'offsetHeight', { configurable: true, get: () => 11 });
        // 子元素高 165px（含 margin 0）
        Object.defineProperty(contentChild, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({ x: 0, y: 0, width: 200, height: 165, top: 0, right: 200, bottom: 165, left: 0, toJSON: () => ({}) })
        });

        (component as any).mobileDrawer = { nativeElement: container };
        (component as any).mobileDrawerTitle = { nativeElement: title };
        (component as any).mobileDrawerContent = { nativeElement: content };
        (component as any).mobileDrawerHandle = { nativeElement: handle };

        const emittedHeights: number[] = [];
        component.drawerHeightChange.subscribe((value) => {
          emittedHeights.push(value);
          (component as any)['drawerHeight'].set(value);
        });

        // 第一次测量：应 emit（advanceTimersByTime 避免 ParkingService 递归 setTimeout 导致 10000 timer 限制）
        (component as any).requestAutoHeight();
        vi.advanceTimersByTime(200);

        const firstEmitCount = emittedHeights.length;
        expect(firstEmitCount).toBeGreaterThan(0);

        // 第二次测量：内容不变，lastEmittedVh 已缓存，不应再 emit
        (component as any).requestAutoHeight();
        vi.advanceTimersByTime(200);

        expect(emittedHeights.length).toBe(firstEmitCount);
      } finally {
        globalThis.requestAnimationFrame = originalRaf;
        globalThis.cancelAnimationFrame = originalCancelRaf;
        vi.useRealTimers();
      }
    }, 5000);

    it('算法: targetPx = titleH + intrinsicContentH + handleH + guard', async () => {
      vi.useFakeTimers();
      const originalRaf = globalThis.requestAnimationFrame;
      const originalCancelRaf = globalThis.cancelAnimationFrame;

      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
        cb(0);
        return 1;
      }) as typeof requestAnimationFrame;
      globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;

      try {
        mockUiState.isMobile.set(true);
        mockUiState.isFlowDetailOpen.set(true);

        const task = createMockTask('task-a', 'Task A', 'Short content');
        (component as any)['task'] = signal(task);

        const viewportHeight = window.innerHeight || 844;
        (component as any)['drawerHeight'] = signal(12);
        (component as any)['autoHeightEnabled'] = signal(true);

        fixture.detectChanges();

        // 构建 mock DOM：一个内容子元素 90px，加按钮区 45px
        const container = document.createElement('div');
        const title = document.createElement('div');
        const content = document.createElement('div');
        const handle = document.createElement('div');
        const contentBody = document.createElement('div');
        const actionSection = document.createElement('div');
        content.appendChild(contentBody);
        content.appendChild(actionSection);

        Object.defineProperty(title, 'offsetHeight', { configurable: true, get: () => 20 });
        Object.defineProperty(handle, 'offsetHeight', { configurable: true, get: () => 11 });
        Object.defineProperty(contentBody, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({ x: 0, y: 0, width: 200, height: 90, top: 0, right: 200, bottom: 90, left: 0, toJSON: () => ({}) })
        });
        Object.defineProperty(actionSection, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({ x: 0, y: 90, width: 200, height: 45, top: 90, right: 200, bottom: 135, left: 0, toJSON: () => ({}) })
        });

        (component as any).mobileDrawer = { nativeElement: container };
        (component as any).mobileDrawerTitle = { nativeElement: title };
        (component as any).mobileDrawerContent = { nativeElement: content };
        (component as any).mobileDrawerHandle = { nativeElement: handle };

        const emittedHeights: number[] = [];
        component.drawerHeightChange.subscribe((value) => {
          emittedHeights.push(value);
          (component as any)['drawerHeight'].set(value);
        });

        (component as any).requestAutoHeight();
        vi.advanceTimersByTime(200);

        // targetPx = 20 + (90+45) + 11 + 4 = 170
        const expectedPx = 20 + 135 + 11 + 4;
        const expectedVh = (expectedPx / viewportHeight) * 100;

        expect(emittedHeights.length).toBeGreaterThan(0);
        expect(emittedHeights[0]).toBeCloseTo(expectedVh, 1);
      } finally {
        globalThis.requestAnimationFrame = originalRaf;
        globalThis.cancelAnimationFrame = originalCancelRaf;
        vi.useRealTimers();
      }
    });
  });
});
