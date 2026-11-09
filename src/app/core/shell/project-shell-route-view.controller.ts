import type { LaunchSnapshot } from '../../../models/launch-shell';
import type { ProjectShellTaskDeepLinkRouteResult } from './project-shell-task-deep-link.controller';
import type { ProjectShellRouteState } from './project-shell-route-state.controller';

export interface ProjectShellRouteViewControllerOptions {
  activateFlowIntent(source: 'route' | 'deeplink'): void;
  flowRestore: {
    applyStateAwareFlowRestore(currentUrl: string, projectId?: string): void;
    cancelFlowStateAwareTimers(): void;
    setActiveView(view: 'text' | 'flow'): void;
  };
  projectState: {
    activeProjectId(): string | null;
    projects(): Array<{ id: string }>;
  };
  startupLaunchSnapshot: Pick<LaunchSnapshot, 'degradeReason'> | null;
  toast: {
    info(title: string, message: string): void;
  };
  userSession: {
    switchActiveProject(projectId: string): void;
  };
}

export class ProjectShellRouteViewController {
  constructor(private readonly options: ProjectShellRouteViewControllerOptions) {}

  applyResolvedRouteView(
    routeState: ProjectShellRouteState,
    taskDeepLinkResult: ProjectShellTaskDeepLinkRouteResult | null,
  ): void {
    if (routeState.degradeMobileStartupRoute) {
      this.applyDegradedStartupRoute(routeState);
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
      this.options.flowRestore.cancelFlowStateAwareTimers();
      this.options.flowRestore.setActiveView('text');
      return;
    }

    this.options.flowRestore.applyStateAwareFlowRestore(
      routeState.currentUrl,
      routeState.projectId,
    );
  }

  private applyDegradedStartupRoute(routeState: ProjectShellRouteState): void {
    this.options.flowRestore.cancelFlowStateAwareTimers();
    this.options.flowRestore.setActiveView('text');
    this.options.toast.info('已切换到文本视图', this.resolveStartupDegradeMessage());
    this.switchToFallbackProjectIfNeeded(routeState);
  }

  private resolveStartupDegradeMessage(): string {
    return this.options.startupLaunchSnapshot?.degradeReason === 'mobile-default-text'
      ? '手机端启动默认进入文本视图，可稍后手动切换流程图'
      : '启动阶段已回退到更稳定的文本视图';
  }

  private switchToFallbackProjectIfNeeded(routeState: ProjectShellRouteState): void {
    if (routeState.handoffResult.kind !== 'degraded-to-project'
      || this.options.projectState.activeProjectId()) {
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
    this.options.flowRestore.cancelFlowStateAwareTimers();
    this.options.activateFlowIntent(currentUrl.includes('/task/') ? 'deeplink' : 'route');
    this.options.flowRestore.setActiveView('flow');
  }
}
