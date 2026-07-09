import { describe, expect, it } from 'vitest';

import { FOCUS_CONFIG } from '../config/focus.config';
import { shouldRecheckFocusGateOnResume } from './app-lifecycle-focus-gate.helpers';

describe('shouldRecheckFocusGateOnResume', () => {
  it('skips manual and online resume reasons', () => {
    expect(shouldRecheckFocusGateOnResume('manual', FOCUS_CONFIG.GATE.IDLE_RECHECK_THRESHOLD + 1)).toBe(false);
    expect(shouldRecheckFocusGateOnResume('online', FOCUS_CONFIG.GATE.IDLE_RECHECK_THRESHOLD + 1)).toBe(false);
  });

  it('always rechecks after a pageshow resume', () => {
    expect(shouldRecheckFocusGateOnResume('pageshow', 0)).toBe(true);
  });

  it('rechecks visibility resumes only after the focus gate idle threshold', () => {
    expect(shouldRecheckFocusGateOnResume(
      'visibility-threshold',
      FOCUS_CONFIG.GATE.IDLE_RECHECK_THRESHOLD - 1,
    )).toBe(false);
    expect(shouldRecheckFocusGateOnResume(
      'visibility-threshold',
      FOCUS_CONFIG.GATE.IDLE_RECHECK_THRESHOLD,
    )).toBe(true);
  });
});
