import { describe, expect, it } from 'vitest';
import * as go from 'gojs';

import {
  axisStillRejected,
  computeStableDocCenterFromClient,
  createOverviewPointerState,
  readRejectedDirection,
  shouldSkipRejectedPositionWrite,
} from './flow-overview-pointer.helpers';

describe('flow-overview-pointer.helpers', () => {
  it('creates a neutral pointer state for a fresh overview interaction', () => {
    const state = createOverviewPointerState();

    expect(state).toEqual({
      capturedPointerId: null,
      hasPointerCapture: false,
      isDraggingBox: false,
      isManualBoxDrag: false,
      isMouseDraggingBox: false,
      isResettingOverviewInteraction: false,
      suppressNextOverviewClick: false,
      manualDragStartClientX: 0,
      manualDragStartClientY: 0,
      manualDragStartViewToDocFactorX: 1,
      manualDragStartViewToDocFactorY: 1,
      manualDragStartBoxCenterDoc: null,
      manualDragViewportSize: null,
      rejectedDragBoundary: null,
      pendingDragClientX: null,
      pendingDragClientY: null,
      pendingDragRafId: null,
    });
  });

  it('classifies rejected drag direction with a one-pixel tolerance', () => {
    expect(readRejectedDirection(102, 100)).toBe(1);
    expect(readRejectedDirection(98, 100)).toBe(-1);
    expect(readRejectedDirection(100.5, 100)).toBe(0);
  });

  it('detects whether an axis remains rejected in the same direction', () => {
    expect(axisStillRejected(103, 100, 1)).toBe(true);
    expect(axisStillRejected(97, 100, -1)).toBe(true);
    expect(axisStillRejected(100.5, 100, 0)).toBe(true);
    expect(axisStillRejected(99, 100, 1)).toBe(false);
  });

  it('skips duplicate position writes while the diagram keeps clamping to the same boundary', () => {
    const state = createOverviewPointerState();
    const acceptedPosition = new go.Point(10, 20);
    state.rejectedDragBoundary = {
      acceptedPosition,
      blockX: 1,
      blockY: 0,
    };

    expect(shouldSkipRejectedPositionWrite(state, new go.Point(12, 20.5), acceptedPosition)).toBe(true);
    expect(shouldSkipRejectedPositionWrite(state, new go.Point(9, 20.5), acceptedPosition)).toBe(false);
  });

  it('computes a stable document center from drag-start client deltas', () => {
    const state = createOverviewPointerState();
    state.manualDragStartClientX = 100;
    state.manualDragStartClientY = 200;
    state.manualDragStartViewToDocFactorX = 2;
    state.manualDragStartViewToDocFactorY = 3;
    state.manualDragStartBoxCenterDoc = new go.Point(50, 75);

    expect(computeStableDocCenterFromClient(state, 105, 190)).toEqual(new go.Point(60, 45));
  });
});
