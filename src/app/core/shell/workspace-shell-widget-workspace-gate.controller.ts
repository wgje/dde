import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';
import { resolveWidgetWorkspaceGatePrimeKey } from './workspace-shell-android-widget-bootstrap.helpers';

export interface WorkspaceShellWidgetWorkspaceGateControllerOptions {
  routeUrl: () => string;
  currentUserId: () => string | null;
  isApplicationReady: () => boolean;
  primeWidgetWorkspaceGateSync: () => void;
  refreshFocusSessionFromCloud: (userId: string | null) => unknown;
  recheckGate: (options: {
    source: 'widget-open-workspace';
    reloadLocal: false;
  }) => Promise<void> | void;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellWidgetWorkspaceGateController {
  private primedKey: string | null = null;
  private pendingRecheckKey: string | null = null;
  private recheckInFlightKey: string | null = null;
  private isTornDown = false;

  constructor(private readonly options: WorkspaceShellWidgetWorkspaceGateControllerOptions) {}

  resetPrimeState(): void {
    if (this.isTornDown) {
      return;
    }

    this.primedKey = null;
  }

  prime(startupEntryIntent: StartupEntryIntent): void {
    if (this.isTornDown) {
      return;
    }

    const primeKey = resolveWidgetWorkspaceGatePrimeKey(
      startupEntryIntent,
      this.options.routeUrl(),
    );
    if (!primeKey) {
      return;
    }

    const currentUserId = this.options.currentUserId();
    if (!currentUserId) {
      this.pendingRecheckKey = primeKey;
      return;
    }

    if (this.primedKey === primeKey) {
      return;
    }

    this.primedKey = primeKey;
    this.options.primeWidgetWorkspaceGateSync();
    this.refreshFocusSessionFromCloud(currentUserId);

    this.pendingRecheckKey = primeKey;
    this.flush();
  }

  flush(): void {
    if (this.isTornDown || !this.pendingRecheckKey) {
      return;
    }

    if (!this.options.isApplicationReady()) {
      return;
    }

    const currentUserId = this.options.currentUserId();
    if (!currentUserId) {
      return;
    }

    if (this.primedKey !== this.pendingRecheckKey) {
      this.primedKey = this.pendingRecheckKey;
      this.options.primeWidgetWorkspaceGateSync();
      this.refreshFocusSessionFromCloud(currentUserId);
    }

    this.recheck(this.pendingRecheckKey);
  }

  teardown(): void {
    this.isTornDown = true;
    this.primedKey = null;
    this.pendingRecheckKey = null;
    this.recheckInFlightKey = null;
  }

  private refreshFocusSessionFromCloud(userId: string): void {
    try {
      void Promise.resolve(this.options.refreshFocusSessionFromCloud(userId)).catch(
        (error: unknown) => {
          if (this.isTornDown) {
            return;
          }

          this.warn('Startup entry widget workspace gate cloud refresh failed', error);
        },
      );
    } catch (error) {
      this.warn('Startup entry widget workspace gate cloud refresh failed', error);
    }
  }

  private recheck(recheckKey: string): void {
    if (this.isTornDown || this.recheckInFlightKey) {
      return;
    }

    this.recheckInFlightKey = recheckKey;
    const recheckOwnerUserId = this.options.currentUserId();

    try {
      void Promise.resolve(this.options.recheckGate({
        source: 'widget-open-workspace',
        reloadLocal: false,
      })).then(() => {
        this.consumePendingRecheckAfterSuccess(recheckKey, recheckOwnerUserId);
      }).catch((error: unknown) => {
        if (this.isTornDown) {
          return;
        }

        this.warn('Startup entry widget workspace gate recheck failed', error);
      }).finally(() => {
        if (this.isTornDown) {
          return;
        }

        if (this.recheckInFlightKey === recheckKey) {
          this.recheckInFlightKey = null;
        }
        this.flushPendingRecheckAfterSettle(recheckKey);
      });
    } catch (error) {
      this.recheckInFlightKey = null;
      this.warn('Startup entry widget workspace gate recheck failed', error);
      this.flushPendingRecheckAfterSettle(recheckKey);
    }
  }

  private consumePendingRecheckAfterSuccess(
    recheckKey: string,
    recheckOwnerUserId: string | null,
  ): void {
    if (this.isTornDown) {
      return;
    }

    if (this.options.currentUserId() !== recheckOwnerUserId) {
      return;
    }

    if (this.pendingRecheckKey === recheckKey) {
      this.pendingRecheckKey = null;
    }
  }

  private flushPendingRecheckAfterSettle(recheckKey: string): void {
    if (this.pendingRecheckKey && this.pendingRecheckKey !== recheckKey) {
      this.flush();
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not re-enter widget gate retry chains.
    }
  }
}
