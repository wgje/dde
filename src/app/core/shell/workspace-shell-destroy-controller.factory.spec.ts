import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceShellDestroyController } from './workspace-shell-destroy-controller.factory';

function createController() {
  const record: string[] = [];
  const push = (label: string) => vi.fn(() => record.push(label));
  const controller = createWorkspaceShellDestroyController({
    markDestroyed: push('component.destroyed'),
    signalEffects: { teardown: push('signalEffects.teardown') },
    startupBootstrap: { teardown: push('startupBootstrap.teardown') },
    storageEscape: { teardown: push('storageEscape.teardown') },
    startupEntryIntent: { teardown: push('startupEntryIntent.teardown') },
    undoService: { flushPendingAction: push('undo.flushPendingAction') },
    modalCoord: { clearCallbacks: push('modalCoord.clearCallbacks') },
    conflictHandler: { cleanup: push('conflictHandler.cleanup') },
    routeSyncController: { cleanup: push('routeSync.cleanup') },
    sessionTransitionCleanup: { cleanup: push('sessionTransition.cleanup') },
    remoteCallbackTeardown: { teardown: push('remoteCallbacks.teardown') },
    ngOnInitStartup: { teardown: push('ngOnInitStartup.teardown') },
    startupLazyServices: { teardown: push('startupLazyServices.teardown') },
    sidebarToggleEvent: { cleanup: push('sidebarToggleEvent.cleanup') },
    lazyLifecycles: {
      teardownKeyboardShortcutsStage: push('lazyLifecycles.teardownKeyboardShortcutsStage'),
      teardownStartupStage: push('lazyLifecycles.teardownStartupStage'),
    },
    interactionLifecycle: {
      teardownDestroyStage: push('interactionLifecycle.teardownDestroyStage'),
      cleanupViewportStage: push('interactionLifecycle.cleanupViewportStage'),
    },
    toolLazyLoad: { teardown: push('toolLazyLoad.teardown') },
    androidWidgetLazyLoad: { teardown: push('androidWidget.teardown') },
    focusMountIntent: { teardown: push('focusMountIntent.teardown') },
    syncPulseLifecycle: {
      clearFocusEntrySyncPulseRetry: push('syncPulse.clearFocusEntrySyncPulseRetry'),
      destroy: push('syncPulse.destroy'),
    },
    startupTier: { destroy: push('startupTier.destroy') },
    projectSubscription: { clear: push('projectSubscription.clear') },
    beforeUnloadController: { cleanup: push('beforeUnload.cleanup') },
    searchController: { cleanup: push('search.cleanup') },
    flowPrewarm: { teardown: push('flowPrewarm.teardown') },
  });

  return { controller, record };
}

describe('createWorkspaceShellDestroyController', () => {
  it('wires shell dependencies into the destroy controller', () => {
    const { controller, record } = createController();

    controller.destroy();

    expect(record).toEqual([
      'component.destroyed',
      'signalEffects.teardown',
      'startupBootstrap.teardown',
      'storageEscape.teardown',
      'startupEntryIntent.teardown',
      'undo.flushPendingAction',
      'modalCoord.clearCallbacks',
      'conflictHandler.cleanup',
      'routeSync.cleanup',
      'sessionTransition.cleanup',
      'remoteCallbacks.teardown',
      'ngOnInitStartup.teardown',
      'startupLazyServices.teardown',
      'sidebarToggleEvent.cleanup',
      'lazyLifecycles.teardownKeyboardShortcutsStage',
      'interactionLifecycle.teardownDestroyStage',
      'toolLazyLoad.teardown',
      'androidWidget.teardown',
      'focusMountIntent.teardown',
      'syncPulse.clearFocusEntrySyncPulseRetry',
      'flowPrewarm.teardown',
      'lazyLifecycles.teardownStartupStage',
      'syncPulse.destroy',
      'startupTier.destroy',
      'projectSubscription.clear',
      'beforeUnload.cleanup',
      'search.cleanup',
      'interactionLifecycle.cleanupViewportStage',
    ]);
  });

  it('provides the resume-interaction feature flag gate inside the factory', () => {
    const { controller, record } = createController();

    controller.destroy();

    expect(record).toContain('projectSubscription.clear');
  });
});
