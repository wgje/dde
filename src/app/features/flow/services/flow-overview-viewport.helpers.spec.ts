import { describe, expect, it } from 'vitest';
import * as go from 'gojs';

import {
  decideOverviewStableBoundsReuse,
  decideOverviewViewportAnchorSuppression,
  isManualOverviewMovementViewport,
  resolveOverviewReleaseViewportCatchUp,
  resolveOverviewBoundsViewport,
  resolveOverviewViewportBoundsForSource,
  shouldAnchorOverviewOnViewport,
  shouldSuppressSettledPostDragAnchor,
  type OverviewViewportContext,
} from './flow-overview-viewport.helpers';

function createContext(overrides: Partial<OverviewViewportContext> = {}): OverviewViewportContext {
  return {
    source: 'viewport',
    viewportBounds: new go.Rect(10, 20, 100, 80),
    releaseViewportBounds: null,
    usingFakeViewportBounds: false,
    usingReleaseViewportBounds: false,
    usingManualViewportBounds: false,
    shouldSuppressNextViewportAnchor: false,
    isPassiveObservedViewportUpdate: true,
    viewportIsInsideCurrentOverviewBounds: false,
    ...overrides,
  };
}

describe('flow-overview-viewport.helpers', () => {
  it('prefers fake and release viewport bounds before observed diagram bounds', () => {
    const fakeViewportBounds = new go.Rect(1, 2, 3, 4);
    const releaseViewportBounds = new go.Rect(5, 6, 7, 8);
    const observedViewportBounds = new go.Rect(10, 20, 30, 40);

    expect(resolveOverviewViewportBoundsForSource({
      source: 'viewport',
      usingManualViewportBounds: true,
      fakeViewportBounds,
      releaseViewportBounds,
      observedViewportBounds,
      currentDiagramPosition: new go.Point(50, 60),
    })).toBe(fakeViewportBounds);

    expect(resolveOverviewViewportBoundsForSource({
      source: 'viewport',
      usingManualViewportBounds: true,
      fakeViewportBounds: null,
      releaseViewportBounds,
      observedViewportBounds,
      currentDiagramPosition: new go.Point(50, 60),
    })).toBe(releaseViewportBounds);
  });

  it('uses diagram position for passive viewport updates when GoJS viewport bounds lag behind', () => {
    const resolved = resolveOverviewViewportBoundsForSource({
      source: 'viewport',
      usingManualViewportBounds: false,
      fakeViewportBounds: null,
      releaseViewportBounds: null,
      observedViewportBounds: new go.Rect(10, 20, 100, 80),
      currentDiagramPosition: new go.Point(40, 60),
    });

    expect(resolved).toEqual(new go.Rect(40, 60, 100, 80));
  });

  it('keeps observed bounds for document updates even when diagram position differs', () => {
    const observedViewportBounds = new go.Rect(10, 20, 100, 80);

    expect(resolveOverviewViewportBoundsForSource({
      source: 'document',
      usingManualViewportBounds: false,
      fakeViewportBounds: null,
      releaseViewportBounds: null,
      observedViewportBounds,
      currentDiagramPosition: new go.Point(40, 60),
    })).toBe(observedViewportBounds);
  });

  it('decides whether to consume the pending viewport anchor suppression', () => {
    expect(decideOverviewViewportAnchorSuppression({
      source: 'viewport',
      usingManualViewportBounds: false,
      viewportBounds: new go.Rect(10, 20, 100, 80),
      suppressNextViewportAnchor: true,
      postDragAnchorSuppressionBounds: new go.Rect(10.5, 20.5, 100, 80),
    })).toEqual({
      shouldSuppressNextViewportAnchor: true,
      shouldClearSuppressNextViewportAnchor: true,
      shouldClearPostDragAnchorSuppressionBounds: false,
    });

    expect(decideOverviewViewportAnchorSuppression({
      source: 'viewport',
      usingManualViewportBounds: false,
      viewportBounds: new go.Rect(10, 20, 100, 80),
      suppressNextViewportAnchor: true,
      postDragAnchorSuppressionBounds: new go.Rect(20, 20, 100, 80),
    })).toEqual({
      shouldSuppressNextViewportAnchor: false,
      shouldClearSuppressNextViewportAnchor: true,
      shouldClearPostDragAnchorSuppressionBounds: true,
    });
  });

  it('keeps suppression pending untouched when no suppression flag is armed', () => {
    expect(decideOverviewViewportAnchorSuppression({
      source: 'viewport',
      usingManualViewportBounds: false,
      viewportBounds: new go.Rect(10, 20, 100, 80),
      suppressNextViewportAnchor: false,
      postDragAnchorSuppressionBounds: new go.Rect(10, 20, 100, 80),
    })).toEqual({
      shouldSuppressNextViewportAnchor: false,
      shouldClearSuppressNextViewportAnchor: false,
      shouldClearPostDragAnchorSuppressionBounds: false,
    });
  });

  it('clears release viewport bounds once observed viewport catches up', () => {
    const releaseViewportBounds = new go.Rect(40, 60, 100, 80);
    const decision = resolveOverviewReleaseViewportCatchUp({
      context: createContext({
        usingReleaseViewportBounds: true,
        releaseViewportBounds,
      }),
      observedViewportBounds: new go.Rect(40.5, 60.5, 100, 80),
      overviewReleaseShouldAnchor: false,
    });

    expect(decision).toEqual({
      postDragAnchorSuppressionBounds: releaseViewportBounds,
    });
    expect(decision?.postDragAnchorSuppressionBounds).not.toBe(releaseViewportBounds);
  });

  it('keeps release viewport bounds when observed viewport has not caught up', () => {
    expect(resolveOverviewReleaseViewportCatchUp({
      context: createContext({
        usingReleaseViewportBounds: true,
        releaseViewportBounds: new go.Rect(40, 60, 100, 80),
      }),
      observedViewportBounds: new go.Rect(45, 60, 100, 80),
      overviewReleaseShouldAnchor: false,
    })).toBeNull();
  });

  it('detects settled post-drag anchor suppression from context or stored bounds', () => {
    expect(shouldSuppressSettledPostDragAnchor(
      createContext({ shouldSuppressNextViewportAnchor: true }),
      null,
    )).toBe(true);

    expect(shouldSuppressSettledPostDragAnchor(
      createContext({ shouldSuppressNextViewportAnchor: false }),
      new go.Rect(10.5, 20.5, 100, 80),
    )).toBe(true);

    expect(shouldSuppressSettledPostDragAnchor(
      createContext({ shouldSuppressNextViewportAnchor: false }),
      new go.Rect(30, 20, 100, 80),
    )).toBe(false);
  });

  it('classifies manual overview movement viewports', () => {
    expect(isManualOverviewMovementViewport(createContext({ usingFakeViewportBounds: true }), true, false)).toBe(true);
    expect(isManualOverviewMovementViewport(createContext({ usingReleaseViewportBounds: true }), false, false)).toBe(true);
    expect(isManualOverviewMovementViewport(createContext(), true, true)).toBe(true);
    expect(isManualOverviewMovementViewport(createContext(), true, false)).toBe(false);
  });

  it('decides when overview should anchor on the viewport', () => {
    expect(shouldAnchorOverviewOnViewport(
      createContext({ source: 'document', isPassiveObservedViewportUpdate: false }),
      true,
      false,
    )).toBe(true);

    expect(shouldAnchorOverviewOnViewport(
      createContext({ usingFakeViewportBounds: true, isPassiveObservedViewportUpdate: false }),
      true,
      false,
    )).toBe(false);

    expect(shouldAnchorOverviewOnViewport(
      createContext({
        usingReleaseViewportBounds: true,
        isPassiveObservedViewportUpdate: false,
        viewportIsInsideCurrentOverviewBounds: true,
      }),
      false,
      false,
    )).toBe(false);
  });

  it('uses node-centered viewport bounds only for manual movement around the node center', () => {
    expect(resolveOverviewBoundsViewport({
      context: createContext({ viewportBounds: new go.Rect(0, 0, 100, 80) }),
      nodeBounds: new go.Rect(200, 300, 100, 60),
      viewportContainsNodeCenter: true,
      manualMovementViewport: true,
    })).toEqual(new go.Rect(200, 280, 100, 80));

    const viewportBounds = new go.Rect(0, 0, 100, 80);
    expect(resolveOverviewBoundsViewport({
      context: createContext({ viewportBounds }),
      nodeBounds: new go.Rect(200, 300, 100, 60),
      viewportContainsNodeCenter: false,
      manualMovementViewport: true,
    })).toBe(viewportBounds);
  });

  it('decides stable-bounds reuse mode for passive pan, box drag, and outside manual viewport', () => {
    expect(decideOverviewStableBoundsReuse({
      context: createContext({
        isPassiveObservedViewportUpdate: true,
        viewportIsInsideCurrentOverviewBounds: false,
      }),
      overviewFixedBounds: null,
      manualMovementViewport: false,
      isViewportOutside: false,
      viewportContainsNodeCenter: true,
    })).toEqual({
      preferStableBounds: true,
      reuseWhenInsideBounds: false,
    });

    expect(decideOverviewStableBoundsReuse({
      context: createContext({
        usingFakeViewportBounds: true,
        usingManualViewportBounds: true,
        isPassiveObservedViewportUpdate: false,
      }),
      overviewFixedBounds: new go.Rect(0, 0, 200, 200),
      manualMovementViewport: true,
      isViewportOutside: false,
      viewportContainsNodeCenter: true,
    })).toEqual({
      preferStableBounds: true,
      reuseWhenInsideBounds: true,
    });

    expect(decideOverviewStableBoundsReuse({
      context: createContext({
        isPassiveObservedViewportUpdate: false,
        viewportIsInsideCurrentOverviewBounds: false,
      }),
      overviewFixedBounds: null,
      manualMovementViewport: true,
      isViewportOutside: true,
      viewportContainsNodeCenter: false,
    })).toEqual({
      preferStableBounds: true,
      reuseWhenInsideBounds: false,
    });
  });
});
