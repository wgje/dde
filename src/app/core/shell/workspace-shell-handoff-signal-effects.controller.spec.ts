import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellHandoffSignalEffectsController } from './workspace-shell-handoff-signal-effects.controller';
import type { WorkspaceShellSignalEffectRegistrarController } from './workspace-shell-signal-effect-registrar.controller';

function createController(isWorkspaceHandoffReady = true) {
  const effects = new Map<string, () => void>();
  const register = vi.fn((effectName: string, callback: () => void) => {
    effects.set(effectName, callback);
  });
  const effectRegistrar = { register } as unknown as WorkspaceShellSignalEffectRegistrarController;
  const handoffEffect = { sync: vi.fn() };
  const commitWorkspaceHandoff = vi.fn();
  const controller = new WorkspaceShellHandoffSignalEffectsController({
    effectRegistrar,
    handoffEffect,
    isWorkspaceHandoffReady: vi.fn(() => isWorkspaceHandoffReady),
    commitWorkspaceHandoff,
  });

  return {
    commitWorkspaceHandoff,
    controller,
    effects,
    handoffEffect,
    register,
  };
}

describe('WorkspaceShellHandoffSignalEffectsController', () => {
  it('registers handoff evaluation before workspace readiness commit', () => {
    const { controller, register } = createController();

    controller.setup();

    expect(register.mock.calls.map(([effectName]) => effectName)).toEqual([
      'workspace-handoff',
      'workspace-ready',
    ]);
  });

  it('forwards handoff evaluation to the handoff effect controller', () => {
    const { controller, effects, handoffEffect } = createController();

    controller.setup();
    effects.get('workspace-handoff')?.();

    expect(handoffEffect.sync).toHaveBeenCalledTimes(1);
  });

  it('commits only after workspace handoff readiness is reached', () => {
    const notReady = createController(false);
    const ready = createController(true);

    notReady.controller.setup();
    ready.controller.setup();
    notReady.effects.get('workspace-ready')?.();
    ready.effects.get('workspace-ready')?.();

    expect(notReady.commitWorkspaceHandoff).not.toHaveBeenCalled();
    expect(ready.commitWorkspaceHandoff).toHaveBeenCalledTimes(1);
  });
});
