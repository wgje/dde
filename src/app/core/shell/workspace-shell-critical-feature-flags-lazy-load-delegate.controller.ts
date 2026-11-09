import type {
  WorkspaceShellCriticalFeatureFlagsDelegate,
  WorkspaceShellCriticalFeatureFlagsLazyLoadDelegateOptions,
} from './workspace-shell-critical-feature-flags-lazy-load-delegate.factory';

export class WorkspaceShellCriticalFeatureFlagsLazyLoadDelegateController
implements WorkspaceShellCriticalFeatureFlagsDelegate {
  private controller: WorkspaceShellCriticalFeatureFlagsDelegate | null = null;
  private controllerPromise: Promise<WorkspaceShellCriticalFeatureFlagsDelegate> | null = null;

  constructor(
    private readonly options: WorkspaceShellCriticalFeatureFlagsLazyLoadDelegateOptions,
  ) {}

  validate(): void {
    void this.loadController()
      .then(controller => this.validateController(controller))
      .catch(() => undefined);
  }

  private loadController(): Promise<WorkspaceShellCriticalFeatureFlagsDelegate> {
    if (this.controller) {
      return Promise.resolve(this.controller);
    }

    return (this.controllerPromise ??= this.resolveController()
      .then(controller => {
        this.controller = controller;
        return controller;
      })
      .catch(error => {
        this.controllerPromise = null;
        this.options.warn(
          '关键安全开关 lazy-load 校验器加载失败，已跳过本次启动校验',
          error,
        );
        throw error;
      }));
  }

  private validateController(controller: WorkspaceShellCriticalFeatureFlagsDelegate): void {
    try {
      controller.validate();
    } catch (error) {
      this.options.warn(
        '关键安全开关 lazy-load 校验器执行失败，已跳过本次启动校验',
        error,
      );
    }
  }

  private async resolveController(): Promise<WorkspaceShellCriticalFeatureFlagsDelegate> {
    if (this.options.createCriticalFeatureFlagsController) {
      return this.options.createCriticalFeatureFlagsController();
    }

    const [
      { WorkspaceShellCriticalFeatureFlagsController },
      { validateCriticalFlags },
    ] = await Promise.all([
      import('./workspace-shell-critical-feature-flags.controller'),
      import('../../../config/feature-flags.config'),
    ]);

    return new WorkspaceShellCriticalFeatureFlagsController({
      validateCriticalFlags,
      warn: this.options.warn,
      warning: this.options.warning,
      getHostname: this.options.getHostname,
    });
  }
}
