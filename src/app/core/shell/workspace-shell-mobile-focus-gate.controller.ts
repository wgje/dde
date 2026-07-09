export interface WorkspaceShellMobileFocusGateControllerOptions {
  isThrottledFocusStartup: () => boolean;
  isMobile: () => boolean;
  currentUserId: () => string | null;
  setFocusModeIntentActivated: (active: boolean) => void;
  preloadFocusModeAssets: (reason: 'intent') => Promise<void>;
  dispatchFocusEntrySyncPulseIfReady: () => void;
  teardownFocusMountIntentListener: () => void;
  checkGateForProjectEntry: () => void;
  warmProjectEntryGateSnapshot: () => void;
}

export class WorkspaceShellMobileFocusGateController {
  private pendingProjectGateCheck = false;

  constructor(private readonly options: WorkspaceShellMobileFocusGateControllerOptions) {}

  checkGateForMobileProjectEntry(): void {
    if (!this.options.isThrottledFocusStartup() || !this.options.isMobile()) {
      return;
    }

    this.options.setFocusModeIntentActivated(true);
    void this.options.preloadFocusModeAssets('intent');
    this.options.dispatchFocusEntrySyncPulseIfReady();
    this.options.teardownFocusMountIntentListener();
    if (!this.options.currentUserId()) {
      this.pendingProjectGateCheck = true;
      return;
    }

    this.pendingProjectGateCheck = false;
    this.options.checkGateForProjectEntry();
  }

  warmMobileProjectGateSnapshot(): void {
    if (!this.options.isThrottledFocusStartup() || !this.options.isMobile()) {
      return;
    }

    this.options.warmProjectEntryGateSnapshot();
  }

  flushPendingMobileProjectGateCheck(): void {
    if (
      !this.pendingProjectGateCheck
      || !this.options.isThrottledFocusStartup()
      || !this.options.isMobile()
      || !this.options.currentUserId()
    ) {
      return;
    }

    this.options.checkGateForProjectEntry();
    this.pendingProjectGateCheck = false;
  }
}
