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
  let mockTaskOps: {
    connectionAdapter: {
      removeConnection: ReturnType<typeof vi.fn>;
      updateConnectionContent: ReturnType<typeof vi.fn>;
      addCrossTreeConnection: ReturnType<typeof vi.fn>;
    };
    detachTask: ReturnType<typeof vi.fn>;
    moveTaskToStage: ReturnType<typeof vi.fn>;
    getDirectChildren: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    originalInnerWidth = window.innerWidth;
    originalInnerHeight = window.innerHeight;

    mockTaskOps = {
      connectionAdapter: {
        removeConnection: vi.fn(),
        updateConnectionContent: vi.fn(),
        addCrossTreeConnection: vi.fn(),
      },
      detachTask: vi.fn(),
      moveTaskToStage: vi.fn(() => ({ ok: true })),
      getDirectChildren: vi.fn(() => []),
    };

    TestBed.configureTestingModule({
      providers: [
        FlowLinkService,
        {
          provide: ProjectStateService,
          useValue: {
            activeProjectId: signal('project-1'),
            getTask: vi.fn(() => null),
          },
        },
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
        {
          provide: ToastService,
          useValue: {
            success: vi.fn(),
            warning: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
          },
        },
        {
          provide: UiStateService,
          useValue: {
            isMobile: signal(true),
          },
        },
        { provide: FlowLinkRelinkService, useValue: {} },
      ],
    });

    service = TestBed.inject(FlowLinkService);
  });

  afterEach(() => {
    service.dispose();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
  });

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
});
