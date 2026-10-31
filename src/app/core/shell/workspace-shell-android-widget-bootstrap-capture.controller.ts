import type {
  AndroidWidgetBootstrapRequest,
  StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import type { RuntimePlatformSnapshot } from '../../../utils/runtime-platform';
import {
  resolveAndroidWidgetBootstrapCaptureDecision,
  resolveAndroidWidgetBootstrapTrust,
} from './workspace-shell-android-widget-bootstrap.helpers';

export interface WorkspaceShellAndroidWidgetBootstrapCaptureControllerOptions {
  getPendingBootstrap: () => AndroidWidgetBootstrapRequest | null;
  setPendingBootstrap: (request: AndroidWidgetBootstrapRequest | null) => void;
  setDeferredStartupEntryIntent: (startupEntryIntent: StartupEntryIntent | null) => void;
  persistPendingBootstrap: (request: AndroidWidgetBootstrapRequest | null) => void;
  persistDeferredStartupEntryIntent: (startupEntryIntent: StartupEntryIntent | null) => void;
  consumeStartupEntryIntent: (onCleanupFailed?: () => void) => void;
  readRuntimePlatform: () => Pick<RuntimePlatformSnapshot, 'isAndroid' | 'isTwa'>;
  warn: (message: string, context?: unknown) => void;
}

export class WorkspaceShellAndroidWidgetBootstrapCaptureController {
  private captureKey: string | null = null;

  constructor(
    private readonly options: WorkspaceShellAndroidWidgetBootstrapCaptureControllerOptions,
  ) {}

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

  clearCompletedBootstrapState(): void {
    this.setDeferredStartupEntryIntent(null);
    this.clearPendingBootstrap();
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
}
