import { TestBed } from '@angular/core/testing';
import { NgZone } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import { FlowTouchService } from './flow-touch.service';
import { FlowDragDropService } from './flow-drag-drop.service';
import { LoggerService } from '../../../../services/logger.service';
import type { Task } from '../../../../models';

describe('FlowTouchService', () => {
  let service: FlowTouchService;
  const mockDragDropService = {
    findInsertPosition: vi.fn(() => ({})),
  };

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: '待分配任务',
    content: '',
    status: 'active',
    stage: null,
    order: 0,
    rank: 0,
    x: 0,
    y: 0,
    parentId: null,
    displayId: 'T1',
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attachments: [],
    tags: [],
    parkingMeta: null,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();

    TestBed.configureTestingModule({
      providers: [
        FlowTouchService,
        { provide: FlowDragDropService, useValue: mockDragDropService },
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
        { provide: NgZone, useValue: new NgZone({ enableLongStackTrace: false }) },
      ],
    });

    service = TestBed.inject(FlowTouchService);
  });

  afterEach(() => {
    service.cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('应返回是否成功启动 touch 会话，避免无效 touch 安装全局监听', () => {
    const task = createTask();

    expect(service.startTouch({ touches: [] } as unknown as TouchEvent, task)).toBe(false);
    expect(service.hasActiveTouchSession).toBe(false);

    expect(service.startTouch({ touches: [{ clientX: 130, clientY: 150 }] } as unknown as TouchEvent, task)).toBe(true);
    expect(service.hasActiveTouchSession).toBe(true);
  });

  it('应在 pointerup 兜底时按显式坐标完成 drop', () => {
    vi.useFakeTimers();
    const task = createTask();
    const insertInfo = { afterTaskId: 'task-2' };
    mockDragDropService.findInsertPosition.mockReturnValue(insertInfo);

    const diagramDiv = document.createElement('div');
    vi.spyOn(diagramDiv, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 120,
      right: 500,
      bottom: 520,
      width: 400,
      height: 400,
      x: 100,
      y: 120,
      toJSON: () => ({}),
    } as DOMRect);

    const diagram = {
      transformViewToDoc: vi.fn((point: go.Point) => point),
    } as unknown as go.Diagram;

    const callback = vi.fn();

    service.startTouch({ touches: [{ clientX: 130, clientY: 150 }] } as unknown as TouchEvent, task);
    vi.advanceTimersByTime(1000);
    service.handleTouchMove({ touches: [{ clientX: 260, clientY: 310 }] } as unknown as TouchEvent);

    service.endTouchAtPosition(diagramDiv, diagram, callback, 260, 310);

    expect(mockDragDropService.findInsertPosition).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledOnce();

    const [droppedTask, droppedInsertInfo, droppedPoint] = callback.mock.calls[0] as [Task, typeof insertInfo, go.Point];
    expect(droppedTask.id).toBe(task.id);
    expect(droppedInsertInfo).toEqual(insertInfo);
    expect(droppedPoint.x).toBe(160);
    expect(droppedPoint.y).toBe(190);
  });

  it('应通过 pointer 会话完成移动端待分配 drop', () => {
    vi.useFakeTimers();
    const task = createTask();
    const insertInfo = { parentId: 'parent-1' };
    mockDragDropService.findInsertPosition.mockReturnValue(insertInfo);

    const source = document.createElement('button');
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const hasPointerCapture = vi.fn(() => true);
    Object.assign(source, { setPointerCapture, releasePointerCapture, hasPointerCapture });

    const diagramDiv = document.createElement('div');
    vi.spyOn(diagramDiv, 'getBoundingClientRect').mockReturnValue({
      left: 40,
      top: 80,
      right: 440,
      bottom: 480,
      width: 400,
      height: 400,
      x: 40,
      y: 80,
      toJSON: () => ({}),
    } as DOMRect);

    const diagram = {
      transformViewToDoc: vi.fn((point: go.Point) => point),
    } as unknown as go.Diagram;

    const callback = vi.fn();

    service.startPointer({
      pointerId: 9,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 90,
      clientY: 120,
      currentTarget: source,
    } as unknown as PointerEvent, task);

    expect(service.hasActiveTouchSession).toBe(true);
    expect(service.isPointerSessionActive).toBe(true);

    vi.advanceTimersByTime(1000);
    service.handlePointerMove({
      pointerId: 9,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 250,
      clientY: 320,
    } as unknown as PointerEvent);

    service.endPointer({
      pointerId: 9,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 250,
      clientY: 320,
    } as unknown as PointerEvent, diagramDiv, diagram, callback);

    expect(setPointerCapture).toHaveBeenCalledWith(9);
    expect(callback).toHaveBeenCalledOnce();
    expect(releasePointerCapture).toHaveBeenCalledWith(9);

    const [droppedTask, droppedInsertInfo, droppedPoint] = callback.mock.calls[0] as [Task, typeof insertInfo, go.Point];
    expect(droppedTask.id).toBe(task.id);
    expect(droppedInsertInfo).toEqual(insertInfo);
    expect(droppedPoint.x).toBe(210);
    expect(droppedPoint.y).toBe(240);
  });

  it('drop 回调抛错时仍应清理拖拽会话、ghost 和 pointer capture', () => {
    vi.useFakeTimers();
    const task = createTask();
    const insertInfo = { parentId: 'parent-1' };
    mockDragDropService.findInsertPosition.mockReturnValue(insertInfo);

    const source = document.createElement('button');
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const hasPointerCapture = vi.fn(() => true);
    Object.assign(source, { setPointerCapture, releasePointerCapture, hasPointerCapture });

    const diagramDiv = document.createElement('div');
    vi.spyOn(diagramDiv, 'getBoundingClientRect').mockReturnValue({
      left: 40,
      top: 80,
      right: 440,
      bottom: 480,
      width: 400,
      height: 400,
      x: 40,
      y: 80,
      toJSON: () => ({}),
    } as DOMRect);

    const diagram = {
      transformViewToDoc: vi.fn((point: go.Point) => point),
    } as unknown as go.Diagram;
    const callbackError = new Error('drop failed');

    service.startPointer({
      pointerId: 9,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 90,
      clientY: 120,
      currentTarget: source,
    } as unknown as PointerEvent, task);
    vi.advanceTimersByTime(1000);

    expect(document.body.textContent).toContain(task.title);

    service.handlePointerMove({
      pointerId: 9,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 250,
      clientY: 320,
    } as unknown as PointerEvent);

    expect(() => service.endPointer({
      pointerId: 9,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 250,
      clientY: 320,
    } as unknown as PointerEvent, diagramDiv, diagram, () => {
      throw callbackError;
    })).toThrow(callbackError);

    expect(service.hasActiveTouchSession).toBe(false);
    expect(service.isPointerSessionActive).toBe(false);
    expect(service.isTouchDragging).toBe(false);
    expect(service.draggingId()).toBeNull();
    expect(document.body.textContent).not.toContain(task.title);
    expect(releasePointerCapture).toHaveBeenCalledWith(9);
  });

  it('touchcancel 不应提交 drop，但应清理触摸会话', () => {
    vi.useFakeTimers();
    const task = createTask();

    const diagramDiv = document.createElement('div');
    vi.spyOn(diagramDiv, 'getBoundingClientRect').mockReturnValue({
      left: 80,
      top: 100,
      right: 480,
      bottom: 500,
      width: 400,
      height: 400,
      x: 80,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect);

    const diagram = {
      transformViewToDoc: vi.fn((point: go.Point) => point),
    } as unknown as go.Diagram;

    const callback = vi.fn();

    service.startTouch({ touches: [{ identifier: 7, clientX: 120, clientY: 140 }] } as unknown as TouchEvent, task);
    vi.advanceTimersByTime(1000);
    service.handleTouchMove({ touches: [{ identifier: 7, clientX: 240, clientY: 280 }] } as unknown as TouchEvent);

    service.endTouch({ type: 'touchcancel', changedTouches: [] } as unknown as TouchEvent, diagramDiv, diagram, callback);

    expect(callback).not.toHaveBeenCalled();
    expect(service.hasActiveTouchSession).toBe(false);
  });

  it('移动超过阈值时应清理 long-press timer，即使浏览器 timer handle 为 0', () => {
    const longPressTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => longPressTimer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const task = createTask();

    service.startTouch({
      touches: [{ identifier: 7, clientX: 120, clientY: 140 }],
    } as unknown as TouchEvent, task);
    service.handleTouchMove({
      touches: [{ identifier: 7, clientX: 160, clientY: 190 }],
    } as unknown as TouchEvent);

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });

  it('cleanup 应清理 pointer fallback timer，即使浏览器 timer handle 为 0', () => {
    const fallbackTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    const touchService = service as unknown as {
      pendingPointerFallbackCleanup: ReturnType<typeof setTimeout> | null;
    };
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    touchService.pendingPointerFallbackCleanup = fallbackTimer;

    service.cleanup();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(touchService.pendingPointerFallbackCleanup).toBeNull();
  });

  it('cleanup 清理 long-press timer 失败时仍应重置触摸会话状态', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementationOnce(() => {
        throw new Error('long press timer cleanup failed');
      })
      .mockImplementation(() => undefined);
    const task = createTask();

    service.startTouch({
      touches: [{ identifier: 7, clientX: 120, clientY: 140 }],
    } as unknown as TouchEvent, task);

    expect(() => service.cleanup()).not.toThrow();

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(service.hasActiveTouchSession).toBe(false);
    expect(service.isTouchDragging).toBe(false);
    expect(service.draggingId()).toBeNull();
  });

  it('cleanup 清理 pointer fallback timer 失败时仍应置空 fallback 状态', () => {
    const fallbackTimer = 1 as unknown as ReturnType<typeof setTimeout>;
    const touchService = service as unknown as {
      pendingPointerFallbackCleanup: ReturnType<typeof setTimeout> | null;
      pointerFallbackExpired: (() => void) | undefined;
    };
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementationOnce(() => {
        throw new Error('pointer fallback cleanup failed');
      })
      .mockImplementation(() => undefined);
    touchService.pendingPointerFallbackCleanup = fallbackTimer;
    touchService.pointerFallbackExpired = vi.fn();

    expect(() => service.cleanup()).not.toThrow();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(fallbackTimer);
    expect(touchService.pendingPointerFallbackCleanup).toBeNull();
    expect(touchService.pointerFallbackExpired).toBeUndefined();
  });

  it('重新 arm pointer fallback 时旧 timer 清理失败也应安装新的兜底 timer', () => {
    vi.useFakeTimers();
    const task = createTask();
    const fallbackExpired = vi.fn();

    service.startTouch({
      touches: [{ identifier: 7, clientX: 120, clientY: 140 }],
    } as unknown as TouchEvent, task);
    vi.advanceTimersByTime(1000);

    expect(service.deferCancelForPointerFallback(fallbackExpired)).toBe(true);
    const touchService = service as unknown as {
      pendingPointerFallbackCleanup: ReturnType<typeof setTimeout> | null;
    };
    const firstFallbackTimer = touchService.pendingPointerFallbackCleanup;
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementationOnce(() => {
        throw new Error('replace pointer fallback timer failed');
      })
      .mockImplementation(() => undefined);

    expect(() => service.handlePointerFallbackMove(160, 190)).not.toThrow();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(firstFallbackTimer);
    expect(touchService.pendingPointerFallbackCleanup).not.toBe(firstFallbackTimer);
    expect(touchService.pendingPointerFallbackCleanup).not.toBeNull();
  });

  it('pointercancel 不应提交 drop，但应清理 pointer 会话', () => {
    vi.useFakeTimers();
    const task = createTask();
    const callback = vi.fn();

    service.startPointer({
      pointerId: 11,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 120,
      clientY: 140,
      currentTarget: document.createElement('div'),
    } as unknown as PointerEvent, task);
    vi.advanceTimersByTime(1000);

    service.cancelPointer(null, null, callback);

    expect(callback).not.toHaveBeenCalled();
    expect(service.hasActiveTouchSession).toBe(false);
    expect(service.isPointerSessionActive).toBe(false);
  });

  it('dispose 后重新 activate 应恢复待分配触摸拖拽', () => {
    const task = createTask();
    service.dispose();
    service.activate();

    service.startTouch({ touches: [{ clientX: 120, clientY: 140 }] } as unknown as TouchEvent, task);

    expect(service.hasActiveTouchSession).toBe(true);
  });

  it('GoJS SelectionMoved 监听注册失败后不应阻塞后续重试', () => {
    const registerError = new Error('diagram listener failed');
    const failingDiagram = {
      addDiagramListener: vi.fn(() => {
        throw registerError;
      }),
    } as unknown as go.Diagram;
    const healthyDiagram = {
      addDiagramListener: vi.fn(),
    } as unknown as go.Diagram;

    expect(() => service.installDiagramDragGhostListeners(failingDiagram, true)).not.toThrow();
    service.installDiagramDragGhostListeners(healthyDiagram, true);

    expect(failingDiagram.addDiagramListener).toHaveBeenCalledWith('SelectionMoved', expect.any(Function));
    expect(healthyDiagram.addDiagramListener).toHaveBeenCalledWith('SelectionMoved', expect.any(Function));
  });

  it('dispose 清理全局 resize 监听时应隔离单个 removeEventListener 失败并清空追踪状态', () => {
    const handler = service.createDrawerResizeHandler(
      vi.fn(),
      vi.fn(),
      () => 40,
    );
    const removeError = new Error('remove listener failed');
    const originalRemoveEventListener = window.removeEventListener.bind(window);
    const removeSpy = vi.spyOn(window, 'removeEventListener')
      .mockImplementationOnce((...args: Parameters<typeof window.removeEventListener>) => {
        originalRemoveEventListener(...args);
        throw removeError;
      })
      .mockImplementation((...args: Parameters<typeof window.removeEventListener>) => {
        originalRemoveEventListener(...args);
      });

    handler.startResize({
      preventDefault: vi.fn(),
      touches: [{ clientY: 300 }],
    } as unknown as TouchEvent);

    expect(() => service.dispose()).not.toThrow();

    expect(removeSpy).toHaveBeenCalledTimes(3);
    expect((service as unknown as { activeListeners: unknown[] }).activeListeners).toEqual([]);
  });

  it('重复启动抽屉触摸 resize 时应移除上一组全局监听器', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const handler = service.createDrawerResizeHandler(
      vi.fn(),
      vi.fn(),
      () => 40,
    );
    const firstEvent = {
      preventDefault: vi.fn(),
      touches: [{ clientY: 300 }],
    } as unknown as TouchEvent;
    const secondEvent = {
      preventDefault: vi.fn(),
      touches: [{ clientY: 260 }],
    } as unknown as TouchEvent;

    handler.startResize(firstEvent);
    handler.startResize(secondEvent);

    const firstTouchMoveHandler = addSpy.mock.calls.find(([type]) => type === 'touchmove')?.[1];
    const firstTouchEndHandler = addSpy.mock.calls.find(([type]) => type === 'touchend')?.[1];

    expect(removeSpy).toHaveBeenCalledWith('touchmove', firstTouchMoveHandler);
    expect(removeSpy).toHaveBeenCalledWith('touchend', firstTouchEndHandler);
    expect(removeSpy).toHaveBeenCalledWith('touchcancel', firstTouchEndHandler);

    handler.cleanup();
  });

  it('resize handler cleanup 应隔离单个 removeEventListener 失败并清空追踪状态', () => {
    const handler = service.createDrawerResizeHandler(
      vi.fn(),
      vi.fn(),
      () => 40,
    );
    const removeError = new Error('remove listener failed');
    const originalRemoveEventListener = window.removeEventListener.bind(window);
    const removeSpy = vi.spyOn(window, 'removeEventListener')
      .mockImplementationOnce((...args: Parameters<typeof window.removeEventListener>) => {
        originalRemoveEventListener(...args);
        throw removeError;
      })
      .mockImplementation((...args: Parameters<typeof window.removeEventListener>) => {
        originalRemoveEventListener(...args);
      });

    handler.startResize({
      preventDefault: vi.fn(),
      touches: [{ clientY: 300 }],
    } as unknown as TouchEvent);

    expect(() => handler.cleanup()).not.toThrow();

    expect(removeSpy).toHaveBeenCalledTimes(3);
    expect((service as unknown as { activeListeners: unknown[] }).activeListeners).toEqual([]);
  });
});
