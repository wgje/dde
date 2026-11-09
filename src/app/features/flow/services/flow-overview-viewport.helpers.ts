import * as go from 'gojs';

import {
  overviewViewportIsInsideBounds,
  overviewViewportPositionAlmostEqual,
} from './flow-overview-bounds.helpers';

export type OverviewUpdateSource = 'viewport' | 'document';

export interface OverviewViewportContext {
  source: OverviewUpdateSource;
  viewportBounds: go.Rect;
  releaseViewportBounds: go.Rect | null;
  usingFakeViewportBounds: boolean;
  usingReleaseViewportBounds: boolean;
  usingManualViewportBounds: boolean;
  shouldSuppressNextViewportAnchor: boolean;
  isPassiveObservedViewportUpdate: boolean;
  viewportIsInsideCurrentOverviewBounds: boolean;
}

export interface OverviewWorldBoundsPlan {
  viewportBounds: go.Rect;
  totalBounds: go.Rect;
  worldBounds: go.Rect;
  isViewportOutside: boolean;
  freezeScaleForStableManualBounds: boolean;
  smoothManualScale: boolean;
  shouldAnchorOverviewOnViewport: boolean;
}

export interface OverviewViewportBoundsSourceInput {
  source: OverviewUpdateSource;
  usingManualViewportBounds: boolean;
  fakeViewportBounds: go.Rect | null;
  releaseViewportBounds: go.Rect | null;
  observedViewportBounds: go.Rect;
  currentDiagramPosition: go.Point | null;
}

export interface OverviewViewportAnchorSuppressionInput {
  source: OverviewUpdateSource;
  usingManualViewportBounds: boolean;
  viewportBounds: go.Rect;
  suppressNextViewportAnchor: boolean;
  postDragAnchorSuppressionBounds: go.Rect | null;
}

export interface OverviewViewportAnchorSuppressionDecision {
  shouldSuppressNextViewportAnchor: boolean;
  shouldClearSuppressNextViewportAnchor: boolean;
  shouldClearPostDragAnchorSuppressionBounds: boolean;
}

export interface OverviewBoundsViewportInput {
  context: OverviewViewportContext;
  nodeBounds: go.Rect;
  viewportContainsNodeCenter: boolean;
  manualMovementViewport: boolean;
}

export interface OverviewStableBoundsReuseInput {
  context: OverviewViewportContext;
  overviewFixedBounds: go.Rect | null;
  manualMovementViewport: boolean;
  isViewportOutside: boolean;
  viewportContainsNodeCenter: boolean;
}

export interface OverviewStableBoundsReuseDecision {
  preferStableBounds: boolean;
  reuseWhenInsideBounds: boolean;
}

export interface OverviewReleaseViewportCatchUpInput {
  context: OverviewViewportContext;
  observedViewportBounds: go.Rect | null | undefined;
  overviewReleaseShouldAnchor: boolean;
}

export interface OverviewReleaseViewportCatchUpDecision {
  postDragAnchorSuppressionBounds: go.Rect | null;
}

export function resolveOverviewViewportBoundsForSource(input: OverviewViewportBoundsSourceInput): go.Rect {
  if (input.fakeViewportBounds) return input.fakeViewportBounds;
  if (input.releaseViewportBounds) return input.releaseViewportBounds;

  const { observedViewportBounds, currentDiagramPosition } = input;
  const hasCurrentDiagramPosition = !!currentDiagramPosition
    && Number.isFinite(currentDiagramPosition.x)
    && Number.isFinite(currentDiagramPosition.y);
  const shouldUseDiagramPosition = input.source === 'viewport'
    && !input.usingManualViewportBounds
    && observedViewportBounds.isReal()
    && hasCurrentDiagramPosition
    && !overviewViewportPositionAlmostEqual(
      observedViewportBounds,
      new go.Rect(
        currentDiagramPosition.x,
        currentDiagramPosition.y,
        observedViewportBounds.width,
        observedViewportBounds.height,
      ),
    );

  return shouldUseDiagramPosition
    ? new go.Rect(
        currentDiagramPosition.x,
        currentDiagramPosition.y,
        observedViewportBounds.width,
        observedViewportBounds.height,
      )
    : observedViewportBounds;
}

export function decideOverviewViewportAnchorSuppression(
  input: OverviewViewportAnchorSuppressionInput,
): OverviewViewportAnchorSuppressionDecision {
  const shouldSuppressNextViewportAnchor = input.source === 'viewport'
    && !input.usingManualViewportBounds
    && input.suppressNextViewportAnchor
    && !!input.postDragAnchorSuppressionBounds?.isReal()
    && overviewViewportPositionAlmostEqual(input.viewportBounds, input.postDragAnchorSuppressionBounds);

  return {
    shouldSuppressNextViewportAnchor,
    shouldClearSuppressNextViewportAnchor: input.suppressNextViewportAnchor,
    shouldClearPostDragAnchorSuppressionBounds: input.suppressNextViewportAnchor && !shouldSuppressNextViewportAnchor,
  };
}

export function resolveOverviewReleaseViewportCatchUp(
  input: OverviewReleaseViewportCatchUpInput,
): OverviewReleaseViewportCatchUpDecision | null {
  const releaseViewportBounds = input.context.releaseViewportBounds;
  const observedViewportBounds = input.observedViewportBounds;
  if (!input.context.usingReleaseViewportBounds || !releaseViewportBounds) {
    return null;
  }

  const observedCaughtUp = observedViewportBounds?.isReal()
    && Math.abs(observedViewportBounds.x - releaseViewportBounds.x) < 1
    && Math.abs(observedViewportBounds.y - releaseViewportBounds.y) < 1;
  if (!observedCaughtUp) {
    return null;
  }

  return {
    postDragAnchorSuppressionBounds: input.overviewReleaseShouldAnchor
      ? null
      : releaseViewportBounds.copy(),
  };
}

export function shouldSuppressSettledPostDragAnchor(
  context: OverviewViewportContext,
  suppressedPostDragBounds: go.Rect | null,
): boolean {
  return context.shouldSuppressNextViewportAnchor
    || !!suppressedPostDragBounds?.isReal()
      && overviewViewportPositionAlmostEqual(context.viewportBounds, suppressedPostDragBounds);
}

export function isManualOverviewMovementViewport(
  context: OverviewViewportContext,
  overviewReleaseShouldAnchor: boolean,
  shouldSuppressSettledPostDragAnchorValue: boolean,
): boolean {
  return context.usingFakeViewportBounds
    || (context.usingReleaseViewportBounds && !overviewReleaseShouldAnchor)
    || shouldSuppressSettledPostDragAnchorValue;
}

export function shouldAnchorOverviewOnViewport(
  context: OverviewViewportContext,
  overviewReleaseShouldAnchor: boolean,
  shouldSuppressSettledPostDragAnchorValue: boolean,
): boolean {
  return !context.usingFakeViewportBounds
    && !context.isPassiveObservedViewportUpdate
    && !shouldSuppressSettledPostDragAnchorValue
    && (!context.usingReleaseViewportBounds || overviewReleaseShouldAnchor)
    && (context.source === 'document' || context.usingReleaseViewportBounds || !context.viewportIsInsideCurrentOverviewBounds);
}

export function resolveOverviewBoundsViewport(input: OverviewBoundsViewportInput): go.Rect {
  if (!input.manualMovementViewport || !input.viewportContainsNodeCenter) {
    return input.context.viewportBounds;
  }

  return new go.Rect(
    input.nodeBounds.center.x - input.context.viewportBounds.width / 2,
    input.nodeBounds.center.y - input.context.viewportBounds.height / 2,
    input.context.viewportBounds.width,
    input.context.viewportBounds.height,
  );
}

export function decideOverviewStableBoundsReuse(
  input: OverviewStableBoundsReuseInput,
): OverviewStableBoundsReuseDecision {
  const shouldReuseStableBoundsForMainPan = input.context.source === 'viewport'
    && !input.context.usingManualViewportBounds
    && input.context.viewportIsInsideCurrentOverviewBounds;
  const shouldReuseStableBoundsForBoxDrag = input.context.usingFakeViewportBounds
    && !!input.overviewFixedBounds?.isReal()
    && overviewViewportIsInsideBounds(input.overviewFixedBounds, input.context.viewportBounds);

  return {
    preferStableBounds: input.context.isPassiveObservedViewportUpdate
      || shouldReuseStableBoundsForMainPan
      || shouldReuseStableBoundsForBoxDrag
      || (
        input.manualMovementViewport
        && input.isViewportOutside
        && !input.viewportContainsNodeCenter
      ),
    reuseWhenInsideBounds: shouldReuseStableBoundsForMainPan || shouldReuseStableBoundsForBoxDrag,
  };
}
