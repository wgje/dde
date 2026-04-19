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
    vi.useRealTimers();
    TestBed.resetTestingModule();
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

  it('dispose 后重新 activate 应恢复待分配触摸拖拽', () => {
    const task = createTask();
    service.dispose();
    service.activate();

    service.startTouch({ touches: [{ clientX: 120, clientY: 140 }] } as unknown as TouchEvent, task);

    expect(service.hasActiveTouchSession).toBe(true);
  });
});
