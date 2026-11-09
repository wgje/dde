import type { Injector } from '@angular/core';

import type { SyncPulseReason } from '../../../services/sync-pulse-engine.service';

import type {
  WorkspaceShellFocusEntrySyncPulseResult,
} from './workspace-shell-focus-entry-sync-pulse.controller';
import {
  createWorkspaceShellFocusSyncMountState,
} from './workspace-shell-focus-sync-mount-state.factory';
import { createWorkspaceShellFocusSyncDelegates } from './workspace-shell-focus-sync-delegates.factory';
import { createWorkspaceShellFocusSyncLazyHost } from './workspace-shell-focus-sync-lazy-host.factory';
import type { WorkspaceShellMountStateController } from './workspace-shell-mount-state.controller';

export interface WorkspaceShellFocusSyncControllersOptions {
  authCoord: {
    isCheckingSession(): boolean;
    isAuthLoading(): boolean;
  };
  authService: {
    readonly isConfigured: boolean;
  };
  userSession: { currentUserId(): string | null };
  focusStartupProbe: {
    hasPendingGateWork(): boolean;
    checkGateForProjectEntry(): unknown;
    warmProjectEntryGateSnapshot(): void;
    initialize(): void;
  };
  syncCoordinator: {
    pendingActionsCount(): number;
    offlineMode(): boolean;
    isOnline(): boolean;
    syncError(): unknown;
    initialize(): void;
  };
  startupTier: {
    isTierReady(tier: 'p0' | 'p1' | 'p2'): boolean;
    markAuthReady(): void;
  };
  getWindow?: () => Window | undefined;
  isDestroyed: () => boolean;
  appLifecycle: {
    isResuming(): boolean;
    isRecoveryCompensationInFlight(): boolean;
    getCurrentRecoveryTicket(): unknown;
  };
  injector: Injector;
  isMobile: () => boolean;
  sidebarToolsLazyLoad: {
    preloadFocusModeAssets(reason: 'intent'): Promise<void>;
    preload(reason: 'p1'): void;
  };
  startupEntryControllers: () => {
    readonly startupEntryIntentController: {
      flushWidgetWorkspaceGateRecheck(): void;
    };
  };
  taskOpsAdapter: { warmup(): Promise<unknown> };
  simpleSync: { startRuntime(): void };
  warn: (message: string, error: unknown) => void;
}

export type WorkspaceShellResolvedFocusSyncControllersOptions =
  Omit<WorkspaceShellFocusSyncControllersOptions, 'startupEntryControllers'> & {
    getWindow: () => Window | undefined;
    flushWidgetWorkspaceGateRecheck: () => void;
  };

export interface WorkspaceShellFocusMountIntentDelegate {
  setup(): void;
  teardown(): void;
}

export interface WorkspaceShellFocusEntrySyncPulseDelegate {
  clearRetry(): void;
  dispatchIfReady(): void;
  handleOwnerChange(ownerId: string | null): void;
  reset(rearmIntentListener?: boolean): void;
}

export interface WorkspaceShellSyncPulseLifecycleDelegate {
  clearFocusEntrySyncPulseRetry(): void;
  destroy(): void;
  dispatchFocusEntrySyncPulseIfReady(): void;
  initialize(): void;
  isReady(): boolean;
  resetFocusEntrySyncPulse(rearmIntentListener?: boolean): void;
  sync(): void;
  syncEffect(): void;
  trigger(reason: SyncPulseReason): Promise<WorkspaceShellFocusEntrySyncPulseResult | null>;
}

export interface WorkspaceShellMobileFocusGateDelegate {
  checkGateForMobileProjectEntry(): void;
  flushPendingMobileProjectGateCheck(): void;
  warmMobileProjectGateSnapshot(): void;
}

export interface WorkspaceShellFocusProbeDelegate {
  sync(): void;
}

export interface WorkspaceShellStartupTierHydrationDelegate {
  markAuthReadyIfReady(): void;
  startSyncHydrationIfReady(): void;
  warmupInteractionIfReady(): void;
}

export interface WorkspaceShellFocusSyncControllerHosts {
  focusMountIntent: WorkspaceShellFocusMountIntentDelegate;
  focusEntrySyncPulse: WorkspaceShellFocusEntrySyncPulseDelegate;
  syncPulseLifecycle: WorkspaceShellSyncPulseLifecycleDelegate;
  mobileFocusGate: WorkspaceShellMobileFocusGateDelegate;
  focusProbeController: WorkspaceShellFocusProbeDelegate;
  startupTierHydration: WorkspaceShellStartupTierHydrationDelegate;
}

export interface WorkspaceShellFocusSyncControllers
  extends WorkspaceShellFocusSyncControllerHosts {
  mountState: WorkspaceShellMountStateController;
}

export function createWorkspaceShellFocusSyncControllers(
  options: WorkspaceShellFocusSyncControllersOptions,
): WorkspaceShellFocusSyncControllers {
  const mountState = createWorkspaceShellFocusSyncMountState(options);

  return createWorkspaceShellFocusSyncControllersWithMountState(options, mountState);
}

export function createWorkspaceShellFocusSyncControllersWithMountState(
  options: WorkspaceShellFocusSyncControllersOptions,
  mountState: WorkspaceShellMountStateController,
): WorkspaceShellFocusSyncControllers {
  const resolvedOptions = resolveFocusSyncControllersOptions(options);
  const lazyHosts = createWorkspaceShellFocusSyncLazyHost(resolvedOptions, mountState);

  return {
    mountState,
    ...createWorkspaceShellFocusSyncDelegates({ lazyHosts, mountState }),
  };
}

function resolveFocusSyncControllersOptions(
  options: WorkspaceShellFocusSyncControllersOptions,
): WorkspaceShellResolvedFocusSyncControllersOptions {
  return {
    ...options,
    getWindow: options.getWindow ?? readBrowserWindow,
    flushWidgetWorkspaceGateRecheck: () =>
      options.startupEntryControllers().startupEntryIntentController
        .flushWidgetWorkspaceGateRecheck(),
  };
}

function readBrowserWindow(): Window | undefined {
  return typeof window === 'undefined' ? undefined : window;
}
