import type {
  WorkspaceShellCriticalFeatureFlagsDelegate,
} from './workspace-shell-critical-feature-flags-lazy-load-delegate.factory';

const LOAD_FAILURE_MESSAGE =
  '关键安全开关 lazy-load delegate 加载失败，已跳过本次启动校验';

export interface WorkspaceShellCriticalFeatureFlagsDelegateLoaderControllerOptions {
  loadDelegate: () => Promise<WorkspaceShellCriticalFeatureFlagsDelegate>;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellCriticalFeatureFlagsDelegateLoaderController
implements WorkspaceShellCriticalFeatureFlagsDelegate {
  private delegatePromise: Promise<WorkspaceShellCriticalFeatureFlagsDelegate> | null = null;

  constructor(
    private readonly options: WorkspaceShellCriticalFeatureFlagsDelegateLoaderControllerOptions,
  ) {}

  validate(): void {
    void this.loadDelegate()
      .then(delegate => delegate.validate())
      .catch(() => undefined);
  }

  private loadDelegate(): Promise<WorkspaceShellCriticalFeatureFlagsDelegate> {
    if (this.delegatePromise) {
      return this.delegatePromise;
    }

    const delegatePromise = this.createDelegateSafely()
      .catch(error => {
        if (this.delegatePromise === delegatePromise) {
          this.delegatePromise = null;
        }
        this.warn(error);
        throw error;
      });
    this.delegatePromise = delegatePromise;
    return delegatePromise;
  }

  private createDelegateSafely(): Promise<WorkspaceShellCriticalFeatureFlagsDelegate> {
    try {
      return Promise.resolve(this.options.loadDelegate());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private warn(error: unknown): void {
    try {
      this.options.warn(LOAD_FAILURE_MESSAGE, error);
    } catch {
      // Warning failures must not block the lazy-load retry boundary.
    }
  }
}
