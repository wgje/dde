import * as go from 'gojs';

import type { ViewState } from './flow-zoom.service';

const MIN_SAFE_DIAGRAM_WIDTH = 220;
const MIN_SAFE_DIAGRAM_HEIGHT = 160;
const DEVICE_PIXEL_RATIO_CHANGE_TOLERANCE = 0.001;

export interface FlowViewStateCandidates {
  stableViewState?: ViewState | null;
  recoverableViewState?: ViewState | null;
  currentViewState?: ViewState | null;
  persistedViewState?: ViewState | null;
}

export interface FlowDevicePixelRatioChange {
  changed: boolean;
  previousRatio: number;
  nextRatio: number;
}

export function isSafeFlowDiagramSize(width: number, height: number): boolean {
  return width >= MIN_SAFE_DIAGRAM_WIDTH && height >= MIN_SAFE_DIAGRAM_HEIGHT;
}

export function getSafeDevicePixelRatio(): number {
  if (typeof window === 'undefined') {
    return 1;
  }

  const ratio = window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

export function detectFlowDevicePixelRatioChange(
  previousRatio: number,
  nextRatio: number = getSafeDevicePixelRatio(),
): FlowDevicePixelRatioChange {
  return {
    changed: Math.abs(nextRatio - previousRatio) >= DEVICE_PIXEL_RATIO_CHANGE_TOLERANCE,
    previousRatio,
    nextRatio,
  };
}

export function normalizeFlowViewState(viewState: ViewState | null | undefined): ViewState | null {
  if (!viewState) {
    return null;
  }

  if (
    !Number.isFinite(viewState.scale) ||
    viewState.scale <= 0 ||
    viewState.scale > 4 ||
    !Number.isFinite(viewState.positionX) ||
    !Number.isFinite(viewState.positionY)
  ) {
    return null;
  }

  return {
    scale: viewState.scale,
    positionX: viewState.positionX,
    positionY: viewState.positionY,
  };
}

export function selectBestFlowViewState(candidates: FlowViewStateCandidates): ViewState | null {
  const orderedCandidates = [
    candidates.stableViewState,
    candidates.recoverableViewState,
    candidates.currentViewState,
    candidates.persistedViewState,
  ];

  for (const candidate of orderedCandidates) {
    const normalized = normalizeFlowViewState(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

export function getCurrentFlowViewStateSnapshot(diagram: go.Diagram | null): ViewState | null {
  if (!diagram) {
    return null;
  }

  return normalizeFlowViewState({
    scale: diagram.scale,
    positionX: diagram.position.x,
    positionY: diagram.position.y,
  });
}

export function applyFlowViewState(diagram: go.Diagram | null, viewState: ViewState): void {
  if (!diagram) {
    return;
  }

  diagram.scale = viewState.scale;
  diagram.position = new go.Point(viewState.positionX, viewState.positionY);
}

export function canPersistFlowViewState(
  diagram: go.Diagram | null,
  diagramDiv: HTMLDivElement | null,
  isRecoveryActive: boolean,
): boolean {
  if (!diagram || isRecoveryActive) {
    return false;
  }

  return isSafeFlowDiagramSize(diagramDiv?.clientWidth ?? 0, diagramDiv?.clientHeight ?? 0)
    && Number.isFinite(diagram.scale)
    && diagram.scale > 0
    && Number.isFinite(diagram.position.x)
    && Number.isFinite(diagram.position.y);
}

export function hasVisibleFlowDiagramContent(diagram: go.Diagram | null): boolean {
  if (!diagram) {
    return false;
  }

  const viewportBounds = diagram.viewportBounds;
  if (!viewportBounds.isReal() || viewportBounds.width <= 0 || viewportBounds.height <= 0) {
    return false;
  }

  if (getFlowDiagramNodeCount(diagram) === 0) {
    return true;
  }

  const documentBounds = diagram.documentBounds;
  if (!documentBounds.isReal() || documentBounds.width <= 0 || documentBounds.height <= 0) {
    return false;
  }

  return viewportBounds.intersectsRect(documentBounds);
}

function getFlowDiagramNodeCount(diagram: go.Diagram): number {
  const diagramWithNodes = diagram as go.Diagram & { nodes?: { count?: number } };
  return typeof diagramWithNodes.nodes?.count === 'number' ? diagramWithNodes.nodes.count : 0;
}
