import {
  createWorkspaceShellSignalEffectsLazyLoadDelegate,
  type WorkspaceShellSignalEffectsLazyLoadDelegate,
  type WorkspaceShellSignalEffectsLazyLoadDelegateOptions,
} from './workspace-shell-signal-effects-lazy-load-delegate.factory';

export interface WorkspaceShellSignalEffectsDelegatesOptions {
  registerEffect: WorkspaceShellSignalEffectsLazyLoadDelegateOptions['registerEffect'];
  modalEffects: WorkspaceShellSignalEffectsLazyLoadDelegateOptions['modalEffects'];
  dataProtectionReminder:
    WorkspaceShellSignalEffectsLazyLoadDelegateOptions['dataProtectionReminder'];
  launchSnapshotController:
    WorkspaceShellSignalEffectsLazyLoadDelegateOptions['launchSnapshotController'];
  route: {
    routeState: {
      routeUrl(): string;
    };
    projectState: {
      projects(): unknown;
      activeProjectId(): string | null;
    };
    routeSyncController: { syncStateFromRoute(): void };
  };
  runtime: {
    androidWidgetLazyLoad: {
      captureFromRoute(routeUrl: string | null): Promise<boolean>;
      syncProcessing(): void;
    };
  };
  startupEntryIntent:
    WorkspaceShellSignalEffectsLazyLoadDelegateOptions['startupEntryIntentController'];
  handoff: {
    effect: WorkspaceShellSignalEffectsLazyLoadDelegateOptions['handoffEffect'];
    bootStage: { isWorkspaceHandoffReady(): boolean };
    readiness: { commitWorkspaceHandoffIfReady(): void };
  };
  focus: {
    probe:
      WorkspaceShellSignalEffectsLazyLoadDelegateOptions['focusProbeController'];
    entryPulse:
      WorkspaceShellSignalEffectsLazyLoadDelegateOptions['focusEntrySyncPulse'];
  };
  startupTierState: {
    coreDataLoaded:
      NonNullable<WorkspaceShellSignalEffectsLazyLoadDelegateOptions['coreDataLoaded']>;
    isTierReady:
      NonNullable<WorkspaceShellSignalEffectsLazyLoadDelegateOptions['isStartupTierReady']>;
  };
  startupTier:
    WorkspaceShellSignalEffectsLazyLoadDelegateOptions['startupTierHydration'];
  remoteCallbackRegistration:
    WorkspaceShellSignalEffectsLazyLoadDelegateOptions['remoteCallbacks'];
  projectSubscription:
    WorkspaceShellSignalEffectsLazyLoadDelegateOptions['projectSubscription'];
  isDestroyed: WorkspaceShellSignalEffectsLazyLoadDelegateOptions['destroyed'];
  syncPulse:
    WorkspaceShellSignalEffectsLazyLoadDelegateOptions['syncPulseEffect'];
  session: {
    userSession: { currentUserId(): string | null };
    transition:
      WorkspaceShellSignalEffectsLazyLoadDelegateOptions['sessionTransition'];
  };
  warn: WorkspaceShellSignalEffectsLazyLoadDelegateOptions['warn'];
  createSignalEffectsLazyLoadDelegate?: (
    options: WorkspaceShellSignalEffectsLazyLoadDelegateOptions,
  ) => WorkspaceShellSignalEffectsLazyLoadDelegate;
  createSignalEffectsLazyLoadHost?:
    WorkspaceShellSignalEffectsLazyLoadDelegateOptions['createSignalEffectsLazyLoadHost'];
  createSignalEffectsController?:
    WorkspaceShellSignalEffectsLazyLoadDelegateOptions['createSignalEffectsController'];
}

function createSignalEffectErrorHandlers(
  warn: WorkspaceShellSignalEffectsDelegatesOptions['warn'],
): Pick<
  WorkspaceShellSignalEffectsLazyLoadDelegateOptions,
  'onEffectError' | 'onAsyncEffectError'
> {
  return {
    onEffectError: (effect, error) => {
      warn('Workspace shell signal effect 执行失败', { effect, error });
    },
    onAsyncEffectError: (effect, error) => {
      warn('Workspace shell signal effect 异步执行失败', { effect, error });
    },
  };
}

export function createWorkspaceShellSignalEffectsDelegates(
  options: WorkspaceShellSignalEffectsDelegatesOptions,
): WorkspaceShellSignalEffectsLazyLoadDelegate {
  const createDelegate =
    options.createSignalEffectsLazyLoadDelegate
    ?? createWorkspaceShellSignalEffectsLazyLoadDelegate;

  return createDelegate({
    registerEffect: options.registerEffect,
    modalEffects: options.modalEffects,
    dataProtectionReminder: options.dataProtectionReminder,
    launchSnapshotController: options.launchSnapshotController,
    routeUrl: () => options.route.routeState.routeUrl(),
    projects: () => options.route.projectState.projects(),
    activeProjectId: () => options.route.projectState.activeProjectId(),
    syncStateFromRoute: () =>
      options.route.routeSyncController.syncStateFromRoute(),
    captureAndroidWidgetBootstrapFromRoute: routeUrl =>
      options.runtime.androidWidgetLazyLoad.captureFromRoute(routeUrl),
    syncAndroidWidgetBootstrapProcessing: () =>
      options.runtime.androidWidgetLazyLoad.syncProcessing(),
    startupEntryIntentController: options.startupEntryIntent,
    handoffEffect: options.handoff.effect,
    isWorkspaceHandoffReady: () =>
      options.handoff.bootStage.isWorkspaceHandoffReady(),
    commitWorkspaceHandoff: () =>
      options.handoff.readiness.commitWorkspaceHandoffIfReady(),
    focusProbeController: options.focus.probe,
    coreDataLoaded: options.startupTierState.coreDataLoaded,
    isStartupTierReady: options.startupTierState.isTierReady,
    startupTierHydration: options.startupTier,
    remoteCallbacks: options.remoteCallbackRegistration,
    projectSubscription: options.projectSubscription,
    currentUserId: () => options.session.userSession.currentUserId(),
    destroyed: options.isDestroyed,
    focusEntrySyncPulse: options.focus.entryPulse,
    syncPulseEffect: options.syncPulse,
    sessionTransition: options.session.transition,
    ...createSignalEffectErrorHandlers(options.warn),
    warn: options.warn,
    ...(options.createSignalEffectsLazyLoadHost
      ? { createSignalEffectsLazyLoadHost: options.createSignalEffectsLazyLoadHost }
      : {}),
    ...(options.createSignalEffectsController
      ? { createSignalEffectsController: options.createSignalEffectsController }
      : {}),
  });
}
