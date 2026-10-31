import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';
import type {
  WorkspaceShellStartupEntryDeferredClearOwner,
} from './workspace-shell-startup-entry-action.controller';
import type {
  WorkspaceShellStartupWidgetGateMutationEffectContext,
} from './workspace-shell-startup-widget-gate-mutation-effect.controller';

export interface WorkspaceShellStartupEntryIntentSyncActionDelegate {
  apply(
    startupEntryIntent: StartupEntryIntent,
    mutationContext: WorkspaceShellStartupWidgetGateMutationEffectContext | null,
  ): WorkspaceShellStartupEntryDeferredClearOwner;
}

export interface WorkspaceShellStartupEntryIntentSyncQueryCleanupDelegate {
  consume(startupEntryIntentKey: string): void;
  isPending(startupEntryIntentKey: string): boolean;
}

export interface WorkspaceShellStartupEntryIntentSyncWidgetGateDelegate {
  prime(startupEntryIntent: StartupEntryIntent): void;
  resetPrimeState(): void;
}

export interface WorkspaceShellStartupEntryIntentSyncControllerOptions {
  routeUrl: () => string;
  currentStartupEntryIntent: () => StartupEntryIntent | null;
  deferredStartupEntryIntent: () => StartupEntryIntent | null;
  isApplicationReady: () => boolean;
  clearDeferredStartupEntryIntent: () => void;
  startupEntryAction: WorkspaceShellStartupEntryIntentSyncActionDelegate;
  startupQueryCleanup: WorkspaceShellStartupEntryIntentSyncQueryCleanupDelegate;
  widgetWorkspaceGate: WorkspaceShellStartupEntryIntentSyncWidgetGateDelegate;
}

export class WorkspaceShellStartupEntryIntentSyncController {
  private handledStartupEntryIntentKey: string | null = null;
  private tornDown = false;

  constructor(
    private readonly options: WorkspaceShellStartupEntryIntentSyncControllerOptions,
  ) {}

  isTornDown(): boolean {
    return this.tornDown;
  }

  sync(): void {
    if (this.tornDown) return;

    const currentStartupEntryIntent = this.options.currentStartupEntryIntent();
    const deferredStartupEntryIntent = this.options.deferredStartupEntryIntent();
    const startupEntryIntent = currentStartupEntryIntent ?? deferredStartupEntryIntent;
    if (!startupEntryIntent) {
      this.handledStartupEntryIntentKey = null;
      this.options.widgetWorkspaceGate.resetPrimeState();
      return;
    }

    this.options.widgetWorkspaceGate.prime(startupEntryIntent);

    // Android bootstrap capture owns query cleanup for this route.
    if (currentStartupEntryIntent?.androidWidgetBootstrap === true) return;
    if (!this.options.isApplicationReady()) return;

    const startupEntryIntentKey = this.resolveIntentKey(startupEntryIntent);
    if (this.handledStartupEntryIntentKey === startupEntryIntentKey) {
      if (
        this.options.currentStartupEntryIntent()
        && this.options.startupQueryCleanup.isPending(startupEntryIntentKey)
      ) {
        this.options.startupQueryCleanup.consume(startupEntryIntentKey);
      }
      return;
    }

    this.handledStartupEntryIntentKey = startupEntryIntentKey;
    this.applyStartupEntryIntentForSync(
      startupEntryIntent,
      startupEntryIntentKey,
      currentStartupEntryIntent,
      deferredStartupEntryIntent,
    );
    if (currentStartupEntryIntent) {
      this.options.startupQueryCleanup.consume(startupEntryIntentKey);
    }
  }

  teardown(): void {
    this.tornDown = true;
    this.handledStartupEntryIntentKey = null;
  }

  private applyStartupEntryIntentForSync(
    startupEntryIntent: StartupEntryIntent,
    startupEntryIntentKey: string,
    currentStartupEntryIntent: StartupEntryIntent | null,
    deferredStartupEntryIntent: StartupEntryIntent | null,
  ): void {
    const shouldClearDeferred = this.shouldClearDeferredStartupEntryIntent(
      currentStartupEntryIntent,
      deferredStartupEntryIntent,
    );
    const deferredClearOwner = this.options.startupEntryAction.apply(startupEntryIntent, {
      clearDeferredAfterSuccess: shouldClearDeferred,
      onFailure: () => {
        if (this.handledStartupEntryIntentKey === startupEntryIntentKey) {
          this.handledStartupEntryIntentKey = null;
        }
      },
    });
    if (deferredClearOwner === 'caller' && shouldClearDeferred) {
      this.options.clearDeferredStartupEntryIntent();
    }
  }

  private resolveIntentKey(startupEntryIntent: StartupEntryIntent): string {
    return `${startupEntryIntent.entry}:${startupEntryIntent.rawIntent ?? ''}:${this.options.routeUrl()}`;
  }

  private shouldClearDeferredStartupEntryIntent(
    currentStartupEntryIntent: StartupEntryIntent | null,
    deferredStartupEntryIntent: StartupEntryIntent | null,
  ): boolean {
    if (!deferredStartupEntryIntent || !currentStartupEntryIntent) return true;

    return areSameStartupEntryIntent(currentStartupEntryIntent, deferredStartupEntryIntent);
  }
}

function areSameStartupEntryIntent(
  left: StartupEntryIntent,
  right: StartupEntryIntent,
): boolean {
  return left.entry === right.entry
    && left.intent === right.intent
    && left.rawIntent === right.rawIntent
    && left.widgetGateEntryId === right.widgetGateEntryId
    && left.androidWidgetBootstrap === right.androidWidgetBootstrap;
}
