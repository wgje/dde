import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellStartupTierSignalEffectsController } from './workspace-shell-startup-tier-signal-effects.controller';
import type { WorkspaceShellSignalEffectRegistrarController } from './workspace-shell-signal-effect-registrar.controller';

function createController() {
  const effects = new Map<string, () => void>();
  const register = vi.fn((effectName: string, callback: () => void) => {
    effects.set(effectName, callback);
  });
  const effectRegistrar = { register } as unknown as WorkspaceShellSignalEffectRegistrarController;
  const currentUserId = vi.fn(() => 'user-1');
  const coreDataLoaded = vi.fn(() => true);
  const isStartupTierReady = vi.fn((_tier: 'p1' | 'p2') => true);
  const startupTierHydration = {
    markAuthReadyIfReady: vi.fn(),
    warmupInteractionIfReady: vi.fn(),
    startSyncHydrationIfReady: vi.fn(),
  };
  const controller = new WorkspaceShellStartupTierSignalEffectsController({
    effectRegistrar,
    currentUserId,
    coreDataLoaded,
    isStartupTierReady,
    startupTierHydration,
  });

  return {
    controller,
    coreDataLoaded,
    currentUserId,
    effects,
    isStartupTierReady,
    register,
    startupTierHydration,
  };
}

describe('WorkspaceShellStartupTierSignalEffectsController', () => {
  it('registers auth-ready, p1, and p2 effects in startup order', () => {
    const { controller, register } = createController();

    controller.setup();

    expect(register.mock.calls.map(([effectName]) => effectName)).toEqual([
      'startup-tier-auth-ready',
      'startup-tier-p1',
      'startup-tier-p2',
    ]);
  });

  it('captures auth dependencies before marking auth ready', () => {
    const {
      controller,
      coreDataLoaded,
      currentUserId,
      effects,
      startupTierHydration,
    } = createController();
    const order: string[] = [];
    currentUserId.mockImplementation(() => {
      order.push('currentUserId');
      return 'user-1';
    });
    coreDataLoaded.mockImplementation(() => {
      order.push('coreDataLoaded');
      return true;
    });
    startupTierHydration.markAuthReadyIfReady.mockImplementation(() => {
      order.push('markAuthReadyIfReady');
    });

    controller.setup();
    effects.get('startup-tier-auth-ready')?.();

    expect(order).toEqual([
      'currentUserId',
      'coreDataLoaded',
      'markAuthReadyIfReady',
    ]);
  });

  it('captures p1 and p2 readiness before running hydration stages', () => {
    const {
      controller,
      effects,
      isStartupTierReady,
      startupTierHydration,
    } = createController();

    controller.setup();
    effects.get('startup-tier-p1')?.();
    effects.get('startup-tier-p2')?.();

    expect(isStartupTierReady).toHaveBeenNthCalledWith(1, 'p1');
    expect(isStartupTierReady).toHaveBeenNthCalledWith(2, 'p2');
    expect(startupTierHydration.warmupInteractionIfReady).toHaveBeenCalledTimes(1);
    expect(startupTierHydration.startSyncHydrationIfReady).toHaveBeenCalledTimes(1);
  });
});
