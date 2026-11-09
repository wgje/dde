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
import { registerFlowTaskDetailSameTaskUpdateSpecs } from './flow-task-detail-same-task-update.spec-helpers';

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
      tasks: vi.fn(() => {
        const tasks = mockProjectState.activeProject()?.tasks ?? [];
        const inputTask = component?.task?.();
        return tasks.length || !inputTask ? tasks : [inputTask];
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
      (component as any)['task'] = signal(createMockTask('task-a', 'Task A', 'Content A'));
      fixture.detectChanges();
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

    it('任务切换后应忽略旧任务 planner 保存的晚到结果', async () => {
      let resolveSave!: (saved: boolean) => void;
      mockTaskOpsAdapter.updateTaskExpectedMinutes.mockImplementationOnce(
        () => new Promise<boolean>(resolve => {
          resolveSave = resolve;
        }),
      );
      const taskSignal = signal(createMockTask('task-a', 'Task A', 'Content A'));
      (component as any)['task'] = taskSignal;
      component.isEditMode.set(true);
      fixture.detectChanges();

      const saving = component.onExpectedMinutesChange('task-a', '25');
      expect(component.plannerSaveState()).toBe('saving');

      taskSignal.set(createMockTask('task-b', 'Task B', 'Content B'));
      fixture.detectChanges();
      expect(component.plannerSaveState()).toBe('idle');

      resolveSave(false);
      await expect(saving).resolves.toBe(false);

      expect(component.plannerSaveState()).toBe('idle');
    });

    it('planner 保存状态应只由同一任务的最新请求结算', async () => {
      let resolveFirst!: (saved: boolean) => void;
      let resolveSecond!: (saved: boolean) => void;
      mockTaskOpsAdapter.updateTaskExpectedMinutes
        .mockImplementationOnce(() => new Promise<boolean>(resolve => {
          resolveFirst = resolve;
        }))
        .mockImplementationOnce(() => new Promise<boolean>(resolve => {
          resolveSecond = resolve;
        }));
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      component.isEditMode.set(true);
      fixture.detectChanges();

      const firstSave = component.onExpectedMinutesChange('task-a', '20');
      const secondSave = component.onExpectedMinutesChange('task-a', '30');
      expect(component.plannerSaveState()).toBe('saving');

      resolveFirst(true);
      await expect(firstSave).resolves.toBe(true);
      expect(component.plannerSaveState()).toBe('saving');

      resolveSecond(false);
      await expect(secondSave).resolves.toBe(false);
      expect(component.plannerSaveState()).toBe('failed');
    });

    it('planner 保存 rejection 应收口为 false 并标记失败', async () => {
      mockTaskOpsAdapter.updateTaskWaitMinutes.mockRejectedValueOnce(new Error('persist failed'));
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      component.isEditMode.set(true);
      fixture.detectChanges();

      await expect(component.onWaitMinutesChange('task-a', '15')).resolves.toBe(false);

      expect(component.plannerSaveState()).toBe('failed');
    });

    it('组件销毁后不应由 planner 保存晚到结果改写状态', async () => {
      let resolveSave!: (saved: boolean) => void;
      mockTaskOpsAdapter.updateTaskExpectedMinutes.mockImplementationOnce(
        () => new Promise<boolean>(resolve => {
          resolveSave = resolve;
        }),
      );
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      component.isEditMode.set(true);
      fixture.detectChanges();

      const saving = component.onExpectedMinutesChange('task-a', '25');
      expect(component.plannerSaveState()).toBe('saving');

      component.ngOnDestroy();
      expect(component.plannerSaveState()).toBe('idle');
      resolveSave(false);
      await expect(saving).resolves.toBe(false);

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
    it('项目切换应退役详情态并拒绝所有过期直达写入', async () => {
      const taskA = createMockTask('task-a', 'Task A', '- [ ] Todo');
      const taskB = createMockTask('task-b', 'Task B', 'B');
      (component as any)['task'] = signal(taskA);
      mockProjectState.activeProject.set({ ...mockProjectState.activeProject(), tasks: [taskA] });
      fixture.detectChanges();
      component.showReminderMenu.set(true);
      mockProjectState.activeProjectId.set('project-1');
      fixture.detectChanges();
      expect(component.showReminderMenu()).toBe(true);
      const detailChange = vi.fn();
      const parkTask = vi.fn();
      component.titleChange.subscribe(detailChange);
      component.contentChange.subscribe(detailChange);
      component.attentionChange.subscribe(detailChange);
      component.parkTask.subscribe(parkTask);
      mockProjectState.activeProjectId.set('project-2');
      mockProjectState.activeProject.set({ ...mockProjectState.activeProject(), id: 'project-2', tasks: [taskB] });
      fixture.detectChanges();
      await Promise.resolve();
      component.onLocalTitleChange('stale');
      component.onLocalContentChange('stale');
      component.onLocalAttentionDraftChange('stale');
      const plannerSaved = await Promise.all([component.onExpectedMinutesChange(taskA.id, 20), component.onWaitMinutesChange(taskA.id, 20), component.onCognitiveLoadChange(taskA.id, 'high')]);
      const input = Object.assign(document.createElement('input'), { value: 'stale todo' });
      const quickSaved = await component.addQuickTodo(taskA.id, input);
      await Promise.all([component.onParkTaskClick(taskA), component.setReminderPreset(taskA.id, 5), component.clearReminder(taskA.id)]);
      const checkbox = document.createElement('button');
      checkbox.dataset['todoIndex'] = '0';
      await component.onPreviewClick({ target: checkbox, stopPropagation: vi.fn() } as unknown as MouseEvent);
      expect.soft(component.showReminderMenu()).toBe(false);
      expect.soft(detailChange).not.toHaveBeenCalled();
      expect.soft(plannerSaved).toEqual([false, false, false]);
      expect.soft(quickSaved).toBe(false);
      expect.soft([mockTaskOpsAdapter.updateTaskExpectedMinutes, mockTaskOpsAdapter.updateTaskWaitMinutes, mockTaskOpsAdapter.updateTaskCognitiveLoad].every(mock => mock.mock.calls.length === 0)).toBe(true);
      expect.soft(mockTaskOpsAdapter.updateTaskContent).not.toHaveBeenCalled();
      expect.soft(mockFlowTaskOps.parkTask).not.toHaveBeenCalled();
      expect.soft(mockReminderService.setReminder).not.toHaveBeenCalled();
      expect.soft(mockReminderService.cancelReminder).not.toHaveBeenCalled();
      expect.soft(parkTask).not.toHaveBeenCalled();
    });
    it('自动停泊替换任务对象后仍应为同一项目任务写入提醒', async () => {
      const taskA = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(taskA);
      mockProjectState.activeProject.set({ ...mockProjectState.activeProject(), tasks: [taskA] });
      mockFlowTaskOps.parkTask.mockImplementationOnce(async () => {
        const parkedTask = { ...taskA, parkingMeta: { state: 'parked' as const, parkedAt: '2026-07-29T00:00:00.000Z', lastVisitedAt: '2026-07-29T00:00:00.000Z', contextSnapshot: null, reminder: null, pinned: false } };
        mockProjectState.activeProject.set({ ...mockProjectState.activeProject(), tasks: [parkedTask] });
        return true;
      });
      fixture.detectChanges();

      await component.setReminderPreset(taskA.id, 5);

      expect(mockReminderService.setReminder).toHaveBeenCalledTimes(1);
    });
    it('同项目 A→B→A 后应拒绝旧预览、待办、提醒和 planner 完成', async () => {
      const taskA = createMockTask('task-a', 'Task A', '- [ ] Todo'), taskB = createMockTask('task-b', 'Task B', 'B');
      const replacementA = createMockTask('task-a', 'Current A', 'Current A content');
      let resolveContent!: (saved: boolean) => void, resolveTodo!: (saved: boolean) => void, resolvePlanner!: (saved: boolean) => void, resolveReminder!: (saved: boolean) => void;
      mockTaskOpsAdapter.updateTaskContent.mockReturnValueOnce(new Promise(resolve => { resolveContent = resolve; }));
      mockFlowTaskOps.addQuickTodo.mockReturnValueOnce(new Promise(resolve => { resolveTodo = resolve; }));
      mockTaskOpsAdapter.updateTaskExpectedMinutes.mockReturnValueOnce(new Promise(resolve => { resolvePlanner = resolve; }));
      mockReminderService.cancelReminder.mockReturnValueOnce(new Promise(resolve => { resolveReminder = resolve; }));
      const taskSignal = signal(taskA);
      (component as any)['task'] = taskSignal;
      mockProjectState.activeProject.set({ ...mockProjectState.activeProject(), tasks: [taskA, taskB] });
      fixture.detectChanges();
      const checkbox = document.createElement('button');
      checkbox.dataset['todoIndex'] = '0';
      const input = Object.assign(document.createElement('input'), { value: 'A todo' });
      const focus = vi.spyOn(input, 'focus');
      const preview = component.onPreviewClick({ target: checkbox, stopPropagation: vi.fn() } as unknown as MouseEvent);
      const todo = component.addQuickTodo(taskA.id, input);
      const planner = component.onExpectedMinutesChange(taskA.id, 25);
      const reminder = component.clearReminder(taskA.id);
      taskSignal.set(taskB); fixture.detectChanges();
      mockProjectState.activeProject.set({ ...mockProjectState.activeProject(), tasks: [replacementA, taskB] });
      taskSignal.set(replacementA); fixture.detectChanges();
      component.showReminderMenu.set(true);
      resolveContent(true); resolveTodo(true); resolvePlanner(false); resolveReminder(true);
      await Promise.all([preview, todo, planner, reminder]);
      expect.soft(component.localContent()).toBe(replacementA.content);
      expect.soft(input.value).toBe('A todo');
      expect.soft(focus).not.toHaveBeenCalled();
      expect.soft(component.plannerSaveState()).toBe('idle');
      expect.soft(component.showReminderMenu()).toBe(true);
    });
  });
  registerFlowTaskDetailSameTaskUpdateSpecs(() => ({ component, fixture, mockTaskOpsAdapter, mockUndoService, createMockTask }));
  registerFlowTaskDetailEditModeSpecs(() => ({ component, fixture, createClickEvent, createMockTask }));

  registerFlowTaskDetailInputSpecs(() => ({ component, fixture, mockChangeTracker, mockFlowTaskOps, createMockTask }));

  registerFlowTaskDetailDrawerHeightSpecs(() => ({ component, fixture, mockUiState, createMockTask }));

});
