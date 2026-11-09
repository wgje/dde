import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellAndroidWidgetSignalEffectsController } from './workspace-shell-android-widget-signal-effects.controller';
import { WorkspaceShellSignalEffectRegistrarController } from './workspace-shell-signal-effect-registrar.controller';

function createController(overrides: {
  routeUrl?: () => string | null | undefined;
  captureAndroidWidgetBootstrapFromRoute?: (routeUrl: string | null) => Promise<boolean>;
} = {}) {
  const effects: Array<() => void> = [];
  const onAsyncEffectError = vi.fn();
  const effectRegistrar = new WorkspaceShellSignalEffectRegistrarController({
    registerEffect: callback => effects.push(callback),
    onAsyncEffectError,
  });
  const routeUrl = overrides.routeUrl ?? vi.fn(() => '/projects/project-1');
  const captureAndroidWidgetBootstrapFromRoute =
    overrides.captureAndroidWidgetBootstrapFromRoute ?? vi.fn().mockResolvedValue(false);
  const syncAndroidWidgetBootstrapProcessing = vi.fn();
  const controller = new WorkspaceShellAndroidWidgetSignalEffectsController({
    effectRegistrar,
    routeUrl,
    captureAndroidWidgetBootstrapFromRoute,
    syncAndroidWidgetBootstrapProcessing,
  });

  return {
    captureAndroidWidgetBootstrapFromRoute,
    controller,
    effects,
    onAsyncEffectError,
    syncAndroidWidgetBootstrapProcessing,
  };
}

describe('WorkspaceShellAndroidWidgetSignalEffectsController', () => {
  it('registers capture and processing effects', () => {
    const {
      captureAndroidWidgetBootstrapFromRoute,
      controller,
      effects,
      syncAndroidWidgetBootstrapProcessing,
    } = createController();

    controller.setup();
    effects.forEach(run => run());

    expect(effects).toHaveLength(2);
    expect(captureAndroidWidgetBootstrapFromRoute).toHaveBeenCalledWith(
      '/projects/project-1',
    );
    expect(syncAndroidWidgetBootstrapProcessing).toHaveBeenCalledTimes(1);
  });

  it('normalizes unavailable route values to null', () => {
    const { captureAndroidWidgetBootstrapFromRoute, controller, effects } = createController({
      routeUrl: vi.fn(() => undefined),
    });

    controller.setup();
    effects.forEach(run => run());

    expect(captureAndroidWidgetBootstrapFromRoute).toHaveBeenCalledWith(null);
  });

  it('reports asynchronous capture failures through the effect registrar', async () => {
    const error = new Error('android widget bootstrap failed');
    const { controller, effects, onAsyncEffectError } = createController({
      captureAndroidWidgetBootstrapFromRoute: vi.fn().mockRejectedValue(error),
    });

    controller.setup();
    effects.forEach(run => run());
    await Promise.resolve();

    expect(onAsyncEffectError).toHaveBeenCalledWith(
      'android-widget-bootstrap-capture',
      error,
    );
  });
});
