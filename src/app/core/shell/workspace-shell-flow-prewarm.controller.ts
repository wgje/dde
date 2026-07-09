export type FlowPrewarmStatus = 'idle' | 'scheduled' | 'loading' | 'ready' | 'failed';

export interface WorkspaceShellFlowPrewarmResult {
  warmed: boolean;
  warmedServices?: string[];
}

export interface WorkspaceShellFlowPrewarmControllerOptions {
  isDestroyed: () => boolean;
  prewarmFlow?: () => Promise<WorkspaceShellFlowPrewarmResult>;
  schedule?: (callback: () => void) => ReturnType<typeof setTimeout> | number;
  clearScheduled?: (handle: ReturnType<typeof setTimeout> | number) => void;
  warn: (message: string, error: unknown) => void;
}

export interface FlowPrewarmTraceEvent {
  status: FlowPrewarmStatus;
  reason: string;
  at: number;
}

export class WorkspaceShellFlowPrewarmController {
  private currentStatus: FlowPrewarmStatus = 'idle';
  private scheduledHandle: ReturnType<typeof setTimeout> | number | null = null;
  private prewarmPromise: Promise<WorkspaceShellFlowPrewarmResult> | null = null;
  private generation = 0;
  private currentReason = '';

  constructor(private readonly options: WorkspaceShellFlowPrewarmControllerOptions) {}

  status(): FlowPrewarmStatus {
    return this.currentStatus;
  }

  scheduleAggressivePrewarm(reason: string): void {
    if (
      this.options.isDestroyed() ||
      this.currentStatus === 'scheduled' ||
      this.currentStatus === 'loading' ||
      this.currentStatus === 'ready'
    ) {
      return;
    }

    this.currentStatus = 'scheduled';
    this.currentReason = reason;
    this.recordTrace('scheduled', reason);
    let ranScheduledCallbackSynchronously = false;
    try {
      const scheduledHandle = this.schedule(() => {
        if (this.currentStatus !== 'scheduled') {
          return;
        }
        ranScheduledCallbackSynchronously = true;
        this.scheduledHandle = null;
        this.startPrewarm(reason);
      });
      this.scheduledHandle = ranScheduledCallbackSynchronously ? null : scheduledHandle;
    } catch (error) {
      this.scheduledHandle = null;
      if (!ranScheduledCallbackSynchronously && this.currentStatus === 'scheduled') {
        this.currentStatus = 'failed';
        this.recordTrace('failed', reason);
      }
      this.warn('Flow 预热调度失败，已允许稍后重试', error);
    }
  }

  teardown(): void {
    this.generation += 1;
    if (this.scheduledHandle !== null) {
      try {
        this.clearScheduled(this.scheduledHandle);
      } catch (error) {
        this.warn('Flow 预热调度清理失败，已继续清理', error);
      }
      this.scheduledHandle = null;
    }
    this.prewarmPromise = null;
    this.currentStatus = 'idle';
    this.currentReason = '';
  }

  private startPrewarm(reason: string): void {
    if (this.options.isDestroyed()) {
      this.currentStatus = 'idle';
      return;
    }

    this.currentStatus = 'loading';
    this.recordTrace('loading', this.currentReason || reason);
    const generation = this.generation;
    this.prewarmPromise = Promise.resolve()
      .then(() => this.prewarmFlow())
      .then(result => {
        if (this.isCurrentGeneration(generation)) {
          this.currentStatus = result.warmed ? 'ready' : 'failed';
          this.recordTrace(this.currentStatus, this.currentReason || reason);
          this.prewarmPromise = null;
        }
        return result;
      })
      .catch(error => {
        if (this.isCurrentGeneration(generation)) {
          this.prewarmPromise = null;
          this.currentStatus = 'failed';
          this.recordTrace('failed', this.currentReason || reason);
          this.warn('Flow 预热失败，已允许稍后重试', error);
        }
        throw error;
      });

    void this.prewarmPromise.catch(() => undefined);
  }

  private prewarmFlow(): Promise<WorkspaceShellFlowPrewarmResult> {
    if (this.options.prewarmFlow) {
      return this.options.prewarmFlow();
    }

    return import('../../features/flow/flow-prewarm')
      .then(({ prewarmFlowFeature }) => prewarmFlowFeature());
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.generation && !this.options.isDestroyed();
  }

  private schedule(callback: () => void): ReturnType<typeof setTimeout> | number {
    if (this.options.schedule) {
      return this.options.schedule(callback);
    }

    const requestIdle = globalThis.requestIdleCallback;
    if (typeof requestIdle === 'function') {
      return requestIdle(callback, { timeout: 750 });
    }

    return setTimeout(callback, 0);
  }

  private clearScheduled(handle: ReturnType<typeof setTimeout> | number): void {
    if (this.options.clearScheduled) {
      this.options.clearScheduled(handle);
      return;
    }

    const cancelIdle = globalThis.cancelIdleCallback;
    if (typeof cancelIdle === 'function' && typeof handle === 'number') {
      cancelIdle(handle);
      return;
    }

    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not interrupt prewarm retry or teardown state resets.
    }
  }

  private recordTrace(status: FlowPrewarmStatus, reason: string): void {
    try {
      const target = globalThis as typeof globalThis & {
        __NANOFLOW_FLOW_PREWARM_TRACE__?: FlowPrewarmTraceEvent[];
      };
      const records = Array.isArray(target.__NANOFLOW_FLOW_PREWARM_TRACE__)
        ? target.__NANOFLOW_FLOW_PREWARM_TRACE__
        : [];
      target.__NANOFLOW_FLOW_PREWARM_TRACE__ = [
        ...records,
        {
          status,
          reason,
          at: typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now(),
        },
      ];
    } catch {
      // E2E trace only; never affect production behavior.
    }
  }
}
