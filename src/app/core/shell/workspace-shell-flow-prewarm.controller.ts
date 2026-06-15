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

export class WorkspaceShellFlowPrewarmController {
  private currentStatus: FlowPrewarmStatus = 'idle';
  private scheduledHandle: ReturnType<typeof setTimeout> | number | null = null;
  private prewarmPromise: Promise<WorkspaceShellFlowPrewarmResult> | null = null;
  private generation = 0;

  constructor(private readonly options: WorkspaceShellFlowPrewarmControllerOptions) {}

  status(): FlowPrewarmStatus {
    return this.currentStatus;
  }

  scheduleAggressivePrewarm(_reason: string): void {
    if (
      this.options.isDestroyed() ||
      this.currentStatus === 'scheduled' ||
      this.currentStatus === 'loading' ||
      this.currentStatus === 'ready'
    ) {
      return;
    }

    this.currentStatus = 'scheduled';
    this.scheduledHandle = this.schedule(() => {
      if (this.currentStatus !== 'scheduled') {
        return;
      }
      this.scheduledHandle = null;
      this.startPrewarm();
    });
  }

  teardown(): void {
    this.generation += 1;
    if (this.scheduledHandle !== null) {
      this.clearScheduled(this.scheduledHandle);
      this.scheduledHandle = null;
    }
    this.prewarmPromise = null;
    this.currentStatus = 'idle';
  }

  private startPrewarm(): void {
    if (this.options.isDestroyed()) {
      this.currentStatus = 'idle';
      return;
    }

    this.currentStatus = 'loading';
    const generation = this.generation;
    this.prewarmPromise = Promise.resolve()
      .then(() => this.prewarmFlow())
      .then(result => {
        if (this.isCurrentGeneration(generation)) {
          this.currentStatus = result.warmed ? 'ready' : 'failed';
          this.prewarmPromise = null;
        }
        return result;
      })
      .catch(error => {
        if (this.isCurrentGeneration(generation)) {
          this.prewarmPromise = null;
          this.currentStatus = 'failed';
          this.options.warn('Flow 预热失败，已允许稍后重试', error);
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
}
