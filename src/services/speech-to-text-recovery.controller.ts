import {
  isControlledUpstreamRetryableTranscribeError,
  resolveRetryableTranscribeReplayDelayMs,
  shouldScheduleOfflineCacheReplay,
} from './speech-to-text.helpers';

interface RecoverySubscription {
  unsubscribe(): void;
}

interface RecoveryEventStream<T> {
  subscribe(listener: (event: T) => void): RecoverySubscription;
}

interface SessionRestoredEvent {
  userId: string;
  source: string;
}

interface SessionInvalidatedEvent {
  userId: string | null;
  source: string;
}

interface OnlineEventTarget {
  addEventListener(type: 'online', listener: EventListener): void;
  removeEventListener(type: 'online', listener: EventListener): void;
}

interface RecoveryLogger {
  debug(category: string, message: string, context?: unknown): void;
  error(category: string, message: string, context?: unknown): void;
  info(category: string, message: string, context?: unknown): void;
}

export interface SpeechToTextRecoveryControllerOptions {
  currentUserId: () => string | null;
  defaultUpstreamRetryDelayMs: number;
  deferUntilSettled: (
    isSettled: () => boolean,
    onSettled: () => void,
    reason: string,
  ) => void;
  isDestroyed: () => boolean;
  isOnline: () => boolean;
  logger: RecoveryLogger;
  networkErrorCode: string;
  notifyReplaySuccess: (count: number) => void;
  offlineReplayRetryDelayMs: number;
  onlineTarget?: OnlineEventTarget | null;
  processOfflineCache: () => Promise<readonly unknown[]>;
  processReplay: () => Promise<void>;
  refreshPendingCount: () => void | Promise<void>;
  scheduleReplay: (reason: string, delayMs: number) => void;
  sessionInvalidated$: RecoveryEventStream<SessionInvalidatedEvent>;
  sessionRestored$: RecoveryEventStream<SessionRestoredEvent>;
}

export class SpeechToTextRecoveryController {
  private readonly subscriptions: RecoverySubscription[] = [];
  private readonly onlineTarget: OnlineEventTarget | null;
  private currentOnlineHandler: (() => void) | null = null;
  private currentReplayTimeout: ReturnType<typeof setTimeout> | null = null;
  private controlledRetryDelayMs: number | null = null;
  private replayPromise: Promise<void> | null = null;
  private destroyed = false;

  constructor(private readonly options: SpeechToTextRecoveryControllerOptions) {
    this.onlineTarget = options.onlineTarget === undefined
      ? (typeof window === 'undefined' ? null : window)
      : options.onlineTarget;
    this.setupOnlineListener();
    this.setupSessionListeners();
  }

  get onlineHandler(): (() => void) | null {
    return this.currentOnlineHandler;
  }

  set onlineHandler(value: (() => void) | null) {
    this.currentOnlineHandler = value;
  }

  get replayTimeout(): ReturnType<typeof setTimeout> | null {
    return this.currentReplayTimeout;
  }

  setControlledRetryDelayMs(value: number | null): void {
    this.controlledRetryDelayMs = value;
  }

  async processReplayAndNotify(): Promise<void> {
    try {
      const results = await this.options.processOfflineCache();
      if (this.isDestroyed()) {
        return;
      }
      if (results.length > 0) {
        this.options.notifyReplaySuccess(results.length);
      }
    } catch (error) {
      if (this.isDestroyed()) {
        return;
      }
      this.options.logger.error(
        'SpeechToText',
        'Failed to process offline cache',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  scheduleRetryableReplay(error: unknown, reason: string): void {
    const controlledDelayMs = this.controlledRetryDelayMs;
    this.controlledRetryDelayMs = null;
    const delayMs = resolveRetryableTranscribeReplayDelayMs({
      isControlledUpstreamRetryableError: isControlledUpstreamRetryableTranscribeError(
        error,
        this.options.isOnline(),
        this.options.networkErrorCode,
      ),
      controlledDelayMs,
      defaultUpstreamRetryDelayMs: this.options.defaultUpstreamRetryDelayMs,
      offlineReplayRetryDelayMs: this.options.offlineReplayRetryDelayMs,
    });
    this.options.scheduleReplay(reason, delayMs);
  }

  schedule(reason: string, delayMs: number): void {
    if (!shouldScheduleOfflineCacheReplay(
      this.isDestroyed(),
      this.options.isOnline(),
      this.currentReplayTimeout !== null,
    )) {
      return;
    }

    this.options.logger.info(
      'SpeechToText',
      'Scheduling offline audio replay after transient failure',
      { reason },
    );
    this.currentReplayTimeout = setTimeout(() => {
      this.currentReplayTimeout = null;
      void this.run('delayed-retry');
    }, delayMs);
  }

  run(reason: string): Promise<void> {
    if (this.isDestroyed()) {
      return Promise.resolve();
    }

    if (this.replayPromise) {
      this.options.logger.debug(
        'SpeechToText',
        'Offline audio replay already in progress, reusing existing run',
        { reason },
      );
      return this.replayPromise;
    }

    this.clearReplayTimeout();
    const replayPromise = this.options.processReplay().finally(() => {
      if (this.replayPromise === replayPromise) {
        this.replayPromise = null;
      }
    });
    this.replayPromise = replayPromise;
    return replayPromise;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.clearReplayTimeout();
    if (this.onlineTarget && this.currentOnlineHandler) {
      this.onlineTarget.removeEventListener('online', this.currentOnlineHandler);
    }
    this.currentOnlineHandler = null;
    this.subscriptions.splice(0).forEach(subscription => subscription.unsubscribe());
  }

  private isDestroyed(): boolean {
    return this.destroyed || this.options.isDestroyed();
  }

  private clearReplayTimeout(): void {
    if (this.currentReplayTimeout === null) {
      return;
    }

    clearTimeout(this.currentReplayTimeout);
    this.currentReplayTimeout = null;
  }

  private setupOnlineListener(): void {
    if (!this.onlineTarget) {
      return;
    }

    this.currentOnlineHandler = () => {
      this.options.logger.info(
        'SpeechToText',
        'Network restored, processing offline audio cache',
      );
      void this.run('network-restored');
    };
    this.onlineTarget.addEventListener('online', this.currentOnlineHandler);
  }

  private setupSessionListeners(): void {
    this.subscriptions.push(
      this.options.sessionRestored$.subscribe(event => {
        this.options.deferUntilSettled(
          () => this.options.currentUserId() === event.userId,
          () => {
            void this.options.refreshPendingCount();
            if (!this.options.isOnline()) {
              return;
            }

            this.options.logger.info(
              'SpeechToText',
              'Session restored, replaying offline audio cache',
            );
            void this.run('session-restored');
          },
          `session-restored:${event.source}`,
        );
      }),
      this.options.sessionInvalidated$.subscribe(event => {
        this.options.deferUntilSettled(
          () => event.userId == null || this.options.currentUserId() !== event.userId,
          () => {
            void this.options.refreshPendingCount();
          },
          `session-invalidated:${event.source}`,
        );
      }),
    );
  }
}
