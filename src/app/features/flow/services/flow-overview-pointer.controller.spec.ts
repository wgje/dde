import { NgZone } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import {
  FlowOverviewPointerController,
  type FlowOverviewPointerControllerHost,
} from './flow-overview-pointer.controller';

describe('FlowOverviewPointerController', () => {
  let container: HTMLDivElement;
  let host: FlowOverviewPointerControllerHost;
  let hostState: ReturnType<typeof createHostState>;
  let diagram: go.Diagram;
  let overview: go.Overview;
  let zone: Pick<NgZone, 'runOutsideAngular'>;

  beforeEach(() => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 42));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    container = document.createElement('div');
    container.style.touchAction = 'pan-y';
    container.setPointerCapture = vi.fn();
    container.releasePointerCapture = vi.fn();
    document.body.appendChild(container);

    diagram = createDiagramMock();
    overview = createOverviewMock();
    hostState = createHostState();
    host = createHost(hostState, diagram, overview);
    zone = createZoneMock();
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('restores touchAction and removes pointer listeners on detach', () => {
    const controller = createController();
    const addSpy = vi.spyOn(container, 'addEventListener');
    const removeSpy = vi.spyOn(container, 'removeEventListener');
    const windowAddSpy = vi.spyOn(window, 'addEventListener');
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');

    controller.attach(container);

    expect(container.style.touchAction).toBe('none');
    expect(zone.runOutsideAngular).toHaveBeenCalledOnce();
    expect(addSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), { passive: false, capture: true });
    expect(addSpy).toHaveBeenCalledWith('click', expect.any(Function), { passive: false, capture: true });
    expect(windowAddSpy).toHaveBeenCalledWith('pointermove', expect.any(Function), { passive: false });
    expect(windowAddSpy).toHaveBeenCalledWith('pointercancel', expect.any(Function), { passive: false });

    controller.detach();

    expect(container.style.touchAction).toBe('pan-y');
    expect(removeSpy).toHaveBeenCalledWith(
      'pointerdown',
      expect.any(Function),
      { capture: true } as EventListenerOptions,
    );
    expect(removeSpy).toHaveBeenCalledWith('click', expect.any(Function), { capture: true } as EventListenerOptions);
    expect(windowRemoveSpy).toHaveBeenCalledWith('pointermove', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('pointercancel', expect.any(Function));
    expect(hostState.isOverviewBoxDragging).toBe(false);
    expect(hostState.isOverviewInteracting).toBe(false);
  });

  it('does not attach listeners or mutate touchAction after the overview host is destroyed', () => {
    hostState.destroyed = true;
    const controller = createController();
    const addSpy = vi.spyOn(container, 'addEventListener');
    const removeSpy = vi.spyOn(container, 'removeEventListener');
    const windowAddSpy = vi.spyOn(window, 'addEventListener');
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');

    controller.attach(container);
    controller.detach();

    expect(container.style.touchAction).toBe('pan-y');
    expect(zone.runOutsideAngular).not.toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(windowAddSpy).not.toHaveBeenCalled();
    expect(windowRemoveSpy).not.toHaveBeenCalled();
    expect(hostState.isOverviewBoxDragging).toBe(false);
    expect(hostState.isOverviewInteracting).toBe(false);
  });

  it('cancels a pending drag frame and releases pointer capture when detached mid-drag', () => {
    const controller = createController();
    controller.attach(container);

    container.dispatchEvent(createPointerEvent('pointerdown', { clientX: 10, clientY: 10, pointerId: 7 }));
    container.dispatchEvent(createPointerEvent('pointermove', { clientX: 28, clientY: 34, pointerId: 7 }));

    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(container.setPointerCapture).toHaveBeenCalledWith(7);
    expect((diagram as unknown as { skipsUndoManager: boolean }).skipsUndoManager).toBe(true);

    controller.detach();
    window.dispatchEvent(createPointerEvent('pointermove', { clientX: 80, clientY: 90, pointerId: 7 }));

    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
    expect(container.releasePointerCapture).toHaveBeenCalledWith(7);
    expect((diagram as unknown as { skipsUndoManager: boolean }).skipsUndoManager).toBe(false);
    expect(hostState.isOverviewBoxDragging).toBe(false);
    expect(hostState.isOverviewInteracting).toBe(false);
    expect(hostState.overviewBoxViewportBounds).toBeNull();
    expect(hostState.overviewInteractionLastApplyAt).toBe(0);
    expect(hostState.clearViewportBindings).toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it('cancels manual overview drag without committing the pointercancel position', () => {
    const controller = createController();
    controller.attach(container);

    container.dispatchEvent(createPointerEvent('pointerdown', { clientX: 10, clientY: 10, pointerId: 7 }));
    container.dispatchEvent(createPointerEvent('pointermove', { clientX: 28, clientY: 34, pointerId: 7 }));
    const positionBeforeCancel = diagram.position.copy();

    container.dispatchEvent(createPointerEvent('pointercancel', { clientX: 120, clientY: 140, pointerId: 7 }));

    expect(diagram.position.equals(positionBeforeCancel)).toBe(true);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
    expect(container.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(hostState.applyOverviewUpdateNow).not.toHaveBeenCalled();
    expect(hostState.scheduleOverviewUpdate).not.toHaveBeenCalled();
    expect(hostState.isOverviewBoxDragging).toBe(false);
    expect(hostState.isOverviewInteracting).toBe(false);
    expect((diagram as unknown as { skipsUndoManager: boolean }).skipsUndoManager).toBe(false);

    controller.detach();
  });

  it('suppresses only the synthetic click immediately after a manual overview drag', () => {
    const controller = createController();
    controller.attach(container);

    container.dispatchEvent(createPointerEvent('pointerdown', { clientX: 10, clientY: 10, pointerId: 7 }));
    container.dispatchEvent(createPointerEvent('pointerup', { clientX: 10, clientY: 10, pointerId: 7 }));

    const syntheticClick = createMouseEvent('click');
    const nextClick = createMouseEvent('click');
    const firstPreventDefault = vi.spyOn(syntheticClick, 'preventDefault');
    const nextPreventDefault = vi.spyOn(nextClick, 'preventDefault');

    container.dispatchEvent(syntheticClick);
    container.dispatchEvent(nextClick);

    expect(firstPreventDefault).toHaveBeenCalledTimes(1);
    expect(nextPreventDefault).not.toHaveBeenCalled();

    controller.detach();
  });

  it('ignores late pointer starts after the overview host is destroyed', () => {
    const controller = createController();
    controller.attach(container);
    hostState.destroyed = true;

    container.dispatchEvent(createPointerEvent('pointerdown', { clientX: 10, clientY: 10, pointerId: 7 }));

    expect(container.setPointerCapture).not.toHaveBeenCalled();
    expect(hostState.isOverviewBoxDragging).toBe(false);
    expect(hostState.isOverviewInteracting).toBe(false);
    expect(hostState.clearViewportBindings).not.toHaveBeenCalled();

    controller.detach();
  });

  it('ignores late pointer releases after the overview host is destroyed', () => {
    const controller = createController();
    controller.attach(container);

    container.dispatchEvent(createPointerEvent('pointerdown', { clientX: 10, clientY: 10, pointerId: 7 }));
    const positionBeforeRelease = diagram.position.copy();
    hostState.applyOverviewUpdateNow.mockClear();
    hostState.scheduleOverviewUpdate.mockClear();
    hostState.destroyed = true;

    container.dispatchEvent(createPointerEvent('pointerup', { clientX: 80, clientY: 90, pointerId: 7 }));

    expect(diagram.position.equals(positionBeforeRelease)).toBe(true);
    expect(hostState.applyOverviewUpdateNow).not.toHaveBeenCalled();
    expect(hostState.scheduleOverviewUpdate).not.toHaveBeenCalled();
    expect(container.releasePointerCapture).toHaveBeenCalledWith(7);
    expect((diagram as unknown as { skipsUndoManager: boolean }).skipsUndoManager).toBe(false);
    expect(hostState.isOverviewBoxDragging).toBe(false);
    expect(hostState.isOverviewInteracting).toBe(false);

    controller.detach();
  });

  function createController(): FlowOverviewPointerController {
    return new FlowOverviewPointerController(zone as NgZone, host);
  }
});

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

function createPointerEvent(type: string, init: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

function createMouseEvent(type: string, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

function createZoneMock(): Pick<NgZone, 'runOutsideAngular'> & { runOutsideAngular: ReturnType<typeof vi.fn> } {
  const runOutsideAngular = vi.fn().mockImplementation(<T>(callback: () => T): T => callback());
  return { runOutsideAngular } as Pick<NgZone, 'runOutsideAngular'> & { runOutsideAngular: ReturnType<typeof vi.fn> };
}

function createDiagramMock(): go.Diagram {
  return {
    position: new go.Point(0, 0),
    viewportBounds: new go.Rect(0, 0, 200, 120),
    skipsUndoManager: false,
  } as go.Diagram;
}

function createOverviewMock(): go.Overview {
  return {
    box: {
      actualBounds: new go.Rect(0, 0, 100, 100),
    },
    transformViewToDoc: vi.fn((point: go.Point) => point),
  } as unknown as go.Overview;
}

function createHostState() {
  return {
    hasManualBoxMovement: false,
    destroyed: false,
    isOverviewBoxDragging: false,
    isOverviewInteracting: false,
    overviewBoxViewportBounds: null as go.Rect | null,
    overviewInteractionLastApplyAt: 123,
    clearOverviewBoundsCache: vi.fn(),
    clearViewportBindings: vi.fn(),
    scheduleOverviewUpdate: vi.fn(),
    applyOverviewUpdateNow: vi.fn(),
    cancelScheduledOverviewUpdate: vi.fn(),
    requestInteractionRefresh: vi.fn(),
    syncOverviewBoxToViewport: vi.fn(),
    setOverviewReleaseViewportBounds: vi.fn(),
    setOverviewReleaseShouldAnchor: vi.fn(),
    setOverviewPostDragAnchorSuppressionBounds: vi.fn(),
    setOverviewSuppressNextViewportAnchor: vi.fn(),
    setOverviewUpdateDelay: vi.fn(),
  };
}

function createHost(
  state: ReturnType<typeof createHostState>,
  diagram: go.Diagram,
  overview: go.Overview,
): FlowOverviewPointerControllerHost {
  return {
    debug: vi.fn(),
    getDiagram: () => diagram,
    getOverview: () => overview,
    isDestroyed: () => state.destroyed,
    getHasManualBoxMovement: () => state.hasManualBoxMovement,
    setHasManualBoxMovement: (value) => { state.hasManualBoxMovement = value; },
    getIsOverviewBoxDragging: () => state.isOverviewBoxDragging,
    setIsOverviewBoxDragging: (value) => { state.isOverviewBoxDragging = value; },
    getIsOverviewInteracting: () => state.isOverviewInteracting,
    setIsOverviewInteracting: (value) => { state.isOverviewInteracting = value; },
    getOverviewBoxViewportBounds: () => state.overviewBoxViewportBounds,
    setOverviewBoxViewportBounds: (bounds) => { state.overviewBoxViewportBounds = bounds; },
    setOverviewReleaseViewportBounds: state.setOverviewReleaseViewportBounds,
    setOverviewReleaseShouldAnchor: state.setOverviewReleaseShouldAnchor,
    setOverviewPostDragAnchorSuppressionBounds: state.setOverviewPostDragAnchorSuppressionBounds,
    setOverviewSuppressNextViewportAnchor: state.setOverviewSuppressNextViewportAnchor,
    clearOverviewBoundsCache: state.clearOverviewBoundsCache,
    getOverviewInteractionLastApplyAt: () => state.overviewInteractionLastApplyAt,
    setOverviewInteractionLastApplyAt: (value) => { state.overviewInteractionLastApplyAt = value; },
    scheduleOverviewUpdate: state.scheduleOverviewUpdate,
    applyOverviewUpdateNow: state.applyOverviewUpdateNow,
    cancelScheduledOverviewUpdate: state.cancelScheduledOverviewUpdate,
    clearViewportBindings: state.clearViewportBindings,
    syncOverviewBoxToViewport: state.syncOverviewBoxToViewport,
    setOverviewUpdateDelay: state.setOverviewUpdateDelay,
    getIdleUpdateDelayMs: () => 80,
    getDragUpdateDelayMs: () => 16,
    requestInteractionRefresh: state.requestInteractionRefresh,
  };
}
