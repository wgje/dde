import { SYNC_CONFIG } from '../../../../config';

export interface RealtimePollingSchedulerRuntime {
  isTransportContextCurrent: (
    transportGeneration: number,
    projectId: string,
    userId: string | null,
  ) => boolean;
  canActivateRemoteTransport: () => boolean;
  isOnline: () => boolean;
  isRealtimePaused: () => boolean;
  hasRealtimeChannel: () => boolean;
  maybeReenterRealtimeFromPolling: (
    projectId: string,
    userId: string | null,
    transportGeneration: number,
  ) => Promise<boolean>;
  onRemoteChange: (payload: { eventType?: string; projectId?: string } | undefined) => Promise<void>;
}

interface RealtimePollingSchedulerLogger {
  info: (message: string, data?: unknown) => void;
  debug: (message: string, data?: unknown) => void;
}

export class RealtimePollingSchedulerController {
  private pollingTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private isUserActive = true;
  private userActiveTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private activityCleanupFns: (() => void)[] = [];
  private activityTrackingGeneration = 0;
  private activePollingKeys = new Map<string, number>();
  private pollingRunId = 0;
  private pollingTickId = 0;

  constructor(private readonly logger: RealtimePollingSchedulerLogger) {}

  startUserActivityTracking(): void {
    if (typeof window === 'undefined' || this.activityCleanupFns.length > 0) return;

    const activityGeneration = ++this.activityTrackingGeneration;
    const resetActiveTimer = () => {
      if (this.activityTrackingGeneration !== activityGeneration) {
        return;
      }

      this.isUserActive = true;
      if (this.userActiveTimer !== null) {
        const userActiveTimer = this.userActiveTimer;
        this.userActiveTimer = null;
        this.clearTimeoutSafely(userActiveTimer);
      }
      const userActiveTimer = globalThis.setTimeout(() => {
        if (
          this.activityTrackingGeneration !== activityGeneration
          || this.userActiveTimer !== userActiveTimer
        ) {
          return;
        }

        this.isUserActive = false;
        this.userActiveTimer = null;
      }, SYNC_CONFIG.USER_ACTIVE_TIMEOUT);
      this.userActiveTimer = userActiveTimer;
    };

    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    try {
      events.forEach(event => {
        window.addEventListener(event, resetActiveTimer, { passive: true });
        this.activityCleanupFns.push(() => window.removeEventListener(event, resetActiveTimer));
      });

      resetActiveTimer();
    } catch (error) {
      this.clearUserActivityTracking();
      throw error;
    }
  }

  startPolling(
    projectId: string,
    userId: string | null,
    transportGeneration: number,
    runtime: RealtimePollingSchedulerRuntime,
  ): void {
    if (!this.canStartPollingSafely(projectId, userId, transportGeneration, runtime)) {
      return;
    }

    this.stopPollingTimer();
    const pollingRunId = ++this.pollingRunId;

    this.info('启动轮询同步', { projectId, interval: SYNC_CONFIG.POLLING_INTERVAL });

    const poll = async () => {
      await this.runPollingTick(projectId, userId, transportGeneration, runtime, pollingRunId);
    };

    void this.runPollSafely(poll).then(() => {
      if (this.shouldScheduleNextPollSafely(pollingRunId, projectId, userId, transportGeneration, runtime)) {
        this.scheduleNextPoll(projectId, userId, transportGeneration, pollingRunId, runtime, poll);
      }
    });
  }

  async runPollingTick(
    projectId: string,
    userId: string | null,
    transportGeneration: number,
    runtime: RealtimePollingSchedulerRuntime,
    pollingRunId?: number,
  ): Promise<void> {
    try {
      if (!this.shouldRunPollingTick(projectId, userId, transportGeneration, runtime)) return;
      const pollingKey = this.createPollingKey(projectId, userId, transportGeneration);
      if (this.activePollingKeys.has(pollingKey)) {
        this.debug('轮询跳过：上一次 poll 仍在执行');
        return;
      }

      const pollingTickId = ++this.pollingTickId;
      this.activePollingKeys.set(pollingKey, pollingTickId);
      try {
        if (await this.tryMaybeReenterRealtimeFromPolling(projectId, userId, transportGeneration, runtime)) return;

        if (!this.shouldContinuePollingTickAfterReentry(
          pollingRunId,
          projectId,
          userId,
          transportGeneration,
          runtime,
        )) {
          return;
        }

        try {
          await runtime.onRemoteChange({
            eventType: 'polling',
            projectId,
          });
        } catch (e) {
          this.debug('轮询检查失败', e);
        }
      } finally {
        if (this.activePollingKeys.get(pollingKey) === pollingTickId) {
          this.activePollingKeys.delete(pollingKey);
        }
      }
    } catch (error) {
      this.debug(
        pollingRunId === undefined
          ? '轮询 tick 执行失败，已跳过本次 tick'
          : '轮询 tick 执行失败，保留下次调度',
        error,
      );
    }
  }

  stopPolling(): void {
    this.stopPollingTimer();
    this.activePollingKeys.clear();
  }

  private stopPollingTimer(): void {
    this.pollingRunId += 1;
    if (this.pollingTimer !== null) {
      const pollingTimer = this.pollingTimer;
      this.pollingTimer = null;
      this.clearTimeoutSafely(pollingTimer);
    }
  }

  hasActivePolling(): boolean {
    return this.pollingTimer !== null || this.activePollingKeys.size > 0;
  }

  cleanup(): void {
    this.stopPolling();
    this.clearUserActivityTracking();
  }

  private shouldRunPollingTick(
    projectId: string,
    userId: string | null,
    transportGeneration: number,
    runtime: RealtimePollingSchedulerRuntime,
  ): boolean {
    return runtime.isTransportContextCurrent(transportGeneration, projectId, userId)
      && runtime.isOnline()
      && !runtime.isRealtimePaused();
  }

  private async tryMaybeReenterRealtimeFromPolling(
    projectId: string,
    userId: string | null,
    transportGeneration: number,
    runtime: RealtimePollingSchedulerRuntime,
  ): Promise<boolean> {
    try {
      return await runtime.maybeReenterRealtimeFromPolling(projectId, userId, transportGeneration);
    } catch (error) {
      this.debug('Realtime 重入探测失败，继续使用轮询兜底', error);
      return false;
    }
  }

  private shouldContinuePollingTickAfterReentry(
    pollingRunId: number | undefined,
    projectId: string,
    userId: string | null,
    transportGeneration: number,
    runtime: RealtimePollingSchedulerRuntime,
  ): boolean {
    return (pollingRunId === undefined || this.isPollingRunCurrent(pollingRunId))
      && this.shouldRunPollingTick(projectId, userId, transportGeneration, runtime)
      && !runtime.hasRealtimeChannel();
  }

  private canStartPollingSafely(
    projectId: string,
    userId: string | null,
    transportGeneration: number,
    runtime: RealtimePollingSchedulerRuntime,
  ): boolean {
    try {
      return runtime.isTransportContextCurrent(transportGeneration, projectId, userId)
        && runtime.canActivateRemoteTransport()
        && !runtime.hasRealtimeChannel();
    } catch (error) {
      this.debug('轮询启动条件检查失败，跳过本次启动', error);
      this.stopPollingTimer();
      this.activePollingKeys.clear();
      return false;
    }
  }

  private getPollingInterval(): number {
    return this.isUserActive ? SYNC_CONFIG.POLLING_ACTIVE_INTERVAL : SYNC_CONFIG.POLLING_INTERVAL;
  }

  private isPollingRunCurrent(pollingRunId: number): boolean {
    return this.pollingRunId === pollingRunId;
  }

  private createPollingKey(
    projectId: string,
    userId: string | null,
    transportGeneration: number,
  ): string {
    return `${transportGeneration}:${projectId}:${userId ?? ''}`;
  }

  private shouldScheduleNextPoll(
    pollingRunId: number,
    projectId: string,
    userId: string | null,
    transportGeneration: number,
    runtime: RealtimePollingSchedulerRuntime,
  ): boolean {
    return this.isPollingRunCurrent(pollingRunId)
      && runtime.isTransportContextCurrent(transportGeneration, projectId, userId)
      && runtime.isOnline()
      && !runtime.isRealtimePaused()
      && !runtime.hasRealtimeChannel();
  }

  private scheduleNextPoll(
    projectId: string,
    userId: string | null,
    transportGeneration: number,
    pollingRunId: number,
    runtime: RealtimePollingSchedulerRuntime,
    poll: () => Promise<void>,
  ): void {
    if (!this.shouldScheduleNextPollSafely(pollingRunId, projectId, userId, transportGeneration, runtime)) {
      return;
    }

    const pollingTimer = globalThis.setTimeout(async () => {
      if (this.pollingTimer !== pollingTimer) {
        return;
      }

      this.pollingTimer = null;
      if (!this.shouldScheduleNextPollSafely(pollingRunId, projectId, userId, transportGeneration, runtime)) {
        return;
      }
      await this.runPollSafely(poll);
      if (this.shouldScheduleNextPollSafely(pollingRunId, projectId, userId, transportGeneration, runtime)) {
        this.scheduleNextPoll(projectId, userId, transportGeneration, pollingRunId, runtime, poll);
      }
    }, this.getPollingInterval());
    this.pollingTimer = pollingTimer;
  }

  private shouldScheduleNextPollSafely(
    pollingRunId: number,
    projectId: string,
    userId: string | null,
    transportGeneration: number,
    runtime: RealtimePollingSchedulerRuntime,
  ): boolean {
    try {
      return this.shouldScheduleNextPoll(pollingRunId, projectId, userId, transportGeneration, runtime);
    } catch (error) {
      if (this.isPollingRunCurrent(pollingRunId)) {
        this.debug('轮询调度条件检查失败，停止当前轮询', error);
        this.stopPollingTimer();
      }
      return false;
    }
  }

  private clearUserActivityTracking(): void {
    this.activityTrackingGeneration += 1;
    if (this.userActiveTimer !== null) {
      const userActiveTimer = this.userActiveTimer;
      this.userActiveTimer = null;
      this.clearTimeoutSafely(userActiveTimer);
    }

    for (const cleanupFn of this.activityCleanupFns) {
      try {
        cleanupFn();
      } catch (error) {
        this.debug('用户活跃监听清理失败，继续清理其他监听', error);
      }
    }
    this.activityCleanupFns = [];
  }

  private async runPollSafely(poll: () => Promise<void>): Promise<void> {
    try {
      await poll();
    } catch (error) {
      this.debug('轮询 tick 执行失败，保留下次调度', error);
    }
  }

  private clearTimeoutSafely(timer: ReturnType<typeof globalThis.setTimeout>): void {
    try {
      globalThis.clearTimeout(timer);
    } catch (error) {
      this.debug('定时器清理失败，继续清理调度状态', error);
    }
  }

  private debug(message: string, data?: unknown): void {
    try {
      if (arguments.length > 1) {
        this.logger.debug(message, data);
      } else {
        this.logger.debug(message);
      }
    } catch {
      // Observability failures must not change polling, retry, or cleanup state.
    }
  }

  private info(message: string, data?: unknown): void {
    try {
      if (arguments.length > 1) {
        this.logger.info(message, data);
      } else {
        this.logger.info(message);
      }
    } catch {
      // Observability failures must not prevent polling fallback startup.
    }
  }
}
