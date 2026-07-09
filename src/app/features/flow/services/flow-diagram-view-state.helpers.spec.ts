import { describe, expect, it } from 'vitest';

import type { ViewState } from './flow-zoom.service';
import {
  detectFlowDevicePixelRatioChange,
  selectBestFlowViewState,
} from './flow-diagram-view-state.helpers';

const viewState = (scale: number, positionX: number, positionY: number): ViewState => ({
  scale,
  positionX,
  positionY,
});

describe('flow-diagram-view-state.helpers', () => {
  describe('selectBestFlowViewState', () => {
    it('uses stable state before later fallback candidates', () => {
      expect(selectBestFlowViewState({
        stableViewState: viewState(1.25, 10, 20),
        recoverableViewState: viewState(1.5, 30, 40),
        currentViewState: viewState(1.75, 50, 60),
        persistedViewState: viewState(2, 70, 80),
      })).toEqual(viewState(1.25, 10, 20));
    });

    it('skips invalid candidates and uses current state before persisted state', () => {
      expect(selectBestFlowViewState({
        stableViewState: viewState(0, 10, 20),
        recoverableViewState: viewState(Number.NaN, 30, 40),
        currentViewState: viewState(1.75, 50, 60),
        persistedViewState: viewState(2, 70, 80),
      })).toEqual(viewState(1.75, 50, 60));
    });

    it('returns null when every candidate is missing or invalid', () => {
      expect(selectBestFlowViewState({
        stableViewState: null,
        recoverableViewState: undefined,
        persistedViewState: viewState(5, 70, 80),
      })).toBeNull();
    });
  });

  describe('detectFlowDevicePixelRatioChange', () => {
    it('reports a change when the ratio delta reaches the tolerance', () => {
      expect(detectFlowDevicePixelRatioChange(1, 1.01)).toEqual({
        changed: true,
        previousRatio: 1,
        nextRatio: 1.01,
      });
    });

    it('ignores sub-threshold ratio drift', () => {
      expect(detectFlowDevicePixelRatioChange(2, 2.0005)).toEqual({
        changed: false,
        previousRatio: 2,
        nextRatio: 2.0005,
      });
    });
  });
});
