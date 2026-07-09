import { describe, expect, it } from 'vitest';

import {
  isHeavyRecoveryInCooldown,
  isRecoveryCompensationInFlight,
} from './app-lifecycle-recovery-state.helpers';

describe('app-lifecycle recovery state helpers', () => {
  describe('isRecoveryCompensationInFlight', () => {
    it('reports no compensation when no ticket is active', () => {
      expect(isRecoveryCompensationInFlight(null)).toBe(false);
      expect(isRecoveryCompensationInFlight(null, 'ticket-1')).toBe(false);
    });

    it('matches the active compensation ticket when a ticket id is supplied', () => {
      expect(isRecoveryCompensationInFlight('ticket-1', 'ticket-1')).toBe(true);
      expect(isRecoveryCompensationInFlight('ticket-1', 'ticket-2')).toBe(false);
    });

    it('treats any active compensation as in flight when no ticket id is supplied', () => {
      expect(isRecoveryCompensationInFlight('ticket-1')).toBe(true);
    });
  });

  describe('isHeavyRecoveryInCooldown', () => {
    it('reports no cooldown before any heavy recovery has completed', () => {
      expect(isHeavyRecoveryInCooldown(null, 1_000, 500)).toBe(false);
    });

    it('reports cooldown while the last heavy recovery is inside the window', () => {
      expect(isHeavyRecoveryInCooldown(1_000, 1_400, 500)).toBe(true);
    });

    it('reports no cooldown once the window has elapsed', () => {
      expect(isHeavyRecoveryInCooldown(1_000, 1_500, 500)).toBe(false);
    });
  });
});
