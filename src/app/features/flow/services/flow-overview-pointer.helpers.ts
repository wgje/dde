import * as go from 'gojs';

export type RejectedDragDirection = -1 | 0 | 1;
export type OverviewViewportSize = { w: number; h: number };

export interface RejectedDragBoundary {
  acceptedPosition: go.Point;
  blockX: RejectedDragDirection;
  blockY: RejectedDragDirection;
}

export interface OverviewPointerState {
  capturedPointerId: number | null;
  hasPointerCapture: boolean;
  isDraggingBox: boolean;
  isManualBoxDrag: boolean;
  isMouseDraggingBox: boolean;
  isResettingOverviewInteraction: boolean;
  suppressNextOverviewClick: boolean;
  manualDragStartClientX: number;
  manualDragStartClientY: number;
  manualDragStartViewToDocFactorX: number;
  manualDragStartViewToDocFactorY: number;
  manualDragStartBoxCenterDoc: go.Point | null;
  manualDragViewportSize: OverviewViewportSize | null;
  rejectedDragBoundary: RejectedDragBoundary | null;
  pendingDragClientX: number | null;
  pendingDragClientY: number | null;
  pendingDragRafId: number | null;
}

export function createOverviewPointerState(): OverviewPointerState {
  return {
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
  };
}

export function readRejectedDirection(desiredValue: number, acceptedValue: number): RejectedDragDirection {
  const epsilon = 1;
  if (desiredValue > acceptedValue + epsilon) return 1;
  if (desiredValue < acceptedValue - epsilon) return -1;
  return 0;
}

export function axisStillRejected(
  desiredValue: number,
  acceptedValue: number,
  direction: RejectedDragDirection,
): boolean {
  const epsilon = 1;
  if (direction > 0) return desiredValue > acceptedValue + epsilon;
  if (direction < 0) return desiredValue < acceptedValue - epsilon;
  return Math.abs(desiredValue - acceptedValue) < epsilon;
}

export function shouldSkipRejectedPositionWrite(
  state: OverviewPointerState,
  desiredPos: go.Point,
  currentPosition: go.Point,
): boolean {
  if (!state.rejectedDragBoundary || !currentPosition.equals(state.rejectedDragBoundary.acceptedPosition)) {
    return false;
  }

  return axisStillRejected(desiredPos.x, state.rejectedDragBoundary.acceptedPosition.x, state.rejectedDragBoundary.blockX)
    && axisStillRejected(desiredPos.y, state.rejectedDragBoundary.acceptedPosition.y, state.rejectedDragBoundary.blockY);
}

export function computeStableDocCenterFromClient(
  state: OverviewPointerState,
  clientX: number,
  clientY: number,
): go.Point | null {
  if (!state.manualDragStartBoxCenterDoc) return null;
  const viewDeltaX = clientX - state.manualDragStartClientX;
  const viewDeltaY = clientY - state.manualDragStartClientY;
  return new go.Point(
    state.manualDragStartBoxCenterDoc.x + viewDeltaX * state.manualDragStartViewToDocFactorX,
    state.manualDragStartBoxCenterDoc.y + viewDeltaY * state.manualDragStartViewToDocFactorY,
  );
}
