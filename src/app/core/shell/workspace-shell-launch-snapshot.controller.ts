import type { ColorMode, Project, ThemeType } from '../../../models';

type WorkspaceShellLaunchView = 'text' | 'flow';

export interface WorkspaceShellLaunchSnapshotPersistOptions {
  userId: string | null;
  activeProjectId: string | null;
  lastActiveView: WorkspaceShellLaunchView | null;
  routeUrl: string;
  resolvedLaunchView: WorkspaceShellLaunchView;
  mobileDegraded: boolean;
  degradeReason: string | null;
  theme: ThemeType;
  colorMode: ColorMode;
}

export interface WorkspaceShellLaunchSnapshotControllerOptions {
  isWriteBlocked: () => boolean;
  isHintOnlyStartupPlaceholderVisible: () => boolean;
  cancelPendingPersist: () => void;
  projects: () => Project[];
  currentUserId: () => string | null;
  isSessionInitialized: () => boolean;
  isCheckingSession: () => boolean;
  getPersistOwnerDuringAuthSettle: () => string | null;
  activeProjectId: () => string | null;
  activeView: () => WorkspaceShellLaunchView | null;
  routeUrl: () => string;
  isMobile: () => boolean;
  theme: () => ThemeType;
  readColorMode: () => ColorMode;
  schedulePersistDeferred: (
    projects: Project[],
    options: WorkspaceShellLaunchSnapshotPersistOptions,
  ) => void;
}

export class WorkspaceShellLaunchSnapshotController {
  constructor(private readonly options: WorkspaceShellLaunchSnapshotControllerOptions) {}

  sync(): void {
    if (this.options.isWriteBlocked() || this.options.isHintOnlyStartupPlaceholderVisible()) {
      this.options.cancelPendingPersist();
      return;
    }

    const projects = this.options.projects();
    const userId = this.resolveUserId();
    if (!userId) {
      this.options.cancelPendingPersist();
      return;
    }

    const activeProjectId = this.options.activeProjectId();
    const lastActiveView = this.options.activeView();
    const theme = this.options.theme();
    const colorMode = this.options.readColorMode();
    const routeUrl = this.options.routeUrl();
    const resolvedLaunchView = lastActiveView ?? 'text';
    const mobileDegraded = this.options.isMobile()
      && (routeUrl.endsWith('/flow') || routeUrl.includes('/task/'))
      && resolvedLaunchView === 'text';

    this.options.schedulePersistDeferred(projects, {
      userId,
      activeProjectId,
      lastActiveView,
      routeUrl,
      resolvedLaunchView,
      mobileDegraded,
      degradeReason: mobileDegraded ? 'mobile-default-text' : null,
      theme,
      colorMode,
    });
  }

  resolveUserId(): string | null {
    const currentUserId = this.options.currentUserId();
    if (currentUserId) {
      return currentUserId;
    }

    const authSettling = !this.options.isSessionInitialized() || this.options.isCheckingSession();
    if (!authSettling) {
      return null;
    }

    return this.options.getPersistOwnerDuringAuthSettle();
  }
}

export function readWorkspaceLaunchSnapshotColorMode(documentRef: Document | undefined = getDocument()): ColorMode {
  if (!documentRef) {
    return 'system';
  }

  const mode = documentRef.documentElement.getAttribute('data-color-mode');
  return mode === 'light' || mode === 'dark' ? mode : 'system';
}

function getDocument(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document;
}
