import type { ActivatedRoute, Router } from '@angular/router';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import {
  shouldDegradeMobileStartupRoute,
  type HandoffCoordinatorService,
  type HandoffResult,
} from '../../../services/handoff-coordinator.service';
import type { FlowCommandService } from '../../features/flow/services/flow-command.service';
import type { TaskOperationAdapterService } from '../../../services/task-operation-adapter.service';
import { resolveStartupEntryIntent } from '../../../utils/startup-entry-intent';
import type { LaunchSnapshot } from '../../../models/launch-shell';
import {
  ProjectShellTaskDeepLinkController,
  type ProjectShellTaskDeepLinkRouteResult,
} from './project-shell-task-deep-link.controller';
import { ProjectShellFlowRestoreController } from './project-shell-flow-restore.controller';

type StartupEntryIntent = ReturnType<typeof resolveStartupEntryIntent>;

interface ProjectShellRouteState {
  projectId?: string;
  taskId?: string;
  currentUrl: string;
  startupEntryIntent: StartupEntryIntent;
  handoffResult: HandoffResult;
  degradeMobileStartupRoute: boolean;
}

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
  flowCommand: Pick<FlowCommandService, 'centerOnNode'>;
  activateFlowIntent(source: 'click' | 'route' | 'deeplink' | 'restore-idle'): void;
}

export class ProjectShellRouteController {
  private startupRouteDecisionResolved = false;
  private readonly flowRestore: ProjectShellFlowRestoreController;
  private readonly taskDeepLink: ProjectShellTaskDeepLinkController;

  constructor(private readonly options: ProjectShellRouteControllerOptions) {
    this.flowRestore = new ProjectShellFlowRestoreController({
      flowStateAwareRestoreEnabled: options.flowStateAwareRestoreEnabled,
      flowIntentActivated: options.flowIntentActivated,
      flowPrefetchOnlyActivated: options.flowPrefetchOnlyActivated,
      uiState: options.uiState,
      activateFlowIntent: source => options.activateFlowIntent(source),
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
    const routeState = this.resolveRouteChangeState();
    this.syncProjectFromRoute(routeState.projectId);
    const taskDeepLinkResult = this.resolveTaskDeepLinkResult(routeState);
    this.startupRouteDecisionResolved = true;
    this.applyResolvedRouteView(routeState, taskDeepLinkResult);
  }

  handleTaskDeepLink(
    taskId: string,
    options?: { degradeToWorkspaceOnMissing?: boolean }
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

  private resolveRouteChangeState(): ProjectShellRouteState {
    const snapshot = this.options.route.snapshot;
    const projectId = snapshot.params['projectId'] as string | undefined;
    const taskId = snapshot.firstChild?.params['taskId'] as string | undefined;
    const currentUrl = this.options.router.url;
    const startupEntryIntent = resolveStartupEntryIntent(currentUrl);
    const handoffResult = this.options.handoffCoordinator.result();
    const snapshotMatchesCurrentRoute = this.matchesStartupSnapshotIntent(
      startupEntryIntent,
      projectId,
      taskId,
      currentUrl,
    );

    return {
      projectId,
      taskId,
      currentUrl,
      startupEntryIntent,
      handoffResult,
      degradeMobileStartupRoute: this.shouldDegradeStartupRoute(
        currentUrl,
        startupEntryIntent,
        handoffResult,
        snapshotMatchesCurrentRoute,
      ),
    };
  }

  private matchesStartupSnapshotIntent(
    startupEntryIntent: StartupEntryIntent,
    projectId: string | undefined,
    taskId: string | undefined,
    currentUrl: string,
  ): boolean {
    const snapshotRouteIntent = startupEntryIntent ? null : this.options.startupLaunchSnapshot?.routeIntent;
    if (!snapshotRouteIntent || snapshotRouteIntent.projectId !== projectId) return false;

    if (snapshotRouteIntent.kind === 'task') return snapshotRouteIntent.taskId === taskId;
    if (snapshotRouteIntent.kind === 'flow') return currentUrl.endsWith('/flow');
    if (snapshotRouteIntent.kind === 'text') return currentUrl.endsWith('/text');
    return snapshotRouteIntent.kind === 'project';
  }

  private shouldDegradeStartupRoute(
    currentUrl: string,
    startupEntryIntent: StartupEntryIntent,
    handoffResult: HandoffResult,
    snapshotMatchesCurrentRoute: boolean,
  ): boolean {
    if (!FEATURE_FLAGS.SNAPSHOT_HANDOFF_V2 || this.startupRouteDecisionResolved || startupEntryIntent) {
      return false;
    }

    return handoffResult.kind === 'degraded-to-text'
      || (this.options.startupLaunchSnapshot?.mobileDegraded === true && snapshotMatchesCurrentRoute)
      || shouldDegradeMobileStartupRoute(currentUrl, this.options.uiState.isMobile());
  }

  private syncProjectFromRoute(projectId: string | undefined): void {
    if (!projectId || projectId === this.options.projectState.activeProjectId()) {
      return;
    }

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
    });
  }

  private applyResolvedRouteView(
    routeState: ProjectShellRouteState,
    taskDeepLinkResult: ProjectShellTaskDeepLinkRouteResult | null,
  ): void {
    if (routeState.degradeMobileStartupRoute) {
      this.applyDegradedStartupRoute(routeState.handoffResult);
      return;
    }

    if (this.shouldOpenFlowRoute(routeState.currentUrl, taskDeepLinkResult)) {
      this.applyFlowRouteView(routeState.currentUrl);
      return;
    }

    if (taskDeepLinkResult === 'pending' || taskDeepLinkResult === 'workspace') {
      return;
    }

    if (routeState.currentUrl.endsWith('/text')) {
      this.cancelFlowStateAwareTimers();
      this.setActiveView('text');
      return;
    }

    this.applyStateAwareFlowRestore(routeState.currentUrl, routeState.projectId);
  }

  private applyDegradedStartupRoute(handoffResult: HandoffResult): void {
    this.cancelFlowStateAwareTimers();
    this.setActiveView('text');
    this.options.toast.info('已切换到文本视图', this.resolveStartupDegradeMessage());
    this.switchToFallbackProjectIfNeeded(handoffResult);
  }

  private resolveStartupDegradeMessage(): string {
    return this.options.startupLaunchSnapshot?.degradeReason === 'mobile-default-text'
      ? '手机端启动默认进入文本视图，可稍后手动切换流程图'
      : '启动阶段已回退到更稳定的文本视图';
  }

  private switchToFallbackProjectIfNeeded(handoffResult: HandoffResult): void {
    if (handoffResult.kind !== 'degraded-to-project' || this.options.projectState.activeProjectId()) {
      return;
    }

    const fallbackProjectId = this.options.projectState.projects()[0]?.id ?? null;
    if (fallbackProjectId) {
      this.options.userSession.switchActiveProject(fallbackProjectId);
    }
  }

  private shouldOpenFlowRoute(
    currentUrl: string,
    taskDeepLinkResult: ProjectShellTaskDeepLinkRouteResult | null,
  ): boolean {
    return currentUrl.endsWith('/flow') || taskDeepLinkResult === 'flow';
  }

  private applyFlowRouteView(currentUrl: string): void {
    this.cancelFlowStateAwareTimers();
    this.options.activateFlowIntent(currentUrl.includes('/task/') ? 'deeplink' : 'route');
    this.setActiveView('flow');
  }
}
