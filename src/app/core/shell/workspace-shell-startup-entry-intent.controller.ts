import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';
import {
  resolveConsumedStartupEntryNavigation,
  type ConsumedStartupEntryNavigationCommands,
} from './workspace-shell-startup-route.helpers';
import { WorkspaceShellStartupEntryActionController } from './workspace-shell-startup-entry-action.controller';
import { WorkspaceShellStartupEntryIntentSyncController } from './workspace-shell-startup-entry-intent-sync.controller';
import { WorkspaceShellStartupQueryCleanupController } from './workspace-shell-startup-query-cleanup.controller';
import { WorkspaceShellStartupWidgetGateMutationEffectController } from './workspace-shell-startup-widget-gate-mutation-effect.controller';
import { WorkspaceShellWidgetWorkspaceGateController } from './workspace-shell-widget-workspace-gate.controller';

export interface WorkspaceShellStartupEntryIntentControllerOptions {
  routeUrl: () => string;
  currentStartupEntryIntent: () => StartupEntryIntent | null;
  deferredStartupEntryIntent: () => StartupEntryIntent | null;
  currentUserId: () => string | null;
  isApplicationReady: () => boolean;
  isBlackBoxEnabled: () => boolean;
  setSidebarOpen: (open: boolean) => void;
  activateSidebarTools?: () => void;
  preloadSidebarTools: (reason: 'intent') => void;
  loadBlackBoxRecorder: () => Promise<void> | void;
  applyWidgetGateMutation: (input: {
    intent: 'mark-gate-read' | 'mark-gate-complete';
    widgetGateEntryId: string | null;
  }) => Promise<unknown> | unknown;
  primeWidgetWorkspaceGateSync: () => void;
  refreshFocusSessionFromCloud: (userId: string | null) => unknown;
  recheckGate: (options: { source: 'widget-open-workspace'; reloadLocal: false }) => Promise<void> | void;
  clearDeferredStartupEntryIntent: () => void;
  resolveMobileRootProjectId: () => string | null;
  navigate: (
    commands: ConsumedStartupEntryNavigationCommands,
    options: { replaceUrl: true },
  ) => Promise<unknown> | unknown;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellStartupEntryIntentController {
  private readonly startupEntryAction: WorkspaceShellStartupEntryActionController;
  private readonly syncController: WorkspaceShellStartupEntryIntentSyncController;
  private readonly startupQueryCleanup: WorkspaceShellStartupQueryCleanupController;
  private readonly widgetWorkspaceGate: WorkspaceShellWidgetWorkspaceGateController;

  constructor(private readonly options: WorkspaceShellStartupEntryIntentControllerOptions) {
    this.startupQueryCleanup = new WorkspaceShellStartupQueryCleanupController({
      resolveNavigation: () => this.resolveConsumedStartupEntryNavigation(),
      navigate: options.navigate,
      warn: options.warn,
    });
    this.widgetWorkspaceGate = new WorkspaceShellWidgetWorkspaceGateController({
      routeUrl: options.routeUrl,
      currentUserId: options.currentUserId,
      isApplicationReady: options.isApplicationReady,
      primeWidgetWorkspaceGateSync: options.primeWidgetWorkspaceGateSync,
      refreshFocusSessionFromCloud: options.refreshFocusSessionFromCloud,
      recheckGate: options.recheckGate,
      warn: options.warn,
    });
    this.startupEntryAction = new WorkspaceShellStartupEntryActionController({
      isBlackBoxEnabled: options.isBlackBoxEnabled,
      setSidebarOpen: options.setSidebarOpen,
      activateSidebarTools: options.activateSidebarTools ?? (() => {}),
      preloadSidebarTools: options.preloadSidebarTools,
      loadBlackBoxRecorder: options.loadBlackBoxRecorder,
      primeWidgetWorkspaceGateSync: startupEntryIntent =>
        this.widgetWorkspaceGate.prime(startupEntryIntent),
      mutationEffect: new WorkspaceShellStartupWidgetGateMutationEffectController({
        applyMutation: options.applyWidgetGateMutation,
        clearDeferredStartupEntryIntent: options.clearDeferredStartupEntryIntent,
        warn: options.warn,
      }),
      warn: options.warn,
    });
    this.syncController = new WorkspaceShellStartupEntryIntentSyncController({
      routeUrl: options.routeUrl,
      currentStartupEntryIntent: options.currentStartupEntryIntent,
      deferredStartupEntryIntent: options.deferredStartupEntryIntent,
      isApplicationReady: options.isApplicationReady,
      clearDeferredStartupEntryIntent: options.clearDeferredStartupEntryIntent,
      startupEntryAction: this.startupEntryAction,
      startupQueryCleanup: this.startupQueryCleanup,
      widgetWorkspaceGate: this.widgetWorkspaceGate,
    });
  }

  resetPrimeState(): void {
    if (this.syncController.isTornDown()) {
      return;
    }

    this.widgetWorkspaceGate.resetPrimeState();
  }

  sync(): void {
    this.syncController.sync();
  }

  apply(startupEntryIntent: StartupEntryIntent): void {
    if (this.syncController.isTornDown()) {
      return;
    }

    this.startupEntryAction.apply(startupEntryIntent, null);
  }

  primeWidgetWorkspaceGateSync(startupEntryIntent: StartupEntryIntent): void {
    this.widgetWorkspaceGate.prime(startupEntryIntent);
  }

  flushWidgetWorkspaceGateRecheck(): void {
    this.widgetWorkspaceGate.flush();
  }

  resolveConsumedStartupEntryNavigation(): ConsumedStartupEntryNavigationCommands {
    return resolveConsumedStartupEntryNavigation({
      routeUrl: this.options.routeUrl(),
      mobileRootProjectId: this.options.resolveMobileRootProjectId,
    });
  }

  teardown(): void {
    this.syncController.teardown();
    this.startupEntryAction.teardown();
    this.startupQueryCleanup.teardown();
    this.widgetWorkspaceGate.teardown();
  }
}
