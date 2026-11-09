import { inject, Injector } from '@angular/core';

import { ActionQueueService } from '../../../services/action-queue.service';
import { AppLifecycleOrchestratorService } from '../../../services/app-lifecycle-orchestrator.service';
import { AuthService } from '../../../services/auth.service';
import { BeforeUnloadManagerService } from '../../../services/before-unload-manager.service';
import { BeforeUnloadGuardService } from '../../../services/guards';
import { BootStageService } from '../../../services/boot-stage.service';
import { EventBusService } from '../../../services/event-bus.service';
import { FocusPreferenceService } from '../../../services/focus-preference.service';
import { HandoffCoordinatorService } from '../../../services/handoff-coordinator.service';
import { ModalService } from '../../../services/modal.service';
import { NetworkAwarenessService } from '../../../services/network-awareness.service';
import { PreferenceService } from '../../../services/preference.service';
import { ProjectStateService } from '../../../services/project-state.service';
import { SentryLazyLoaderService } from '../../../services/sentry-lazy-loader.service';
import { StartupTierOrchestratorService } from '../../../services/startup-tier-orchestrator.service';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { ToastService } from '../../../services/toast.service';
import { UiStateService } from '../../../services/ui-state.service';
import { UndoService } from '../../../services/undo.service';
import { UserSessionService } from '../../../services/user-session.service';
import { WidgetBindingService } from '../../../services/widget-binding.service';
import { WorkspaceModalCoordinatorService } from '../../../services/workspace-modal-coordinator.service';
import { AppAuthCoordinatorService } from '../services/app-auth-coordinator.service';
import { AppProjectCoordinatorService } from '../services/app-project-coordinator.service';
import { TaskStore } from '../state/stores';
import {
  createWorkspaceShellGraphRuntimeContext,
  type WorkspaceShellGraphRuntimeContext,
} from './workspace-shell-graph-runtime-context.factory';

export interface WorkspaceShellGraphContext extends WorkspaceShellGraphRuntimeContext {
  readonly actionQueue: ActionQueueService;
  readonly appLifecycle: AppLifecycleOrchestratorService;
  readonly authCoord: AppAuthCoordinatorService;
  readonly authService: AuthService;
  readonly beforeUnloadGuard: BeforeUnloadGuardService;
  readonly beforeUnloadManager: BeforeUnloadManagerService;
  readonly bootStage: BootStageService;
  readonly eventBus: EventBusService;
  readonly focusPrefs: FocusPreferenceService;
  readonly handoffCoordinator: HandoffCoordinatorService;
  readonly injector: Injector;
  readonly modal: ModalService;
  readonly modalCoord: WorkspaceModalCoordinatorService;
  readonly networkAwareness: NetworkAwarenessService;
  readonly preferenceService: PreferenceService;
  readonly projectCoord: AppProjectCoordinatorService;
  readonly projectState: ProjectStateService;
  readonly sentryLazyLoader: SentryLazyLoaderService;
  readonly startupTier: StartupTierOrchestratorService;
  readonly supabaseClient: SupabaseClientService;
  readonly syncCoordinator: SyncCoordinatorService;
  readonly taskStore: TaskStore;
  readonly toast: ToastService;
  readonly uiState: UiStateService;
  readonly undoService: UndoService;
  readonly userSession: UserSessionService;
  readonly widgetBinding: WidgetBindingService;
}

export function createWorkspaceShellGraphContext(): WorkspaceShellGraphContext {
  const runtimeContext = createWorkspaceShellGraphRuntimeContext();

  return {
    ...runtimeContext,
    actionQueue: inject(ActionQueueService),
    appLifecycle: inject(AppLifecycleOrchestratorService),
    authCoord: inject(AppAuthCoordinatorService),
    authService: inject(AuthService),
    beforeUnloadGuard: inject(BeforeUnloadGuardService),
    beforeUnloadManager: inject(BeforeUnloadManagerService),
    bootStage: inject(BootStageService),
    eventBus: inject(EventBusService),
    focusPrefs: inject(FocusPreferenceService),
    handoffCoordinator: inject(HandoffCoordinatorService),
    injector: inject(Injector),
    modal: inject(ModalService),
    modalCoord: inject(WorkspaceModalCoordinatorService),
    networkAwareness: inject(NetworkAwarenessService),
    preferenceService: inject(PreferenceService),
    projectCoord: inject(AppProjectCoordinatorService),
    projectState: inject(ProjectStateService),
    sentryLazyLoader: inject(SentryLazyLoaderService),
    startupTier: inject(StartupTierOrchestratorService),
    supabaseClient: inject(SupabaseClientService),
    syncCoordinator: inject(SyncCoordinatorService),
    taskStore: inject(TaskStore),
    toast: inject(ToastService),
    uiState: inject(UiStateService),
    undoService: inject(UndoService),
    userSession: inject(UserSessionService),
    widgetBinding: inject(WidgetBindingService),
  };
}
