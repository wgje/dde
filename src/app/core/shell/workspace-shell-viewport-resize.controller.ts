import { shouldAutoCloseSidebarOnViewportChange } from '../../../utils/layout-stability';

const WORKSPACE_SHELL_MOBILE_BREAKPOINT_PX = 768;
const WORKSPACE_SHELL_VIEWPORT_RESIZE_DEBOUNCE_MS = 150;

export interface WorkspaceShellViewportResizeControllerOptions {
  isMobile: () => boolean;
  setIsMobile: (isMobile: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  getWindow: () => Pick<Window, 'innerWidth'> | undefined;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  debounceMs?: number;
}

export class WorkspaceShellViewportResizeController {
  private previousViewportIsMobile = this.options.isMobile();
  private resizeDebounceTimer: unknown | null = null;

  constructor(private readonly options: WorkspaceShellViewportResizeControllerOptions) {}

  handleResize(): void {
    const windowRef = this.options.getWindow();
    if (!windowRef) return;

    if (this.resizeDebounceTimer !== null) {
      this.cancelResizeDebounceTimer();
    }

    let resizeDebounceTimer: unknown = null;
    try {
      resizeDebounceTimer = this.setTimeout(() => {
        this.runScheduledResize(windowRef, resizeDebounceTimer);
      }, this.options.debounceMs ?? WORKSPACE_SHELL_VIEWPORT_RESIZE_DEBOUNCE_MS);
    } catch {
      this.resizeDebounceTimer = null;
      this.syncViewportState(windowRef);
      return;
    }
    this.resizeDebounceTimer = resizeDebounceTimer;
  }

  cleanup(): void {
    this.cancelResizeDebounceTimer();
  }

  private setTimeout(callback: () => void, delayMs: number): unknown {
    return this.options.setTimeout?.(callback, delayMs) ?? setTimeout(callback, delayMs);
  }

  private clearTimeout(timer: unknown): void {
    if (this.options.clearTimeout) {
      this.options.clearTimeout(timer);
      return;
    }

    clearTimeout(timer as ReturnType<typeof setTimeout>);
  }

  private cancelResizeDebounceTimer(): void {
    if (this.resizeDebounceTimer === null) return;

    const resizeDebounceTimer = this.resizeDebounceTimer;
    this.resizeDebounceTimer = null;
    try {
      this.clearTimeout(resizeDebounceTimer);
    } catch {
      // Timer cleanup is best-effort; nulling the token prevents stale callbacks
      // from mutating viewport state even when the host timer API fails.
    }
  }

  private runScheduledResize(
    windowRef: Pick<Window, 'innerWidth'>,
    resizeDebounceTimer: unknown,
  ): void {
    if (this.resizeDebounceTimer !== resizeDebounceTimer) {
      return;
    }

    try {
      this.syncViewportState(windowRef);
    } finally {
      if (this.resizeDebounceTimer === resizeDebounceTimer) {
        this.resizeDebounceTimer = null;
      }
    }
  }

  private syncViewportState(windowRef: Pick<Window, 'innerWidth'>): void {
    const nextIsMobile = windowRef.innerWidth < WORKSPACE_SHELL_MOBILE_BREAKPOINT_PX;
    const shouldCloseSidebar = shouldAutoCloseSidebarOnViewportChange(
      this.previousViewportIsMobile,
      nextIsMobile,
    );

    if (this.options.isMobile() !== nextIsMobile) {
      this.options.setIsMobile(nextIsMobile);
    }

    if (shouldCloseSidebar) {
      this.options.setSidebarOpen(false);
    }

    this.previousViewportIsMobile = nextIsMobile;
  }
}
