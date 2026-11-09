import { gateSnoozeCount, getTodayDate } from '../state/focus-stores';

interface GateStorageLogger {
  debug(scope: string, message: string, context?: unknown): void;
}

const GATE_LAST_CHECK_DATE_KEY = 'focus_gate_last_check_date';
const GATE_SNOOZE_RESET_DATE_KEY = 'focus_gate_snooze_reset_date';

function getOwnerScopedKey(baseKey: string, ownerUserId: string | null): string | null {
  const normalizedOwnerUserId = ownerUserId?.trim();
  return normalizedOwnerUserId
    ? `${baseKey}.${encodeURIComponent(normalizedOwnerUserId)}`
    : null;
}

function clearLegacyHandledDate(): void {
  localStorage.removeItem(GATE_LAST_CHECK_DATE_KEY);
}

export function resetDailyGateSnoozeCount(logger: GateStorageLogger): void {
  const today = getTodayDate();
  const lastResetDate = localStorage.getItem(GATE_SNOOZE_RESET_DATE_KEY);

  if (lastResetDate !== today) {
    gateSnoozeCount.set(0);
    localStorage.setItem(GATE_SNOOZE_RESET_DATE_KEY, today);
    logger.debug('Gate', 'Daily snooze count reset');
  }
}

export function isGateHandledToday(ownerUserId: string | null, logger: GateStorageLogger): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    clearLegacyHandledDate();
    const storageKey = getOwnerScopedKey(GATE_LAST_CHECK_DATE_KEY, ownerUserId);
    return storageKey !== null && localStorage.getItem(storageKey) === getTodayDate();
  } catch (error) {
    logger.debug(
      'Gate',
      'Read GATE_LAST_CHECK_DATE_KEY failed, fall through to normal check',
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

export function persistGateHandledToday(ownerUserId: string | null, logger: GateStorageLogger): void {
  if (typeof localStorage === 'undefined') return;
  try {
    clearLegacyHandledDate();
    const storageKey = getOwnerScopedKey(GATE_LAST_CHECK_DATE_KEY, ownerUserId);
    if (storageKey !== null) {
      localStorage.setItem(storageKey, getTodayDate());
    }
  } catch (error) {
    logger.debug(
      'Gate',
      'Persist GATE_LAST_CHECK_DATE_KEY failed, dedup will fall back to in-memory state',
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function clearGateHandledToday(ownerUserId: string | null): void {
  if (typeof localStorage === 'undefined') return;
  clearLegacyHandledDate();
  const storageKey = getOwnerScopedKey(GATE_LAST_CHECK_DATE_KEY, ownerUserId);
  if (storageKey !== null) {
    localStorage.removeItem(storageKey);
  }
}
