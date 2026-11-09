import type { RealtimeChannel } from '@supabase/supabase-js';
import { isBrowserNetworkSuspendedWindow } from '../../../../utils/browser-network-suspension';

export interface RealtimeStatusError {
  message?: string;
}

type RealtimeStatusLevel = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';

export interface RealtimeSubscribeState {
  projectId: string;
  userId: string;
  transportGeneration: number;
  channelName: string;
  channel: RealtimeChannel;
  previousStatus: string | null;
  consecutiveErrors: number;
}

export interface RealtimeStatusControllerRuntime {
  isStateCurrent: (state: RealtimeSubscribeState) => boolean;
  isRealtimeEnabled: () => boolean;
  fallbackToPolling: (projectId: string, userId: string, transportGeneration: number) => void;
  triggerRealtimeReconnectChange: (projectId: string) => void;
}

export interface RealtimeStatusTransportCircuit {
  armCircuit: (userId: string, errorMessage: string | undefined, consecutiveErrors: number) => number;
  clearBackoff: (projectId: string) => void;
  clearCircuit: () => void;
}

interface RealtimeStatusLogger {
  info: (message: string, data?: unknown) => void;
  debug: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
}

interface RealtimeStatusTelemetry {
  addBreadcrumb: (breadcrumb: {
    category?: string;
    level?: RealtimeStatusLevel;
    message?: string;
    data?: Record<string, unknown>;
  }) => void;
  captureMessage: (message: string, context?: {
    level?: RealtimeStatusLevel;
    extra?: Record<string, unknown>;
  }) => void;
}

export class RealtimeStatusController {
  private static readonly REALTIME_MAX_CONSECUTIVE_ERRORS = 3;

  constructor(
    private readonly logger: RealtimeStatusLogger,
    private readonly sentryLazyLoader: RealtimeStatusTelemetry,
    private readonly transportCircuit: RealtimeStatusTransportCircuit,
    private readonly isBrowserNetworkSuspended = isBrowserNetworkSuspendedWindow,
  ) {}

  handleSubscribeStatus(
    status: string,
    err: RealtimeStatusError | undefined,
    state: RealtimeSubscribeState,
    runtime: RealtimeStatusControllerRuntime,
  ): void {
    if (!this.isStateCurrentSafely(state, runtime)) return;

    this.infoRealtimeStatus('Realtime 订阅状态', {
      status,
      channel: state.channelName,
      previousStatus: state.previousStatus,
    });

    if (this.shouldIgnoreRealtimeStatusError(status, err, state, runtime)) {
      state.previousStatus = status;
      return;
    }

    if (this.isRealtimeChannelErrorStatus(status)) {
      this.handleRealtimeChannelError(status, err, state, runtime);
      state.previousStatus = status;
      return;
    }

    if (status === 'SUBSCRIBED') {
      this.handleRealtimeSubscribedStatus(state, runtime);
    }

    state.previousStatus = status;
  }

  private shouldIgnoreRealtimeStatusError(
    status: string,
    err: RealtimeStatusError | undefined,
    state: RealtimeSubscribeState,
    runtime: RealtimeStatusControllerRuntime,
  ): boolean {
    if (!this.isRealtimeChannelErrorStatus(status)) return false;

    if (this.isBrowserNetworkSuspended()) {
      this.debugRealtimeStatus('浏览器网络挂起期间忽略 Realtime 通道中断', {
        status,
        channel: state.channelName,
        error: err?.message,
      });
      return true;
    }

    if (!runtime.isRealtimeEnabled()) {
      this.debugRealtimeStatus('Realtime 已被策略禁用，忽略通道中断', {
        status,
        channel: state.channelName,
        error: err?.message,
      });
      return true;
    }

    return false;
  }

  private isRealtimeChannelErrorStatus(status: string): boolean {
    return status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED';
  }

  private handleRealtimeChannelError(
    status: string,
    err: RealtimeStatusError | undefined,
    state: RealtimeSubscribeState,
    runtime: RealtimeStatusControllerRuntime,
  ): void {
    state.consecutiveErrors++;
    this.recordRealtimeChannelErrorBreadcrumb(status, err, state);

    if (state.consecutiveErrors === RealtimeStatusController.REALTIME_MAX_CONSECUTIVE_ERRORS) {
      this.degradeRealtimeChannelToPolling(status, err, state, runtime);
      return;
    }

    this.debugRealtimeStatus('Realtime 通道瞬时错误，等待连续失败阈值', {
      status,
      channel: state.channelName,
      consecutiveErrors: state.consecutiveErrors,
      error: err?.message,
    });
  }

  private recordRealtimeChannelErrorBreadcrumb(
    status: string,
    err: RealtimeStatusError | undefined,
    state: RealtimeSubscribeState,
  ): void {
    this.addRealtimeBreadcrumb({
      category: 'realtime',
      level: 'warning',
      message: 'realtime_channel_error',
      data: {
        status,
        channel: state.channelName,
        projectId: state.projectId,
        userId: state.userId,
        error: err?.message,
        consecutiveErrors: state.consecutiveErrors,
      },
    });
  }

  private degradeRealtimeChannelToPolling(
    status: string,
    err: RealtimeStatusError | undefined,
    state: RealtimeSubscribeState,
    runtime: RealtimeStatusControllerRuntime,
  ): void {
    const realtimeCircuitMs = this.armRealtimeTransportCircuitSafely(
      state.userId,
      err?.message,
      state.consecutiveErrors,
    );
    try {
      runtime.fallbackToPolling(state.projectId, state.userId, state.transportGeneration);
      this.recordRealtimePollingFallback(status, err, state, realtimeCircuitMs);
    } catch (error) {
      state.consecutiveErrors = Math.min(
        state.consecutiveErrors,
        RealtimeStatusController.REALTIME_MAX_CONSECUTIVE_ERRORS - 1,
      );
      this.warnRealtimeStatusFailure('Realtime 降级到轮询失败', error);
    }
  }

  private recordRealtimePollingFallback(
    status: string,
    err: RealtimeStatusError | undefined,
    state: RealtimeSubscribeState,
    realtimeCircuitMs: number,
  ): void {
    this.addRealtimeBreadcrumb({
      category: 'realtime',
      level: 'warning',
      message: 'realtime_fallback_polling_started',
      data: {
        projectId: state.projectId,
        userId: state.userId,
        reason: 'realtime_channel_error',
        status,
        error: err?.message,
        consecutiveErrors: state.consecutiveErrors,
        realtimeCircuitMs,
      },
    });
    this.captureRealtimeMessage('Realtime 订阅错误', {
      level: 'warning',
      extra: {
        status,
        error: err?.message,
        consecutiveErrors: state.consecutiveErrors,
        degradedToPolling: true,
        realtimeCircuitMs,
      },
    });
    this.warnRealtimeStatusFailure('Realtime 连续失败，降级到轮询', {
      consecutiveErrors: state.consecutiveErrors,
      realtimeCircuitMs,
      error: err?.message,
    });
  }

  private handleRealtimeSubscribedStatus(
    state: RealtimeSubscribeState,
    runtime: RealtimeStatusControllerRuntime,
  ): void {
    const previousStatus = state.previousStatus;
    state.consecutiveErrors = 0;
    this.clearRealtimeTransportCircuitSafely(state.projectId);

    if (previousStatus && previousStatus !== 'SUBSCRIBED') {
      this.infoRealtimeStatus('Realtime 重连成功，触发增量同步', { previousStatus });
      try {
        runtime.triggerRealtimeReconnectChange(state.projectId);
      } catch (error) {
        this.warnRealtimeStatusFailure('Realtime 重连后增量同步触发失败', error);
      }
    }
  }

  private addRealtimeBreadcrumb(
    breadcrumb: Parameters<RealtimeStatusTelemetry['addBreadcrumb']>[0],
  ): void {
    try {
      this.sentryLazyLoader.addBreadcrumb(breadcrumb);
    } catch {
      // Telemetry sinks must not block realtime fallback or recovery paths.
    }
  }

  private captureRealtimeMessage(
    message: string,
    context: Parameters<RealtimeStatusTelemetry['captureMessage']>[1],
  ): void {
    try {
      this.sentryLazyLoader.captureMessage(message, context);
    } catch {
      // Telemetry sinks must not block realtime fallback or recovery paths.
    }
  }

  private warnRealtimeStatusFailure(message: string, data?: unknown): void {
    try {
      this.logger.warn(message, data);
    } catch {
      // Warning sinks must not block realtime fallback or recovery paths.
    }
  }

  private isStateCurrentSafely(
    state: RealtimeSubscribeState,
    runtime: RealtimeStatusControllerRuntime,
  ): boolean {
    try {
      return runtime.isStateCurrent(state);
    } catch (error) {
      this.warnRealtimeStatusFailure('Realtime 订阅状态归属判定失败，已忽略本次状态', error);
      return false;
    }
  }

  private clearRealtimeTransportCircuitSafely(projectId: string): void {
    try {
      this.transportCircuit.clearBackoff(projectId);
    } catch (error) {
      this.warnRealtimeStatusFailure('Realtime 熔断退避清理失败', error);
    }

    try {
      this.transportCircuit.clearCircuit();
    } catch (error) {
      this.warnRealtimeStatusFailure('Realtime 熔断状态清理失败', error);
    }
  }

  private armRealtimeTransportCircuitSafely(
    userId: string,
    errorMessage: string | undefined,
    consecutiveErrors: number,
  ): number {
    try {
      return this.transportCircuit.armCircuit(userId, errorMessage, consecutiveErrors);
    } catch (error) {
      this.warnRealtimeStatusFailure('Realtime 熔断状态写入失败', error);
      return 0;
    }
  }

  private infoRealtimeStatus(message: string, data?: unknown): void {
    try {
      this.logger.info(message, data);
    } catch {
      // Diagnostic sinks must not block realtime status transitions.
    }
  }

  private debugRealtimeStatus(message: string, data?: unknown): void {
    try {
      this.logger.debug(message, data);
    } catch {
      // Diagnostic sinks must not block realtime status transitions.
    }
  }
}
