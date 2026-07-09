interface WorkspaceShellFocusMountIntentWindow {
  addEventListener: (
    eventName: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ) => void;
  removeEventListener: (eventName: string, listener: EventListener) => void;
}

type WorkspaceShellFocusMountIntentEventName = 'pointerdown' | 'keydown' | 'touchstart';

export interface WorkspaceShellFocusMountIntentControllerOptions {
  getWindow: () => WorkspaceShellFocusMountIntentWindow | undefined;
  isEnabled: () => boolean;
  setFocusModeIntentActivated: (active: boolean) => void;
  dispatchFocusEntrySyncPulseIfReady: () => void;
}

export class WorkspaceShellFocusMountIntentController {
  private registered = false;
  private registeredWindowRef: WorkspaceShellFocusMountIntentWindow | null = null;

  private readonly focusMountIntentListener: EventListener = () => {
    if (!this.options.isEnabled()) {
      this.teardown();
      return;
    }

    this.options.setFocusModeIntentActivated(true);
    this.options.dispatchFocusEntrySyncPulseIfReady();
    this.teardown();
  };

  constructor(private readonly options: WorkspaceShellFocusMountIntentControllerOptions) {}

  setup(): void {
    if (this.registered) {
      return;
    }

    const windowRef = this.options.getWindow();
    if (!windowRef || !this.options.isEnabled()) {
      return;
    }

    const registeredEvents: WorkspaceShellFocusMountIntentEventName[] = [];
    try {
      windowRef.addEventListener('pointerdown', this.focusMountIntentListener, { once: true, passive: true });
      registeredEvents.push('pointerdown');
      windowRef.addEventListener('keydown', this.focusMountIntentListener, { once: true });
      registeredEvents.push('keydown');
      windowRef.addEventListener('touchstart', this.focusMountIntentListener, { once: true, passive: true });
      registeredEvents.push('touchstart');
      this.registeredWindowRef = windowRef;
      this.registered = true;
    } catch (error) {
      for (const eventName of registeredEvents) {
        this.removeFirstInteractionListener(windowRef, eventName);
      }
      this.registeredWindowRef = null;
      this.registered = false;
      throw error;
    }
  }

  teardown(): void {
    const windowRef = this.registeredWindowRef;
    if (!windowRef || !this.registered) return;

    this.registered = false;
    this.registeredWindowRef = null;
    this.removeFirstInteractionListener(windowRef, 'pointerdown');
    this.removeFirstInteractionListener(windowRef, 'keydown');
    this.removeFirstInteractionListener(windowRef, 'touchstart');
  }

  private removeFirstInteractionListener(
    windowRef: WorkspaceShellFocusMountIntentWindow,
    eventName: WorkspaceShellFocusMountIntentEventName,
  ): void {
    try {
      windowRef.removeEventListener(eventName, this.focusMountIntentListener);
      return;
    } catch {
      // Best-effort teardown: one failed listener removal must not leave the rest bound.
    }

    try {
      windowRef.removeEventListener(eventName, this.focusMountIntentListener);
    } catch {
      // Swallow teardown failures; the controller is already marked unregistered.
    }
  }
}
