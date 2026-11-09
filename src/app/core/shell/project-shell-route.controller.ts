import type { ActivatedRoute, Router } from '@angular/router';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import {
  type HandoffCoordinatorService,
} from '../../../services/handoff-coordinator.service';
import type { FlowCommandService } from '../../features/flow/services/flow-command.service';
import type { TaskOperationAdapterService } from '../../../services/task-operation-adapter.service';
import type { ActiveProjectOwner } from '../../../services/project-state.service';
import type { LaunchSnapshot } from '../../../models/launch-shell';
import {
  ProjectShellTaskDeepLinkController,
  type ProjectShellTaskDeepLinkRouteResult,
} from './project-shell-task-deep-link.controller';
import { ProjectShellFlowRestoreController } from './project-shell-flow-restore.controller';
import {
  ProjectShellRouteStateController,
  type ProjectShellRouteState,
} from './project-shell-route-state.controller';
import { ProjectShellRouteViewController } from './project-shell-route-view.controller';

type SignalSetter<T> = {
  set(value: T): void;
};

export interface ProjectShellRouteControllerOptions {
  route: ActivatedRoute;
  router: Router;
  handoffCoordinator: HandoffCoordinatorService;
  startupLaunchSnapshot: Pick<
    LaunchSnapshot,
    'routeIntent' | 'mobileDegraded' | 'degradeReason'
  > | null;
  flowStateAwareRestoreEnabled: boolean;
  flowIntentActivated(): boolean;
  flowPrefetchOnlyActivated: SignalSetter<boolean>;
  uiState: {
    isMobile(): boolean;
    activeView: SignalSetter<'text' | 'flow'>;
    getLastActiveView(): 'text' | 'flow' | null;
    persistActiveView(view: 'text' | 'flow'): void;
  };
  projectState: {
    activeProjectId(): string | null;
    getProject(projectId: string): { name: string } | null | undefined;
    projects(): Array<{ id: string }>;
    tasks(): unknown[];
    getTask(taskId: string): unknown;
    captureActiveProjectOwner?(): ActiveProjectOwner;
    isActiveProjectOwnerCurrent?(owner: ActiveProjectOwner): boolean;
  };
  syncCoordinator: {
    isLoadingRemote?: () => boolean;
  };
  userSession: {
    switchActiveProject(projectId: string): void;
  };
  tabSync: {
    notifyProjectOpen(projectId: string, projectName: string): void;
  };
  toast: {
    info(title: string, message: string, options?: unknown): void;
    warning(title: string, message: string, options?: unknown): void;
    success(title: string): void;
  };
  taskOpsAdapter: Pick<TaskOperationAdapterService, 'addFloatingTask'>;
  flowCommand: Pick<FlowCommandService, 'centerOnNode'>
    & Partial<Pick<FlowCommandService, 'clearAllCommands'>>;
  activateFlowIntent(source: 'click' | 'route' | 'deeplink' | 'restore-idle'): void;
}

export class ProjectShellRouteController {
  private readonly flowRestore: ProjectShellFlowRestoreController;
  private readonly routeState: ProjectShellRouteStateController;
  private readonly routeView: ProjectShellRouteViewController;
  private readonly taskDeepLink: ProjectShellTaskDeepLinkController;

  constructor(private readonly options: ProjectShellRouteControllerOptions) {
    this.routeState = new ProjectShellRouteStateController({
      handoffCoordinator: options.handoffCoordinator,
      isMobile: () => options.uiState.isMobile(),
      route: options.route,
      router: options.router,
      snapshotHandoffEnabled: FEATURE_FLAGS.SNAPSHOT_HANDOFF_V2,
      startupLaunchSnapshot: options.startupLaunchSnapshot,
    });
    this.flowRestore = new ProjectShellFlowRestoreController({
      flowStateAwareRestoreEnabled: options.flowStateAwareRestoreEnabled,
      flowIntentActivated: options.flowIntentActivated,
      flowPrefetchOnlyActivated: options.flowPrefetchOnlyActivated,
      uiState: options.uiState,
      activateFlowIntent: source => options.activateFlowIntent(source),
    });
    this.routeView = new ProjectShellRouteViewController({
      activateFlowIntent: source => options.activateFlowIntent(source),
      flowRestore: this.flowRestore,
      projectState: options.projectState,
      startupLaunchSnapshot: options.startupLaunchSnapshot,
      toast: options.toast,
      userSession: options.userSession,
    });
    this.taskDeepLink = new ProjectShellTaskDeepLinkController({
      projectState: options.projectState,
      syncCoordinator: options.syncCoordinator,
      router: options.router,
      toast: options.toast,
      taskOpsAdapter: options.taskOpsAdapter,
      flowCommand: options.flowCommand,
      activateFlowIntent: source => options.activateFlowIntent(source),
      setActiveView: view => this.setActiveView(view),
    });
  }

  handleRouteChange(): void {
    const routeState = this.routeState.resolveRouteChangeState();
    const previousActiveProjectId = this.options.projectState.activeProjectId();
    this.taskDeepLink.retirePendingAttempt();
    this.syncProjectFromRoute(routeState.projectId, previousActiveProjectId);
    const taskDeepLinkResult = this.resolveTaskDeepLinkResult(routeState);
    this.routeState.markStartupRouteDecisionResolved();
    this.routeView.applyResolvedRouteView(routeState, taskDeepLinkResult);
  }

  handleTaskDeepLink(
    taskId: string,
    options?: { degradeToWorkspaceOnMissing?: boolean; deferCenter?: boolean }
  ): ProjectShellTaskDeepLinkRouteResult {
    return this.taskDeepLink.handleTaskDeepLink(taskId, options);
  }

  applyStateAwareFlowRestore(currentUrl: string, projectId?: string): void {
    this.flowRestore.applyStateAwareFlowRestore(currentUrl, projectId);
  }

  setActiveView(view: 'text' | 'flow'): void {
    this.flowRestore.setActiveView(view);
  }

  cancelFlowStateAwareTimers(): void {
    this.flowRestore.cancelFlowStateAwareTimers();
  }

  destroy(): void {
    this.flowRestore.destroy();
    this.taskDeepLink.destroy();
  }

  private syncProjectFromRoute(
    projectId: string | undefined,
    previousActiveProjectId: string | null,
  ): void {
    if (!projectId || projectId === previousActiveProjectId) {
      return;
    }

    this.options.flowCommand.clearAllCommands?.();
    this.options.userSession.switchActiveProject(projectId);
    const project = this.options.projectState.getProject(projectId);
    if (project) {
      this.options.tabSync.notifyProjectOpen(projectId, project.name);
    }
  }

  private resolveTaskDeepLinkResult(
    routeState: ProjectShellRouteState,
  ): ProjectShellTaskDeepLinkRouteResult | null {
    if (!routeState.taskId || routeState.degradeMobileStartupRoute) {
      return null;
    }

    return this.handleTaskDeepLink(routeState.taskId, {
      degradeToWorkspaceOnMissing: routeState.startupEntryIntent !== null,
      deferCenter: true,
    });
  }

}
