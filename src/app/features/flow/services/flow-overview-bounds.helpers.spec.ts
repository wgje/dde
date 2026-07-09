import { describe, expect, it } from 'vitest';
import * as go from 'gojs';

import {
  buildOverviewCandidateWorldBounds,
  calculateOverviewBaseScaleForBounds,
  calculateExtendedOverviewBounds,
  calculateOverviewDynamicBuffers,
  calculateOverviewTotalBounds,
  clampOverviewScale,
  constrainScaleForViewportBox,
  ensureOverviewMinimumSize,
  ensureOverviewViewportEdgeBuffer,
  expandOverviewHorizontalBuffer,
  expandOverviewVerticalBuffer,
  getOverviewBoundsCacheKey,
  isOverviewViewportOutsideNodeBounds,
  overviewViewportContainsNodeCenter,
  overviewViewportFitsInsideStableBounds,
  overviewViewportIsInsideBounds,
  overviewViewportPositionAlmostEqual,
  resolveOverviewScaleForTotalBounds,
  resolveOverviewNodesBounds,
  resolveOverviewRefreshPlan,
  resolveOverviewTargetScale,
  resolveOverviewWorldBoundsForViewport,
  updateOverviewScaleTowardTarget,
  type OverviewScaleUpdateParams,
} from './flow-overview-bounds.helpers';

describe('flow-overview-bounds.helpers', () => {
  function createScaleParams(overrides: Partial<OverviewScaleUpdateParams> = {}): OverviewScaleUpdateParams {
    return {
      viewportBounds: new go.Rect(0, 0, 200, 100),
      totalBounds: new go.Rect(0, 0, 1000, 500),
      containerWidth: 300,
      containerHeight: 200,
      baseScale: 0.2,
      isViewportOutside: false,
      freezeScaleForStableManualBounds: false,
      smoothManualScale: false,
      ...overrides,
    };
  }

  it('clamps overview scale to the supported range', () => {
    expect(clampOverviewScale(0)).toBe(1e-4);
    expect(clampOverviewScale(0.25)).toBe(0.25);
    expect(clampOverviewScale(1)).toBe(0.5);
  });

  it('resolves total-bounds scale with overview padding and hard max', () => {
    expect(resolveOverviewScaleForTotalBounds(createScaleParams())).toBeCloseTo(0.21);
    expect(resolveOverviewScaleForTotalBounds(createScaleParams({
      totalBounds: new go.Rect(0, 0, 100, 100),
    }))).toBe(0.5);
  });

  it('resolves resize refresh scale and anchors to the viewport when it is real', () => {
    expect(resolveOverviewRefreshPlan({
      containerWidth: 400,
      containerHeight: 300,
      documentBounds: new go.Rect(0, 0, 1000, 500),
      viewportBounds: new go.Rect(10, 20, 100, 80),
    })).toEqual({
      scale: 0.32,
      anchorBounds: new go.Rect(10, 20, 100, 80),
    });
  });

  it('falls back to document bounds for refresh anchor and ignores invalid inputs', () => {
    const documentBounds = new go.Rect(0, 0, 1000, 500);

    expect(resolveOverviewRefreshPlan({
      containerWidth: 400,
      containerHeight: 300,
      documentBounds,
      viewportBounds: new go.Rect(Number.NaN, 0, 100, 80),
    })).toEqual({
      scale: 0.32,
      anchorBounds: documentBounds,
    });

    expect(resolveOverviewRefreshPlan({
      containerWidth: 0,
      containerHeight: 300,
      documentBounds,
      viewportBounds: new go.Rect(10, 20, 100, 80),
    })).toBeNull();
  });

  it('uses base scale unless viewport is outside or the viewport box needs shrinking', () => {
    expect(resolveOverviewTargetScale(createScaleParams(), 0.1)).toBe(0.2);
    expect(resolveOverviewTargetScale(createScaleParams({ isViewportOutside: true }), 0.1)).toBeCloseTo(0.21);
    expect(resolveOverviewTargetScale(createScaleParams({
      viewportBounds: new go.Rect(0, 0, 2000, 100),
      totalBounds: new go.Rect(0, 0, 4000, 1000),
      baseScale: 0.2,
    }), 0.2)).toBeCloseTo(0.0525);
  });

  it('constrains scale so the viewport box fits inside the overview container', () => {
    const viewportBounds = new go.Rect(0, 0, 1000, 500);

    expect(constrainScaleForViewportBox(0.5, viewportBounds, 300, 200, 40)).toBeCloseTo(0.26);
    expect(constrainScaleForViewportBox(0.1, viewportBounds, 300, 200, 40)).toBe(0.1);
  });

  it('steps overview scale toward the target only while smoothing is enabled', () => {
    expect(updateOverviewScaleTowardTarget(0.2, 0.4, false)).toBe(0.4);
    expect(updateOverviewScaleTowardTarget(0.2, 0.4, true)).toBeCloseTo(0.224);
    expect(updateOverviewScaleTowardTarget(0.2, 0.201, true)).toBe(0.201);
  });

  it('calculates dynamic buffers from container dimensions with minimum fallbacks', () => {
    expect(calculateOverviewDynamicBuffers(100, 100)).toEqual({
      dynamicBufferW: 400,
      dynamicBufferH: 400,
    });
    expect(calculateOverviewDynamicBuffers(2000, 1800)).toEqual({
      dynamicBufferW: 600,
      dynamicBufferH: 540,
    });
    expect(calculateOverviewDynamicBuffers(null, undefined)).toEqual({
      dynamicBufferW: 400,
      dynamicBufferH: 400,
    });
  });

  it('resolves overview node bounds from real, missing, and invalid document bounds', () => {
    expect(resolveOverviewNodesBounds(null)).toEqual(new go.Rect(0, 0, 500, 500));
    expect(resolveOverviewNodesBounds(new go.Rect(0, 0, Number.NaN, Number.NaN)))
      .toEqual(new go.Rect(-250, -250, 500, 500));
    expect(resolveOverviewNodesBounds(new go.Rect(100, 200, 300, 400)))
      .toEqual(new go.Rect(20, 120, 460, 560));
  });

  it('calculates overview base scale from container and node bounds', () => {
    expect(calculateOverviewBaseScaleForBounds(400, 300, new go.Rect(0, 0, 1000, 500))).toBeCloseTo(0.32);
    expect(calculateOverviewBaseScaleForBounds(0, 300, new go.Rect(0, 0, 1000, 500))).toBe(0.15);
  });

  it('combines document and viewport bounds for overview total bounds', () => {
    const viewportBounds = new go.Rect(-100, 50, 300, 200);

    expect(calculateOverviewTotalBounds(new go.Rect(0, 0, 1000, 500), viewportBounds))
      .toEqual(new go.Rect(-100, 0, 1100, 500));
    expect(calculateOverviewTotalBounds(new go.Rect(0, 0, Number.NaN, Number.NaN), viewportBounds))
      .toEqual(viewportBounds);
  });

  it('extends overview bounds toward viewport overflow and keeps minimum size', () => {
    const bounds = calculateExtendedOverviewBounds(
      new go.Rect(0, 0, 100, 100),
      new go.Rect(-20, 80, 60, 50),
      { dynamicBufferW: 40, dynamicBufferH: 30 },
    );

    expect(bounds).toEqual(new go.Rect(-60, -25, 160, 155));
  });

  it('builds candidate world bounds and adds passive-pan edge buffer when viewport leaves current bounds', () => {
    const bounds = buildOverviewCandidateWorldBounds({
      nodeBounds: new go.Rect(0, 0, 100, 100),
      boundsViewport: new go.Rect(20, 20, 200, 150),
      viewportBounds: new go.Rect(20, 20, 200, 150),
      containerWidth: 100,
      containerHeight: 100,
      isPassiveObservedViewportUpdate: true,
      viewportIsInsideCurrentOverviewBounds: false,
    });

    expect(bounds).toEqual(new go.Rect(-380, -380, 1000, 950));
  });

  it('expands bounds around the center when minimum viewport padding is missing', () => {
    const bounds = ensureOverviewMinimumSize(
      new go.Rect(10, 20, 100, 80),
      new go.Rect(0, 0, 200, 150),
      40,
      50,
    );

    expect(bounds).toEqual(new go.Rect(-60, -40, 240, 200));
  });

  it('adds missing horizontal and vertical edge buffers in place', () => {
    const bounds = new go.Rect(0, 0, 100, 100);
    const viewportBounds = new go.Rect(10, 20, 80, 70);

    expandOverviewHorizontalBuffer(bounds, viewportBounds, 30);
    expandOverviewVerticalBuffer(bounds, viewportBounds, 40);

    expect(bounds).toEqual(new go.Rect(-20, -20, 140, 150));
  });

  it('creates buffered viewport bounds without mutating the source bounds', () => {
    const sourceBounds = new go.Rect(0, 0, 100, 100);
    const viewportBounds = new go.Rect(20, 20, 200, 150);

    expect(ensureOverviewViewportEdgeBuffer(
      sourceBounds,
      viewportBounds,
      { dynamicBufferW: 40, dynamicBufferH: 30 },
      'passive-pan',
    )).toEqual(new go.Rect(-180, -130, 420, 330));
    expect(sourceBounds).toEqual(new go.Rect(0, 0, 100, 100));
  });

  it('detects whether a viewport is inside stable overview bounds', () => {
    const stableBounds = new go.Rect(0, 0, 1000, 900);

    expect(overviewViewportFitsInsideStableBounds(stableBounds, new go.Rect(200, 200, 300, 200))).toBe(true);
    expect(overviewViewportFitsInsideStableBounds(stableBounds, new go.Rect(10, 200, 300, 200))).toBe(false);
    expect(overviewViewportFitsInsideStableBounds(new go.Rect(Number.NaN, 0, 1, 1), new go.Rect(0, 0, 1, 1))).toBe(false);
  });

  it('allows a one-pixel tolerance when checking viewport containment', () => {
    const bounds = new go.Rect(0, 0, 100, 100);

    expect(overviewViewportIsInsideBounds(bounds, new go.Rect(-1, 0, 101, 100))).toBe(true);
    expect(overviewViewportIsInsideBounds(bounds, new go.Rect(-2, 0, 101, 100))).toBe(false);
  });

  it('reuses stable world bounds only when the viewport fits the requested reuse mode', () => {
    const candidateBounds = new go.Rect(-50, -50, 200, 200);
    const currentBounds = new go.Rect(0, 0, 1000, 900);

    expect(resolveOverviewWorldBoundsForViewport(
      candidateBounds,
      new go.Rect(200, 200, 300, 200),
      currentBounds,
      true,
    )).toEqual({ bounds: currentBounds, reusedStableBounds: true });

    expect(resolveOverviewWorldBoundsForViewport(
      candidateBounds,
      new go.Rect(-10, 200, 300, 200),
      currentBounds,
      true,
      true,
    )).toEqual({
      bounds: currentBounds.copy().unionRect(candidateBounds),
      reusedStableBounds: false,
    });

    expect(resolveOverviewWorldBoundsForViewport(candidateBounds, new go.Rect(0, 0, 1, 1), currentBounds, false))
      .toEqual({ bounds: candidateBounds, reusedStableBounds: false });
  });

  it('compares viewport positions with a one-pixel tolerance', () => {
    expect(overviewViewportPositionAlmostEqual(new go.Rect(0, 0, 10, 10), new go.Rect(0.5, 0.9, 20, 20))).toBe(true);
    expect(overviewViewportPositionAlmostEqual(new go.Rect(0, 0, 10, 10), new go.Rect(1, 0, 10, 10))).toBe(false);
  });

  it('classifies viewport location relative to node bounds', () => {
    const nodeBounds = new go.Rect(100, 100, 200, 100);

    expect(isOverviewViewportOutsideNodeBounds(new go.Rect(49, 100, 200, 100), nodeBounds)).toBe(true);
    expect(isOverviewViewportOutsideNodeBounds(new go.Rect(50, 100, 200, 100), nodeBounds)).toBe(false);
    expect(overviewViewportContainsNodeCenter(new go.Rect(150, 120, 100, 80), nodeBounds)).toBe(true);
    expect(overviewViewportContainsNodeCenter(new go.Rect(0, 0, 100, 100), nodeBounds)).toBe(false);
  });

  it('rounds bounds values for stable cache keys', () => {
    expect(getOverviewBoundsCacheKey(new go.Rect(1.2, 2.5, 3.49, 4.51))).toBe('1|3|3|5');
  });
});
