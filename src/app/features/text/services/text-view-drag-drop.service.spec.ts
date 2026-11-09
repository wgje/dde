import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { TextViewDragDropService } from './text-view-drag-drop.service';

describe('TextViewDragDropService', () => {
  let service: TextViewDragDropService;

  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: '阶段任务',
    content: '',
    status: 'active',
    stage: 1,
    order: 0,
    parentId: null,
    rank: 0,
    x: 0,
    y: 0,
    createdDate: new Date('2026-04-11T10:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-04-11T10:00:00.000Z').toISOString(),
    attachments: [],
    tags: [],
    parkingMeta: null,
    expected_minutes: null,
    wait_minutes: null,
    cognitive_load: null,
    displayId: '1,a',
    ...overrides,
  });

  const createTouch = (clientX: number, clientY: number): Touch => ({
    clientX,
    clientY,
  } as Touch);

  const mockRect = (element: HTMLElement, top: number, height: number) => {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: top,
      top,
      left: 0,
      bottom: top + height,
      right: 0,
      width: 320,
      height,
      toJSON: () => ({}),
    } as DOMRect);
  };

  const mockScrollable = (element: HTMLElement, initialScrollTop: number, maxScrollTop: number) => {
    let currentScrollTop = initialScrollTop;
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get: () => currentScrollTop,
      set: (value: number) => {
        currentScrollTop = Math.min(maxScrollTop, Math.max(0, value));
      },
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    TestBed.configureTestingModule({
      providers: [
        TextViewDragDropService,
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => logger),
          },
        },
      ],
    });

    service = TestBed.inject(TextViewDragDropService);
  });

  afterEach(() => {
    service?.cleanup();
    vi.runOnlyPendingTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.querySelectorAll('[data-drag-ghost="true"]').forEach(node => node.remove());
  });

  it('should treat vertical body movement as scroll intent in default mode', () => {
    const task = createTask();

    service.startTouchDrag(task, createTouch(100, 100), vi.fn());
    const moved = service.handleTouchMove(createTouch(104, 130));

    expect(moved).toBe(false);
    expect(service.isTouchDragging).toBe(false);
    expect(service.touchDragTask).toBeNull();
    expect(service.draggingTaskId()).toBeNull();
  });

  it('should activate drag on vertical movement when the gesture starts from the handle', () => {
    const task = createTask();

    service.startTouchDrag(task, createTouch(100, 100), vi.fn(), { gestureMode: 'handle' });
    const moved = service.handleTouchMove(createTouch(104, 130));

    expect(moved).toBe(true);
    expect(service.isTouchDragging).toBe(true);
    expect(service.touchDragTask).toMatchObject({ id: task.id });
    expect(service.draggingTaskId()).toBe(task.id);
  });

  it('should clear long-press timer handle 0 when movement becomes scroll intent', () => {
    const longPressTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => longPressTimer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const task = createTask();

    service.startTouchDrag(task, createTouch(100, 100), vi.fn());
    service.handleTouchMove(createTouch(104, 130));

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(service.touchDragTask).toBeNull();
  });

  it('should clear move timeout handle 0 when touch drag ends', () => {
    const timer = 0 as unknown as ReturnType<typeof setTimeout>;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => timer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const task = createTask();

    service.startTouchDrag(task, createTouch(100, 100), vi.fn(), { gestureMode: 'handle' });
    service.handleTouchMove(createTouch(130, 130));
    clearTimeoutSpy.mockClear();

    service.endTouchDrag();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });

  it('should clear move timeout handle 0 when cleanup runs during touch drag', () => {
    const timer = 0 as unknown as ReturnType<typeof setTimeout>;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => timer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const task = createTask();

    service.startTouchDrag(task, createTouch(100, 100), vi.fn(), { gestureMode: 'handle' });
    service.handleTouchMove(createTouch(130, 130));
    clearTimeoutSpy.mockClear();

    service.cleanup();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });

  describe('鼠标拖拽丢失看门狗', () => {
    const startMouseDrag = (taskId = 'task-watchdog') => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      service.startDrag(createTask({ id: taskId }));
      service.startAutoScroll(container, 120);
      return container;
    };

    it('拖拽源节点被移除且 dragover 静默 1.5s 后应广播 mouseDragLost 自愈事件', () => {
      const lostListener = vi.fn();
      document.addEventListener('mouseDragLost', lostListener);
      const container = startMouseDrag();

      try {
        // 源节点从未挂到 DOM（等价于拖拽中被远端同步移除）
        vi.advanceTimersByTime(1500);

        expect(lostListener).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
          '[MouseDrag] 拖拽源节点已被移除且 dragover 静默，dragend 可能已丢失，触发自愈清理',
          { draggingTaskId: 'task-watchdog' },
        );
      } finally {
        document.removeEventListener('mouseDragLost', lostListener);
        container.remove();
      }
    });

    it('源节点仍在 DOM 时（拖出窗口场景）不应误判，只重新武装看门狗', () => {
      const lostListener = vi.fn();
      document.addEventListener('mouseDragLost', lostListener);
      const container = startMouseDrag();
      const sourceCard = document.createElement('div');
      sourceCard.setAttribute('data-task-id', 'task-watchdog');
      document.body.appendChild(sourceCard);

      try {
        vi.advanceTimersByTime(1500 * 3);

        expect(lostListener).not.toHaveBeenCalled();

        // 源节点消失后，下一轮看门狗才触发自愈
        sourceCard.remove();
        vi.advanceTimersByTime(1500);
        expect(lostListener).toHaveBeenCalledTimes(1);
      } finally {
        document.removeEventListener('mouseDragLost', lostListener);
        sourceCard.remove();
        container.remove();
      }
    });

    it('dragover 心跳应重置看门狗计时', () => {
      const lostListener = vi.fn();
      document.addEventListener('mouseDragLost', lostListener);
      const container = startMouseDrag();

      try {
        vi.advanceTimersByTime(1400);
        // dragover 心跳到达 -> 重新计时
        (service as unknown as { handleDragAutoScroll: (e: { clientY: number }) => void })
          .handleDragAutoScroll({ clientY: 200 });
        vi.advanceTimersByTime(1400);

        expect(lostListener).not.toHaveBeenCalled();

        vi.advanceTimersByTime(200);
        expect(lostListener).toHaveBeenCalledTimes(1);
      } finally {
        document.removeEventListener('mouseDragLost', lostListener);
        container.remove();
      }
    });

    it('endDrag 后看门狗必须被清除，不再广播丢失事件', () => {
      const lostListener = vi.fn();
      document.addEventListener('mouseDragLost', lostListener);
      const container = startMouseDrag();

      try {
        service.endDrag();
        vi.advanceTimersByTime(1500 * 2);

        expect(lostListener).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener('mouseDragLost', lostListener);
        container.remove();
      }
    });
  });

  it('should keep DOM update guard active until the latest beginDOMUpdate timer expires', () => {
    service.beginDOMUpdate();
    vi.advanceTimersByTime(80);

    service.beginDOMUpdate();
    vi.advanceTimersByTime(20);

    expect(service.isDOMUpdating).toBe(true);

    vi.advanceTimersByTime(80);

    expect(service.isDOMUpdating).toBe(false);
  });

  it('should use a shorter long-press delay for handle gestures', () => {
    const handleTask = createTask();
    service.startTouchDrag(handleTask, createTouch(100, 100), vi.fn(), { gestureMode: 'handle' });

    vi.advanceTimersByTime(179);
    expect(service.isTouchDragging).toBe(false);

    vi.advanceTimersByTime(1);
    expect(service.isTouchDragging).toBe(true);

    service.endTouchDrag();

    const defaultTask = createTask({ id: 'task-2' });
    service.startTouchDrag(defaultTask, createTouch(100, 100), vi.fn());

    vi.advanceTimersByTime(180);
    expect(service.isTouchDragging).toBe(false);

    vi.advanceTimersByTime(320);
    expect(service.isTouchDragging).toBe(true);
  });

  it('should only keep auto-opened stages in the pending collapse set', () => {
    const task = createTask();
    service.startTouchDrag(task, createTouch(100, 100), vi.fn(), { gestureMode: 'handle' });
    vi.advanceTimersByTime(180);

    service.switchToStage(2, { autoExpanded: false });
    expect(service.endTouchDrag().autoExpandedStages).toEqual([]);

    service.startTouchDrag(task, createTouch(100, 100), vi.fn(), { gestureMode: 'handle' });
    vi.advanceTimersByTime(180);

    service.switchToStage(3, { autoExpanded: true });
    expect(service.endTouchDrag().autoExpandedStages).toEqual([3]);
  });

  it('should hand off auto-scroll from the task list to the stage list while the pointer stays at the edge', () => {
    const outer = document.createElement('div');
    outer.className = 'text-view-scroll-container';
    const stageList = document.createElement('div');
    stageList.setAttribute('data-stage-scroll-container', '');
    const taskList = document.createElement('div');
    taskList.setAttribute('data-stage-task-list', '1');
    stageList.appendChild(taskList);
    outer.appendChild(stageList);
    document.body.appendChild(outer);

    mockScrollable(stageList, 0, 400);
    mockScrollable(taskList, 360, 360);
    mockScrollable(outer, 0, 480);

    mockRect(taskList, 100, 180);
    mockRect(stageList, 80, 320);
    mockRect(outer, 0, 480);

    const autoScrollState = (service as unknown as {
      autoScrollState: { scrollContainer: HTMLElement | null; lastClientY: number; stickyScrollAmount: number | null };
      performAutoScrollStep: () => void;
    }).autoScrollState;
    autoScrollState.scrollContainer = taskList;
    autoScrollState.lastClientY = 270;

    (service as unknown as { performAutoScrollStep: () => void }).performAutoScrollStep();

    const firstStageScrollTop = stageList.scrollTop;

    (service as unknown as { performAutoScrollStep: () => void }).performAutoScrollStep();

    expect(firstStageScrollTop).toBeGreaterThan(0);
    expect(stageList.scrollTop).toBeGreaterThan(firstStageScrollTop);
    expect(autoScrollState.scrollContainer).toBe(stageList);
    expect(autoScrollState.stickyScrollAmount).toBeGreaterThan(0);

    outer.remove();
  });

  it('should hand off auto-scroll to the outer text view when both task list and stage list are exhausted', () => {
    const outer = document.createElement('div');
    outer.className = 'text-view-scroll-container';
    const stageList = document.createElement('div');
    stageList.setAttribute('data-stage-scroll-container', '');
    const taskList = document.createElement('div');
    taskList.setAttribute('data-stage-task-list', '1');
    stageList.appendChild(taskList);
    outer.appendChild(stageList);
    document.body.appendChild(outer);

    mockScrollable(stageList, 400, 400);
    mockScrollable(taskList, 360, 360);
    mockScrollable(outer, 0, 480);

    mockRect(taskList, 100, 180);
    mockRect(stageList, 80, 320);
    mockRect(outer, 0, 480);

    const autoScrollState = (service as unknown as {
      autoScrollState: { scrollContainer: HTMLElement | null; lastClientY: number; stickyScrollAmount: number | null };
      performAutoScrollStep: () => void;
    }).autoScrollState;
    autoScrollState.scrollContainer = taskList;
    autoScrollState.lastClientY = 270;

    (service as unknown as { performAutoScrollStep: () => void }).performAutoScrollStep();

    const firstOuterScrollTop = outer.scrollTop;

    (service as unknown as { performAutoScrollStep: () => void }).performAutoScrollStep();

    expect(firstOuterScrollTop).toBeGreaterThan(0);
    expect(outer.scrollTop).toBeGreaterThan(firstOuterScrollTop);
    expect(autoScrollState.scrollContainer).toBe(outer);
    expect(autoScrollState.stickyScrollAmount).toBeGreaterThan(0);

    outer.remove();
  });
});
