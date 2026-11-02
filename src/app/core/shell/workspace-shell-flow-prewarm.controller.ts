import {
  WorkspaceShellFlowPrewarmSchedulerController,
  type WorkspaceShellFlowPrewarmScheduledHandle,
} from './workspace-shell-flow-prewarm-scheduler.controller';
import {
  WorkspaceShellFlowPrewarmTraceController,
  type FlowPrewarmStatus,
} from './workspace-shell-flow-prewarm-trace.controller';

export type {
  FlowPrewarmStatus,
  FlowPrewarmTraceEvent,
} from './workspace-shell-flow-prewarm-trace.controller';

export interface WorkspaceShellFlowPrewarmResult {
  warmed: boolean;
  warmedServices?: string[];
}

export interface WorkspaceShellFlowPrewarmControllerOptions {
  isDestroyed: () => boolean;
  prewarmFlow?: () => Promise<WorkspaceShellFlowPrewarmResult>;
  schedule?: (callback: () => void) => WorkspaceShellFlowPrewarmScheduledHandle;
  clearScheduled?: (handle: WorkspaceShellFlowPrewarmScheduledHandle) => void;
  gateScheduledPrewarm?: (resume: () => void) => (() => void) | void;
  trace?: Pick<WorkspaceShellFlowPrewarmTraceController, 'record'>;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellFlowPrewarmController {
  private currentStatus: FlowPrewarmStatus = 'idle';
  private prewarmPromise: Promise<WorkspaceShellFlowPrewarmResult> | null = null;
  private generation = 0;
  private currentReason = '';
  private readonly scheduler: WorkspaceShellFlowPrewarmSchedulerController;
  private readonly trace: Pick<WorkspaceShellFlowPrewarmTraceController, 'record'>;
  private gateRelease: (() => void) | null = null;

  constructor(private readonly options: WorkspaceShellFlowPrewarmControllerOptions) {
    this.scheduler = new WorkspaceShellFlowPrewarmSchedulerController({
      schedule: options.schedule,
      clearScheduled: options.clearScheduled,
    });
    this.trace = options.trace ?? new WorkspaceShellFlowPrewarmTraceController();
  }

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
    this.trace.record('scheduled', reason);
    if (this.options.gateScheduledPrewarm) {
      this.registerScheduledGate(reason);
      return;
    }

    this.schedulePrewarm(reason);
  }

  private registerScheduledGate(reason: string): void {
    try {
      const gateRelease = this.options.gateScheduledPrewarm?.(() => {
        if (this.currentStatus !== 'scheduled') {
          return;
        }
        this.gateRelease = null;
        this.schedulePrewarm(reason);
      });
      if (this.currentStatus === 'scheduled' && typeof gateRelease === 'function') {
        this.gateRelease = gateRelease;
      }
    } catch (error) {
      if (this.currentStatus === 'scheduled') {
        this.currentStatus = 'failed';
        this.trace.record('failed', reason);
      }
      this.warn('Flow 预热 P1 gate 注册失败，已允许稍后重试', error);
    }
  }

  private schedulePrewarm(reason: string): void {
    try {
      this.scheduler.schedule(() => {
        if (this.currentStatus !== 'scheduled') {
          return;
        }
        this.startPrewarm(reason);
      });
    } catch (error) {
      if (this.currentStatus === 'scheduled') {
        this.currentStatus = 'failed';
        this.trace.record('failed', reason);
      }
      this.warn('Flow 预热调度失败，已允许稍后重试', error);
    }
  }

  teardown(): void {
    this.generation += 1;
    try {
      this.gateRelease?.();
    } catch (error) {
      this.warn('Flow 预热 P1 gate 清理失败，已继续清理', error);
    }
    this.gateRelease = null;
    try {
      this.scheduler.clear();
    } catch (error) {
      this.warn('Flow 预热调度清理失败，已继续清理', error);
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

    this.gateRelease = null;
    this.currentStatus = 'loading';
    this.trace.record('loading', this.currentReason || reason);
    const generation = this.generation;
    this.prewarmPromise = Promise.resolve()
      .then(() => this.prewarmFlow())
      .then(result => {
        if (this.isCurrentGeneration(generation)) {
          this.currentStatus = result.warmed ? 'ready' : 'failed';
          this.trace.record(this.currentStatus, this.currentReason || reason);
          this.prewarmPromise = null;
        }
        return result;
      })
      .catch(error => {
        if (this.isCurrentGeneration(generation)) {
          this.prewarmPromise = null;
          this.currentStatus = 'failed';
          this.trace.record('failed', this.currentReason || reason);
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

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not interrupt prewarm retry or teardown state resets.
    }
  }

}
