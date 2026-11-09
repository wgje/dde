import { describe, expect, it } from 'vitest';
import {
  clampFlowOverlayPosition,
  resolveFlowLinkActionMenuPosition,
  resolveFlowLinkDeleteHintPosition,
} from './flow-link-overlay-position.helpers';

describe('flow-link-overlay-position.helpers', () => {
  const viewport = { width: 400, height: 600 };

  it('clamps arbitrary overlay positions inside the viewport padding', () => {
    expect(clampFlowOverlayPosition({
      rawX: -100,
      rawY: -100,
      overlayWidth: 120,
      overlayHeight: 80,
      viewport,
    })).toEqual({ x: 16, y: 16 });

    expect(clampFlowOverlayPosition({
      rawX: 360,
      rawY: 570,
      overlayWidth: 120,
      overlayHeight: 80,
      viewport,
    })).toEqual({ x: 264, y: 504 });
  });

  it('positions action menus centered above the pointer', () => {
    expect(resolveFlowLinkActionMenuPosition({ x: 260, y: 260 }, viewport)).toEqual({
      x: 160,
      y: 150,
    });
    expect(resolveFlowLinkActionMenuPosition({ x: 20, y: 20 }, viewport)).toEqual({
      x: 16,
      y: 16,
    });
    expect(resolveFlowLinkActionMenuPosition(null, viewport)).toEqual({ x: 0, y: 0 });
  });

  it('positions delete hints with the legacy mobile offset', () => {
    expect(resolveFlowLinkDeleteHintPosition({ x: 260, y: 260 }, viewport)).toEqual({
      x: 200,
      y: 210,
    });
    expect(resolveFlowLinkDeleteHintPosition({ x: 390, y: 590 }, viewport)).toEqual({
      x: 204,
      y: 534,
    });
    expect(resolveFlowLinkDeleteHintPosition(null, viewport)).toEqual({ x: 0, y: 0 });
  });
});
