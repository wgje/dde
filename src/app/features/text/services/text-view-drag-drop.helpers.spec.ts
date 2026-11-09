import { describe, expect, it } from 'vitest';
import {
  applyAutoScrollAmount,
  applyDragGhostFeedback,
  calculateDragGhostPosition,
  createDragGhostElement,
  createDragGhostCss,
  createInitialTouchDragState,
  createTouchMoveMetrics,
  getAutoScrollAmount,
  getNestedAutoScrollAmount,
  getNextAutoScrollContainer,
  removeDragGhostElement,
} from './text-view-drag-drop.helpers';

describe('text-view-drag-drop.helpers', () => {
  it('creates a clean touch drag state', () => {
    const state = createInitialTouchDragState();

    expect(state.task).toBeNull();
    expect(state.isDragging).toBe(false);
    expect(state.targetStage).toBeNull();
    expect(state.targetBeforeId).toBeNull();
    expect(state.targetUnassignedId).toBeNull();
    expect(state.gestureMode).toBe('default');
    expect(state.expandedDuringDrag.size).toBe(0);
  });

  it('distinguishes default vertical scroll intent from handle drag movement', () => {
    const defaultMetrics = createTouchMoveMetrics({
      touch: { clientX: 104, clientY: 130 },
      startX: 100,
      startY: 100,
      gestureMode: 'default',
      defaultMoveThreshold: 15,
      handleMoveThreshold: 6,
      defaultVerticalScrollRatio: 3.5,
    });

    expect(defaultMetrics.isVerticalScroll).toBe(true);
    expect(defaultMetrics.threshold).toBe(15);

    const handleMetrics = createTouchMoveMetrics({
      touch: { clientX: 104, clientY: 130 },
      startX: 100,
      startY: 100,
      gestureMode: 'handle',
      defaultMoveThreshold: 15,
      handleMoveThreshold: 6,
      defaultVerticalScrollRatio: 3.5,
    });

    expect(handleMetrics.isVerticalScroll).toBe(false);
    expect(handleMetrics.threshold).toBe(6);
  });

  it('clamps drag ghost position and emits required CSS tokens', () => {
    const position = calculateDragGhostPosition({
      x: 20,
      y: 590,
      width: 200,
      height: 48,
      margin: 10,
      viewportWidth: 360,
      viewportHeight: 640,
    });

    expect(position).toEqual({ x: 10, y: 582, width: 200, height: 48 });
    const css = createDragGhostCss(position);
    expect(css).toContain('position: fixed');
    expect(css).toContain('left: 10px');
    expect(css).toContain('top: 582px');
    expect(css).toContain('opacity: 0.3');
  });

  it('applies valid and invalid drag ghost feedback colors', () => {
    const ghost = document.createElement('div');

    applyDragGhostFeedback(ghost, true);
    expect(ghost.style.borderColor).toBe('#4A8C8C');
    expect(ghost.style.boxShadow).toContain('rgba(74, 140, 140, 0.4)');

    applyDragGhostFeedback(ghost, false);
    expect(ghost.style.borderColor).toBe('#C15B3E');
    expect(ghost.style.boxShadow).toContain('rgba(193, 91, 62, 0.3)');
  });

  it('creates a drag ghost element and logs its placement', () => {
    const logger = { debug: vi.fn() };

    const ghost = createDragGhostElement({
      taskId: 'task-1234',
      title: '',
      x: 20,
      y: 590,
      viewportWidth: 360,
      viewportHeight: 640,
      timestamp: 123,
      logger,
    });

    expect(ghost.id).toBe('touch-drag-ghost-123');
    expect(ghost.innerText).toBe('未命名任务');
    expect(document.body.contains(ghost)).toBe(true);
    expect(logger.debug).toHaveBeenCalledWith('🎯 Ghost created:', expect.objectContaining({
      taskId: '1234',
      ghostId: 'touch-drag-ghost-123',
    }));

    ghost.remove();
  });

  it('removes the current drag ghost and cleans orphaned ghost elements', () => {
    vi.useFakeTimers();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const current = document.createElement('div');
    current.id = 'current';
    current.setAttribute('data-drag-ghost', 'true');
    const active = document.createElement('div');
    active.id = 'active';
    active.setAttribute('data-drag-ghost', 'true');
    const orphaned = document.createElement('div');
    orphaned.id = 'orphaned';
    orphaned.setAttribute('data-drag-ghost', 'true');
    document.body.append(current, active, orphaned);

    removeDragGhostElement({
      ghost: current,
      getActiveGhostId: () => 'active',
      logger,
    });
    vi.advanceTimersByTime(0);

    expect(document.body.contains(current)).toBe(false);
    expect(document.body.contains(active)).toBe(true);
    expect(document.body.contains(orphaned)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();

    active.remove();
    vi.useRealTimers();
  });

  it('computes edge auto-scroll amounts for nested and outer containers', () => {
    const rect = createRect(100, 300);

    expect(getNestedAutoScrollAmount(110, rect)).toBeLessThan(0);
    expect(getNestedAutoScrollAmount(390, rect)).toBeGreaterThan(0);
    expect(getNestedAutoScrollAmount(240, rect)).toBe(0);

    expect(getAutoScrollAmount(120, rect)).toBeLessThan(0);
    expect(getAutoScrollAmount(390, rect)).toBeGreaterThan(0);
    expect(getAutoScrollAmount(240, rect)).toBe(0);
  });

  it('applies scroll amount and resolves auto-scroll fallback containers', () => {
    const outer = document.createElement('div');
    outer.className = 'text-view-scroll-container';
    const stage = document.createElement('div');
    stage.setAttribute('data-stage-scroll-container', '');
    const taskList = document.createElement('div');
    taskList.setAttribute('data-stage-task-list', '1');
    stage.appendChild(taskList);
    outer.appendChild(stage);
    document.body.appendChild(outer);

    let scrollTop = 0;
    Object.defineProperty(stage, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    expect(applyAutoScrollAmount(stage, 12)).toBe(true);
    expect(stage.scrollTop).toBe(12);
    expect(getNextAutoScrollContainer(taskList)).toBe(stage);
    expect(getNextAutoScrollContainer(stage)).toBe(outer);
    expect(getNextAutoScrollContainer(outer)).toBeNull();

    outer.remove();
  });
});

function createRect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: 320,
    bottom: top + height,
    width: 320,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}
