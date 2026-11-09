import {
  WorkspaceShellSessionTransitionRecoveryController,
  type WorkspaceShellSessionTransitionRecoveryControllerOptions,
} from './workspace-shell-session-transition-recovery.controller';
import {
  WorkspaceShellSessionTransitionSubscriptionsController,
  type WorkspaceShellSessionInvalidatedEvent,
  type WorkspaceShellSessionRestoredEvent,
  type WorkspaceShellSessionTransitionSubscription,
} from './workspace-shell-session-transition-subscriptions.controller';

export type {
  WorkspaceShellSessionInvalidatedEvent,
  WorkspaceShellSessionRestoredEvent,
  WorkspaceShellSessionTransitionSubscription,
} from './workspace-shell-session-transition-subscriptions.controller';

export interface WorkspaceShellSessionTransitionControllerOptions
  extends WorkspaceShellSessionTransitionRecoveryControllerOptions {
  subscribeToSessionRestored?: (
    listener: (event: WorkspaceShellSessionRestoredEvent) => void,
  ) => WorkspaceShellSessionTransitionSubscription;
  subscribeToSessionInvalidated?: (
    listener: (event: WorkspaceShellSessionInvalidatedEvent) => void,
  ) => WorkspaceShellSessionTransitionSubscription;
  subscriptions?: Pick<
    WorkspaceShellSessionTransitionSubscriptionsController,
    'cleanup' | 'setup'
  >;
}

export class WorkspaceShellSessionTransitionController {
  private readonly recovery: WorkspaceShellSessionTransitionRecoveryController;
  private readonly subscriptions: Pick<
    WorkspaceShellSessionTransitionSubscriptionsController,
    'cleanup' | 'setup'
  >;

  constructor(options: WorkspaceShellSessionTransitionControllerOptions) {
    this.recovery = new WorkspaceShellSessionTransitionRecoveryController(options);
    this.subscriptions = options.subscriptions
      ?? new WorkspaceShellSessionTransitionSubscriptionsController({
        onSessionInvalidated: event => {
          void this.recovery.handleSessionInvalidated(event);
        },
        onSessionRestored: event => {
          void this.recovery.handleSessionRestored(event);
        },
        subscribeToSessionInvalidated: options.subscribeToSessionInvalidated,
        subscribeToSessionRestored: options.subscribeToSessionRestored,
        warn: options.warn,
      });
  }

  setupSessionHandlers(): void {
    this.cleanup();
    this.subscriptions.setup();
  }

  cleanup(): void {
    this.recovery.cleanup(() => this.subscriptions.cleanup());
  }

  handleSessionRestored(event: WorkspaceShellSessionRestoredEvent): Promise<void> {
    return this.recovery.handleSessionRestored(event);
  }

  handleSessionInvalidated(event: WorkspaceShellSessionInvalidatedEvent): Promise<void> {
    return this.recovery.handleSessionInvalidated(event);
  }
}
