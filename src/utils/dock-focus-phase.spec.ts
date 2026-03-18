import { describe, expect, it } from 'vitest';
import {
  resolveDockFocusChromeLayoutLocked,
  resolveDockFocusChromePhase,
  resolveDockFocusUiPhase,
} from './dock-focus-phase';

describe('resolveDockFocusUiPhase', () => {
  it('should prefer transition phase when entering or exiting', () => {
    expect(
      resolveDockFocusUiPhase(false, { phase: 'entering' }),
    ).toBe('entering');
    expect(
      resolveDockFocusUiPhase(false, { phase: 'exiting' }),
    ).toBe('exiting');
  });

  it('should treat focus mode without transition as focused', () => {
    expect(resolveDockFocusUiPhase(true, null)).toBe('focused');
  });

  it('should stay idle when neither focus mode nor transition is active', () => {
    expect(resolveDockFocusUiPhase(false, null)).toBe('idle');
  });

  it('should expose restoring phase only for chrome-level recovery', () => {
    expect(resolveDockFocusChromePhase(false, null, false, true)).toBe('restoring');
    expect(resolveDockFocusChromePhase(true, null, false, true)).toBe('idle');
    expect(resolveDockFocusChromePhase(true, { phase: 'exiting' }, true, true)).toBe('exiting');
  });

  it('should keep desktop chrome layout locked through takeover and restore phases', () => {
    expect(resolveDockFocusChromeLayoutLocked('idle')).toBe(false);
    expect(resolveDockFocusChromeLayoutLocked('entering')).toBe(true);
    expect(resolveDockFocusChromeLayoutLocked('focused')).toBe(true);
    expect(resolveDockFocusChromeLayoutLocked('exiting')).toBe(true);
    expect(resolveDockFocusChromeLayoutLocked('restoring')).toBe(true);
  });
});
