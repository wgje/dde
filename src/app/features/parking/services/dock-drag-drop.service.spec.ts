import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DockEngineService } from '../../../../services/dock-engine.service';
import { GateService } from '../../../../services/gate.service';
import { FocusDockLeaderService } from '../../../../services/focus-dock-leader.service';
import { TaskStore } from '../../../core/state/stores';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { DockDragDropService } from './dock-drag-drop.service';

describe('DockDragDropService', () => {
  let service: DockDragDropService;
  let setDockExpanded: ReturnType<typeof vi.fn>;
  let dockTaskFromExternalDrag: ReturnType<typeof vi.fn>;
  let toggleLoad: ReturnType<typeof vi.fn>;
  let getTask: ReturnType<typeof vi.fn>;
  const gateActive = signal(false);
  const readOnlyFollower = signal(false);

  beforeEach(() => {
    setDockExpanded = vi.fn();
    dockTaskFromExternalDrag = vi.fn(() => Promise.resolve(true));
    toggleLoad = vi.fn();
    getTask = vi.fn();
    gateActive.set(false);
    readOnlyFollower.set(false);
    TestBed.configureTestingModule({
      providers: [
        DockDragDropService,
        {
          provide: DockEngineService,
          useValue: {
            dockExpanded: signal(false),
            focusMode: signal(false),
            focusScrimOn: signal(false),
            dockedEntries: signal([]),
            setDockExpanded,
            dockTaskFromExternalDrag,
            toggleLoad,
          },
        },
        { provide: TaskStore, useValue: { getTask } },
        { provide: GateService, useValue: { isActive: gateActive } },
        { provide: FocusDockLeaderService, useValue: { isReadOnlyFollower: readOnlyFollower } },
      ],
    });
    service = TestBed.inject(DockDragDropService);
  });

  it('clears external drag state and pending semicircle expansion on drag end', () => {
    vi.useFakeTimers();
    try {
      const dataTransfer = { types: ['application/x-nanoflow-task'] } as unknown as DataTransfer;

      service.onDockRailDragEnter({
        preventDefault: vi.fn(),
        dataTransfer,
      } as unknown as DragEvent);
      expect(service.dropState()).toBe('canDrop');

      service.onDockCardDragEnd();
      vi.advanceTimersByTime(PARKING_CONFIG.DOCK_SEMICIRCLE_DRAG_EXPAND_DELAY_MS);

      expect(service.dropState()).toBe('idle');
      expect(service.semicircleHoverExpanded()).toBe(false);
      expect(setDockExpanded).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not run a late semicircle drag expansion after dock mutation becomes blocked', () => {
    vi.useFakeTimers();
    try {
      const dataTransfer = { types: ['application/x-nanoflow-task'] } as unknown as DataTransfer;

      service.onDockRailDragOver({
        preventDefault: vi.fn(),
        dataTransfer,
      } as unknown as DragEvent);
      gateActive.set(true);

      vi.advanceTimersByTime(PARKING_CONFIG.DOCK_SEMICIRCLE_DRAG_EXPAND_DELAY_MS);

      expect(service.semicircleHoverExpanded()).toBe(false);
      expect(setDockExpanded).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears external drag state when dock mutation becomes blocked before drag leave', () => {
    vi.useFakeTimers();
    try {
      const dataTransfer = { types: ['application/x-nanoflow-task'] } as unknown as DataTransfer;

      service.onDockRailDragEnter({
        preventDefault: vi.fn(),
        dataTransfer,
      } as unknown as DragEvent);
      expect(service.dropState()).toBe('canDrop');

      gateActive.set(true);
      service.onDockRailDragLeave();
      vi.advanceTimersByTime(PARKING_CONFIG.DOCK_SEMICIRCLE_DRAG_EXPAND_DELAY_MS);

      expect(service.dropState()).toBe('idle');
      expect(service.semicircleHoverExpanded()).toBe(false);
      expect(setDockExpanded).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for external drop commit before marking recently docked', async () => {
    vi.useFakeTimers();
    try {
      getTask.mockReturnValue({ id: 'task-1', status: 'active' });
      dockTaskFromExternalDrag.mockResolvedValue(true);
      const markRecentlyDocked = vi.fn();
      const dataTransfer = createTaskDataTransfer('task-1', 'flow');

      service.onDrop({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer,
      } as unknown as DragEvent, markRecentlyDocked);

      expect(dockTaskFromExternalDrag).toHaveBeenCalledWith('task-1', 'flow');
      expect(markRecentlyDocked).not.toHaveBeenCalled();
      expect(service.dropState()).toBe('idle');

      await flushMicrotasks();

      expect(markRecentlyDocked).toHaveBeenCalledWith('task-1');
      expect(service.dropState()).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows reject feedback when final external drop commit resolves false', async () => {
    vi.useFakeTimers();
    try {
      getTask.mockReturnValue({ id: 'task-1', status: 'active' });
      dockTaskFromExternalDrag.mockResolvedValue(false);
      const markRecentlyDocked = vi.fn();
      const dataTransfer = createTaskDataTransfer('task-1', 'flow');

      service.onDrop({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer,
      } as unknown as DragEvent, markRecentlyDocked);

      expect(dockTaskFromExternalDrag).toHaveBeenCalledWith('task-1', 'flow');
      expect(markRecentlyDocked).not.toHaveBeenCalled();
      expect(service.dropState()).toBe('idle');

      await flushMicrotasks();

      expect(markRecentlyDocked).not.toHaveBeenCalled();
      expect(service.dropState()).toBe('reject');

      vi.advanceTimersByTime(PARKING_CONFIG.DOCK_DROP_REJECT_RESET_MS);
      expect(service.dropState()).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending long-press reorder when touch movement exceeds the gesture threshold first', () => {
    vi.useFakeTimers();
    try {
      service.onTouchStart({
        touches: [{ clientY: 100 }],
      } as unknown as TouchEvent, 'task-1');

      service.onTouchMove({
        touches: [{ clientY: 150 }],
      } as unknown as TouchEvent);
      vi.advanceTimersByTime(PARKING_CONFIG.DOCK_LONG_PRESS_DELAY_MS);
      service.onTouchMove({
        touches: [{ clientY: 210 }],
      } as unknown as TouchEvent);

      expect(toggleLoad).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a late touch long-press reorder after service destroy', () => {
    vi.useFakeTimers();
    try {
      service.ngOnDestroy();

      service.onTouchStart({
        touches: [{ clientY: 100 }],
      } as unknown as TouchEvent, 'task-1');
      vi.advanceTimersByTime(PARKING_CONFIG.DOCK_LONG_PRESS_DELAY_MS);
      service.onTouchMove({
        touches: [{ clientY: 150 }],
      } as unknown as TouchEvent);

      expect(toggleLoad).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores pointer end events from a different touch while a long-press reorder is pending', () => {
    vi.useFakeTimers();
    try {
      service.onPointerStart(createTouchPointerEvent('pointerdown', {
        clientY: 100,
        pointerId: 1,
      }), 'task-1');

      service.onPointerEnd(createTouchPointerEvent('pointerup', {
        clientY: 100,
        pointerId: 2,
      }));

      vi.advanceTimersByTime(PARKING_CONFIG.DOCK_LONG_PRESS_DELAY_MS);
      service.onPointerMove(createTouchPointerEvent('pointermove', {
        clientY: 150,
        pointerId: 1,
      }));

      expect(toggleLoad).toHaveBeenCalledWith('task-1', 'down');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows reject feedback when final external drop commit rejects', async () => {
    vi.useFakeTimers();
    try {
      getTask.mockReturnValue({ id: 'task-1', status: 'active' });
      const rejectedCommit = Promise.reject(new Error('persist failed'));
      rejectedCommit.catch(() => undefined);
      dockTaskFromExternalDrag.mockReturnValue(rejectedCommit);
      const markRecentlyDocked = vi.fn();
      const dataTransfer = createTaskDataTransfer('task-1', 'flow');

      service.onDrop({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer,
      } as unknown as DragEvent, markRecentlyDocked);

      expect(dockTaskFromExternalDrag).toHaveBeenCalledWith('task-1', 'flow');
      expect(markRecentlyDocked).not.toHaveBeenCalled();
      expect(service.dropState()).toBe('idle');

      await flushMicrotasks();

      expect(markRecentlyDocked).not.toHaveBeenCalled();
      expect(service.dropState()).toBe('reject');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not update drop UI after service destroy while external commit is pending', async () => {
    vi.useFakeTimers();
    try {
      getTask.mockReturnValue({ id: 'task-1', status: 'active' });
      const commit = createDeferred<boolean>();
      dockTaskFromExternalDrag.mockReturnValue(commit.promise);
      const markRecentlyDocked = vi.fn();
      const dataTransfer = createTaskDataTransfer('task-1', 'flow');

      service.onDrop({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer,
      } as unknown as DragEvent, markRecentlyDocked);

      service.ngOnDestroy();
      commit.resolve(false);
      await flushMicrotasks();

      expect(markRecentlyDocked).not.toHaveBeenCalled();
      expect(service.dropState()).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });
});

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'touch';
  }
}

function createTouchPointerEvent(type: string, init: PointerEventInit = {}): PointerEvent {
  return new TestPointerEvent(type, init) as PointerEvent;
}

function createTaskDataTransfer(taskId: string, source: 'text' | 'flow'): DataTransfer {
  return {
    types: ['application/x-nanoflow-task'],
    getData: vi.fn((mime: string) => mime === 'application/x-nanoflow-task'
      ? JSON.stringify({
          v: 1,
          type: 'task',
          taskId,
          projectId: 'project-1',
          source,
        })
      : ''),
  } as unknown as DataTransfer;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
