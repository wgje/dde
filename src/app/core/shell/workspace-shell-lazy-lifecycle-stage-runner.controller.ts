export interface WorkspaceShellLazyLifecycleStageStep {
  label: string;
  run: () => void;
}

export interface WorkspaceShellLazyLifecycleStageRunnerControllerOptions {
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellLazyLifecycleStageRunnerController {
  constructor(private readonly options: WorkspaceShellLazyLifecycleStageRunnerControllerOptions) {}

  run(steps: readonly WorkspaceShellLazyLifecycleStageStep[]): void {
    for (const step of steps) {
      this.runStep(step);
    }
  }

  private runStep(step: WorkspaceShellLazyLifecycleStageStep): void {
    try {
      step.run();
    } catch (error) {
      this.warnStepFailure(step.label, error);
    }
  }

  private warnStepFailure(label: string, error: unknown): void {
    try {
      this.options.warn(
        `工作区懒生命周期步骤 ${label} 执行失败，已继续后续生命周期`,
        error,
      );
    } catch {
      // Logger failure must not interrupt best-effort lifecycle cleanup.
    }
  }
}
