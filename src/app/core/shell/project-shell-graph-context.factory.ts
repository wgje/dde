import {
  DestroyRef,
  Injector,
  inject,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import { DockEngineService } from '../../../services/dock-engine.service';
import { HandoffCoordinatorService } from '../../../services/handoff-coordinator.service';
import { LaunchSnapshotService } from '../../../services/launch-snapshot.service';
import { LoggerService } from '../../../services/logger.service';
import { ProjectStateService } from '../../../services/project-state.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { TabSyncService } from '../../../services/tab-sync.service';
import { TaskOperationAdapterService } from '../../../services/task-operation-adapter.service';
import { ToastService } from '../../../services/toast.service';
import { UiStateService } from '../../../services/ui-state.service';
import { UserSessionService } from '../../../services/user-session.service';
import { FlowCommandService } from '../../features/flow/services/flow-command.service';

export interface ProjectShellGraphContext {
  destroyRef: DestroyRef;
  dockEngine: DockEngineService;
  flowCommand: FlowCommandService;
  flowIntentLazyLoadEnabled: boolean;
  flowStateAwareRestoreEnabled: boolean;
  handoffCoordinator: HandoffCoordinatorService;
  injector: Injector;
  logger: ReturnType<LoggerService['category']>;
  projectState: ProjectStateService;
  route: ActivatedRoute;
  router: Router;
  startupLaunchSnapshot: ReturnType<LaunchSnapshotService['read']>;
  syncCoordinator: SyncCoordinatorService;
  tabSync: TabSyncService;
  taskOpsAdapter: Pick<TaskOperationAdapterService, 'addFloatingTask'>;
  toast: ToastService;
  uiState: UiStateService;
  userSession: UserSessionService;
}

export function createProjectShellGraphContext(): ProjectShellGraphContext {
  const injector = inject(Injector);
  const launchSnapshot = inject(LaunchSnapshotService);

  return {
    destroyRef: inject(DestroyRef),
    dockEngine: inject(DockEngineService),
    flowCommand: inject(FlowCommandService),
    flowIntentLazyLoadEnabled: FEATURE_FLAGS.FLOW_INTENT_LAZYLOAD_V1,
    flowStateAwareRestoreEnabled: FEATURE_FLAGS.FLOW_STATE_AWARE_RESTORE_V2,
    handoffCoordinator: inject(HandoffCoordinatorService),
    injector,
    logger: inject(LoggerService).category('ProjectShell'),
    projectState: inject(ProjectStateService),
    route: inject(ActivatedRoute),
    router: inject(Router),
    startupLaunchSnapshot: launchSnapshot.read(),
    syncCoordinator: inject(SyncCoordinatorService),
    tabSync: inject(TabSyncService),
    taskOpsAdapter: {
      addFloatingTask: (...args) =>
        injector.get(TaskOperationAdapterService).addFloatingTask(...args),
    },
    toast: inject(ToastService),
    uiState: inject(UiStateService),
    userSession: inject(UserSessionService),
  };
}
