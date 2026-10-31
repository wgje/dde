import type { AndroidWidgetBootstrapCallbackResult } from '../../../services/widget-binding.service';
import type { AndroidWidgetBootstrapRequest } from '../../../utils/startup-entry-intent';

export type WorkspaceShellAndroidWidgetBootstrapCompleteResult =
  | { ok: true; value: AndroidWidgetBootstrapCallbackResult }
  | { ok: false; error: { code: string; message: string } };

export interface WorkspaceShellAndroidWidgetBootstrapCompletionControllerOptions {
  completeAndroidBootstrap: (
    request: AndroidWidgetBootstrapRequest,
  ) => Promise<WorkspaceShellAndroidWidgetBootstrapCompleteResult>;
  currentUserId: () => string | null;
  isSessionInitialized: () => boolean;
  navigateToCallback: (callback: AndroidWidgetBootstrapCallbackResult) => void;
  settleBootstrapState: () => void;
  warn: (message: string, context?: unknown) => void;
  warningToast: (title: string, message: string) => void;
}

export class WorkspaceShellAndroidWidgetBootstrapCompletionController {
  private inFlight = false;

  constructor(
    private readonly options: WorkspaceShellAndroidWidgetBootstrapCompletionControllerOptions,
  ) {}

  isInFlight(): boolean {
    return this.inFlight;
  }

  async complete(bootstrapRequest: AndroidWidgetBootstrapRequest): Promise<void> {
    const completionUserId = this.options.currentUserId();
    const sessionInitializedAtStart = this.options.isSessionInitialized();
    this.inFlight = true;

    try {
      let result: WorkspaceShellAndroidWidgetBootstrapCompleteResult;
      try {
        result = await this.options.completeAndroidBootstrap(bootstrapRequest);
      } catch (error) {
        this.safeWarn('Android widget bootstrap 完成异常', {
          error,
          hostInstanceId: bootstrapRequest.hostInstanceId,
        });
        return;
      }

      if (!this.isCompletionScopeCurrent(completionUserId, sessionInitializedAtStart)) {
        this.safeWarn('忽略陈旧的 Android widget bootstrap 完成结果', {
          hostInstanceId: bootstrapRequest.hostInstanceId,
          completionUserId,
          currentUserId: this.options.currentUserId(),
          sessionInitialized: this.options.isSessionInitialized(),
        });
        return;
      }

      this.options.settleBootstrapState();
      if (!result.ok) {
        this.safeWarn('Android widget bootstrap 失败', {
          code: result.error.code,
          message: result.error.message,
          hostInstanceId: bootstrapRequest.hostInstanceId,
        });
        this.safeWarningToast('Android 小组件初始化失败', '绑定未完成，请重新打开 NanoFlow 小组件');
        return;
      }

      this.options.navigateToCallback(result.value);
    } finally {
      this.inFlight = false;
    }
  }

  private isCompletionScopeCurrent(
    completionUserId: string | null,
    sessionInitializedAtStart: boolean,
  ): boolean {
    return sessionInitializedAtStart
      && !!completionUserId
      && this.options.isSessionInitialized()
      && this.options.currentUserId() === completionUserId;
  }

  private safeWarn(message: string, context?: unknown): void {
    try {
      if (context === undefined) {
        this.options.warn(message);
      } else {
        this.options.warn(message, context);
      }
    } catch {
      // Completion cleanup must not depend on observability sinks.
    }
  }

  private safeWarningToast(title: string, message: string): void {
    try {
      this.options.warningToast(title, message);
    } catch {
      // Completion is already settled before notifying the user.
    }
  }
}
