import {
  createWorkspaceSidebarChromeSignals,
  type WorkspaceSidebarChromeSignalSources,
} from './workspace-shell-chrome.helpers';

export interface WorkspaceShellFocusChromeControllerOptions
  extends WorkspaceSidebarChromeSignalSources {
}

export class WorkspaceShellFocusChromeController {
  private readonly sidebarChrome = createWorkspaceSidebarChromeSignals({
    phase: this.options.phase,
    isMobile: this.options.isMobile,
    sidebarOpen: this.options.sidebarOpen,
    sidebarWidth: this.options.sidebarWidth,
  });

  readonly focusWorkspaceTakeoverActive =
    this.sidebarChrome.focusWorkspaceTakeoverActive;
  readonly focusWorkspaceTakeoverPhase =
    this.sidebarChrome.focusWorkspaceTakeoverPhase;
  readonly workspaceSidebarWidthPx = this.sidebarChrome.workspaceSidebarWidthPx;
  readonly mobileSidebarBackdropVisible =
    this.sidebarChrome.mobileSidebarBackdropVisible;
  readonly workspaceSidebarOpacity = this.sidebarChrome.workspaceSidebarOpacity;
  readonly workspaceSidebarTransform =
    this.sidebarChrome.workspaceSidebarTransform;
  readonly workspaceSidebarPointerEvents =
    this.sidebarChrome.workspaceSidebarPointerEvents;
  readonly workspaceSidebarTransition =
    this.sidebarChrome.workspaceSidebarTransition;
  readonly workspaceSidebarContentOpacity =
    this.sidebarChrome.workspaceSidebarContentOpacity;
  readonly workspaceSidebarContentTransform =
    this.sidebarChrome.workspaceSidebarContentTransform;
  readonly workspaceSidebarContentTransition =
    this.sidebarChrome.workspaceSidebarContentTransition;

  constructor(private readonly options: WorkspaceShellFocusChromeControllerOptions) {}
}
