import { NgZone } from '@angular/core';
import * as go from 'gojs';

import {
  axisStillRejected,
  computeStableDocCenterFromClient,
  createOverviewPointerState,
  readRejectedDirection,
  shouldSkipRejectedPositionWrite,
  type OverviewPointerState,
  type OverviewViewportSize,
} from './flow-overview-pointer.helpers';
import type { OverviewUpdateSource } from './flow-overview-viewport.helpers';

interface OverviewPointerHandlers {
  onClick: (ev: MouseEvent) => void;
  onPointerDown: (ev: PointerEvent) => void;
  onPointerMove: (ev: PointerEvent) => void;
  onPointerUpLike: (ev?: PointerEvent) => void;
  onPointerCancel: (ev?: PointerEvent) => void;
  onWindowPointerMove: (ev: PointerEvent) => void;
  onWindowPointerUp: (ev: PointerEvent) => void;
  onWindowPointerCancel: (ev: PointerEvent) => void;
  onMouseDown: (ev: MouseEvent) => void;
  onMouseMove: (ev: MouseEvent) => void;
  onMouseUp: (ev: MouseEvent) => void;
  resetOverviewInteractionState: () => void;
}

export interface FlowOverviewPointerControllerHost {
  debug(message: string, value?: unknown): void;
  getDiagram(): go.Diagram | null;
  getOverview(): go.Overview | null;
  isDestroyed(): boolean;
  getHasManualBoxMovement(): boolean;
  setHasManualBoxMovement(value: boolean): void;
  getIsOverviewBoxDragging(): boolean;
  setIsOverviewBoxDragging(value: boolean): void;
  getIsOverviewInteracting(): boolean;
  setIsOverviewInteracting(value: boolean): void;
  getOverviewBoxViewportBounds(): go.Rect | null;
  setOverviewBoxViewportBounds(bounds: go.Rect | null): void;
  setOverviewReleaseViewportBounds(bounds: go.Rect | null): void;
  setOverviewReleaseShouldAnchor(value: boolean): void;
  setOverviewPostDragAnchorSuppressionBounds(bounds: go.Rect | null): void;
  setOverviewSuppressNextViewportAnchor(value: boolean): void;
  clearOverviewBoundsCache(): void;
  getOverviewInteractionLastApplyAt(): number;
  setOverviewInteractionLastApplyAt(value: number): void;
  scheduleOverviewUpdate(source: OverviewUpdateSource): void;
  applyOverviewUpdateNow(source: OverviewUpdateSource): void;
  cancelScheduledOverviewUpdate(): void;
  clearViewportBindings(): void;
  syncOverviewBoxToViewport(viewportBounds: go.Rect): void;
  setOverviewUpdateDelay(delayMs: number): void;
  getIdleUpdateDelayMs(): number;
  getDragUpdateDelayMs(): number;
  requestInteractionRefresh(): void;
}

export class FlowOverviewPointerController {
  private cleanup: (() => void) | null = null;

  constructor(
    private readonly zone: NgZone,
    private readonly host: FlowOverviewPointerControllerHost,
  ) {}

  attach(container: HTMLDivElement): void {
    this.detach();
    if (this.host.isDestroyed()) return;

    const prevTouchAction = container.style.touchAction;
    container.style.touchAction = 'none';
    const supportsPointerEvents = typeof PointerEvent !== 'undefined';
    const state = createOverviewPointerState();
    const handlers = this.createHandlers(container, state);

    this.registerListeners(container, handlers, supportsPointerEvents);
    this.cleanup = () => {
      container.style.touchAction = prevTouchAction;
      handlers.resetOverviewInteractionState();
      this.removeListeners(container, handlers, supportsPointerEvents);
    };
  }

  detach(): void {
    if (!this.cleanup) return;
    this.cleanup();
    this.cleanup = null;
  }

  private getDocPointFromClient(container: HTMLDivElement, clientX: number, clientY: number): go.Point | null {
    const overview = this.host.getOverview();
    if (!overview) return null;

    const rect = container.getBoundingClientRect();
    const viewX = clientX - rect.left;
    const viewY = clientY - rect.top;
    return overview.transformViewToDoc(new go.Point(viewX, viewY));
  }

  private stopManualDragEvent(ev: Event): void {
    try { (ev as Event & { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.(); } catch { /* noop */ }
    try { ev.stopPropagation(); } catch { /* noop */ }
    try { (ev as Event & { preventDefault?: () => void }).preventDefault?.(); } catch { /* noop */ }
  }

  private moveBoxToCenter(center: go.Point, viewportSize?: OverviewViewportSize | null): void {
    const overview = this.host.getOverview();
    if (!overview) return;

    const box = overview.box;
    const bounds = box?.actualBounds;
    if (!box || !bounds?.isReal()) return;

    const width = viewportSize?.w ?? bounds.width;
    const height = viewportSize?.h ?? bounds.height;
    this.host.syncOverviewBoxToViewport(new go.Rect(center.x - width / 2, center.y - height / 2, width, height));
  }

  private updateBoxViewportBounds(centerOverride?: go.Point, fallbackDocPt?: go.Point): void {
    const diagram = this.host.getDiagram();
    const overview = this.host.getOverview();
    if (!diagram || !overview) return;

    const vb = diagram.viewportBounds;
    if (!vb.isReal()) return;

    const boxBounds = overview.box?.actualBounds;
    const center = centerOverride ?? (boxBounds?.isReal() ? boxBounds.center : fallbackDocPt);
    if (!center) return;

    this.host.setOverviewBoxViewportBounds(new go.Rect(
      center.x - vb.width / 2,
      center.y - vb.height / 2,
      vb.width,
      vb.height,
    ));
  }

  private beginManualBoxDrag(state: OverviewPointerState, pt: go.Point, clientX: number, clientY: number): void {
    const diagram = this.host.getDiagram();
    const overview = this.host.getOverview();
    if (!diagram || !overview) return;

    const vb = diagram.viewportBounds;
    if (!vb.isReal()) return;

    this.host.setHasManualBoxMovement(false);
    state.rejectedDragBoundary = null;
    state.manualDragViewportSize = { w: vb.width, h: vb.height };

    const viewportCenter = new go.Point(
      diagram.position.x + vb.width / 2,
      diagram.position.y + vb.height / 2,
    );
    const startOrigin = overview.transformViewToDoc(new go.Point(0, 0));
    const startUnitX = overview.transformViewToDoc(new go.Point(1, 0));
    const startUnitY = overview.transformViewToDoc(new go.Point(0, 1));
    const factorX = startUnitX.x - startOrigin.x;
    const factorY = startUnitY.y - startOrigin.y;
    if (!Number.isFinite(factorX) || !Number.isFinite(factorY) || factorX === 0 || factorY === 0) {
      this.host.debug('beginManualBoxDrag: 退化的 view→doc 映射，跳过手动拖拽初始化');
      return;
    }

    state.manualDragStartClientX = clientX;
    state.manualDragStartClientY = clientY;
    state.manualDragStartViewToDocFactorX = factorX;
    state.manualDragStartViewToDocFactorY = factorY;
    state.manualDragStartBoxCenterDoc = viewportCenter.copy();

    try { diagram.skipsUndoManager = true; } catch { /* noop */ }
    this.host.setOverviewUpdateDelay(this.host.getDragUpdateDelayMs());
    state.isManualBoxDrag = true;
    this.updateBoxViewportBounds(viewportCenter, pt);
  }

  private settleRejectedManualDrag(
    state: OverviewPointerState,
    desiredPos: go.Point,
    acceptedPosition: go.Point,
    viewportSize: OverviewViewportSize,
  ): void {
    const blockX = readRejectedDirection(desiredPos.x, acceptedPosition.x);
    const blockY = readRejectedDirection(desiredPos.y, acceptedPosition.y);
    state.rejectedDragBoundary = blockX !== 0 || blockY !== 0
      ? { acceptedPosition: acceptedPosition.copy(), blockX, blockY }
      : null;
    const acceptedBoxCenter = new go.Point(
      acceptedPosition.x + viewportSize.w / 2,
      acceptedPosition.y + viewportSize.h / 2,
    );
    this.moveBoxToCenter(acceptedBoxCenter, viewportSize);
    this.updateBoxViewportBounds(acceptedBoxCenter);
    this.host.cancelScheduledOverviewUpdate();
  }

  private applyManualBoxDrag(state: OverviewPointerState, clientX: number, clientY: number): boolean {
    const diagram = this.host.getDiagram();
    if (!diagram || !state.isManualBoxDrag || !state.manualDragViewportSize || !state.manualDragStartBoxCenterDoc) {
      return false;
    }

    const stableCenter = computeStableDocCenterFromClient(state, clientX, clientY);
    if (!stableCenter) return false;

    const desiredPos = new go.Point(
      stableCenter.x - state.manualDragViewportSize.w / 2,
      stableCenter.y - state.manualDragViewportSize.h / 2,
    );
    let acceptedPosition = diagram.position;

    if (state.rejectedDragBoundary && acceptedPosition.equals(state.rejectedDragBoundary.acceptedPosition)) {
      if (axisStillRejected(desiredPos.x, acceptedPosition.x, state.rejectedDragBoundary.blockX)) {
        desiredPos.x = acceptedPosition.x;
      }
      if (axisStillRejected(desiredPos.y, acceptedPosition.y, state.rejectedDragBoundary.blockY)) {
        desiredPos.y = acceptedPosition.y;
      }
    }

    let acceptedMovement = false;
    let attemptedPositionWrite = false;
    if (shouldSkipRejectedPositionWrite(state, desiredPos, acceptedPosition)) return false;

    if (!acceptedPosition.equals(desiredPos)) {
      attemptedPositionWrite = true;
      const previousPosition = acceptedPosition.copy();
      diagram.position = desiredPos;
      acceptedPosition = diagram.position;
      acceptedMovement = !acceptedPosition.equals(previousPosition);
      this.host.setHasManualBoxMovement(this.host.getHasManualBoxMovement() || acceptedMovement);
    }

    if (!acceptedMovement) {
      if (attemptedPositionWrite) {
        this.settleRejectedManualDrag(state, desiredPos, acceptedPosition, state.manualDragViewportSize);
      }
      return false;
    }

    state.rejectedDragBoundary = null;
    const acceptedBoxCenter = new go.Point(
      acceptedPosition.x + state.manualDragViewportSize.w / 2,
      acceptedPosition.y + state.manualDragViewportSize.h / 2,
    );
    this.moveBoxToCenter(acceptedBoxCenter, state.manualDragViewportSize);
    this.updateBoxViewportBounds(acceptedBoxCenter);
    return true;
  }

  private endManualBoxDrag(state: OverviewPointerState): void {
    if (!state.isManualBoxDrag) return;
    state.isManualBoxDrag = false;
    state.manualDragViewportSize = null;
    state.manualDragStartBoxCenterDoc = null;
    state.rejectedDragBoundary = null;
    this.host.setHasManualBoxMovement(false);
    this.host.setOverviewUpdateDelay(this.host.getIdleUpdateDelayMs());
    const diagram = this.host.getDiagram();
    if (diagram) {
      try { diagram.skipsUndoManager = false; } catch { /* noop */ }
    }
  }

  private cancelPendingDragRaf(state: OverviewPointerState): void {
    if (state.pendingDragRafId !== null) {
      cancelAnimationFrame(state.pendingDragRafId);
      state.pendingDragRafId = null;
    }
    state.pendingDragClientX = null;
    state.pendingDragClientY = null;
  }

  private applyManualBoxDragFromEvent(state: OverviewPointerState, ev: PointerEvent | MouseEvent): void {
    if (!state.isManualBoxDrag) return;
    this.cancelPendingDragRaf(state);
    const acceptedMovement = this.applyManualBoxDrag(state, ev.clientX, ev.clientY);
    if (acceptedMovement) {
      this.host.applyOverviewUpdateNow('viewport');
    }
  }

  private scheduleManualBoxDrag(state: OverviewPointerState, clientX: number, clientY: number): void {
    state.pendingDragClientX = clientX;
    state.pendingDragClientY = clientY;
    if (state.pendingDragRafId !== null) return;
    state.pendingDragRafId = requestAnimationFrame(() => this.flushScheduledManualBoxDrag(state));
  }

  private flushScheduledManualBoxDrag(state: OverviewPointerState): void {
    state.pendingDragRafId = null;
    if (state.pendingDragClientX === null || state.pendingDragClientY === null) return;
    const x = state.pendingDragClientX;
    const y = state.pendingDragClientY;
    state.pendingDragClientX = null;
    state.pendingDragClientY = null;
    if (this.host.isDestroyed()) return;
    if (!state.isManualBoxDrag) return;

    const acceptedMovement = this.applyManualBoxDrag(state, x, y);
    if (!acceptedMovement) return;
    this.host.applyOverviewUpdateNow('viewport');
  }

  private resetInteractionState(state: OverviewPointerState, container: HTMLDivElement): void {
    if (state.isResettingOverviewInteraction) return;

    state.isResettingOverviewInteraction = true;
    const pointerIdToRelease = state.hasPointerCapture ? state.capturedPointerId : null;
    const wasBoxDragReset = state.isDraggingBox || state.isMouseDraggingBox || this.host.getIsOverviewBoxDragging();

    state.capturedPointerId = null;
    state.hasPointerCapture = false;
    state.isDraggingBox = false;
    state.isMouseDraggingBox = false;
    if (wasBoxDragReset) {
      this.captureReleaseBounds();
    }
    this.host.setIsOverviewBoxDragging(false);
    this.host.setIsOverviewInteracting(false);
    this.host.setOverviewInteractionLastApplyAt(0);
    this.host.setOverviewBoxViewportBounds(null);
    this.host.clearViewportBindings();
    this.cancelPendingDragRaf(state);
    this.endManualBoxDrag(state);

    if (pointerIdToRelease !== null) {
      try { container.releasePointerCapture(pointerIdToRelease); } catch { /* noop */ }
    }

    state.isResettingOverviewInteraction = false;
  }

  private captureReleaseBounds(): void {
    const shouldAnchorRelease = !this.host.getHasManualBoxMovement();
    const actualViewportBounds = this.host.getDiagram()?.viewportBounds;
    const actualPosition = this.host.getDiagram()?.position;
    const hasActualPosition = !!actualPosition
      && Number.isFinite(actualPosition.x)
      && Number.isFinite(actualPosition.y);
    const boxViewportBounds = this.host.getOverviewBoxViewportBounds();
    const releaseViewportBounds = actualViewportBounds?.isReal() && hasActualPosition
      ? new go.Rect(actualPosition.x, actualPosition.y, actualViewportBounds.width, actualViewportBounds.height)
      : boxViewportBounds?.isReal()
        ? boxViewportBounds.copy()
        : null;

    this.host.setOverviewReleaseViewportBounds(releaseViewportBounds);
    this.host.setOverviewReleaseShouldAnchor(shouldAnchorRelease);
    this.host.setOverviewPostDragAnchorSuppressionBounds(releaseViewportBounds?.copy() ?? null);
  }

  private suppressViewportAnchorAfterClickWithoutMovement(): void {
    const viewportBounds = this.host.getDiagram()?.viewportBounds;
    this.host.setOverviewPostDragAnchorSuppressionBounds(viewportBounds?.isReal() ? viewportBounds.copy() : null);
    this.host.setOverviewSuppressNextViewportAnchor(true);
    this.host.setOverviewReleaseViewportBounds(null);
    this.host.setOverviewReleaseShouldAnchor(false);
  }

  private createHandlers(container: HTMLDivElement, state: OverviewPointerState): OverviewPointerHandlers {
    const onClick = (ev: MouseEvent): void => this.handleClick(state, ev);
    const onPointerDown = (ev: PointerEvent): void => this.handlePointerDown(container, state, ev);
    const onPointerMove = (ev: PointerEvent): void => this.handlePointerMove(state, ev);
    const onPointerUpLike = (ev?: PointerEvent): void => this.handlePointerUpLike(container, state, ev);
    const onPointerCancel = (ev?: PointerEvent): void => this.handlePointerCancel(container, state, ev);
    const onWindowPointerMove = (ev: PointerEvent): void => this.handleWindowPointerMove(state, ev);
    const onWindowPointerUp = (ev: PointerEvent): void => this.handleWindowPointerUp(state, onPointerUpLike, ev);
    const onWindowPointerCancel = (ev: PointerEvent): void =>
      this.handleWindowPointerCancel(state, onPointerCancel, ev);
    const onMouseDown = (ev: MouseEvent): void => this.handleMouseDown(container, state, ev);
    const onMouseMove = (ev: MouseEvent): void => this.handleMouseMove(state, ev);
    const onMouseUp = (ev: MouseEvent): void => this.handleMouseUp(container, state, ev);

    return {
      onClick,
      onPointerDown,
      onPointerMove,
      onPointerUpLike,
      onPointerCancel,
      onWindowPointerMove,
      onWindowPointerUp,
      onWindowPointerCancel,
      onMouseDown,
      onMouseMove,
      onMouseUp,
      resetOverviewInteractionState: () => this.resetInteractionState(state, container),
    };
  }

  private handleClick(state: OverviewPointerState, ev: MouseEvent): void {
    if (!state.suppressNextOverviewClick) return;
    state.suppressNextOverviewClick = false;
    this.stopManualDragEvent(ev);
  }

  private handlePointerDown(container: HTMLDivElement, state: OverviewPointerState, ev: PointerEvent): void {
    if (this.host.isDestroyed()) return;
    if (this.tryBeginPointerBoxDrag(container, state, ev)) return;
    state.isDraggingBox = false;
    state.suppressNextOverviewClick = false;
    this.host.setIsOverviewInteracting(true);
    try {
      container.setPointerCapture(ev.pointerId);
      state.capturedPointerId = ev.pointerId;
      state.hasPointerCapture = true;
    } catch (e) {
      this.host.debug('setPointerCapture 不可用:', e);
    }
  }

  private handlePointerMove(state: OverviewPointerState, ev: PointerEvent): void {
    if (this.host.isDestroyed()) return;
    if (!state.isDraggingBox || !this.host.getOverview()) return;
    if (state.isManualBoxDrag) this.stopManualDragEvent(ev);
    if (state.capturedPointerId !== null && ev.pointerId !== state.capturedPointerId) return;
    this.scheduleManualBoxDrag(state, ev.clientX, ev.clientY);
  }

  private handlePointerUpLike(container: HTMLDivElement, state: OverviewPointerState, ev?: PointerEvent): void {
    if (this.host.isDestroyed()) {
      this.resetInteractionState(state, container);
      return;
    }

    const wasDraggingBox = state.isDraggingBox;
    const wasInteracting = this.host.getIsOverviewInteracting();
    if (wasDraggingBox && ev && state.capturedPointerId !== null && ev.pointerId !== state.capturedPointerId) return;
    if (wasDraggingBox && ev && state.isManualBoxDrag) {
      this.stopManualDragEvent(ev);
      this.applyManualBoxDragFromEvent(state, ev);
    }

    const hadManualBoxMovement = this.host.getHasManualBoxMovement();
    this.resetInteractionState(state, container);
    this.finishPointerUpLike(wasDraggingBox, wasInteracting, hadManualBoxMovement);
  }

  private handlePointerCancel(container: HTMLDivElement, state: OverviewPointerState, ev?: PointerEvent): void {
    const wasDraggingBox = state.isDraggingBox;
    if (wasDraggingBox && ev && state.capturedPointerId !== null && ev.pointerId !== state.capturedPointerId) return;
    if (wasDraggingBox && ev && state.isManualBoxDrag) {
      this.stopManualDragEvent(ev);
    }
    this.resetInteractionState(state, container);
  }

  private handleWindowPointerMove(state: OverviewPointerState, ev: PointerEvent): void {
    if (this.host.isDestroyed()) return;
    if (!state.isDraggingBox || state.hasPointerCapture) return;
    if (state.capturedPointerId !== null && ev.pointerId !== state.capturedPointerId) return;
    if (state.isManualBoxDrag) this.stopManualDragEvent(ev);
    this.scheduleManualBoxDrag(state, ev.clientX, ev.clientY);
  }

  private handleWindowPointerUp(
    state: OverviewPointerState,
    onPointerUpLike: (ev?: PointerEvent) => void,
    ev: PointerEvent,
  ): void {
    if (state.capturedPointerId !== null && ev.pointerId === state.capturedPointerId) {
      onPointerUpLike(ev);
    }
  }

  private handleWindowPointerCancel(
    state: OverviewPointerState,
    onPointerCancel: (ev?: PointerEvent) => void,
    ev: PointerEvent,
  ): void {
    if (state.capturedPointerId !== null && ev.pointerId === state.capturedPointerId) {
      onPointerCancel(ev);
    }
  }

  private handleMouseDown(container: HTMLDivElement, state: OverviewPointerState, ev: MouseEvent): void {
    if (this.host.isDestroyed()) return;
    if (this.tryBeginMouseBoxDrag(container, state, ev)) return;
  }

  private handleMouseMove(state: OverviewPointerState, ev: MouseEvent): void {
    if (this.host.isDestroyed()) return;
    if (!state.isMouseDraggingBox) return;
    this.scheduleManualBoxDrag(state, ev.clientX, ev.clientY);
  }

  private handleMouseUp(container: HTMLDivElement, state: OverviewPointerState, ev: MouseEvent): void {
    if (!state.isMouseDraggingBox) return;
    if (state.isManualBoxDrag) {
      this.stopManualDragEvent(ev);
      this.applyManualBoxDragFromEvent(state, ev);
    }
    const hadManualBoxMovement = this.host.getHasManualBoxMovement();
    this.resetInteractionState(state, container);
    if (!hadManualBoxMovement) {
      this.suppressViewportAnchorAfterClickWithoutMovement();
      return;
    }
    this.host.clearOverviewBoundsCache();
    this.host.scheduleOverviewUpdate('viewport');
  }

  private tryBeginPointerBoxDrag(container: HTMLDivElement, state: OverviewPointerState, ev: PointerEvent): boolean {
    const pt = this.getDocPointFromClient(container, ev.clientX, ev.clientY);
    const boxBounds = this.host.getOverview()?.box?.actualBounds;
    if (!pt || !boxBounds?.isReal() || !boxBounds.containsPoint(pt)) return false;

    state.isDraggingBox = true;
    this.host.setIsOverviewBoxDragging(true);
    state.suppressNextOverviewClick = true;
    this.stopManualDragEvent(ev);

    try {
      container.setPointerCapture(ev.pointerId);
      state.capturedPointerId = ev.pointerId;
      state.hasPointerCapture = true;
    } catch (e) {
      state.capturedPointerId = ev.pointerId;
      this.host.debug('Overview box setPointerCapture 不可用:', e);
    }

    this.beginManualBoxDrag(state, pt, ev.clientX, ev.clientY);
    this.host.clearViewportBindings();
    return true;
  }

  private tryBeginMouseBoxDrag(container: HTMLDivElement, state: OverviewPointerState, ev: MouseEvent): boolean {
    const pt = this.getDocPointFromClient(container, ev.clientX, ev.clientY);
    const boxBounds = this.host.getOverview()?.box?.actualBounds;
    if (!pt || !boxBounds?.isReal() || !boxBounds.containsPoint(pt)) return false;

    state.isMouseDraggingBox = true;
    this.host.setIsOverviewBoxDragging(true);
    this.stopManualDragEvent(ev);
    this.beginManualBoxDrag(state, pt, ev.clientX, ev.clientY);
    this.host.clearViewportBindings();
    return true;
  }

  private finishPointerUpLike(wasDraggingBox: boolean, wasInteracting: boolean, hadManualBoxMovement: boolean): void {
    if (wasDraggingBox) {
      if (!hadManualBoxMovement) {
        this.suppressViewportAnchorAfterClickWithoutMovement();
        return;
      }
      this.host.clearOverviewBoundsCache();
      this.host.scheduleOverviewUpdate('viewport');
      return;
    }

    if (!wasInteracting) return;

    this.host.clearOverviewBoundsCache();
    this.host.scheduleOverviewUpdate('viewport');
    this.host.requestInteractionRefresh();
  }

  private registerListeners(
    container: HTMLDivElement,
    handlers: OverviewPointerHandlers,
    supportsPointerEvents: boolean,
  ): void {
    this.zone.runOutsideAngular(() => {
      container.addEventListener('pointerdown', handlers.onPointerDown, { passive: false, capture: true });
      container.addEventListener('pointermove', handlers.onPointerMove, { passive: false, capture: true });
      container.addEventListener('pointerup', handlers.onPointerUpLike, { passive: false, capture: true });
      container.addEventListener('pointercancel', handlers.onPointerCancel, { passive: false, capture: true });
      container.addEventListener('lostpointercapture', handlers.onPointerCancel, { passive: false, capture: true });
      container.addEventListener('click', handlers.onClick, { passive: false, capture: true });
      window.addEventListener('pointermove', handlers.onWindowPointerMove, { passive: false });
      window.addEventListener('pointerup', handlers.onWindowPointerUp, { passive: false });
      window.addEventListener('pointercancel', handlers.onWindowPointerCancel, { passive: false });
      if (!supportsPointerEvents) {
        container.addEventListener('mousedown', handlers.onMouseDown, { passive: false, capture: true });
        window.addEventListener('mousemove', handlers.onMouseMove, { passive: true });
        window.addEventListener('mouseup', handlers.onMouseUp, { passive: true });
      }
    });
  }

  private removeListeners(
    container: HTMLDivElement,
    handlers: OverviewPointerHandlers,
    supportsPointerEvents: boolean,
  ): void {
    container.removeEventListener('pointerdown', handlers.onPointerDown, { capture: true } as EventListenerOptions);
    container.removeEventListener('pointermove', handlers.onPointerMove, { capture: true } as EventListenerOptions);
    container.removeEventListener('pointerup', handlers.onPointerUpLike, { capture: true } as EventListenerOptions);
    container.removeEventListener('pointercancel', handlers.onPointerCancel, { capture: true } as EventListenerOptions);
    container.removeEventListener('lostpointercapture', handlers.onPointerCancel, { capture: true } as EventListenerOptions);
    container.removeEventListener('click', handlers.onClick, { capture: true } as EventListenerOptions);
    window.removeEventListener('pointermove', handlers.onWindowPointerMove);
    window.removeEventListener('pointerup', handlers.onWindowPointerUp);
    window.removeEventListener('pointercancel', handlers.onWindowPointerCancel);
    if (!supportsPointerEvents) {
      container.removeEventListener('mousedown', handlers.onMouseDown, { capture: true } as EventListenerOptions);
      window.removeEventListener('mousemove', handlers.onMouseMove);
      window.removeEventListener('mouseup', handlers.onMouseUp);
    }
  }
}
