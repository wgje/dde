export interface WorkspaceShellSidebarToggleEventControllerOptions {
  getWindow?: () => Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined;
  toggleSidebar: () => void;
}

export class WorkspaceShellSidebarToggleEventController {
  private boundWindowRef: Pick<Window, 'addEventListener' | 'removeEventListener'> | null = null;

  private readonly onToggleSidebar = () => {
    this.options.toggleSidebar();
  };

  constructor(private readonly options: WorkspaceShellSidebarToggleEventControllerOptions) {}

  setup(): void {
    const windowRef = this.getWindow();
    if (!windowRef) return;

    this.removeToggleSidebarListener(this.boundWindowRef);
    if (this.boundWindowRef !== windowRef) {
      this.removeToggleSidebarListener(windowRef);
    }
    try {
      windowRef.addEventListener('toggle-sidebar', this.onToggleSidebar);
    } catch {
      this.boundWindowRef = null;
      return;
    }
    this.boundWindowRef = windowRef;
  }

  cleanup(): void {
    const windowRef = this.boundWindowRef ?? this.getWindow();
    this.boundWindowRef = null;
    this.removeToggleSidebarListener(windowRef);
  }

  private getWindow(): Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined {
    return this.options.getWindow?.() ?? readWindowRef();
  }

  private removeToggleSidebarListener(
    windowRef: Pick<Window, 'removeEventListener'> | null | undefined,
  ): void {
    try {
      windowRef?.removeEventListener('toggle-sidebar', this.onToggleSidebar);
    } catch {
      // Best-effort cleanup; a stale listener removal must not block rebinding or teardown.
    }
  }
}

function readWindowRef(): Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined {
  return typeof window === 'undefined' ? undefined : window;
}
