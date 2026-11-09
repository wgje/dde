import { WorkspaceShellSignOutController } from './workspace-shell-sign-out.controller';

export interface WorkspaceShellSignOutFactoryOptions {
  authCoord: {
    signOut(): Promise<boolean>;
  };
  syncPulseLifecycle: () => {
    resetFocusEntrySyncPulse(rearmIntentListener: boolean): void;
    destroy(): void;
  };
  projectCoord: {
    clearState(): void;
  };
  searchController: () => {
    clear(): void;
  };
}

export function createWorkspaceShellSignOutController(
  options: WorkspaceShellSignOutFactoryOptions,
): WorkspaceShellSignOutController {
  return new WorkspaceShellSignOutController({
    signOut: () => options.authCoord.signOut(),
    resetFocusEntrySyncPulseState: (rearmIntentListener) =>
      options.syncPulseLifecycle()
        .resetFocusEntrySyncPulse(rearmIntentListener),
    destroySyncPulse: () => options.syncPulseLifecycle().destroy(),
    clearProjectState: () => options.projectCoord.clearState(),
    clearSearchState: () => options.searchController().clear(),
  });
}
