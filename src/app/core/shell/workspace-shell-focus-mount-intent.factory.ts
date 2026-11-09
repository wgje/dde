import {
  WorkspaceShellFocusMountIntentController,
  type WorkspaceShellFocusMountIntentControllerOptions,
} from './workspace-shell-focus-mount-intent.controller';

export interface WorkspaceShellFocusMountIntentFactoryOptions {
  getWindow: WorkspaceShellFocusMountIntentControllerOptions['getWindow'];
  isThrottledFocusStartup: () => boolean;
  setFocusModeIntentActivated: (active: boolean) => void;
  syncPulseLifecycle: () => { dispatchFocusEntrySyncPulseIfReady(): void };
}

export function createWorkspaceShellFocusMountIntentController(
  options: WorkspaceShellFocusMountIntentFactoryOptions,
): WorkspaceShellFocusMountIntentController {
  return new WorkspaceShellFocusMountIntentController({
    getWindow: options.getWindow,
    isEnabled: () => options.isThrottledFocusStartup(),
    setFocusModeIntentActivated: active =>
      options.setFocusModeIntentActivated(active),
    dispatchFocusEntrySyncPulseIfReady: () =>
      options.syncPulseLifecycle().dispatchFocusEntrySyncPulseIfReady(),
  });
}
