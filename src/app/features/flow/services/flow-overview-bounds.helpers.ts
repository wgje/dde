import * as go from 'gojs';

export interface OverviewScaleUpdateParams {
  viewportBounds: go.Rect;
  totalBounds: go.Rect;
  containerWidth: number;
  containerHeight: number;
  baseScale: number;
  isViewportOutside: boolean;
  freezeScaleForStableManualBounds: boolean;
  smoothManualScale: boolean;
}

export type OverviewEdgeBufferMode = 'default' | 'passive-pan';

export interface OverviewDynamicBuffers {
  dynamicBufferW: number;
  dynamicBufferH: number;
}

export interface OverviewWorldBoundsResolution {
  bounds: go.Rect;
  reusedStableBounds: boolean;
}

export interface OverviewCandidateWorldBoundsInput {
  nodeBounds: go.Rect;
  boundsViewport: go.Rect;
  viewportBounds: go.Rect;
  containerWidth: number | null | undefined;
  containerHeight: number | null | undefined;
  isPassiveObservedViewportUpdate: boolean;
  viewportIsInsideCurrentOverviewBounds: boolean;
}

export interface OverviewRefreshPlanInput {
  containerWidth: number;
  containerHeight: number;
  documentBounds: go.Rect;
  viewportBounds: go.Rect;
}

export interface OverviewRefreshPlan {
  scale: number;
  anchorBounds: go.Rect;
}

export function clampOverviewScale(scale: number): number {
  return Math.max(1e-4, Math.min(0.5, scale));
}

export function resolveOverviewRefreshPlan(input: OverviewRefreshPlanInput): OverviewRefreshPlan | null {
  if (
    input.containerWidth <= 0 ||
    input.containerHeight <= 0 ||
    !input.documentBounds.isReal() ||
    input.documentBounds.width <= 0 ||
    input.documentBounds.height <= 0
  ) {
    return null;
  }

  const padding = 0.1;
  const scaleX = (input.containerWidth * (1 - padding * 2)) / input.documentBounds.width;
  const scaleY = (input.containerHeight * (1 - padding * 2)) / input.documentBounds.height;
  return {
    scale: Math.max(0.02, Math.min(0.5, Math.min(scaleX, scaleY))),
    anchorBounds: input.viewportBounds.isReal() ? input.viewportBounds : input.documentBounds,
  };
}

export function resolveOverviewScaleForTotalBounds(params: OverviewScaleUpdateParams): number {
  const padding = 0.15;
  const scaleX = (params.containerWidth * (1 - padding * 2)) / params.totalBounds.width;
  const scaleY = (params.containerHeight * (1 - padding * 2)) / params.totalBounds.height;
  return Math.min(scaleX, scaleY, 0.5);
}

export function resolveOverviewTargetScale(params: OverviewScaleUpdateParams, currentScale: number): number {
  const boxPadding = Math.max(20, Math.min(params.containerWidth, params.containerHeight) * 0.1);
  const needsShrinkForBox =
    params.viewportBounds.width * currentScale > params.containerWidth - boxPadding ||
    params.viewportBounds.height * currentScale > params.containerHeight - boxPadding;

  const targetScale = params.isViewportOutside || needsShrinkForBox
    ? resolveOverviewScaleForTotalBounds(params)
    : params.baseScale;

  return constrainScaleForViewportBox(
    targetScale,
    params.viewportBounds,
    params.containerWidth,
    params.containerHeight,
    boxPadding,
  );
}

export function constrainScaleForViewportBox(
  scale: number,
  viewportBounds: go.Rect,
  containerWidth: number,
  containerHeight: number,
  boxPadding: number,
): number {
  let constrainedScale = clampOverviewScale(scale);
  const maxBoxWidth = containerWidth - boxPadding;
  const maxBoxHeight = containerHeight - boxPadding;

  if (viewportBounds.width * constrainedScale > maxBoxWidth) {
    constrainedScale = Math.min(constrainedScale, maxBoxWidth / viewportBounds.width);
  }
  if (viewportBounds.height * constrainedScale > maxBoxHeight) {
    constrainedScale = Math.min(constrainedScale, maxBoxHeight / viewportBounds.height);
  }

  return clampOverviewScale(constrainedScale);
}

export function updateOverviewScaleTowardTarget(current: number, target: number, smoothStep: boolean): number {
  if (!smoothStep) {
    return target;
  }

  const maxStep = current * 0.12;
  const delta = target - current;
  if (Math.abs(delta) <= Math.max(0.0001, current * 0.015)) {
    return target;
  }

  const step = Math.min(Math.abs(delta), maxStep);
  return current + Math.sign(delta) * step;
}

export function calculateOverviewDynamicBuffers(
  containerWidth: number | null | undefined,
  containerHeight: number | null | undefined,
): OverviewDynamicBuffers {
  const containerW = containerWidth ?? 200;
  const containerH = containerHeight ?? 150;
  return {
    dynamicBufferW: Math.max(400, containerW * 0.3),
    dynamicBufferH: Math.max(400, containerH * 0.3),
  };
}

export function resolveOverviewNodesBounds(documentBounds: go.Rect | null | undefined): go.Rect {
  if (!documentBounds) return new go.Rect(0, 0, 500, 500);

  if (!documentBounds.isReal() || (documentBounds.width === 0 && documentBounds.height === 0)) {
    return new go.Rect(-250, -250, 500, 500);
  }

  const padding = 80;
  return new go.Rect(
    documentBounds.x - padding,
    documentBounds.y - padding,
    documentBounds.width + padding * 2,
    documentBounds.height + padding * 2,
  );
}

export function calculateOverviewBaseScaleForBounds(
  containerWidth: number,
  containerHeight: number,
  nodeBounds: go.Rect,
): number {
  if (containerWidth <= 0 || containerHeight <= 0) return 0.15;

  const padding = 0.1;
  const scaleX = (containerWidth * (1 - padding * 2)) / nodeBounds.width;
  const scaleY = (containerHeight * (1 - padding * 2)) / nodeBounds.height;

  return Math.min(scaleX, scaleY, 0.35);
}

export function calculateOverviewTotalBounds(documentBounds: go.Rect | null | undefined, viewportBounds: go.Rect): go.Rect {
  if (!documentBounds?.isReal() || (documentBounds.width === 0 && documentBounds.height === 0)) {
    return viewportBounds.copy();
  }

  const minX = Math.min(documentBounds.x, viewportBounds.x);
  const minY = Math.min(documentBounds.y, viewportBounds.y);
  const maxX = Math.max(documentBounds.x + documentBounds.width, viewportBounds.x + viewportBounds.width);
  const maxY = Math.max(documentBounds.y + documentBounds.height, viewportBounds.y + viewportBounds.height);
  return new go.Rect(minX, minY, maxX - minX, maxY - minY);
}

export function calculateExtendedOverviewBounds(
  baseBounds: go.Rect,
  viewportBounds: go.Rect,
  buffers: OverviewDynamicBuffers,
): go.Rect {
  const overflowLeft = Math.max(0, baseBounds.x - viewportBounds.x);
  const overflowRight = Math.max(0, viewportBounds.right - baseBounds.right);
  const overflowTop = Math.max(0, baseBounds.y - viewportBounds.y);
  const overflowBottom = Math.max(0, viewportBounds.bottom - baseBounds.bottom);
  const overflowBufferLeft = overflowLeft > 0 ? buffers.dynamicBufferW : 0;
  const overflowBufferRight = overflowRight > 0 ? buffers.dynamicBufferW : 0;
  const overflowBufferTop = overflowTop > 0 ? buffers.dynamicBufferH : 0;
  const overflowBufferBottom = overflowBottom > 0 ? buffers.dynamicBufferH : 0;

  const extended = new go.Rect(
    baseBounds.x - overflowLeft - overflowBufferLeft,
    baseBounds.y - overflowTop - overflowBufferTop,
    baseBounds.width + overflowLeft + overflowRight + overflowBufferLeft + overflowBufferRight,
    baseBounds.height + overflowTop + overflowBottom + overflowBufferTop + overflowBufferBottom,
  );
  return ensureOverviewMinimumSize(extended, viewportBounds, buffers.dynamicBufferW, buffers.dynamicBufferH);
}

export function buildOverviewCandidateWorldBounds(input: OverviewCandidateWorldBoundsInput): go.Rect {
  const dynamicBuffers = calculateOverviewDynamicBuffers(input.containerWidth, input.containerHeight);
  const candidateBounds = calculateExtendedOverviewBounds(
    input.nodeBounds.copy().unionRect(input.boundsViewport),
    input.boundsViewport,
    dynamicBuffers,
  );

  if (input.isPassiveObservedViewportUpdate && !input.viewportIsInsideCurrentOverviewBounds) {
    return ensureOverviewViewportEdgeBuffer(candidateBounds, input.viewportBounds, dynamicBuffers, 'passive-pan');
  }

  return candidateBounds;
}

export function ensureOverviewMinimumSize(
  bounds: go.Rect,
  viewportBounds: go.Rect,
  dynamicBufferW: number,
  dynamicBufferH: number,
): go.Rect {
  const minWidth = viewportBounds.width + dynamicBufferW;
  if (bounds.width < minWidth) {
    const pad = (minWidth - bounds.width) / 2;
    bounds.x -= pad;
    bounds.width = minWidth;
  }

  const minHeight = viewportBounds.height + dynamicBufferH;
  if (bounds.height < minHeight) {
    const pad = (minHeight - bounds.height) / 2;
    bounds.y -= pad;
    bounds.height = minHeight;
  }

  return bounds;
}

export function ensureOverviewViewportEdgeBuffer(
  bounds: go.Rect,
  viewportBounds: go.Rect,
  buffers: OverviewDynamicBuffers,
  mode: OverviewEdgeBufferMode = 'default',
): go.Rect {
  const bufferW = mode === 'passive-pan'
    ? Math.max(buffers.dynamicBufferW, viewportBounds.width)
    : buffers.dynamicBufferW;
  const bufferH = mode === 'passive-pan'
    ? Math.max(buffers.dynamicBufferH, viewportBounds.height)
    : buffers.dynamicBufferH;
  const buffered = bounds.copy();

  expandOverviewHorizontalBuffer(buffered, viewportBounds, bufferW);
  expandOverviewVerticalBuffer(buffered, viewportBounds, bufferH);
  return buffered;
}

export function expandOverviewHorizontalBuffer(bounds: go.Rect, viewportBounds: go.Rect, bufferW: number): void {
  const leftGap = viewportBounds.x - bounds.x;
  if (leftGap < bufferW) {
    const expandLeft = bufferW - leftGap;
    bounds.x -= expandLeft;
    bounds.width += expandLeft;
  }

  const rightGap = bounds.right - viewportBounds.right;
  if (rightGap < bufferW) {
    bounds.width += bufferW - rightGap;
  }
}

export function expandOverviewVerticalBuffer(bounds: go.Rect, viewportBounds: go.Rect, bufferH: number): void {
  const topGap = viewportBounds.y - bounds.y;
  if (topGap < bufferH) {
    const expandTop = bufferH - topGap;
    bounds.y -= expandTop;
    bounds.height += expandTop;
  }

  const bottomGap = bounds.bottom - viewportBounds.bottom;
  if (bottomGap < bufferH) {
    bounds.height += bufferH - bottomGap;
  }
}

export function overviewViewportFitsInsideStableBounds(bounds: go.Rect, viewportBounds: go.Rect): boolean {
  if (!bounds.isReal() || !viewportBounds.isReal()) return false;
  const margin = Math.max(120, Math.min(viewportBounds.width, viewportBounds.height) * 0.2);
  if (bounds.width <= viewportBounds.width + margin * 2 || bounds.height <= viewportBounds.height + margin * 2) {
    return false;
  }
  return viewportBounds.x >= bounds.x + margin
    && viewportBounds.y >= bounds.y + margin
    && viewportBounds.right <= bounds.right - margin
    && viewportBounds.bottom <= bounds.bottom - margin;
}

export function overviewViewportIsInsideBounds(bounds: go.Rect, viewportBounds: go.Rect): boolean {
  if (!bounds.isReal() || !viewportBounds.isReal()) return false;
  const epsilon = 1;
  return viewportBounds.x >= bounds.x - epsilon
    && viewportBounds.y >= bounds.y - epsilon
    && viewportBounds.right <= bounds.right + epsilon
    && viewportBounds.bottom <= bounds.bottom + epsilon;
}

export function resolveOverviewWorldBoundsForViewport(
  candidateBounds: go.Rect,
  viewportBounds: go.Rect,
  currentBounds: go.Rect | null,
  preferStableBounds: boolean,
  reuseWhenInsideBounds = false,
): OverviewWorldBoundsResolution {
  if (!preferStableBounds || !currentBounds?.isReal()) {
    return { bounds: candidateBounds, reusedStableBounds: false };
  }

  const canReuseCurrentBounds = reuseWhenInsideBounds
    ? overviewViewportIsInsideBounds(currentBounds, viewportBounds)
    : overviewViewportFitsInsideStableBounds(currentBounds, viewportBounds);
  if (canReuseCurrentBounds) {
    return { bounds: currentBounds, reusedStableBounds: true };
  }

  return { bounds: currentBounds.copy().unionRect(candidateBounds), reusedStableBounds: false };
}

export function overviewViewportPositionAlmostEqual(left: go.Rect, right: go.Rect): boolean {
  const epsilon = 1;
  return Math.abs(left.x - right.x) < epsilon
    && Math.abs(left.y - right.y) < epsilon;
}

export function isOverviewViewportOutsideNodeBounds(viewportBounds: go.Rect, nodeBounds: go.Rect): boolean {
  return viewportBounds.x < nodeBounds.x - 50
    || viewportBounds.y < nodeBounds.y - 50
    || viewportBounds.right > nodeBounds.right + 50
    || viewportBounds.bottom > nodeBounds.bottom + 50;
}

export function overviewViewportContainsNodeCenter(viewportBounds: go.Rect, nodeBounds: go.Rect): boolean {
  return viewportBounds.x <= nodeBounds.center.x
    && viewportBounds.y <= nodeBounds.center.y
    && viewportBounds.right >= nodeBounds.center.x
    && viewportBounds.bottom >= nodeBounds.center.y;
}

export function getOverviewBoundsCacheKey(bounds: go.Rect): string {
  const q = (value: number) => Math.round(value);
  return `${q(bounds.x)}|${q(bounds.y)}|${q(bounds.width)}|${q(bounds.height)}`;
}
