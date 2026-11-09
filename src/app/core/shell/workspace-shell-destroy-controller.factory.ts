import { FEATURE_FLAGS } from '../../../config/feature-flags.config';

import { WorkspaceShellDestroyController } from './workspace-shell-destroy.controller';

export interface WorkspaceShellDestroyControllerFactoryOptions {
  markDestroyed: () => void;
  startupBootstrap: { teardown(): void };
  storageEscape: { teardown(): void };
  signalEffects: { teardown(): void };
  startupEntryIntent: { teardown(): void };
  undoService: { flushPendingAction(): void };
  modalCoord: { clearCallbacks(): void };
  conflictHandler: { cleanup(): void };
  routeSyncController: { cleanup(): void };
  sessionTransitionCleanup: { cleanup(): void };
  remoteCallbackTeardown: { teardown(): void };
  ngOnInitStartup: { teardown(): void };
  startupLazyServices: { teardown(): void };
  sidebarToggleEvent: { cleanup(): void };
  lazyLifecycles: {
    teardownKeyboardShortcutsStage(): void;
    teardownStartupStage(): void;
  };
  interactionLifecycle: {
    teardownDestroyStage(): void;
    cleanupViewportStage(): void;
  };
  toolLazyLoad: { teardown(): void };
  androidWidgetLazyLoad: { teardown(): void };
  focusMountIntent: { teardown(): void };
  flowPrewarm: { teardown(): void };
  syncPulseLifecycle: {
    clearFocusEntrySyncPulseRetry(): void;
    destroy(): void;
  };
  startupTier: { destroy(): void };
  projectSubscription: { clear(): void };
  beforeUnloadController: { cleanup(): void };
  searchController: { cleanup(): void };
  warn?: (message: string, error: unknown) => void;
}

export function createWorkspaceShellDestroyController(
  options: WorkspaceShellDestroyControllerFactoryOptions,
): WorkspaceShellDestroyController {
  return new WorkspaceShellDestroyController({
    warn: options.warn,
    initialPhase: {
      markDestroyed: options.markDestroyed,
      teardownSignalEffects: () => options.signalEffects.teardown(),
      teardownStartupBootstrap: () => options.startupBootstrap.teardown(),
      teardownStorageEscape: () => options.storageEscape.teardown(),
      teardownStartupEntryIntent: () => options.startupEntryIntent.teardown(),
      flushPendingUndoAction: () => options.undoService.flushPendingAction(),
      clearModalCallbacks: () => options.modalCoord.clearCallbacks(),
      cleanupConflictHandler: () => options.conflictHandler.cleanup(),
      cleanupRouteSync: () => options.routeSyncController.cleanup(),
      cleanupSessionTransition: () => options.sessionTransitionCleanup.cleanup(),
      teardownRemoteCallbacks: () => options.remoteCallbackTeardown.teardown(),
      teardownNgOnInitStartup: () => options.ngOnInitStartup.teardown(),
      teardownStartupLazyServices: () => options.startupLazyServices.teardown(),
      cleanupSidebarToggleEvent: () => options.sidebarToggleEvent.cleanup(),
    },
    interactionPhase: {
      teardownKeyboardShortcutsStage: () =>
        options.lazyLifecycles.teardownKeyboardShortcutsStage(),
      teardownInteractionDestroyStage: () =>
        options.interactionLifecycle.teardownDestroyStage(),
      teardownToolLazyLoad: () => options.toolLazyLoad.teardown(),
      teardownAndroidWidget: () => options.androidWidgetLazyLoad.teardown(),
      teardownFocusMountIntent: () => options.focusMountIntent.teardown(),
    },
    runtimePhase: {
      clearFocusEntrySyncPulseRetry: () =>
        options.syncPulseLifecycle.clearFocusEntrySyncPulseRetry(),
      teardownFlowPrewarm: () => options.flowPrewarm.teardown(),
      teardownStartupStage: () => options.lazyLifecycles.teardownStartupStage(),
      destroySyncPulse: () => options.syncPulseLifecycle.destroy(),
      destroyStartupTier: () => options.startupTier.destroy(),
      clearProjectSubscription: () => options.projectSubscription.clear(),
      isResumeInteractionFirstEnabled: () =>
        FEATURE_FLAGS.RESUME_INTERACTION_FIRST_V1,
    },
    finalPhase: {
      cleanupBeforeUnload: () => options.beforeUnloadController.cleanup(),
      cleanupSearch: () => options.searchController.cleanup(),
      cleanupInteractionViewportStage: () =>
        options.interactionLifecycle.cleanupViewportStage(),
    },
  });
}
