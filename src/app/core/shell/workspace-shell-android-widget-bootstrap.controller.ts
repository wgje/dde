import type {
  AndroidWidgetBootstrapRequest,
  StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import type { RuntimePlatformSnapshot } from '../../../utils/runtime-platform';
import type { AndroidWidgetBootstrapCallbackResult } from '../../../services/widget-binding.service';
import {
  resolveAndroidWidgetBootstrapCaptureDecision,
  resolveAndroidWidgetBootstrapTrust,
} from './workspace-shell-android-widget-bootstrap.helpers';

type AndroidWidgetBootstrapCompleteResult =
  | { ok: true; value: AndroidWidgetBootstrapCallbackResult }
  | { ok: false; error: { code: string; message: string } };

export interface WorkspaceShellAndroidWidgetBootstrapControllerOptions {
  getPendingBootstrap: () => AndroidWidgetBootstrapRequest | null;
  setPendingBootstrap: (request: AndroidWidgetBootstrapRequest | null) => void;
  setDeferredStartupEntryIntent: (startupEntryIntent: StartupEntryIntent | null) => void;
  persistPendingBootstrap: (request: AndroidWidgetBootstrapRequest | null) => void;
  persistDeferredStartupEntryIntent: (startupEntryIntent: StartupEntryIntent | null) => void;
  consumeStartupEntryIntent: (onCleanupFailed?: () => void) => void;
  completeAndroidBootstrap: (
    request: AndroidWidgetBootstrapRequest,
  ) => Promise<AndroidWidgetBootstrapCompleteResult>;
  currentUserId: () => string | null;
  isSessionInitialized: () => boolean;
  navigateToCallback: (callback: AndroidWidgetBootstrapCallbackResult) => void;
  readRuntimePlatform: () => Pick<RuntimePlatformSnapshot, 'isAndroid' | 'isTwa'>;
  warn: (message: string, context?: unknown) => void;
  warningToast: (title: string, message: string) => void;
}

export class WorkspaceShellAndroidWidgetBootstrapController {
  private captureKey: string | null = null;
  private inFlight = false;

  constructor(private readonly options: WorkspaceShellAndroidWidgetBootstrapControllerOptions) {}

  isInFlight(): boolean {
    return this.inFlight;
  }

  captureFromRoute(routeUrl: string | null): boolean {
    const decision = resolveAndroidWidgetBootstrapCaptureDecision({
      routeUrl,
      currentCaptureKey: this.captureKey,
      isTrustedBootstrapRequest: (bootstrapRequest, nextRouteUrl) =>
        resolveAndroidWidgetBootstrapTrust({
          bootstrapRequest,
          routeUrl: nextRouteUrl,
          runtimePlatform: this.options.readRuntimePlatform(),
          pendingBootstrap: this.options.getPendingBootstrap(),
        }),
    });

    if (decision.kind === 'none') {
      this.captureKey = decision.nextCaptureKey;
      return false;
    }

    this.captureKey = decision.captureKey;

    if (decision.kind === 'corrupt' || decision.kind === 'untrusted') {
      this.clearPendingBootstrap();
      this.setDeferredStartupEntryIntent(decision.startupEntryIntent);
      this.safeWarn(decision.kind === 'corrupt'
        ? '忽略损坏的 Android widget bootstrap 参数'
        : '忽略不可信环境中的 Android widget bootstrap 请求');
      this.consumeStartupEntryIntent(decision.captureKey);
      return true;
    }

    this.options.setPendingBootstrap(decision.bootstrapRequest);
    this.persistPendingBootstrap(decision.bootstrapRequest);
    this.setDeferredStartupEntryIntent(decision.startupEntryIntent);
    this.consumeStartupEntryIntent(decision.captureKey);
    return true;
  }

  async complete(bootstrapRequest: AndroidWidgetBootstrapRequest): Promise<void> {
    const completionUserId = this.options.currentUserId();
    const sessionInitializedAtStart = this.options.isSessionInitialized();
    this.inFlight = true;

    try {
      let result: AndroidWidgetBootstrapCompleteResult;
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

      this.setDeferredStartupEntryIntent(null);

      this.clearPendingBootstrap();
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

  private clearPendingBootstrap(): void {
    this.options.setPendingBootstrap(null);
    this.persistPendingBootstrap(null);
  }

  private releaseCaptureKey(captureKey: string): void {
    if (this.captureKey === captureKey) {
      this.captureKey = null;
    }
  }

  private consumeStartupEntryIntent(captureKey: string): void {
    try {
      this.options.consumeStartupEntryIntent(() => this.releaseCaptureKey(captureKey));
    } catch (error) {
      this.releaseCaptureKey(captureKey);
      this.safeWarn('Android widget bootstrap startup query cleanup failed', error);
    }
  }

  private setDeferredStartupEntryIntent(startupEntryIntent: StartupEntryIntent | null): void {
    this.options.setDeferredStartupEntryIntent(startupEntryIntent);
    this.persistDeferredStartupEntryIntent(startupEntryIntent);
  }

  private persistPendingBootstrap(request: AndroidWidgetBootstrapRequest | null): void {
    try {
      this.options.persistPendingBootstrap(request);
    } catch (error) {
      this.safeWarn('Android widget bootstrap pending state persistence failed', {
        error,
        hostInstanceId: request?.hostInstanceId ?? null,
      });
    }
  }

  private persistDeferredStartupEntryIntent(startupEntryIntent: StartupEntryIntent | null): void {
    try {
      this.options.persistDeferredStartupEntryIntent(startupEntryIntent);
    } catch (error) {
      this.safeWarn('Android widget bootstrap startup intent persistence failed', {
        error,
        startupEntryIntent,
      });
    }
  }

  private safeWarn(message: string, context?: unknown): void {
    try {
      if (context === undefined) {
        this.options.warn(message);
      } else {
        this.options.warn(message, context);
      }
    } catch {
      // Bootstrap cleanup must not depend on observability sinks.
    }
  }

  private safeWarningToast(title: string, message: string): void {
    try {
      this.options.warningToast(title, message);
    } catch {
      // Bootstrap completion is already settled before notifying the user.
    }
  }
}
