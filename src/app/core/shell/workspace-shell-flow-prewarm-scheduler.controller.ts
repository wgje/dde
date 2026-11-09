export type WorkspaceShellFlowPrewarmScheduledHandle =
  ReturnType<typeof setTimeout> | number;

export interface WorkspaceShellFlowPrewarmSchedulerControllerOptions {
  schedule?: (
    callback: () => void,
  ) => WorkspaceShellFlowPrewarmScheduledHandle;
  clearScheduled?: (handle: WorkspaceShellFlowPrewarmScheduledHandle) => void;
}

export class WorkspaceShellFlowPrewarmSchedulerController {
  private scheduledHandle: WorkspaceShellFlowPrewarmScheduledHandle | null = null;

  constructor(
    private readonly options: WorkspaceShellFlowPrewarmSchedulerControllerOptions = {},
  ) {}

  schedule(callback: () => void): void {
    let ranSynchronously = false;
    const scheduledHandle = this.scheduleCallback(() => {
      ranSynchronously = true;
      this.scheduledHandle = null;
      callback();
    });
    this.scheduledHandle = ranSynchronously ? null : scheduledHandle;
  }

  clear(): void {
    if (this.scheduledHandle === null) return;

    const scheduledHandle = this.scheduledHandle;
    this.scheduledHandle = null;
    this.clearCallback(scheduledHandle);
  }

  private scheduleCallback(
    callback: () => void,
  ): WorkspaceShellFlowPrewarmScheduledHandle {
    if (this.options.schedule) {
      return this.options.schedule(callback);
    }

    const requestIdle = globalThis.requestIdleCallback;
    if (typeof requestIdle === 'function') {
      return requestIdle(callback, { timeout: 750 });
    }

    return setTimeout(callback, 0);
  }

  private clearCallback(handle: WorkspaceShellFlowPrewarmScheduledHandle): void {
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
