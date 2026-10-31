import type { ConsumedStartupEntryNavigationCommands } from './workspace-shell-startup-route.helpers';

export interface WorkspaceShellStartupQueryCleanupControllerOptions {
  resolveNavigation: () => ConsumedStartupEntryNavigationCommands;
  navigate: (
    commands: ConsumedStartupEntryNavigationCommands,
    options: { replaceUrl: true },
  ) => Promise<unknown> | unknown;
  warn: (message: string, error: unknown) => void;
}

const STARTUP_QUERY_CLEANUP_RETRY_DELAY_MS = 1_000;
const STARTUP_QUERY_CLEANUP_MAX_RETRIES = 2;

export class WorkspaceShellStartupQueryCleanupController {
  private pendingKey: string | null = null;
  private inFlightKey: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private isTornDown = false;

  constructor(private readonly options: WorkspaceShellStartupQueryCleanupControllerOptions) {}

  isPending(startupEntryIntentKey: string): boolean {
    return !this.isTornDown && this.pendingKey === startupEntryIntentKey;
  }

  consume(startupEntryIntentKey: string): void {
    if (this.isTornDown || this.inFlightKey === startupEntryIntentKey) {
      return;
    }

    this.clearRetryTimer();
    this.consumeAttempt(startupEntryIntentKey, 0);
  }

  private consumeAttempt(startupEntryIntentKey: string, retryCount: number): void {
    if (this.isTornDown) {
      return;
    }

    this.pendingKey = startupEntryIntentKey;
    this.inFlightKey = startupEntryIntentKey;

    try {
      void Promise.resolve(this.options.navigate(
        this.options.resolveNavigation(),
        { replaceUrl: true },
      )).then((navigationResult) => {
        if (this.isTornDown) {
          return;
        }

        if (navigationResult === false || navigationResult === null) {
          this.warn(
            'Startup entry query cleanup navigation failed',
            new Error('Router did not confirm startup entry query cleanup navigation'),
          );
          this.scheduleRetry(startupEntryIntentKey, retryCount);
          return;
        }

        if (this.pendingKey === startupEntryIntentKey) {
          this.pendingKey = null;
          this.clearRetryTimer();
        }
      }).catch((error: unknown) => {
        if (this.isTornDown) {
          return;
        }

        if (this.inFlightKey === startupEntryIntentKey) {
          this.inFlightKey = null;
        }
        this.warn('Startup entry query cleanup navigation failed', error);
        this.scheduleRetry(startupEntryIntentKey, retryCount);
      }).finally(() => {
        if (this.isTornDown) {
          return;
        }

        if (this.inFlightKey === startupEntryIntentKey) {
          this.inFlightKey = null;
        }
      });
    } catch (error) {
      this.inFlightKey = null;
      this.warn('Startup entry query cleanup navigation failed', error);
      this.scheduleRetry(startupEntryIntentKey, retryCount);
    }
  }

  teardown(): void {
    this.isTornDown = true;
    this.clearRetryTimer();
    this.pendingKey = null;
    this.inFlightKey = null;
  }

  private scheduleRetry(startupEntryIntentKey: string, retryCount: number): void {
    if (
      this.isTornDown
      || this.pendingKey !== startupEntryIntentKey
      || retryCount >= STARTUP_QUERY_CLEANUP_MAX_RETRIES
      || this.retryTimer !== null
    ) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.isTornDown && this.pendingKey === startupEntryIntentKey) {
        this.consumeAttempt(startupEntryIntentKey, retryCount + 1);
      }
    }, STARTUP_QUERY_CLEANUP_RETRY_DELAY_MS);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) {
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not re-enter the cleanup retry boundary.
    }
  }
}
