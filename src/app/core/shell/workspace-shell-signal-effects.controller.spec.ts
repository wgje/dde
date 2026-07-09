import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellSignalEffectsController,
  type WorkspaceShellSignalEffectsControllerOptions,
} from './workspace-shell-signal-effects.controller';

type StartupTierTrackingTestOptions = {
  coreDataLoaded: () => boolean;
  isStartupTierReady: (tier: 'p1' | 'p2') => boolean;
};

function createController(
  overrides: Partial<
    WorkspaceShellSignalEffectsControllerOptions & StartupTierTrackingTestOptions
  > = {},
) {
  const effects: Array<() => void> = [];
  const options: WorkspaceShellSignalEffectsControllerOptions
    & StartupTierTrackingTestOptions = {
    registerEffect: callback => {
      effects.push(callback);
    },
    modalEffects: {
      syncRecoverableError: vi.fn(),
      syncLoginRequest: vi.fn(),
      syncMigrationRequest: vi.fn(),
    },
    dataProtectionReminder: { syncFromState: vi.fn() },
    launchSnapshotController: { sync: vi.fn() },
    routeUrl: vi.fn(() => '/projects/project-1'),
    projects: vi.fn(() => [{ id: 'project-1' }]),
    activeProjectId: vi.fn(() => 'project-1'),
    syncStateFromRoute: vi.fn(),
    captureAndroidWidgetBootstrapFromRoute: vi.fn().mockResolvedValue(false),
    syncAndroidWidgetBootstrapProcessing: vi.fn(),
    startupEntryIntentController: { sync: vi.fn() },
    handoffEffect: { sync: vi.fn() },
    isWorkspaceHandoffReady: vi.fn(() => true),
    commitWorkspaceHandoff: vi.fn(),
    focusProbeController: { sync: vi.fn() },
    coreDataLoaded: vi.fn(() => true),
    isStartupTierReady: vi.fn(() => true),
    startupTierHydration: {
      markAuthReadyIfReady: vi.fn(),
      warmupInteractionIfReady: vi.fn(),
      startSyncHydrationIfReady: vi.fn(),
    },
    remoteCallbacks: { registerIfReady: vi.fn() },
    projectSubscription: { sync: vi.fn() },
    currentUserId: vi.fn(() => 'user-1'),
    destroyed: vi.fn(() => false),
    focusEntrySyncPulse: { handleOwnerChange: vi.fn() },
    syncPulseEffect: { sync: vi.fn() },
    sessionTransition: { setupSessionHandlers: vi.fn() },
    ...overrides,
  };

  return {
    controller: new WorkspaceShellSignalEffectsController(options),
    effects,
    options,
  };
}

describe('WorkspaceShellSignalEffectsController', () => {
  it('registers workspace shell effects and session transition handlers', () => {
    const { controller, effects, options } = createController();

    controller.setup();
    effects.forEach(run => run());

    expect(effects).toHaveLength(19);
    expect(options.modalEffects.syncRecoverableError).toHaveBeenCalledTimes(1);
    expect(options.modalEffects.syncLoginRequest).toHaveBeenCalledTimes(1);
    expect(options.modalEffects.syncMigrationRequest).toHaveBeenCalledTimes(1);
    expect(options.dataProtectionReminder.syncFromState).toHaveBeenCalledTimes(1);
    expect(options.launchSnapshotController.sync).toHaveBeenCalledTimes(1);
    expect(options.routeUrl).toHaveBeenCalledTimes(2);
    expect(options.projects).toHaveBeenCalledTimes(1);
    expect(options.activeProjectId).toHaveBeenCalledTimes(1);
    expect(options.syncStateFromRoute).toHaveBeenCalledTimes(1);
    expect(options.captureAndroidWidgetBootstrapFromRoute).toHaveBeenCalledWith('/projects/project-1');
    expect(options.syncAndroidWidgetBootstrapProcessing).toHaveBeenCalledTimes(1);
    expect(options.startupEntryIntentController.sync).toHaveBeenCalledTimes(1);
    expect(options.handoffEffect.sync).toHaveBeenCalledTimes(1);
    expect(options.commitWorkspaceHandoff).toHaveBeenCalledTimes(1);
    expect(options.focusProbeController.sync).toHaveBeenCalledTimes(1);
    expect(options.coreDataLoaded).toHaveBeenCalledTimes(1);
    expect(options.isStartupTierReady).toHaveBeenCalledWith('p1');
    expect(options.isStartupTierReady).toHaveBeenCalledWith('p2');
    expect(options.startupTierHydration.markAuthReadyIfReady).toHaveBeenCalledTimes(1);
    expect(options.startupTierHydration.warmupInteractionIfReady).toHaveBeenCalledTimes(1);
    expect(options.startupTierHydration.startSyncHydrationIfReady).toHaveBeenCalledTimes(1);
    expect(options.remoteCallbacks.registerIfReady).toHaveBeenCalledTimes(1);
    expect(options.projectSubscription.sync).toHaveBeenCalledTimes(1);
    expect(options.focusEntrySyncPulse.handleOwnerChange).toHaveBeenCalledWith('user-1');
    expect(options.syncPulseEffect.sync).toHaveBeenCalledTimes(1);
    expect(options.sessionTransition.setupSessionHandlers).toHaveBeenCalledTimes(1);
  });

  it('does not commit workspace handoff until the boot stage is ready', () => {
    const { controller, effects, options } = createController({
      isWorkspaceHandoffReady: vi.fn(() => false),
    });

    controller.setup();
    effects.forEach(run => run());

    expect(options.commitWorkspaceHandoff).not.toHaveBeenCalled();
  });

  it('does not notify focus-entry owner changes after destroy', () => {
    const { controller, effects, options } = createController({
      destroyed: vi.fn(() => true),
    });

    controller.setup();
    effects.forEach(run => run());

    expect(options.currentUserId).toHaveBeenCalledTimes(2);
    expect(options.focusEntrySyncPulse.handleOwnerChange).not.toHaveBeenCalled();
  });

  it('captures android widget bootstrap async failures from signal effects', async () => {
    const error = new Error('android widget bootstrap failed');
    const onAsyncEffectError = vi.fn();
    const { controller, effects } = createController({
      captureAndroidWidgetBootstrapFromRoute: vi.fn().mockRejectedValue(error),
      onAsyncEffectError,
    });

    controller.setup();
    effects.forEach(run => run());
    await Promise.resolve();

    expect(onAsyncEffectError).toHaveBeenCalledWith(
      'android-widget-bootstrap-capture',
      error,
    );
  });

  it('routes android widget bootstrap async failures to the async error sink when both sinks exist', async () => {
    const error = new Error('android widget bootstrap failed');
    const onEffectError = vi.fn();
    const onAsyncEffectError = vi.fn();
    const { controller, effects } = createController({
      captureAndroidWidgetBootstrapFromRoute: vi.fn().mockRejectedValue(error),
      onEffectError,
      onAsyncEffectError,
    });

    controller.setup();
    effects.forEach(run => run());
    await Promise.resolve();

    expect(onAsyncEffectError).toHaveBeenCalledWith(
      'android-widget-bootstrap-capture',
      error,
    );
    expect(onEffectError).not.toHaveBeenCalledWith(
      'android-widget-bootstrap-capture',
      error,
    );
  });

  it('keeps later signal effects running when one sync effect fails', () => {
    const error = new Error('launch snapshot failed');
    const onEffectError = vi.fn();
    const { controller, effects, options } = createController({
      launchSnapshotController: {
        sync: vi.fn(() => {
          throw error;
        }),
      },
      onEffectError,
    });

    controller.setup();
    expect(() => effects.forEach(run => run())).not.toThrow();

    expect(onEffectError).toHaveBeenCalledWith(
      'launch-snapshot',
      error,
    );
    expect(options.syncPulseEffect.sync).toHaveBeenCalledTimes(1);
  });

  it('keeps signal effects alive when the error sink fails', async () => {
    const asyncError = new Error('android widget bootstrap failed');
    const sinkError = new Error('error sink failed');
    const onAsyncEffectError = vi.fn(() => {
      throw sinkError;
    });
    const { controller, effects } = createController({
      captureAndroidWidgetBootstrapFromRoute: vi.fn().mockRejectedValue(asyncError),
      onAsyncEffectError,
    });

    controller.setup();
    expect(() => effects.forEach(run => run())).not.toThrow();
    await Promise.resolve();

    expect(onAsyncEffectError).toHaveBeenCalledWith(
      'android-widget-bootstrap-capture',
      asyncError,
    );
  });
});
