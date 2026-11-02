import {
  WorkspaceShellSignalEffectRegistrarController,
  type WorkspaceShellEffectRegistrar,
} from './workspace-shell-signal-effect-registrar.controller';
import { WorkspaceShellAndroidWidgetSignalEffectsController } from './workspace-shell-android-widget-signal-effects.controller';
import { WorkspaceShellFocusSyncSignalEffectsController } from './workspace-shell-focus-sync-signal-effects.controller';
import { WorkspaceShellHandoffSignalEffectsController } from './workspace-shell-handoff-signal-effects.controller';
import { WorkspaceShellSessionSyncSignalEffectsController } from './workspace-shell-session-sync-signal-effects.controller';
import { WorkspaceShellStartupRouteSignalEffectsController } from './workspace-shell-startup-route-signal-effects.controller';
import { WorkspaceShellStartupTierSignalEffectsController } from './workspace-shell-startup-tier-signal-effects.controller';
import { WorkspaceShellUiSignalEffectsController } from './workspace-shell-ui-signal-effects.controller';

export type { WorkspaceShellEffectRegistrar } from './workspace-shell-signal-effect-registrar.controller';

export interface WorkspaceShellSignalEffectsControllerOptions {
  registerEffect: WorkspaceShellEffectRegistrar;
  modalEffects: {
    syncRecoverableError(): void;
    syncLoginRequest(): void;
    syncMigrationRequest(): void;
  };
  dataProtectionReminder: { syncFromState(): void };
  launchSnapshotController: { sync(): void };
  routeUrl(): string | null | undefined;
  projects(): unknown;
  activeProjectId(): string | null;
  syncStateFromRoute(): void;
  captureAndroidWidgetBootstrapFromRoute(routeUrl: string | null): Promise<boolean>;
  syncAndroidWidgetBootstrapProcessing(): void;
  startupEntryIntentController: { sync(): void };
  handoffEffect: { sync(): void };
  isWorkspaceHandoffReady(): boolean;
  commitWorkspaceHandoff(): void;
  focusProbeController: { sync(): void };
  coreDataLoaded(): boolean;
  isStartupTierReady(tier: 'p1' | 'p2'): boolean;
  startupTierHydration: {
    markAuthReadyIfReady(): void;
    warmupInteractionIfReady(): void;
    startSyncHydrationIfReady(): void;
  };
  remoteCallbacks: { registerIfReady(): void };
  projectSubscription: { sync(): void };
  currentUserId(): string | null;
  destroyed(): boolean;
  focusEntrySyncPulse: {
    handleOwnerChange(ownerId: string | null): void;
  };
  syncPulseEffect: { sync(): void };
  sessionTransition: { setupSessionHandlers(): void };
  onEffectError?: (effect: string, error: unknown) => void;
  onAsyncEffectError?: (effect: string, error: unknown) => void;
}

function createSignalEffectRegistrar(
  options: WorkspaceShellSignalEffectsControllerOptions,
): WorkspaceShellSignalEffectRegistrarController {
  return new WorkspaceShellSignalEffectRegistrarController({
    registerEffect: options.registerEffect,
    onEffectError: options.onEffectError,
    onAsyncEffectError: options.onAsyncEffectError,
  });
}

function createStartupSignalEffectGroups(
  options: WorkspaceShellSignalEffectsControllerOptions,
  effectRegistrar: WorkspaceShellSignalEffectRegistrarController,
) {
  return {
    androidWidgetEffects: new WorkspaceShellAndroidWidgetSignalEffectsController({
      effectRegistrar,
      routeUrl: options.routeUrl,
      captureAndroidWidgetBootstrapFromRoute:
        options.captureAndroidWidgetBootstrapFromRoute,
      syncAndroidWidgetBootstrapProcessing:
        options.syncAndroidWidgetBootstrapProcessing,
    }),
    handoffSignalEffects: new WorkspaceShellHandoffSignalEffectsController({
      effectRegistrar,
      handoffEffect: options.handoffEffect,
      isWorkspaceHandoffReady: options.isWorkspaceHandoffReady,
      commitWorkspaceHandoff: options.commitWorkspaceHandoff,
    }),
    startupRouteEffects: new WorkspaceShellStartupRouteSignalEffectsController({
      effectRegistrar,
      launchSnapshotController: options.launchSnapshotController,
      routeUrl: options.routeUrl,
      projects: options.projects,
      activeProjectId: options.activeProjectId,
      syncStateFromRoute: options.syncStateFromRoute,
      startupEntryIntentController: options.startupEntryIntentController,
    }),
    startupTierEffects: new WorkspaceShellStartupTierSignalEffectsController({
      effectRegistrar,
      currentUserId: options.currentUserId,
      coreDataLoaded: options.coreDataLoaded,
      isStartupTierReady: options.isStartupTierReady,
      startupTierHydration: options.startupTierHydration,
    }),
  };
}

function createRuntimeSignalEffectGroups(
  options: WorkspaceShellSignalEffectsControllerOptions,
  effectRegistrar: WorkspaceShellSignalEffectRegistrarController,
) {
  return {
    focusSyncEffects: new WorkspaceShellFocusSyncSignalEffectsController({
      effectRegistrar,
      focusProbeController: options.focusProbeController,
      currentUserId: options.currentUserId,
      destroyed: options.destroyed,
      focusEntrySyncPulse: options.focusEntrySyncPulse,
      syncPulseEffect: options.syncPulseEffect,
    }),
    sessionSyncEffects: new WorkspaceShellSessionSyncSignalEffectsController({
      effectRegistrar,
      remoteCallbacks: options.remoteCallbacks,
      projectSubscription: options.projectSubscription,
      sessionTransition: options.sessionTransition,
    }),
    uiEffects: new WorkspaceShellUiSignalEffectsController({
      effectRegistrar,
      modalEffects: options.modalEffects,
      dataProtectionReminder: options.dataProtectionReminder,
    }),
  };
}

function createSignalEffectGroups(options: WorkspaceShellSignalEffectsControllerOptions) {
  const effectRegistrar = createSignalEffectRegistrar(options);
  return {
    ...createStartupSignalEffectGroups(options, effectRegistrar),
    ...createRuntimeSignalEffectGroups(options, effectRegistrar),
  };
}

export class WorkspaceShellSignalEffectsController {
  private readonly groups: ReturnType<typeof createSignalEffectGroups>;

  constructor(options: WorkspaceShellSignalEffectsControllerOptions) {
    this.groups = createSignalEffectGroups(options);
  }

  setup(): void {
    this.groups.uiEffects.setup();
    this.groups.startupRouteEffects.setupLaunchAndRoute();
    this.groups.androidWidgetEffects.setup();
    this.groups.startupRouteEffects.setupStartupEntryIntent();
    this.groups.handoffSignalEffects.setup();
    this.groups.focusSyncEffects.setupProbe();
    this.groups.startupTierEffects.setup();
    this.groups.sessionSyncEffects.setupEffects();
    this.groups.focusSyncEffects.setupOwnerAndSyncPulse();
    this.groups.sessionSyncEffects.setupSessionTransitionHandlers();
  }
}
