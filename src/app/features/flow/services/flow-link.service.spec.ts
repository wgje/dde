import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowLinkService } from './flow-link.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { FlowLinkRelinkService } from './flow-link-relink.service';

describe('FlowLinkService', () => {
  let service: FlowLinkService;
  let originalInnerWidth: number;
  let originalInnerHeight: number;
  let hintOnlyReadOnly: ReturnType<typeof signal<boolean>>;
  let mockProjectState: { activeProjectId: ReturnType<typeof signal<string>>; getTask: ReturnType<typeof vi.fn> };
  let mockToast: {
    success: ReturnType<typeof vi.fn>;
    warning: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
  let uiStateMock: { isMobile: ReturnType<typeof signal<boolean>> };
  let shellRootEl: HTMLDivElement | null = null;
  let diagramEl: HTMLDivElement | null = null;
  let mockTaskOps: {
    connectionAdapter: {
      removeConnection: ReturnType<typeof vi.fn>;
      updateConnectionContent: ReturnType<typeof vi.fn>;
      addCrossTreeConnection: ReturnType<typeof vi.fn>;
    };
    detachTask: ReturnType<typeof vi.fn>;
    moveTaskToStage: ReturnType<typeof vi.fn>;
    getDirectChildren: ReturnType<typeof vi.fn>;
    isHintOnlyStartupReadOnly: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    originalInnerWidth = window.innerWidth;
    originalInnerHeight = window.innerHeight;
    hintOnlyReadOnly = signal(false);
    uiStateMock = {
      isMobile: signal(true),
    };

    mockTaskOps = {
      connectionAdapter: {
        removeConnection: vi.fn(),
        updateConnectionContent: vi.fn(),
        addCrossTreeConnection: vi.fn(),
      },
      detachTask: vi.fn(),
      moveTaskToStage: vi.fn(() => ({ ok: true })),
      getDirectChildren: vi.fn(() => []),
      isHintOnlyStartupReadOnly: vi.fn(() => hintOnlyReadOnly()),
    };
    mockProjectState = {
      activeProjectId: signal('project-1'),
      getTask: vi.fn(() => null),
    };
    mockToast = {
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        FlowLinkService,
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskOperationAdapterService, useValue: mockTaskOps },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        { provide: ToastService, useValue: mockToast },
        {
          provide: UiStateService,
          useValue: uiStateMock,
        },
        { provide: FlowLinkRelinkService, useValue: {} },
      ],
    });

    service = TestBed.inject(FlowLinkService);
  });

  afterEach(() => {
    service.dispose();
    shellRootEl?.remove();
    shellRootEl = null;
    diagramEl?.remove();
    diagramEl = null;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
  });

  function mountFlowBounds(
    rootRect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>,
    diagramRect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>
  ): void {
    shellRootEl = document.createElement('div');
    shellRootEl.setAttribute('data-testid', 'project-shell-main-content');
    vi.spyOn(shellRootEl, 'getBoundingClientRect').mockReturnValue(rootRect as DOMRect);
    document.body.appendChild(shellRootEl);

    diagramEl = document.createElement('div');
    diagramEl.setAttribute('data-testid', 'flow-diagram');
    vi.spyOn(diagramEl, 'getBoundingClientRect').mockReturnValue(diagramRect as DOMRect);
    document.body.appendChild(diagramEl);
  }

  it('移动端首次打开跨树关联时应以预览态锚定在点击点附近', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });

    service.openConnectionEditor('source-task', 'target-task', '跨树描述', 200, 300, '依赖', {
      isCrossTree: true,
      mode: 'preview',
    } as any);

    expect(service.connectionEditorPos()).toEqual({ x: 96, y: 110 });
    expect(service.connectionEditorData()).toMatchObject({
      x: 96,
      y: 110,
      isCrossTree: true,
      mode: 'preview',
    });
  });

  it('桌面端打开跨树关联时应换算到流程图所在壳容器坐标系，并显示在关联块上方', () => {
    uiStateMock.isMobile.set(false);
    mountFlowBounds(
      { left: 200, top: 100, right: 1400, bottom: 900, width: 1200, height: 800 },
      { left: 520, top: 220, right: 1220, bottom: 860, width: 700, height: 640 }
    );

    service.openConnectionEditor('source-task', 'target-task', '跨树描述', 700, 400, '依赖', {
      isCrossTree: true,
      mode: 'preview',
    } as any);

    expect(service.connectionEditorPos()).toEqual({ x: 396, y: 132 });
    expect(service.connectionEditorData()).toMatchObject({
      x: 396,
      y: 132,
      isCrossTree: true,
      mode: 'preview',
    });
  });

  it('桌面端拖动跨树关联块时应允许在整个流程图区域内移动，而不是被视口坐标错误截断', () => {
    uiStateMock.isMobile.set(false);
    mountFlowBounds(
      { left: 200, top: 100, right: 1400, bottom: 900, width: 1200, height: 800 },
      { left: 520, top: 220, right: 1220, bottom: 860, width: 700, height: 640 }
    );

    service.connectionEditorPos.set({ x: 420, y: 180 });

    service.startDragConnEditor(new MouseEvent('mousedown', { clientX: 760, clientY: 420 }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 120, clientY: 420 }));

    expect(service.connectionEditorPos()).toEqual({ x: 328, y: 180 });

    document.dispatchEvent(new MouseEvent('mouseup'));
  });

  it('移动端上方空间不足时应回退到点击点下方', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });

    service.openConnectionEditor('parent-task', 'child-task', '', 40, 80, '', {
      isCrossTree: false,
      mode: 'preview',
    } as any);

    expect(service.connectionEditorPos()).toEqual({ x: 12, y: 90 });
    expect(service.connectionEditorData()).toMatchObject({
      x: 12,
      y: 90,
      isCrossTree: false,
      mode: 'preview',
    });
  });

  it('移动端再次点击同一跨树关联时应从预览态升级为编辑态而不重置会话', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });

    service.openConnectionEditor('source-task', 'target-task', '跨树描述', 200, 300, '依赖', {
      isCrossTree: true,
      mode: 'preview',
    } as any);

    const firstOpen = service.connectionEditorData();

    service.openConnectionEditor('source-task', 'target-task', '跨树描述', 200, 300, '依赖', {
      isCrossTree: true,
      mode: 'preview',
    } as any);

    const secondOpen = service.connectionEditorData();

    expect(firstOpen).not.toBeNull();
    expect(secondOpen).not.toBeNull();
    expect(secondOpen).toMatchObject({
      sourceId: 'source-task',
      targetId: 'target-task',
      mode: 'edit',
    });
    expect(secondOpen?.x).toBe(firstOpen?.x);
    expect(secondOpen?.y).toBe(firstOpen?.y);
  });

  it('移动端打开关联块后应短暂忽略背景关闭，避免同一次点击把预览立即关掉', () => {
    service.openConnectionEditor('source-task', 'target-task', '跨树描述', 200, 300, '依赖', {
      isCrossTree: true,
      mode: 'preview',
    } as any);

    expect(service.shouldIgnoreConnectionEditorBackgroundClose()).toBe(true);

    vi.advanceTimersByTime(350);

    expect(service.shouldIgnoreConnectionEditorBackgroundClose()).toBe(false);
  });

  it('编辑态退回预览态后应短暂忽略背景关闭，避免预览闪现后立刻被关掉', () => {
    service.openConnectionEditor('source-task', 'target-task', '跨树描述', 200, 300, '依赖', {
      isCrossTree: true,
      mode: 'edit',
    } as any);

    service.setConnectionEditorMode('preview');

    expect(service.connectionEditorData()?.mode).toBe('preview');
    expect(service.shouldIgnoreConnectionEditorBackgroundClose()).toBe(true);

    vi.advanceTimersByTime(350);

    expect(service.shouldIgnoreConnectionEditorBackgroundClose()).toBe(false);
  });

  it('删除跨树关联时应调用 removeConnection', () => {
    service.openConnectionEditor('source-task', 'target-task', '跨树描述', 120, 220, '依赖', {
      isCrossTree: true,
      mode: 'edit',
    } as any);

    const result = service.deleteCurrentConnection();

    expect(result).toBe(true);
    expect(mockTaskOps.connectionAdapter.removeConnection).toHaveBeenCalledWith('source-task', 'target-task');
    expect(mockTaskOps.detachTask).not.toHaveBeenCalled();
  });

  it('解除父子关系时应调用 detachTask', () => {
    service.openConnectionEditor('parent-task', 'child-task', '', 120, 220, '', {
      isCrossTree: false,
      mode: 'preview',
    } as any);

    const result = service.deleteCurrentConnection();

    expect(result).toBe(true);
    expect(mockTaskOps.detachTask).toHaveBeenCalledWith('child-task');
    expect(mockTaskOps.connectionAdapter.removeConnection).not.toHaveBeenCalled();
  });

  it('操作菜单编辑应直接以编辑态打开跨树关联', () => {
    service.showLinkActionMenu({
      from: 'source-task',
      to: 'target-task',
      isCrossTree: true,
      title: '依赖',
      description: '跨树描述',
    } as any, 180, 260);

    service.openEditorFromActionMenu();

    expect(service.connectionEditorData()).toMatchObject({
      sourceId: 'source-task',
      targetId: 'target-task',
      isCrossTree: true,
      mode: 'edit',
    });
  });

  it('hint-only 时不应进入连线模式', () => {
    hintOnlyReadOnly.set(true);
    TestBed.flushEffects();

    service.toggleLinkMode();

    expect(service.isLinkMode()).toBe(false);
    expect(service.linkSourceTask()).toBeNull();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '创建连接暂不可用，owner 确认完成前保持只读');
  });

  it('hint-only 时长按连接线不应弹出操作菜单', () => {
    hintOnlyReadOnly.set(true);
    TestBed.flushEffects();

    service.showLinkActionMenu({
      from: 'source-task',
      to: 'target-task',
      isCrossTree: true,
      title: '依赖',
      description: '跨树描述',
    } as any, 180, 260);

    expect(service.linkActionMenu()).toBeNull();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '管理连接暂不可用，owner 确认完成前保持只读');
  });

  it('hint-only 时同一跨树关联二次点击不应从预览态切到编辑态', () => {
    service.openConnectionEditor('source-task', 'target-task', '跨树描述', 200, 300, '依赖', {
      isCrossTree: true,
      mode: 'preview',
    } as any);

    hintOnlyReadOnly.set(true);
    TestBed.flushEffects();

    service.openConnectionEditor('source-task', 'target-task', '跨树描述', 200, 300, '依赖', {
      isCrossTree: true,
      mode: 'preview',
    } as any);

    expect(service.connectionEditorData()).toMatchObject({
      sourceId: 'source-task',
      targetId: 'target-task',
      mode: 'preview',
    });
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '编辑关联暂不可用，owner 确认完成前保持只读');
  });

  it('hint-only 时保存关联内容不应写入本地或触发适配器更新', () => {
    service.openConnectionEditor('source-task', 'target-task', '旧描述', 120, 220, '旧标题', {
      isCrossTree: true,
      mode: 'preview',
    } as any);

    hintOnlyReadOnly.set(true);
    TestBed.flushEffects();

    service.saveConnectionContent('source-task', 'target-task', '新标题', '新描述');

    expect(mockTaskOps.connectionAdapter.updateConnectionContent).not.toHaveBeenCalled();
    expect(service.connectionEditorData()).toMatchObject({
      title: '旧标题',
      description: '旧描述',
      mode: 'preview',
    });
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '编辑关联暂不可用，owner 确认完成前保持只读');
  });

  it('hint-only 时操作菜单应先自动收起，编辑入口随后保持无效', () => {
    service.showLinkActionMenu({
      from: 'source-task',
      to: 'target-task',
      isCrossTree: true,
      title: '依赖',
      description: '跨树描述',
    } as any, 180, 260);

    hintOnlyReadOnly.set(true);
    TestBed.flushEffects();

    service.openEditorFromActionMenu();

    expect(service.linkActionMenu()).toBeNull();
    expect(service.connectionEditorData()).toBeNull();
  });

  it('hint-only 时删除当前关联不应触发删除，并保持预览态编辑器', () => {
    service.openConnectionEditor('source-task', 'target-task', '跨树描述', 120, 220, '依赖', {
      isCrossTree: true,
      mode: 'edit',
    } as any);

    hintOnlyReadOnly.set(true);
    TestBed.flushEffects();

    const result = service.deleteCurrentConnection();

    expect(result).toBe(false);
    expect(mockTaskOps.connectionAdapter.removeConnection).not.toHaveBeenCalled();
    expect(service.connectionEditorData()).toMatchObject({
      sourceId: 'source-task',
      targetId: 'target-task',
      mode: 'preview',
    });
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '删除关联暂不可用，owner 确认完成前保持只读');
  });

  it('hint-only 切入时应自动收起已打开的删除提示、操作菜单并把编辑器切回预览', () => {
    service.showLinkDeleteHint({
      from: 'source-task',
      to: 'target-task',
      isCrossTree: true,
    } as any, 200, 280);
    service.showLinkActionMenu({
      from: 'source-task',
      to: 'target-task',
      isCrossTree: true,
      title: '依赖',
      description: '跨树描述',
    } as any, 180, 260);
    service.openConnectionEditor('source-task', 'target-task', '跨树描述', 120, 220, '依赖', {
      isCrossTree: true,
      mode: 'edit',
    } as any);

    hintOnlyReadOnly.set(true);
    TestBed.flushEffects();

    expect(service.linkDeleteHint()).toBeNull();
    expect(service.linkActionMenu()).toBeNull();
    expect(service.connectionEditorData()).toMatchObject({
      sourceId: 'source-task',
      targetId: 'target-task',
      mode: 'preview',
    });
  });

  it('hint-only 时操作菜单应先自动收起，删除入口随后保持无效', () => {
    service.showLinkActionMenu({
      from: 'source-task',
      to: 'target-task',
      isCrossTree: true,
      title: '依赖',
      description: '跨树描述',
    } as any, 180, 260);

    hintOnlyReadOnly.set(true);
    TestBed.flushEffects();

    const result = service.deleteFromActionMenu();

    expect(result).toBeNull();
    expect(mockTaskOps.connectionAdapter.removeConnection).not.toHaveBeenCalled();
    expect(service.linkActionMenu()).toBeNull();
  });

  it('hint-only 时删除提示应先自动收起，确认动作随后保持无效', () => {
    service.showLinkDeleteHint({
      from: 'source-task',
      to: 'target-task',
      isCrossTree: true,
    } as any, 200, 280);

    hintOnlyReadOnly.set(true);
    TestBed.flushEffects();

    const result = service.confirmLinkDelete();

    expect(result).toBeNull();
    expect(mockTaskOps.connectionAdapter.removeConnection).not.toHaveBeenCalled();
    expect(service.linkDeleteHint()).toBeNull();
  });

  it('hint-only 时拖拽建链不应打开连接类型对话框', () => {
    hintOnlyReadOnly.set(true);
    TestBed.flushEffects();
    mockProjectState.getTask.mockImplementation((taskId: string) => {
      if (taskId === 'source-task') return { id: 'source-task', title: '源任务', stage: 1, parentId: null };
      if (taskId === 'target-task') return { id: 'target-task', title: '目标任务', stage: 2, parentId: null };
      return null;
    });

    const result = service.handleLinkGesture('source-task', 'target-task', 120, 200);

    expect(result).toBe('none');
    expect(service.linkTypeDialog()).toBeNull();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '创建连接暂不可用，owner 确认完成前保持只读');
  });

  it('hint-only 时桌面端右键删除入口不应触发删除', () => {
    hintOnlyReadOnly.set(true);
    TestBed.flushEffects();

    const result = service.deleteLink({
      from: 'source-task',
      to: 'target-task',
      isCrossTree: true,
    } as any);

    expect(result).toBeNull();
    expect(mockTaskOps.connectionAdapter.removeConnection).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '删除关联暂不可用，owner 确认完成前保持只读');
  });

  it('hint-only 时快捷键批量删除跨树关联不应触发删除', () => {
    hintOnlyReadOnly.set(true);
    TestBed.flushEffects();

    service.handleDeleteCrossTreeLinks([
      {
        from: 'source-task',
        to: 'target-task',
        isCrossTree: true,
      } as any,
    ]);

    expect(mockTaskOps.connectionAdapter.removeConnection).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '删除关联暂不可用，owner 确认完成前保持只读');
  });

  it('hint-only 时直接建立跨树关联不应显示成功提示', () => {
    hintOnlyReadOnly.set(true);
    TestBed.flushEffects();
    mockProjectState.getTask.mockImplementation((taskId: string) => {
      if (taskId === 'source-task') return { id: 'source-task', title: '源任务', stage: 1, parentId: null };
      if (taskId === 'target-task') return { id: 'target-task', title: '目标任务', stage: 2, parentId: 'parent-task' };
      return null;
    });

    const result = service.handleLinkGesture('source-task', 'target-task', 120, 200);

    expect(result).toBe('none');
    expect(mockTaskOps.connectionAdapter.addCrossTreeConnection).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '创建连接暂不可用，owner 确认完成前保持只读');
    expect(mockToast.success).not.toHaveBeenCalledWith('已创建关联', '目标任务已有父级，已创建关联连接');
  });
});
