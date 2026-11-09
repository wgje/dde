import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellFocusSyncSignalEffectsController } from './workspace-shell-focus-sync-signal-effects.controller';
import type { WorkspaceShellSignalEffectRegistrarController } from './workspace-shell-signal-effect-registrar.controller';

function createController(destroyed = false) {
  const effects = new Map<string, () => void>();
  const register = vi.fn((effectName: string, callback: () => void) => {
    effects.set(effectName, callback);
  });
  const effectRegistrar = { register } as unknown as WorkspaceShellSignalEffectRegistrarController;
  const focusProbeController = { sync: vi.fn() };
  const currentUserId = vi.fn(() => 'user-1');
  const focusEntrySyncPulse = { handleOwnerChange: vi.fn() };
  const syncPulseEffect = { sync: vi.fn() };
  const controller = new WorkspaceShellFocusSyncSignalEffectsController({
    effectRegistrar,
    focusProbeController,
    currentUserId,
    destroyed: vi.fn(() => destroyed),
    focusEntrySyncPulse,
    syncPulseEffect,
  });

  return {
    controller,
    currentUserId,
    effects,
    focusEntrySyncPulse,
    focusProbeController,
    register,
    syncPulseEffect,
  };
}

describe('WorkspaceShellFocusSyncSignalEffectsController', () => {
  it('registers probe, owner, and sync pulse effects in order', () => {
    const { controller, register } = createController();

    controller.setupProbe();
    controller.setupOwnerAndSyncPulse();

    expect(register.mock.calls.map(([effectName]) => effectName)).toEqual([
      'focus-probe',
      'focus-entry-owner',
      'sync-pulse',
    ]);
  });

  it('forwards probe and sync pulse synchronization', () => {
    const { controller, effects, focusProbeController, syncPulseEffect } = createController();

    controller.setupProbe();
    controller.setupOwnerAndSyncPulse();
    effects.get('focus-probe')?.();
    effects.get('sync-pulse')?.();

    expect(focusProbeController.sync).toHaveBeenCalledTimes(1);
    expect(syncPulseEffect.sync).toHaveBeenCalledTimes(1);
  });

  it('tracks owner dependencies but skips owner notification after destroy', () => {
    const active = createController(false);
    const tornDown = createController(true);

    active.controller.setupOwnerAndSyncPulse();
    tornDown.controller.setupOwnerAndSyncPulse();
    active.effects.get('focus-entry-owner')?.();
    tornDown.effects.get('focus-entry-owner')?.();

    expect(active.focusEntrySyncPulse.handleOwnerChange).toHaveBeenCalledWith('user-1');
    expect(tornDown.currentUserId).toHaveBeenCalledTimes(1);
    expect(tornDown.focusEntrySyncPulse.handleOwnerChange).not.toHaveBeenCalled();
  });
});
