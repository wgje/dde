export interface WorkspaceShellSessionRestoredEvent {
  type: 'session-restored';
  source: string;
  userId: string;
}

export interface WorkspaceShellSessionInvalidatedEvent {
  type: 'session-invalidated';
  source: string;
  userId: string | null;
}

export interface WorkspaceShellSessionTransitionSubscription {
  unsubscribe: () => void;
}

export interface WorkspaceShellSessionTransitionSubscriptionsControllerOptions {
  onSessionRestored(event: WorkspaceShellSessionRestoredEvent): void;
  onSessionInvalidated(event: WorkspaceShellSessionInvalidatedEvent): void;
  warn(message: string, context?: unknown): void;
  subscribeToSessionRestored?: (
    listener: (event: WorkspaceShellSessionRestoredEvent) => void,
  ) => WorkspaceShellSessionTransitionSubscription;
  subscribeToSessionInvalidated?: (
    listener: (event: WorkspaceShellSessionInvalidatedEvent) => void,
  ) => WorkspaceShellSessionTransitionSubscription;
}

export class WorkspaceShellSessionTransitionSubscriptionsController {
  private sessionRestoredSubscription: WorkspaceShellSessionTransitionSubscription | null = null;
  private sessionInvalidatedSubscription: WorkspaceShellSessionTransitionSubscription | null = null;

  constructor(
    private readonly options: WorkspaceShellSessionTransitionSubscriptionsControllerOptions,
  ) {}

  setup(): void {
    this.cleanup();
    let sessionRestoredSubscription: WorkspaceShellSessionTransitionSubscription | null = null;
    let sessionInvalidatedSubscription: WorkspaceShellSessionTransitionSubscription | null = null;

    try {
      sessionRestoredSubscription = this.options.subscribeToSessionRestored?.((event) => {
        this.options.onSessionRestored(event);
      }) ?? null;
      sessionInvalidatedSubscription = this.options.subscribeToSessionInvalidated?.((event) => {
        this.options.onSessionInvalidated(event);
      }) ?? null;

      this.sessionRestoredSubscription = sessionRestoredSubscription;
      this.sessionInvalidatedSubscription = sessionInvalidatedSubscription;
    } catch (error) {
      this.unsubscribe(sessionRestoredSubscription);
      this.unsubscribe(sessionInvalidatedSubscription);
      this.sessionRestoredSubscription = null;
      this.sessionInvalidatedSubscription = null;
      throw error;
    }
  }

  cleanup(): void {
    const sessionRestoredSubscription = this.sessionRestoredSubscription;
    const sessionInvalidatedSubscription = this.sessionInvalidatedSubscription;
    this.sessionRestoredSubscription = null;
    this.sessionInvalidatedSubscription = null;
    this.unsubscribe(sessionRestoredSubscription);
    this.unsubscribe(sessionInvalidatedSubscription);
  }

  private unsubscribe(
    subscription: WorkspaceShellSessionTransitionSubscription | null,
  ): void {
    try {
      subscription?.unsubscribe();
    } catch (error) {
      this.warn('Workspace session transition subscription cleanup failed', error);
    }
  }

  private warn(message: string, context?: unknown): void {
    try {
      this.options.warn(message, context);
    } catch {
      // Warning sinks must not interrupt subscription replacement or cleanup.
    }
  }
}
