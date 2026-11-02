import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellSignalEffectRegistrarController } from './workspace-shell-signal-effect-registrar.controller';

function createController(overrides: {
  registerEffect?: (callback: () => void) => void;
  onEffectError?: (effect: string, error: unknown) => void;
  onAsyncEffectError?: (effect: string, error: unknown) => void;
} = {}) {
  const effects: Array<() => void> = [];
  const registerEffect = overrides.registerEffect ?? ((callback: () => void) => {
    effects.push(callback);
  });
  const onEffectError = overrides.onEffectError ?? vi.fn();
  const controller = new WorkspaceShellSignalEffectRegistrarController({
    registerEffect,
    onEffectError,
    onAsyncEffectError: overrides.onAsyncEffectError,
  });

  return {
    controller,
    effects,
    onEffectError,
  };
}

describe('WorkspaceShellSignalEffectRegistrarController', () => {
  it('registers and runs a named signal effect', () => {
    const callback = vi.fn();
    const { controller, effects } = createController();

    controller.register('launch-snapshot', callback);
    effects.forEach(run => run());

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('isolates synchronous effect failures and reports the effect name', () => {
    const error = new Error('effect failed');
    const { controller, effects, onEffectError } = createController();

    controller.register('launch-snapshot', () => {
      throw error;
    });

    expect(() => effects.forEach(run => run())).not.toThrow();
    expect(onEffectError).toHaveBeenCalledWith('launch-snapshot', error);
  });

  it('reports effect registration failures without throwing', () => {
    const error = new Error('registration failed');
    const { controller, onEffectError } = createController({
      registerEffect: () => {
        throw error;
      },
    });

    expect(() => controller.register('focus-probe', vi.fn())).not.toThrow();

    expect(onEffectError).toHaveBeenCalledWith('focus-probe:register', error);
  });

  it('prefers the async error sink for asynchronous effect failures', () => {
    const error = new Error('async effect failed');
    const onEffectError = vi.fn();
    const onAsyncEffectError = vi.fn();
    const { controller } = createController({ onEffectError, onAsyncEffectError });

    controller.reportAsync('android-widget-bootstrap-capture', error);

    expect(onAsyncEffectError).toHaveBeenCalledWith(
      'android-widget-bootstrap-capture',
      error,
    );
    expect(onEffectError).not.toHaveBeenCalled();
  });

  it('keeps effect execution alive when the diagnostic sink fails', () => {
    const { controller, effects } = createController({
      onEffectError: () => {
        throw new Error('diagnostic sink failed');
      },
    });

    controller.register('sync-pulse', () => {
      throw new Error('effect failed');
    });

    expect(() => effects.forEach(run => run())).not.toThrow();
  });
});
