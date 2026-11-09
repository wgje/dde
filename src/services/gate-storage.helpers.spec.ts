import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearGateHandledToday,
  isGateHandledToday,
  persistGateHandledToday,
} from './gate-storage.helpers';

interface OwnerScopedGateStorage {
  clearHandledToday(ownerUserId: string): void;
  isHandledToday(ownerUserId: string, logger: { debug: ReturnType<typeof vi.fn> }): boolean;
  persistHandledToday(ownerUserId: string, logger: { debug: ReturnType<typeof vi.fn> }): void;
}

const ownerScopedStorage: OwnerScopedGateStorage = {
  clearHandledToday: clearGateHandledToday as unknown as OwnerScopedGateStorage['clearHandledToday'],
  isHandledToday: isGateHandledToday as unknown as OwnerScopedGateStorage['isHandledToday'],
  persistHandledToday: persistGateHandledToday as unknown as OwnerScopedGateStorage['persistHandledToday'],
};

function handledDateKey(ownerUserId: string): string {
  return `focus_gate_last_check_date.${encodeURIComponent(ownerUserId)}`;
}

describe('gate storage owner scope', () => {
  const logger = { debug: vi.fn() };

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('does not let one owner handled-today marker bypass another owner gate', () => {
    ownerScopedStorage.persistHandledToday('user-a', logger);

    expect(ownerScopedStorage.isHandledToday('user-a', logger)).toBe(true);
    expect(ownerScopedStorage.isHandledToday('user-b', logger)).toBe(false);
    expect(localStorage.getItem(handledDateKey('user-a'))).not.toBeNull();
    expect(localStorage.getItem('focus_gate_last_check_date')).toBeNull();
  });

  it('fails closed instead of assigning a legacy global marker to the current owner', () => {
    localStorage.setItem('focus_gate_last_check_date', new Date().toISOString().slice(0, 10));

    expect(ownerScopedStorage.isHandledToday('user-b', logger)).toBe(false);
    expect(localStorage.getItem('focus_gate_last_check_date')).toBeNull();
    expect(localStorage.getItem(handledDateKey('user-b'))).toBeNull();
  });

  it('clears only the requested owner marker', () => {
    ownerScopedStorage.persistHandledToday('user-a', logger);
    ownerScopedStorage.persistHandledToday('user-b', logger);

    ownerScopedStorage.clearHandledToday('user-a');

    expect(ownerScopedStorage.isHandledToday('user-a', logger)).toBe(false);
    expect(ownerScopedStorage.isHandledToday('user-b', logger)).toBe(true);
  });
});
