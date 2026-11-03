import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellSyncPulseReadinessController,
  type WorkspaceShellSyncPulseReadinessControllerOptions,
} from './workspace-shell-sync-pulse-readiness.controller';

function createController(
  overrides: Partial<WorkspaceShellSyncPulseReadinessControllerOptions> = {},
) {
  const warn = vi.fn();
  const options: WorkspaceShellSyncPulseReadinessControllerOptions = {
    isDestroyed: () => false,
    isEventDrivenSyncPulseEnabled: () => true,
    currentUserId: () => 'user-1',
    coreDataLoaded: () => true,
    isOnline: () => true,
    isResuming: () => false,
    isRecoveryCompensationInFlight: () => false,
    isRecoveryTicketDedupEnabled: () => false,
    currentRecoveryTicket: () => null,
    isTieredStartupHydrationEnabled: () => false,
    isP2Ready: () => true,
    focusModeIntentActivated: () => true,
    warn,
    ...overrides,
  };

  return {
    controller: new WorkspaceShellSyncPulseReadinessController(options),
    warn,
  };
}

describe('WorkspaceShellSyncPulseReadinessController', () => {
  it('reports ready when all full readiness conditions pass', () => {
    const { controller } = createController();

    expect(controller.isReady()).toBe(true);
  });

  it.each<[string, Partial<WorkspaceShellSyncPulseReadinessControllerOptions>]>([
    ['destroyed', { isDestroyed: () => true }],
    ['feature disabled', { isEventDrivenSyncPulseEnabled: () => false }],
    ['missing owner', { currentUserId: () => null }],
    ['core data pending', { coreDataLoaded: () => false }],
    ['offline', { isOnline: () => false }],
    ['resuming', { isResuming: () => true }],
    ['recovery compensation', { isRecoveryCompensationInFlight: () => true }],
    ['active recovery ticket', {
      isRecoveryTicketDedupEnabled: () => true,
      currentRecoveryTicket: () => ({ id: 'ticket-1' }),
    }],
    ['p2 hydration pending', {
      isTieredStartupHydrationEnabled: () => true,
      isP2Ready: () => false,
    }],
  ])('blocks full readiness while %s', (_label, overrides) => {
    const { controller } = createController(overrides);

    expect(controller.isReady()).toBe(false);
  });

  it('uses the narrower startup conditions for effect readiness', () => {
    const { controller } = createController({
      isDestroyed: () => true,
      isOnline: () => false,
      isResuming: () => true,
      isRecoveryCompensationInFlight: () => true,
      isRecoveryTicketDedupEnabled: () => true,
      currentRecoveryTicket: () => ({ id: 'ticket-1' }),
    });

    expect(controller.isReadyForEffect()).toBe(true);
  });

  it('requires focus mode intent and full readiness before dispatch', () => {
    const inactive = createController({ focusModeIntentActivated: () => false }).controller;
    const ready = createController().controller;

    expect(inactive.shouldDispatchFocusEntrySyncPulse()).toBe(false);
    expect(ready.shouldDispatchFocusEntrySyncPulse()).toBe(true);
  });

  it('warns and returns false when a readiness dependency throws', () => {
    const error = new Error('readiness probe failed');
    const { controller, warn } = createController({
      isOnline: () => {
        throw error;
      },
    });

    expect(controller.isReady()).toBe(false);
    expect(warn).toHaveBeenCalledWith('同步脉冲状态检查失败，已跳过本次脉冲', error);
  });

  it('isolates warning sink failures', () => {
    const { controller, warn } = createController({
      isOnline: () => {
        throw new Error('readiness probe failed');
      },
    });
    warn.mockImplementation(() => {
      throw new Error('warning sink failed');
    });

    expect(() => controller.isReady()).not.toThrow();
    expect(controller.isReady()).toBe(false);
  });
});
