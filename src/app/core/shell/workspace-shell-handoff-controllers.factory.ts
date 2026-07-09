import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import type {
  HandoffDecisionInput,
  HandoffResult,
} from '../../../services/handoff-coordinator.service';
import type { LaunchSnapshot } from '../../../services/launch-snapshot.service';

import { WorkspaceShellHandoffEffectController } from './workspace-shell-handoff-effect.controller';
import { WorkspaceShellHandoffReadinessController } from './workspace-shell-handoff-readiness.controller';

export interface WorkspaceShellHandoffControllersOptions {
  bootStage: {
    isWorkspaceHandoffReady(): boolean;
    markWorkspaceHandoffReady(): void;
    noteLoaderHidden(): void;
    markApplicationReady(): void;
  };
  handoffCoordinator: {
    markLayoutStable(): void;
    resolve(input: HandoffDecisionInput): HandoffResult;
  };
  startupTier: {
    markHandoffReady(): void;
  };
  startupEntryControllers: () => {
    readonly startupEntryIntentController: {
      flushWidgetWorkspaceGateRecheck(): void;
    };
  };
  routeUrl(): string;
  isMobile: () => boolean;
  projects: () => readonly { id: string }[];
  activeProjectId: () => string | null;
  startupLaunchSnapshot: () => LaunchSnapshot | null;
  userSession: {
    startupProjectCatalogStage(): 'unresolved' | 'partial' | 'resolved';
    switchActiveProject(projectId: string): void;
    trustedPrehydratedSnapshotVisible(): boolean;
  };
  authService: {
    readonly isConfigured: boolean;
    runtimeState(): HandoffDecisionInput['authRuntimeState'];
  };
  authCoord: {
    isCheckingSession(): boolean;
    showLoginRequired(): boolean;
    bootstrapFailed(): boolean;
  };
}

export interface WorkspaceShellHandoffSurfaceOptions
  extends Omit<
    WorkspaceShellHandoffControllersOptions,
    | 'activeProjectId'
    | 'isMobile'
    | 'projects'
    | 'routeUrl'
    | 'startupLaunchSnapshot'
  > {
  routing: {
    readonly routeUrl: WorkspaceShellHandoffControllersOptions['routeUrl'];
  };
  uiState: {
    readonly isMobile: WorkspaceShellHandoffControllersOptions['isMobile'];
  };
  projectState: {
    readonly projects: WorkspaceShellHandoffControllersOptions['projects'];
    readonly activeProjectId:
      WorkspaceShellHandoffControllersOptions['activeProjectId'];
  };
  launchSnapshotSurface: {
    readonly startupLaunchSnapshot:
      WorkspaceShellHandoffControllersOptions['startupLaunchSnapshot'];
  };
}

export function createWorkspaceShellHandoffControllers(
  options: WorkspaceShellHandoffControllersOptions,
) {
  const readiness = new WorkspaceShellHandoffReadinessController({
    isSnapshotHandoffEnabled: () => FEATURE_FLAGS.SNAPSHOT_HANDOFF_V2,
    isWorkspaceHandoffReady: () => options.bootStage.isWorkspaceHandoffReady(),
    markWorkspaceHandoffReady: () => options.bootStage.markWorkspaceHandoffReady(),
    markLayoutStable: () => options.handoffCoordinator.markLayoutStable(),
    getDocument: () => (typeof document === 'undefined' ? undefined : document),
    noteLoaderHidden: () => options.bootStage.noteLoaderHidden(),
    markHandoffReady: () => options.startupTier.markHandoffReady(),
    markApplicationReady: () => options.bootStage.markApplicationReady(),
    flushWidgetWorkspaceGateRecheck: () =>
      options.startupEntryControllers().startupEntryIntentController
        .flushWidgetWorkspaceGateRecheck(),
  });
  const effect = new WorkspaceShellHandoffEffectController({
    isSnapshotHandoffEnabled: () => FEATURE_FLAGS.SNAPSHOT_HANDOFF_V2,
    routeUrl: () => options.routeUrl(),
    isMobile: options.isMobile,
    projects: options.projects,
    activeProjectId: options.activeProjectId,
    startupProjectCatalogStage: () => options.userSession.startupProjectCatalogStage(),
    trustedPrehydratedSnapshotVisible: () =>
      options.userSession.trustedPrehydratedSnapshotVisible(),
    startupLaunchSnapshot: options.startupLaunchSnapshot,
    authConfigured: () => options.authService.isConfigured,
    authRuntimeState: () => options.authService.runtimeState(),
    isCheckingSession: () => options.authCoord.isCheckingSession(),
    showLoginRequired: () => options.authCoord.showLoginRequired(),
    bootstrapFailed: () => options.authCoord.bootstrapFailed(),
    resolveHandoff: (input) => options.handoffCoordinator.resolve(input),
    switchActiveProject: projectId => options.userSession.switchActiveProject(projectId),
  });

  return { readiness, effect };
}

export function createWorkspaceShellHandoffSurface(
  options: WorkspaceShellHandoffSurfaceOptions,
): ReturnType<typeof createWorkspaceShellHandoffControllers> {
  return createWorkspaceShellHandoffControllers({
    ...options,
    routeUrl: options.routing.routeUrl,
    isMobile: options.uiState.isMobile,
    projects: options.projectState.projects,
    activeProjectId: options.projectState.activeProjectId,
    startupLaunchSnapshot:
      options.launchSnapshotSurface.startupLaunchSnapshot,
  });
}
