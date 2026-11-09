import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellUiSignalEffectsController } from './workspace-shell-ui-signal-effects.controller';
import type { WorkspaceShellSignalEffectRegistrarController } from './workspace-shell-signal-effect-registrar.controller';

function createController() {
  const effects = new Map<string, () => void>();
  const register = vi.fn((effectName: string, callback: () => void) => {
    effects.set(effectName, callback);
  });
  const effectRegistrar = { register } as unknown as WorkspaceShellSignalEffectRegistrarController;
  const modalEffects = {
    syncRecoverableError: vi.fn(),
    syncLoginRequest: vi.fn(),
    syncMigrationRequest: vi.fn(),
  };
  const dataProtectionReminder = { syncFromState: vi.fn() };
  const controller = new WorkspaceShellUiSignalEffectsController({
    effectRegistrar,
    modalEffects,
    dataProtectionReminder,
  });

  return {
    controller,
    dataProtectionReminder,
    effects,
    modalEffects,
    register,
  };
}

describe('WorkspaceShellUiSignalEffectsController', () => {
  it('registers modal effects before the data protection reminder', () => {
    const { controller, register } = createController();

    controller.setup();

    expect(register.mock.calls.map(([effectName]) => effectName)).toEqual([
      'modal-recoverable-error',
      'modal-login-request',
      'modal-migration-request',
      'data-protection-reminder',
    ]);
  });

  it('forwards all modal synchronization effects', () => {
    const { controller, effects, modalEffects } = createController();

    controller.setup();
    effects.get('modal-recoverable-error')?.();
    effects.get('modal-login-request')?.();
    effects.get('modal-migration-request')?.();

    expect(modalEffects.syncRecoverableError).toHaveBeenCalledTimes(1);
    expect(modalEffects.syncLoginRequest).toHaveBeenCalledTimes(1);
    expect(modalEffects.syncMigrationRequest).toHaveBeenCalledTimes(1);
  });

  it('forwards data protection reminder state synchronization', () => {
    const { controller, dataProtectionReminder, effects } = createController();

    controller.setup();
    effects.get('data-protection-reminder')?.();

    expect(dataProtectionReminder.syncFromState).toHaveBeenCalledTimes(1);
  });
});
