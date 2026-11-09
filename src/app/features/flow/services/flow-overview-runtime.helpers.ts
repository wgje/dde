import { NgZone } from '@angular/core';
import * as go from 'gojs';

import { FlowOverviewPointerController } from './flow-overview-pointer.controller';
import {
  OverviewBindingsScheduler,
  OverviewViewportUpdateScheduler,
} from './flow-overview-scheduler.helpers';
import type { OverviewUpdateSource } from './flow-overview-viewport.helpers';

export interface FlowOverviewPointerRuntime {
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

export function createFlowOverviewPointerController(
  zone: NgZone,
  runtime: FlowOverviewPointerRuntime,
): FlowOverviewPointerController {
  return new FlowOverviewPointerController(zone, runtime);
}

export interface FlowOverviewCleanupRuntime {
  getOverview(): go.Overview | null;
  setOverview(overview: go.Overview | null): void;
  getDiagram(): go.Diagram | null;
  setOverviewContainer(container: HTMLDivElement | null): void;
  removePendingInitialLayoutHandler(): void;
  pointerController: FlowOverviewPointerController;
  getOverviewResizeObserver(): ResizeObserver | null;
  setOverviewResizeObserver(observer: ResizeObserver | null): void;
  getOverviewDocumentBoundsChangedHandler(): ((event: go.DiagramEvent) => void) | null;
  setOverviewDocumentBoundsChangedHandler(handler: ((event: go.DiagramEvent) => void) | null): void;
  getOverviewViewportBoundsChangedHandler(): ((event: go.DiagramEvent) => void) | null;
  setOverviewViewportBoundsChangedHandler(handler: ((event: go.DiagramEvent) => void) | null): void;
  frameCallbacks: {
    viewportPollRafId: number | null;
    setViewportPollRafId(value: number | null): void;
    resizeRefreshRafId: number | null;
    setResizeRefreshRafId(value: number | null): void;
    interactionRefreshRafId: number | null;
    setInteractionRefreshRafId(value: number | null): void;
  };
  overviewViewportUpdateScheduler: OverviewViewportUpdateScheduler;
  overviewBindingsScheduler: OverviewBindingsScheduler;
  getOverviewIdleUpdateDelayRestoreTimer(): ReturnType<typeof setTimeout> | null;
  setOverviewIdleUpdateDelayRestoreTimer(timer: ReturnType<typeof setTimeout> | null): void;
  resetInteractionState(): void;
  removeOverviewHealHook(): void;
  clearOverviewBoundsCache(): void;
  clearOverviewFixedBounds(): void;
  clearOverviewUpdateCallbacks(): void;
}

export function cleanupFlowOverview(runtime: FlowOverviewCleanupRuntime): void {
  stopOverviewAnimation(runtime.getOverview());
  removeOverviewRuntimeResources(runtime);
  cancelOverviewFrameCallbacks(runtime);
  clearOverviewTimers(runtime);
  runtime.resetInteractionState();
  runtime.removeOverviewHealHook();
  detachOverviewInstance(runtime);

  runtime.setOverviewContainer(null);
  runtime.clearOverviewBoundsCache();
  runtime.clearOverviewFixedBounds();
  runtime.clearOverviewUpdateCallbacks();
}

export interface FlowOverviewAutoScaleRuntime {
  getDiagram(): go.Diagram | null;
  getOverview(): go.Overview | null;
  getOverviewNodeDataCount(): number;
  getOverviewNodesBounds(): go.Rect;
  calculateOverviewBaseScale(): number;
  setOverviewBaseScale(scale: number): void;
  setOverviewLastNodeDataCount(count: number): void;
  setLastOverviewScale(scale: number): void;
  setDocumentBoundsChangedHandler(handler: ((event: go.DiagramEvent) => void) | null): void;
  setViewportBoundsChangedHandler(handler: ((event: go.DiagramEvent) => void) | null): void;
  scheduleOverviewUpdate(source: OverviewUpdateSource): void;
  clearStaleReleaseViewportForObservedPan(): void;
  clampScale(scale: number): number;
}

export function setupFlowOverviewAutoScale(runtime: FlowOverviewAutoScaleRuntime): void {
  const diagram = runtime.getDiagram();
  const overview = runtime.getOverview();
  if (!diagram || !overview) return;

  const baseScale = runtime.calculateOverviewBaseScale();
  runtime.setOverviewBaseScale(baseScale);
  runtime.setOverviewLastNodeDataCount(runtime.getOverviewNodeDataCount());
  const initialScale = runtime.clampScale(baseScale);
  runtime.setLastOverviewScale(initialScale);
  overview.scale = initialScale;
  overview.centerRect(runtime.getOverviewNodesBounds());

  const documentHandler = () => runtime.scheduleOverviewUpdate('document');
  const viewportHandler = () => {
    runtime.clearStaleReleaseViewportForObservedPan();
    runtime.scheduleOverviewUpdate('viewport');
  };
  runtime.setDocumentBoundsChangedHandler(documentHandler);
  runtime.setViewportBoundsChangedHandler(viewportHandler);
  diagram.addDiagramListener('DocumentBoundsChanged', documentHandler);
  diagram.addDiagramListener('ViewportBoundsChanged', viewportHandler);
}

export interface FlowOverviewResizeObserverRuntime {
  isDestroyed(): boolean;
  getOverview(): go.Overview | null;
  refreshOverview(): void;
  getResizeRefreshRafId(): number | null;
  setResizeRefreshRafId(value: number | null): void;
}

export function createFlowOverviewResizeObserver(
  container: HTMLDivElement,
  runtime: FlowOverviewResizeObserverRuntime,
): ResizeObserver {
  const observer = new ResizeObserver(() => {
    const pendingRafId = runtime.getResizeRefreshRafId();
    if (pendingRafId !== null) {
      cancelAnimationFrame(pendingRafId);
    }
    runtime.setResizeRefreshRafId(window.requestAnimationFrame(() => {
      runtime.setResizeRefreshRafId(null);
      if (runtime.isDestroyed() || !runtime.getOverview()) return;
      runtime.refreshOverview();
    }));
  });
  observer.observe(container);
  return observer;
}

export interface FlowOverviewInteractionRefreshRuntime {
  getInteractionRefreshRafId(): number | null;
  setInteractionRefreshRafId(value: number | null): void;
  isDestroyed(): boolean;
  getDiagram(): go.Diagram | null;
  getOverview(): go.Overview | null;
}

export function requestFlowOverviewInteractionRefresh(
  runtime: FlowOverviewInteractionRefreshRuntime,
): void {
  const pendingRafId = runtime.getInteractionRefreshRafId();
  if (pendingRafId !== null) {
    cancelAnimationFrame(pendingRafId);
  }
  runtime.setInteractionRefreshRafId(requestAnimationFrame(() => {
    runtime.setInteractionRefreshRafId(null);
    const diagram = runtime.getDiagram();
    const overview = runtime.getOverview();
    if (runtime.isDestroyed() || !diagram || !overview) return;
    overview.requestUpdate();
    diagram.requestUpdate();
  }));
}

function stopOverviewAnimation(overview: go.Overview | null): void {
  if (!overview) return;

  try {
    const overviewAny = overview as unknown as {
      animationManager?: { stopAnimation?: () => void };
    };
    overviewAny.animationManager?.stopAnimation?.();
  } catch {
    // GoJS cleanup should continue even if its internal animation state is stale.
  }
}

function removeOverviewRuntimeResources(runtime: FlowOverviewCleanupRuntime): void {
  runtime.removePendingInitialLayoutHandler();
  runtime.pointerController.detach();

  const resizeObserver = runtime.getOverviewResizeObserver();
  if (resizeObserver) {
    resizeObserver.disconnect();
    runtime.setOverviewResizeObserver(null);
  }

  const diagram = runtime.getDiagram();
  if (!diagram) return;

  const documentHandler = runtime.getOverviewDocumentBoundsChangedHandler();
  if (documentHandler) {
    diagram.removeDiagramListener('DocumentBoundsChanged', documentHandler);
    runtime.setOverviewDocumentBoundsChangedHandler(null);
  }

  const viewportHandler = runtime.getOverviewViewportBoundsChangedHandler();
  if (viewportHandler) {
    diagram.removeDiagramListener('ViewportBoundsChanged', viewportHandler);
    runtime.setOverviewViewportBoundsChangedHandler(null);
  }
}

function cancelOverviewFrameCallbacks(runtime: FlowOverviewCleanupRuntime): void {
  const callbacks = runtime.frameCallbacks;
  if (callbacks.viewportPollRafId !== null) {
    cancelAnimationFrame(callbacks.viewportPollRafId);
    callbacks.setViewportPollRafId(null);
  }
  if (callbacks.resizeRefreshRafId !== null) {
    cancelAnimationFrame(callbacks.resizeRefreshRafId);
    callbacks.setResizeRefreshRafId(null);
  }
  if (callbacks.interactionRefreshRafId !== null) {
    cancelAnimationFrame(callbacks.interactionRefreshRafId);
    callbacks.setInteractionRefreshRafId(null);
  }
  runtime.overviewViewportUpdateScheduler.cancelAll();
}

function clearOverviewTimers(runtime: FlowOverviewCleanupRuntime): void {
  runtime.overviewBindingsScheduler.cancelPendingRefresh();
  const timer = runtime.getOverviewIdleUpdateDelayRestoreTimer();
  if (timer === null) return;

  clearTimeout(timer);
  runtime.setOverviewIdleUpdateDelayRestoreTimer(null);
}

export interface FlowOverviewCleanupStateRuntime {
  setNodeDragging(value: boolean): void;
  setOverviewInteracting(value: boolean): void;
  setOverviewBoxDragging(value: boolean): void;
  setHasManualBoxMovement(value: boolean): void;
  setOverviewBoxViewportBounds(bounds: go.Rect | null): void;
  setOverviewReleaseViewportBounds(bounds: go.Rect | null): void;
  setOverviewReleaseShouldAnchor(value: boolean): void;
  setOverviewPostDragAnchorSuppressionBounds(bounds: go.Rect | null): void;
  setOverviewSuppressNextViewportAnchor(value: boolean): void;
  setApplyingOverviewViewportUpdate(value: boolean): void;
  setOverviewUpdateQueuedWhileApplying(value: boolean): void;
  overviewViewportUpdateScheduler: OverviewViewportUpdateScheduler;
}

export function resetFlowOverviewCleanupState(runtime: FlowOverviewCleanupStateRuntime): void {
  runtime.setNodeDragging(false);
  runtime.setOverviewInteracting(false);
  runtime.setOverviewBoxDragging(false);
  runtime.setHasManualBoxMovement(false);
  runtime.setOverviewBoxViewportBounds(null);
  runtime.setOverviewReleaseViewportBounds(null);
  runtime.setOverviewReleaseShouldAnchor(false);
  runtime.setOverviewPostDragAnchorSuppressionBounds(null);
  runtime.setOverviewSuppressNextViewportAnchor(false);
  runtime.setApplyingOverviewViewportUpdate(false);
  runtime.setOverviewUpdateQueuedWhileApplying(false);
  runtime.overviewViewportUpdateScheduler.resetInteractionThrottle();
}

export interface FlowOverviewIdleDelayRestoreRuntime {
  getTimer(): ReturnType<typeof setTimeout> | null;
  setTimer(timer: ReturnType<typeof setTimeout> | null): void;
  isDestroyed(): boolean;
  getOverview(): go.Overview | null;
  isOverviewBoxDragging(): boolean;
  isOverviewInteracting(): boolean;
  setOverviewUpdateDelay(delayMs: number): void;
}

export function scheduleFlowOverviewIdleUpdateDelayRestore(
  delayMs: number,
  runtime: FlowOverviewIdleDelayRestoreRuntime,
): void {
  const timer = runtime.getTimer();
  if (timer !== null) {
    clearTimeout(timer);
  }
  runtime.setTimer(setTimeout(() => {
    runtime.setTimer(null);
    if (
      runtime.isDestroyed()
      || !runtime.getOverview()
      || runtime.isOverviewBoxDragging()
      || runtime.isOverviewInteracting()
    ) {
      return;
    }
    runtime.setOverviewUpdateDelay(delayMs);
  }, delayMs));
}

function detachOverviewInstance(runtime: FlowOverviewCleanupRuntime): void {
  const overview = runtime.getOverview();
  if (!overview) return;

  try {
    overview.observed = null;
  } catch {
    // ignore
  }
  overview.div = null;
  runtime.setOverview(null);
}
