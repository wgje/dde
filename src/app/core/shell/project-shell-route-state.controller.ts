import type { ActivatedRoute, Router } from '@angular/router';

import {
  shouldDegradeMobileStartupRoute,
  type HandoffCoordinatorService,
  type HandoffResult,
} from '../../../services/handoff-coordinator.service';
import type { LaunchSnapshot } from '../../../models/launch-shell';
import { resolveStartupEntryIntent } from '../../../utils/startup-entry-intent';

type StartupEntryIntent = ReturnType<typeof resolveStartupEntryIntent>;

export interface ProjectShellRouteState {
  projectId?: string;
  taskId?: string;
  currentUrl: string;
  startupEntryIntent: StartupEntryIntent;
  handoffResult: HandoffResult;
  degradeMobileStartupRoute: boolean;
}

export interface ProjectShellRouteStateControllerOptions {
  route: Pick<ActivatedRoute, 'snapshot'>;
  router: Pick<Router, 'url'>;
  handoffCoordinator: Pick<HandoffCoordinatorService, 'result'>;
  startupLaunchSnapshot: Pick<
    LaunchSnapshot,
    'routeIntent' | 'mobileDegraded' | 'degradeReason'
  > | null;
  snapshotHandoffEnabled: boolean;
  isMobile(): boolean;
}

export class ProjectShellRouteStateController {
  private startupRouteDecisionResolved = false;

  constructor(private readonly options: ProjectShellRouteStateControllerOptions) {}

  resolveRouteChangeState(): ProjectShellRouteState {
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

  markStartupRouteDecisionResolved(): void {
    this.startupRouteDecisionResolved = true;
  }

  private matchesStartupSnapshotIntent(
    startupEntryIntent: StartupEntryIntent,
    projectId: string | undefined,
    taskId: string | undefined,
    currentUrl: string,
  ): boolean {
    const snapshotRouteIntent = startupEntryIntent
      ? null
      : this.options.startupLaunchSnapshot?.routeIntent;
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
    if (!this.options.snapshotHandoffEnabled
      || this.startupRouteDecisionResolved
      || startupEntryIntent) {
      return false;
    }

    return handoffResult.kind === 'degraded-to-text'
      || (this.options.startupLaunchSnapshot?.mobileDegraded === true
        && snapshotMatchesCurrentRoute)
      || shouldDegradeMobileStartupRoute(currentUrl, this.options.isMobile());
  }
}
