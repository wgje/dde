import { GlobalErrorHandler } from '../../../services/global-error-handler.service';
import {
  createWorkspaceShellDataProtectionReminderLazyLoadDelegate,
  type WorkspaceShellDataProtectionReminderLazyLoadDelegateOptions,
} from './workspace-shell-data-protection-reminder-lazy-load-delegate.factory';
import {
  createWorkspaceShellModalEffectsController,
  type WorkspaceShellModalEffectsFactoryOptions,
} from './workspace-shell-modal-effects.factory';
import type { WorkspaceShellRoutingSurface } from './workspace-shell-routing-surface.factory';
import {
  createWorkspaceShellSignalEffectsDelegate,
  type WorkspaceShellSignalEffectsOptionsFactoryOptions,
} from './workspace-shell-signal-effects-options.factory';

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
        WorkspaceShellSignalEffectsOptionsFactoryOptions['startupTierState']['isTierReady'];
    };
    readonly toast: WorkspaceShellDataProtectionReminderLazyLoadDelegateOptions['toast'];
  };

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
