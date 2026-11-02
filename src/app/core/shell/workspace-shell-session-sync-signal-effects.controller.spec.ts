import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellSessionSyncSignalEffectsController } from './workspace-shell-session-sync-signal-effects.controller';
import type { WorkspaceShellSignalEffectRegistrarController } from './workspace-shell-signal-effect-registrar.controller';

function createController(sessionSetup: () => void = vi.fn()) {
  const effects = new Map<string, () => void>();
  const register = vi.fn((effectName: string, callback: () => void) => {
    effects.set(effectName, callback);
  });
  const report = vi.fn();
  const effectRegistrar = {
    register,
    report,
  } as unknown as WorkspaceShellSignalEffectRegistrarController;
  const remoteCallbacks = { registerIfReady: vi.fn() };
  const projectSubscription = { sync: vi.fn() };
  const sessionTransition = { setupSessionHandlers: vi.fn(sessionSetup) };
  const controller = new WorkspaceShellSessionSyncSignalEffectsController({
    effectRegistrar,
    remoteCallbacks,
    projectSubscription,
    sessionTransition,
  });

  return {
    controller,
    effectRegistrar,
    effects,
    projectSubscription,
    register,
    remoteCallbacks,
    report,
    sessionTransition,
  };
}

describe('WorkspaceShellSessionSyncSignalEffectsController', () => {
  it('registers remote callbacks before project subscription', () => {
    const { controller, register } = createController();

    controller.setupEffects();

    expect(register.mock.calls.map(([effectName]) => effectName)).toEqual([
      'remote-callback-registration',
      'project-subscription',
    ]);
  });

  it('forwards remote callback and project subscription synchronization', () => {
    const { controller, effects, projectSubscription, remoteCallbacks } = createController();

    controller.setupEffects();
    effects.get('remote-callback-registration')?.();
    effects.get('project-subscription')?.();

    expect(remoteCallbacks.registerIfReady).toHaveBeenCalledTimes(1);
    expect(projectSubscription.sync).toHaveBeenCalledTimes(1);
  });

  it('sets up session transition handlers outside the signal effect registry', () => {
    const { controller, register, sessionTransition } = createController();

    controller.setupSessionTransitionHandlers();

    expect(sessionTransition.setupSessionHandlers).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();
  });

  it('reports session transition setup failures without throwing', () => {
    const error = new Error('session transition setup failed');
    const { controller, report } = createController(() => {
      throw error;
    });

    expect(() => controller.setupSessionTransitionHandlers()).not.toThrow();

    expect(report).toHaveBeenCalledWith('session-transition-handlers', error);
  });
});
