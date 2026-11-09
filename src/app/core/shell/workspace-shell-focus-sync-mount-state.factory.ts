import { FEATURE_FLAGS } from '../../../config/feature-flags.config';
import { gateState } from '../../../state/focus-stores';
import { isLocalModeEnabled } from '../../../services/guards';

import { WorkspaceShellMountStateController } from './workspace-shell-mount-state.controller';
import type {
  WorkspaceShellFocusSyncControllersOptions,
} from './workspace-shell-focus-sync-controllers.factory';

export function createWorkspaceShellFocusSyncMountState(
  options: WorkspaceShellFocusSyncControllersOptions,
): WorkspaceShellMountStateController {
  return new WorkspaceShellMountStateController({
    currentUserId: () => options.userSession.currentUserId(),
    gateState: () => gateState(),
    hasPendingGateWork: () => options.focusStartupProbe.hasPendingGateWork(),
    isAuthConfigured: () => options.authService.isConfigured,
    isAuthLoading: () => options.authCoord.isAuthLoading(),
    isCheckingSession: () => options.authCoord.isCheckingSession(),
    isDeferredSyncStatusMountEnabled: () =>
      FEATURE_FLAGS.SYNC_STATUS_DEFERRED_MOUNT_V1,
    isLocalModeEnabled: () => isLocalModeEnabled(),
    isOnline: () => options.syncCoordinator.isOnline(),
    isStartupTierReady: tier => options.startupTier.isTierReady(tier),
    isThrottledFocusStartup: () =>
      FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1,
    offlineMode: () => options.syncCoordinator.offlineMode(),
    pendingActionsCount: () => options.syncCoordinator.pendingActionsCount(),
    syncError: () => options.syncCoordinator.syncError(),
  });
}

export function resetWorkspaceShellFocusModeIntentActivated(
  mountState: WorkspaceShellMountStateController,
): void {
  mountState.focusModeIntentActivated.set(
    !FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1,
  );
}
