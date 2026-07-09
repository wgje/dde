export interface WorkspaceShellLazyDelegateCallHostOptions<TDelegate> {
  createDelegate: () => Promise<TDelegate>;
  loadFailureMessage: string;
  teardownFailureMessage?: string;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellLazyDelegateCallHostController<TDelegate> {
  private delegatePromise: Promise<TDelegate> | null = null;
  private delegateInstance: TDelegate | null = null;
  private isTornDown = false;

  constructor(private readonly options: WorkspaceShellLazyDelegateCallHostOptions<TDelegate>) {}

  get loadedDelegate(): TDelegate | null {
    if (this.isTornDown) return null;

    return this.delegateInstance;
  }

  call<TResult>(
    action: (delegate: TDelegate) => TResult | Promise<TResult>,
    fallback: TResult,
    failureMessage = this.options.loadFailureMessage,
    loadFailureMessage = failureMessage,
  ): Promise<TResult> {
    if (this.isTornDown) {
      return Promise.resolve(fallback);
    }

    return this.loadDelegate(loadFailureMessage)
      .then(async delegate => {
        if (this.isTornDown) return fallback;
        try {
          const result = await action(delegate);
          return this.isTornDown ? fallback : result;
        } catch (error) {
          this.warn(failureMessage, error);
          return fallback;
        }
      })
      .catch(() => fallback);
  }

  run(
    action: (delegate: TDelegate) => void,
    failureMessage = this.options.loadFailureMessage,
    loadFailureMessage = failureMessage,
  ): void {
    void this.call(action, undefined, failureMessage, loadFailureMessage);
  }

  runIfLoaded(
    action: (delegate: TDelegate) => void,
    failureMessage = this.options.teardownFailureMessage
      ?? this.options.loadFailureMessage,
  ): void {
    if (this.isTornDown) return;

    if (this.delegateInstance) {
      this.runLoadedOnlyAction(this.delegateInstance, action, failureMessage);
      return;
    }

    void this.delegatePromise
      ?.then(delegate => {
        if (!this.isTornDown) {
          this.runLoadedOnlyAction(delegate, action, failureMessage);
        }
      })
      .catch(() => {
        // Loading and teardown paths own their warnings; loaded-only actions
        // should not duplicate or relabel those failures.
      });
  }

  teardown(): void {
    if (this.isTornDown) return;

    this.isTornDown = true;
    if (this.delegateInstance) {
      const delegateInstance = this.delegateInstance;
      this.delegateInstance = null;
      this.delegatePromise = null;
      this.teardownDelegate(delegateInstance);
      return;
    }

    void this.delegatePromise
      ?.then(delegate => this.teardownDelegate(delegate))
      .catch(error => {
        this.warn(
          this.options.teardownFailureMessage ?? this.options.loadFailureMessage,
          error,
        );
      });
  }

  private loadDelegate(loadFailureMessage: string): Promise<TDelegate> {
    if (this.delegateInstance) {
      return Promise.resolve(this.delegateInstance);
    }

    return (this.delegatePromise ??= this.createDelegateSafely()
      .then(delegate => {
        if (!this.isTornDown) {
          this.delegateInstance = delegate;
        }
        return delegate;
      })
      .catch(error => {
        this.delegatePromise = null;
        if (this.isTornDown) {
          throw error;
        }

        this.warn(loadFailureMessage, error);
        throw error;
      }));
  }

  private createDelegateSafely(): Promise<TDelegate> {
    try {
      return Promise.resolve(this.options.createDelegate());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private runLoadedOnlyAction(
    delegate: TDelegate,
    action: (delegate: TDelegate) => void,
    failureMessage: string,
  ): void {
    try {
      action(delegate);
    } catch (error) {
      this.warn(failureMessage, error);
    }
  }

  private teardownDelegate(delegate: TDelegate): void {
    const teardown = Reflect.get(delegate as object, 'teardown');
    if (typeof teardown === 'function') {
      try {
        Reflect.apply(teardown, delegate as object, []);
      } catch (error) {
        this.warn(
          this.options.teardownFailureMessage ?? this.options.loadFailureMessage,
          error,
        );
      }
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not break teardown, fallback, or retry boundaries.
    }
  }
}
