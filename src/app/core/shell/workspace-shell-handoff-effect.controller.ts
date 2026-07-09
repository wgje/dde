import type {
  HandoffDecisionInput,
  HandoffResult,
} from '../../../services/handoff-coordinator.service';
import type { LaunchSnapshot } from '../../../services/launch-snapshot.service';

export interface WorkspaceShellHandoffEffectControllerOptions {
  isSnapshotHandoffEnabled: () => boolean;
  routeUrl: () => string;
  isMobile: () => boolean;
  projects: () => readonly { id: string }[];
  activeProjectId: () => string | null;
  startupProjectCatalogStage: () => 'unresolved' | 'partial' | 'resolved';
  trustedPrehydratedSnapshotVisible: () => boolean;
  startupLaunchSnapshot: () => LaunchSnapshot | null;
  authConfigured: () => boolean;
  authRuntimeState: () => HandoffDecisionInput['authRuntimeState'];
  isCheckingSession: () => boolean;
  showLoginRequired: () => boolean;
  bootstrapFailed: () => boolean;
  resolveHandoff: (input: HandoffDecisionInput) => HandoffResult;
  switchActiveProject: (projectId: string) => void;
}

export class WorkspaceShellHandoffEffectController {
  constructor(private readonly options: WorkspaceShellHandoffEffectControllerOptions) {}

  sync(): void {
    if (!this.options.isSnapshotHandoffEnabled()) {
      return;
    }

    const projects = this.options.projects();
    const activeProjectId = this.options.activeProjectId();
    const trustedStartupSnapshot = this.resolveTrustedStartupSnapshot();
    const result = this.options.resolveHandoff({
      routeUrl: this.options.routeUrl(),
      isMobile: this.options.isMobile(),
      hasProjects: projects.length > 0,
      activeProjectId,
      authConfigured: this.options.authConfigured(),
      authRuntimeState: this.options.authRuntimeState(),
      isCheckingSession: this.options.isCheckingSession(),
      showLoginRequired: this.options.showLoginRequired(),
      bootstrapFailed: this.options.bootstrapFailed(),
      snapshot: trustedStartupSnapshot,
      snapshotProjectsTrusted: trustedStartupSnapshot !== null,
    });

    if (result.kind === 'degraded-to-project' && !activeProjectId && projects.length > 0) {
      this.options.switchActiveProject(this.resolveFallbackProjectId(projects, trustedStartupSnapshot));
    }
  }

  private resolveTrustedStartupSnapshot(): LaunchSnapshot | null {
    if (
      !this.options.trustedPrehydratedSnapshotVisible()
      || this.options.startupProjectCatalogStage() !== 'partial'
    ) {
      return null;
    }

    return this.options.startupLaunchSnapshot();
  }

  private resolveFallbackProjectId(
    projects: readonly { id: string }[],
    trustedStartupSnapshot: LaunchSnapshot | null,
  ): string {
    const snapshotProjectId = trustedStartupSnapshot?.currentProject?.id ?? null;
    return snapshotProjectId && projects.some((project) => project.id === snapshotProjectId)
      ? snapshotProjectId
      : projects[0].id;
  }
}
