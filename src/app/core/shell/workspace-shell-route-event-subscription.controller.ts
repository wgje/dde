export interface WorkspaceShellRouteEventSubscription {
  unsubscribe: () => void;
}

export interface WorkspaceShellRouteEventSubscriptionControllerOptions {
  subscribeToRouteEvents?: (
    listener: (event: unknown) => void,
  ) => WorkspaceShellRouteEventSubscription;
  isNavigationEnd?: (event: unknown) => boolean;
  onNavigationEnd: () => void;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellRouteEventSubscriptionController {
  private subscription: WorkspaceShellRouteEventSubscription | null = null;
  private generation = 0;

  constructor(
    private readonly options: WorkspaceShellRouteEventSubscriptionControllerOptions,
  ) {}

  setup(): void {
    this.cleanup();
    const generation = ++this.generation;

    try {
      this.subscription = this.options.subscribeToRouteEvents?.((event) => {
        if (generation !== this.generation) return;

        try {
          if (this.options.isNavigationEnd?.(event) !== true) return;
        } catch (error) {
          this.warn(
            'Workspace route sync navigation event predicate failed',
            error,
          );
          return;
        }

        try {
          this.options.onNavigationEnd();
        } catch (error) {
          this.warn('Workspace route sync from navigation event failed', error);
        }
      }) ?? null;
    } catch (error) {
      this.subscription = null;
      this.warn('Workspace route sync subscription setup failed', error);
    }
  }

  cleanup(): void {
    const subscription = this.subscription;
    this.subscription = null;
    this.generation += 1;

    try {
      subscription?.unsubscribe();
    } catch (error) {
      this.warn('Workspace route sync subscription cleanup failed', error);
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not interrupt subscription lifecycle boundaries.
    }
  }
}
