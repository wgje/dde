import { gateSnoozeCount, getTodayDate } from '../state/focus-stores';

interface GateStorageLogger {
  debug(scope: string, message: string, context?: unknown): void;
}

const GATE_LAST_CHECK_DATE_KEY = 'focus_gate_last_check_date';
const GATE_SNOOZE_RESET_DATE_KEY = 'focus_gate_snooze_reset_date';

export function resetDailyGateSnoozeCount(logger: GateStorageLogger): void {
  const today = getTodayDate();
  const lastResetDate = localStorage.getItem(GATE_SNOOZE_RESET_DATE_KEY);

  if (lastResetDate !== today) {
    gateSnoozeCount.set(0);
    localStorage.setItem(GATE_SNOOZE_RESET_DATE_KEY, today);
    logger.debug('Gate', 'Daily snooze count reset');
  }
}

export function isGateHandledToday(logger: GateStorageLogger): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(GATE_LAST_CHECK_DATE_KEY) === getTodayDate();
  } catch (error) {
    logger.debug(
      'Gate',
      'Read GATE_LAST_CHECK_DATE_KEY failed, fall through to normal check',
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

export function persistGateHandledToday(logger: GateStorageLogger): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(GATE_LAST_CHECK_DATE_KEY, getTodayDate());
  } catch (error) {
    logger.debug(
      'Gate',
      'Persist GATE_LAST_CHECK_DATE_KEY failed, dedup will fall back to in-memory state',
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function clearGateHandledToday(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(GATE_LAST_CHECK_DATE_KEY);
}
