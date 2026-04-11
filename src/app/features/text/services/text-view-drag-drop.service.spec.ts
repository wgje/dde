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
});