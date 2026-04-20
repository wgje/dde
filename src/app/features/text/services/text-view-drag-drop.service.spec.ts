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
