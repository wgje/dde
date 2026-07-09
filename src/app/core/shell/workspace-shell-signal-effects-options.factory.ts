import { effect, type Injector } from '@angular/core';

import {
  createWorkspaceShellSignalEffectsDelegates,
  type WorkspaceShellSignalEffectsDelegatesOptions,
} from './workspace-shell-signal-effects-delegates.factory';
import type {
  WorkspaceShellFocusSyncControllers,
} from './workspace-shell-focus-sync-controllers.factory';
import type {
  WorkspaceShellSessionLaunchControllers,
} from './workspace-shell-session-launch.factory';
import type {
  WorkspaceShellRoutingSurface,
} from './workspace-shell-routing-surface.factory';
import {
  createWorkspaceShellDataProtectionReminderLazyLoadDelegate,
  type WorkspaceShellDataProtectionReminderLazyLoadDelegateOptions,
} from './workspace-shell-data-protection-reminder-lazy-load-delegate.factory';
import { GlobalErrorHandler } from '../../../services/global-error-handler.service';
import {
  createWorkspaceShellModalEffectsController,
  type WorkspaceShellModalEffectsFactoryOptions,
} from './workspace-shell-modal-effects.factory';

export interface WorkspaceShellSignalEffectsStartupEntryControllers {
  readonly androidWidgetLazyLoad:
    WorkspaceShellSignalEffectsDelegatesOptions['runtime']['androidWidgetLazyLoad'];
  readonly startupEntryIntentController:
    WorkspaceShellSignalEffectsDelegatesOptions['startupEntryIntent'];
}

type WorkspaceShellSignalEffectsFocusSyncControllers = Pick<
  WorkspaceShellFocusSyncControllers,
  | 'focusEntrySyncPulse'
  | 'focusProbeController'
  | 'mountState'
  | 'startupTierHydration'
  | 'syncPulseLifecycle'
>;

export interface WorkspaceShellSignalEffectsOptionsFactoryOptions {
  injector: Injector;
  registerEffect?: WorkspaceShellSignalEffectsDelegatesOptions['registerEffect'];
  modalEffects: WorkspaceShellSignalEffectsDelegatesOptions['modalEffects'];
  dataProtectionReminder:
    WorkspaceShellSignalEffectsDelegatesOptions['dataProtectionReminder'];
  sessionLaunchControllers: Pick<
    WorkspaceShellSessionLaunchControllers,
    'launchSnapshotController' | 'sessionTransition'
  >;
  routeUrl: WorkspaceShellSignalEffectsDelegatesOptions['route']['routeState']['routeUrl'];
  projectState: WorkspaceShellSignalEffectsDelegatesOptions['route']['projectState'];
  routeSyncController:
    WorkspaceShellSignalEffectsDelegatesOptions['route']['routeSyncController'];
  startupEntryControllers: WorkspaceShellSignalEffectsStartupEntryControllers;
  handoffControllers: {
    readonly effect:
      WorkspaceShellSignalEffectsDelegatesOptions['handoff']['effect'];
    readonly readiness:
      WorkspaceShellSignalEffectsDelegatesOptions['handoff']['readiness'];
  };
  bootStage: WorkspaceShellSignalEffectsDelegatesOptions['handoff']['bootStage'];
  focusSyncControllers: WorkspaceShellSignalEffectsFocusSyncControllers;
  startupTierState: Pick<
    WorkspaceShellSignalEffectsDelegatesOptions['startupTierState'],
    'isTierReady'
  >;
  remoteCallbacks:
    WorkspaceShellSignalEffectsDelegatesOptions['remoteCallbackRegistration'];
  projectSubscription:
    WorkspaceShellSignalEffectsDelegatesOptions['projectSubscription'];
  destroyed: WorkspaceShellSignalEffectsDelegatesOptions['isDestroyed'];
  userSession:
    WorkspaceShellSignalEffectsDelegatesOptions['session']['userSession'];
  warn: WorkspaceShellSignalEffectsDelegatesOptions['warn'];
  createSignalEffectsLazyLoadDelegate?:
    WorkspaceShellSignalEffectsDelegatesOptions['createSignalEffectsLazyLoadDelegate'];
  createSignalEffectsLazyLoadHost?:
    WorkspaceShellSignalEffectsDelegatesOptions['createSignalEffectsLazyLoadHost'];
  createSignalEffectsController?:
    WorkspaceShellSignalEffectsDelegatesOptions['createSignalEffectsController'];
}

export type WorkspaceShellSignalEffectsSurfaceOptions =
  Omit<
    WorkspaceShellSignalEffectsOptionsFactoryOptions,
    | 'dataProtectionReminder'
    | 'modalEffects'
    | 'routeUrl'
    | 'routeSyncController'
    | 'startupTierState'
  > & {
    readonly dataProtectionReminder?: Pick<
      WorkspaceShellDataProtectionReminderLazyLoadDelegateOptions,
      'createDataProtectionReminderController'
    >;
    readonly lazyServiceRefs: {
      readonly exportService:
        WorkspaceShellDataProtectionReminderLazyLoadDelegateOptions['exportService'];
    };
    readonly modal: WorkspaceShellModalEffectsFactoryOptions['modal'];
    readonly modalCoord: WorkspaceShellModalEffectsFactoryOptions['modalCoord'];
    readonly routing: Pick<
      WorkspaceShellRoutingSurface,
      'routeUrl' | 'routeSyncController'
    >;
    readonly startupTier: {
      isTierReady:
        WorkspaceShellSignalEffectsDelegatesOptions['startupTierState']['isTierReady'];
    };
    readonly toast: WorkspaceShellDataProtectionReminderLazyLoadDelegateOptions['toast'];
  };

type OptionalSignalEffectsFactories = Pick<
  WorkspaceShellSignalEffectsDelegatesOptions,
  | 'createSignalEffectsLazyLoadDelegate'
  | 'createSignalEffectsLazyLoadHost'
  | 'createSignalEffectsController'
>;

function createOptionalSignalEffectsFactories(
  options: WorkspaceShellSignalEffectsOptionsFactoryOptions,
): Partial<OptionalSignalEffectsFactories> {
  return {
    ...(options.createSignalEffectsLazyLoadDelegate
      ? {
        createSignalEffectsLazyLoadDelegate:
          options.createSignalEffectsLazyLoadDelegate,
      }
      : {}),
    ...(options.createSignalEffectsLazyLoadHost
      ? { createSignalEffectsLazyLoadHost: options.createSignalEffectsLazyLoadHost }
      : {}),
    ...(options.createSignalEffectsController
      ? { createSignalEffectsController: options.createSignalEffectsController }
      : {}),
  };
}

export function createWorkspaceShellSignalEffectsOptions(
  options: WorkspaceShellSignalEffectsOptionsFactoryOptions,
): WorkspaceShellSignalEffectsDelegatesOptions {
  return {
    registerEffect: options.registerEffect ?? (callback => {
      effect(callback, { injector: options.injector });
    }),
    modalEffects: options.modalEffects,
    dataProtectionReminder: options.dataProtectionReminder,
    launchSnapshotController:
      options.sessionLaunchControllers.launchSnapshotController,
    route: {
      routeState: { routeUrl: options.routeUrl },
      projectState: options.projectState,
      routeSyncController: options.routeSyncController,
    },
    runtime: {
      androidWidgetLazyLoad: options.startupEntryControllers.androidWidgetLazyLoad,
    },
    startupEntryIntent:
      options.startupEntryControllers.startupEntryIntentController,
    handoff: {
      effect: options.handoffControllers.effect,
      bootStage: options.bootStage,
      readiness: options.handoffControllers.readiness,
    },
    focus: {
      probe: options.focusSyncControllers.focusProbeController,
      entryPulse: options.focusSyncControllers.focusEntrySyncPulse,
    },
    startupTierState: {
      coreDataLoaded: () =>
        options.focusSyncControllers.mountState.coreDataLoaded(),
      isTierReady: options.startupTierState.isTierReady,
    },
    startupTier: options.focusSyncControllers.startupTierHydration,
    remoteCallbackRegistration: options.remoteCallbacks,
    projectSubscription: options.projectSubscription,
    isDestroyed: options.destroyed,
    syncPulse: options.focusSyncControllers.syncPulseLifecycle,
    session: {
      userSession: options.userSession,
      transition: options.sessionLaunchControllers.sessionTransition,
    },
    warn: options.warn,
    ...createOptionalSignalEffectsFactories(options),
  };
}

export function createWorkspaceShellSignalEffectsDelegate(
  options: WorkspaceShellSignalEffectsOptionsFactoryOptions,
): ReturnType<typeof createWorkspaceShellSignalEffectsDelegates> {
  return createWorkspaceShellSignalEffectsDelegates(
    createWorkspaceShellSignalEffectsOptions(options),
  );
}

export function createWorkspaceShellSignalEffectsSurface(
  options: WorkspaceShellSignalEffectsSurfaceOptions,
): ReturnType<typeof createWorkspaceShellSignalEffectsDelegate> {
  const errorHandler = options.injector.get(GlobalErrorHandler);

  return createWorkspaceShellSignalEffectsDelegate({
    ...options,
    modalEffects: createWorkspaceShellModalEffectsController({
      errorHandler,
      modal: options.modal,
      modalCoord: options.modalCoord,
      warn: options.warn,
    }),
    dataProtectionReminder:
      createWorkspaceShellDataProtectionReminderLazyLoadDelegate({
        userSession: options.userSession,
        exportService: options.lazyServiceRefs.exportService,
        toast: options.toast,
        ...options.dataProtectionReminder,
        warn: options.warn,
      }),
    routeUrl: options.routing.routeUrl,
    routeSyncController: options.routing.routeSyncController,
    startupTierState: {
      isTierReady: tier => options.startupTier.isTierReady(tier),
    },
  });
}
