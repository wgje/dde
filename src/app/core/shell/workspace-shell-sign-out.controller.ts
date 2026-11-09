export interface WorkspaceShellSignOutControllerOptions {
  signOut: () => Promise<boolean>;
  resetFocusEntrySyncPulseState: (rearmIntentListener: boolean) => void;
  destroySyncPulse: () => void;
  clearProjectState: () => void;
  clearSearchState: () => void;
}

export class WorkspaceShellSignOutController {
  constructor(private readonly options: WorkspaceShellSignOutControllerOptions) {}

  async signOut(): Promise<void> {
    const signedOut = await this.options.signOut();
    if (!signedOut) {
      return;
    }

    this.runLocalCleanupStep(() => {
      this.options.resetFocusEntrySyncPulseState(false);
    });
    this.runLocalCleanupStep(() => {
      this.options.destroySyncPulse();
    });
    this.runLocalCleanupStep(() => {
      this.options.clearProjectState();
    });
    this.runLocalCleanupStep(() => {
      this.options.clearSearchState();
    });
  }

  private runLocalCleanupStep(action: () => void): void {
    try {
      action();
    } catch {
      // Sign-out already succeeded remotely; local cleanup must stay best-effort.
    }
  }
}
