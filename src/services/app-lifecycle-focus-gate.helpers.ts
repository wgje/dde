import { FOCUS_CONFIG } from '../config/focus.config';
import type { AppResumeReason } from './app-lifecycle-orchestrator.types';

export function shouldRecheckFocusGateOnResume(
  reason: AppResumeReason,
  backgroundDurationMs: number,
): boolean {
  if (reason === 'manual' || reason === 'online') {
    return false;
  }

  if (reason === 'pageshow') {
    return true;
  }

  return backgroundDurationMs >= FOCUS_CONFIG.GATE.IDLE_RECHECK_THRESHOLD;
}

export function shouldRunFocusGateResumeCheck(
  enabled: boolean,
  reason: AppResumeReason,
  backgroundDurationMs: number,
): boolean {
  return enabled && shouldRecheckFocusGateOnResume(reason, backgroundDurationMs);
}
