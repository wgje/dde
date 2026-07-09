import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { FlowTaskDetailComponent } from './flow-task-detail.component';
import { UiStateService } from '../../../../services/ui-state.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { UserSessionService } from '../../../../services/user-session.service';
import { UndoService } from '../../../../services/undo.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { LoggerService } from '../../../../services/logger.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { SimpleReminderService } from '../../../../services/simple-reminder.service';
import { FlowTaskOperationsService } from '../services/flow-task-operations.service';
import { disablePollutionGuard, enablePollutionGuard } from '../../../../test-setup.mocks';
import { Task } from '../../../../models';
import { KnowledgeAnchorComponent } from '../../../shared/components/knowledge-anchor/knowledge-anchor.component';
import { KnowledgeAnchorStubComponent } from '../../../../tests/stubs/knowledge-anchor.stub';
import { registerFlowTaskDetailDrawerHeightSpecs } from './flow-task-detail-drawer-height.spec-helpers';
import { registerFlowTaskDetailInputSpecs } from './flow-task-detail-input.spec-helpers';
import { registerFlowTaskDetailEditModeSpecs } from './flow-task-detail-edit-mode.spec-helpers';

describe('FlowTaskDetailComponent - Task Switching Fix', () => {
  let component: FlowTaskDetailComponent;
  let fixture: ComponentFixture<FlowTaskDetailComponent>;
  let mockUiState: any;
  let mockProjectState: any;
  let mockUserSession: any;
  let mockUndoService: any;
  let mockChangeTracker: any;
  let mockFlowTaskOps: any;
  let mockTaskOpsAdapter: any;
  let mockReminderService: any;
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
      getTaskConnections: vi.fn(() => ({ outgoing: [], incoming: [] })),
    };

    mockUserSession = {
      currentUserId: signal('user-1'),
    };

    mockUndoService = {
      appliedReplay: signal(null),
    };

    mockChangeTracker = {
      lockTaskField: vi.fn(),
      unlockTaskField: vi.fn(),
    };
    (mockChangeTracker as any).constructor = { TEXT_INPUT_LOCK_TIMEOUT_MS: 3600000 };

    mockFlowTaskOps = {
      parkTask: vi.fn().mockResolvedValue(true),
      addQuickTodo: vi.fn().mockResolvedValue(true),
    };
    mockTaskOpsAdapter = {
      updateTaskExpectedMinutes: vi.fn().mockResolvedValue(true),
      updateTaskWaitMinutes: vi.fn().mockResolvedValue(true),
      updateTaskCognitiveLoad: vi.fn().mockResolvedValue(true),
      updateTaskContent: vi.fn().mockResolvedValue(true),
    };
    mockReminderService = {
      setReminder: vi.fn().mockResolvedValue(true),
      cancelReminder: vi.fn().mockResolvedValue(true),
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
        { provide: UndoService, useValue: mockUndoService },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: FlowTaskOperationsService, useValue: mockFlowTaskOps },
        { provide: TaskOperationAdapterService, useValue: mockTaskOpsAdapter },
        { provide: SimpleReminderService, useValue: mockReminderService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    }).overrideComponent(FlowTaskDetailComponent, {
      remove: { imports: [KnowledgeAnchorComponent] },
      add: { imports: [KnowledgeAnchorStubComponent] },
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

    it('应该暴露当前任务的僚机摘要', () => {
      const task = {
        ...createMockTask('task-a', 'Task A', '- [ ] 确认接口字段'),
        priority: 'high' as const,
        wait_minutes: 30,
        cognitive_load: 'high' as const,
        tags: ['需联调'],
      };
      mockProjectState.getTaskConnections.mockReturnValue({
        outgoing: [{ targetId: 'task-b' }],
        incoming: [{ sourceId: 'task-c' }],
      });

      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      expect(component.sidecarSummary().badges.map(badge => badge.label)).toEqual([
        '风险1',
        '等待30m',
        '高负荷',
        '需联调',
      ]);
      const summary = fixture.nativeElement.querySelector('[data-testid="flow-task-sidecar-summary"]') as HTMLElement | null;
      expect(summary?.textContent).toContain('风险1');
      expect(summary?.textContent).toContain('等待30m');
      expect(summary?.textContent).not.toContain('关联2');
      expect(summary?.textContent).not.toContain('等待：30 分钟');
      expect(summary?.getAttribute('title')).toBeNull();
      const badge = summary?.querySelector('span[tabindex="0"]') as HTMLElement | null;
      expect(badge?.getAttribute('title')).toBeNull();
    });

    it('小于 1 分钟的规划输入不应落库为 0 分钟', async () => {
      const adapter = (component as any).taskOpsAdapter as {
        updateTaskExpectedMinutes: (taskId: string, minutes: number | null) => Promise<boolean>;
        updateTaskWaitMinutes: (taskId: string, minutes: number | null) => Promise<boolean>;
      };
      const updateExpectedSpy = vi.spyOn(adapter, 'updateTaskExpectedMinutes').mockResolvedValue(true);
      const updateWaitSpy = vi.spyOn(adapter, 'updateTaskWaitMinutes').mockResolvedValue(true);

      await component.onExpectedMinutesChange('task-a', '0.5');
      await component.onWaitMinutesChange('task-a', '0.5');

      expect(updateExpectedSpy).toHaveBeenCalledWith('task-a', null);
      expect(updateWaitSpy).toHaveBeenCalledWith('task-a', null);
    });

    it('规划字段本地持久化失败时应暴露失败状态', async () => {
      mockTaskOpsAdapter.updateTaskWaitMinutes.mockResolvedValueOnce(false);
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      component.isEditMode.set(true);
      fixture.detectChanges();

      const saved = await component.onWaitMinutesChange('task-a', '20');
      fixture.detectChanges();

      expect(saved).toBe(false);
      expect(mockTaskOpsAdapter.updateTaskWaitMinutes).toHaveBeenCalledWith('task-a', 20);
      expect(component.plannerSaveState()).toBe('failed');
      expect(fixture.nativeElement.textContent).toContain('规划字段本地保存失败');
    });

    it('任务切换时应清理规划字段本地保存失败状态', async () => {
      mockTaskOpsAdapter.updateTaskExpectedMinutes.mockResolvedValueOnce(false);
      const taskSignal = signal(createMockTask('task-a', 'Task A', 'Content A'));
      (component as any)['task'] = taskSignal;
      component.isEditMode.set(true);
      fixture.detectChanges();

      await component.onExpectedMinutesChange('task-a', '25');
      expect(component.plannerSaveState()).toBe('failed');

      taskSignal.set(createMockTask('task-b', 'Task B', 'Content B'));
      fixture.detectChanges();

      expect(component.plannerSaveState()).toBe('idle');
    });

    it('应该使用主题化浮层预览僚机徽标内容', () => {
      const trigger = document.createElement('span');
      Object.defineProperty(trigger, 'getBoundingClientRect', {
        value: () => ({ left: 100, right: 148, top: 120, height: 18, width: 48, bottom: 138, x: 100, y: 120, toJSON: () => ({}) }),
      });

      component.showSidecarBadgePreview(
        { currentTarget: trigger } as unknown as Event,
        { id: 'attention-1', label: '注意1', tone: 'attention', tooltipText: 'Token 过期需刷新' },
      );

      const preview = document.body.querySelector('[data-testid="flow-task-sidecar-badge-preview"]') as HTMLElement | null;
      expect(preview).not.toBeNull();
      expect(preview?.textContent).toContain('注意1');
      expect(preview?.textContent).toContain('Token 过期需刷新');
      expect(preview?.style.position).toBe('fixed');
      expect(preview?.style.zIndex).toBe('90');
      expect(preview?.style.pointerEvents).toBe('none');

      component.hideSidecarBadgePreview();
      expect(document.body.querySelector('[data-testid="flow-task-sidecar-badge-preview"]')).toBeNull();
    });

    it('应该在僚机草稿变化时发射 attentionChange', () => {
      const task = {
        ...createMockTask('task-a', 'Task A', 'Content A'),
        attentionMeta: {
          items: [
            {
              id: 'attention-1',
              text: 'Token 过期需刷新',
              level: 'warning' as const,
              done: false,
              createdAt: '2026-06-05T00:00:00.000Z',
              updatedAt: '2026-06-05T00:00:00.000Z',
            },
          ],
          updatedAt: '2026-06-05T00:00:00.000Z',
        },
      };
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      let emitted: any = null;
      component.attentionChange.subscribe((event) => {
        emitted = event;
      });

      component.onLocalAttentionDraftChange('Token 过期需刷新\n接口字段未冻结');

      expect(emitted).toEqual({
        taskId: 'task-a',
        items: [
          {
            id: 'attention-1',
            text: 'Token 过期需刷新',
            level: 'warning',
            done: false,
            createdAt: '2026-06-05T00:00:00.000Z',
          },
          {
            id: undefined,
            text: '接口字段未冻结',
            level: 'info',
            done: false,
            createdAt: undefined,
          },
        ],
      });

      component.addAttentionDraftRow();
      component.onAttentionDraftRowChange(2, '上线前再检查权限');

      expect(emitted.items.map((item: { text: string }) => item.text)).toEqual([
        'Token 过期需刷新',
        '接口字段未冻结',
        '上线前再检查权限',
      ]);

      component.removeAttentionDraftRow(0);

      expect(emitted.items.map((item: { text: string }) => item.text)).toEqual([
        '接口字段未冻结',
        '上线前再检查权限',
      ]);
    });

    it('聚焦僚机草稿时不应被任务元数据刷新覆盖', () => {
      const task = {
        ...createMockTask('task-a', 'Task A', 'Content A'),
        attentionMeta: {
          items: [
            {
              id: 'attention-1',
              text: 'Token 过期需刷新',
              level: 'warning' as const,
              done: false,
              createdAt: '2026-06-05T00:00:00.000Z',
              updatedAt: '2026-06-05T00:00:00.000Z',
            },
          ],
          updatedAt: '2026-06-05T00:00:00.000Z',
        },
      };
      const taskSignal = signal(task);
      (component as any)['task'] = taskSignal;
      fixture.detectChanges();

      component.onAttentionFocus();
      component.addAttentionDraftRow();

      taskSignal.set({
        ...task,
        updatedAt: '2026-06-05T00:01:00.000Z',
        attentionMeta: {
          items: [
            {
              id: 'attention-1',
              text: 'Token 过期需刷新',
              level: 'warning' as const,
              done: false,
              createdAt: '2026-06-05T00:00:00.000Z',
              updatedAt: '2026-06-05T00:01:00.000Z',
            },
          ],
          updatedAt: '2026-06-05T00:01:00.000Z',
        },
      });
      fixture.detectChanges();

      expect(component.localAttentionDraft()).toBe('Token 过期需刷新\n');

      component.onAttentionBlur();

      expect(component.localAttentionDraft()).toBe('Token 过期需刷新');
    });

    it('僚机草稿失焦时应保留刚输入但父任务输入尚未刷新的内容', () => {
      const task = {
        ...createMockTask('task-a', 'Task A', 'Content A'),
        attentionMeta: {
          items: [
            {
              id: 'attention-1',
              text: 'Token 过期需刷新',
              level: 'warning' as const,
              done: false,
              createdAt: '2026-06-05T00:00:00.000Z',
              updatedAt: '2026-06-05T00:00:00.000Z',
            },
          ],
          updatedAt: '2026-06-05T00:00:00.000Z',
        },
      };
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      let emitted: any = null;
      component.attentionChange.subscribe((event) => {
        emitted = event;
      });

      component.onAttentionFocus();
      component.onAttentionDraftRowChange(0, 'Token 过期需刷新；先轮换密钥');
      component.onAttentionBlur();

      expect(emitted).toEqual({
        taskId: 'task-a',
        items: [
          expect.objectContaining({
            id: 'attention-1',
            text: 'Token 过期需刷新；先轮换密钥',
          }),
        ],
      });
      expect(component.localAttentionDraft()).toBe('Token 过期需刷新；先轮换密钥');
      expect(component.attentionDraftRows().map(row => row.text)).toEqual(['Token 过期需刷新；先轮换密钥']);
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

    it('内容失焦提交后父任务仍回传旧内容时应保留未确认草稿', async () => {
      vi.useFakeTimers();
      const task = createMockTask('task-a', 'Task A', 'Content A');
      const taskSignal = signal(task);
      (component as any)['task'] = taskSignal;
      fixture.detectChanges();
      await Promise.resolve();

      component.onInputFocus('content');
      component.onLocalContentChange('Offline Draft');
      component.onInputBlur('content');
      await vi.advanceTimersByTimeAsync(10100);

      taskSignal.set({
        ...task,
        content: 'Content A',
        updatedAt: '2025-12-31T00:01:00Z',
      });
      fixture.detectChanges();

      expect(component['localContent']()).toBe('Offline Draft');
    });

    it('点击预览待办项时应等待本地持久化成功后再提交本地内容', async () => {
      let resolveSave!: (saved: boolean) => void;
      mockTaskOpsAdapter.updateTaskContent.mockReturnValueOnce(
        new Promise<boolean>(resolve => {
          resolveSave = resolve;
        }),
      );
      const task = createMockTask('task-a', 'Task A', '- [ ] Durable todo');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();
      const checkbox = document.createElement('button');
      checkbox.setAttribute('data-todo-index', '0');
      const stopPropagation = vi.fn();

      const previewResult = component.onPreviewClick({
        target: checkbox,
        stopPropagation,
      } as unknown as MouseEvent);

      expect(stopPropagation).toHaveBeenCalled();
      expect(mockTaskOpsAdapter.updateTaskContent).toHaveBeenCalledWith('task-a', '- [x] Durable todo');
      expect(component['localContent']()).toBe('- [ ] Durable todo');

      resolveSave(true);
      await previewResult;

      expect(component['localContent']()).toBe('- [x] Durable todo');
    });

    it('点击预览待办项本地持久化失败时不应留下本地内容变化', async () => {
      mockTaskOpsAdapter.updateTaskContent.mockResolvedValueOnce(false);
      const task = createMockTask('task-a', 'Task A', '- [ ] Durable todo');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();
      const checkbox = document.createElement('button');
      checkbox.setAttribute('data-todo-index', '0');

      await component.onPreviewClick({
        target: checkbox,
        stopPropagation: vi.fn(),
      } as unknown as MouseEvent);

      expect(mockTaskOpsAdapter.updateTaskContent).toHaveBeenCalledWith('task-a', '- [x] Durable todo');
      expect(component['localContent']()).toBe('- [ ] Durable todo');
    });

    it('应该在撤销回放命中当前任务内容时覆盖聚焦中的本地缓冲', () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');

      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      component.onInputFocus('content');
      component['localContent'].set('');

      (component as any)['task'].set({ ...task, content: 'Recovered Content' });
      fixture.detectChanges();
      expect(component['localContent']()).toBe('');

      mockUndoService.appliedReplay.set({
        sequence: 1,
        kind: 'undo',
        projectId: 'project-1',
        taskFieldChanges: { 'task-a': ['content'] },
      });
      fixture.detectChanges();

      expect(component['localContent']()).toBe('Recovered Content');

      component['localContent'].set('Resume Edit');
      (component as any)['task'].set({ ...task, content: 'Remote Update After Replay' });
      fixture.detectChanges();

      expect(component['localContent']()).toBe('Resume Edit');
    });
  });

  registerFlowTaskDetailEditModeSpecs(() => ({
    component,
    fixture,
    createClickEvent,
    createMockTask,
  }));

  registerFlowTaskDetailInputSpecs(() => ({
    component,
    fixture,
    mockChangeTracker,
    mockFlowTaskOps,
    createMockTask,
  }));

  registerFlowTaskDetailDrawerHeightSpecs(() => ({
    component,
    fixture,
    mockUiState,
    createMockTask,
  }));

});
