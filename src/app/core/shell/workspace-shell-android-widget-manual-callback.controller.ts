import type { WritableSignal } from '@angular/core';
import type { BeforeUnloadManagerService } from '../../../services/before-unload-manager.service';
import type { CategoryLogger } from '../../../services/logger.service';
import type { AndroidWidgetBootstrapCallbackResult } from '../../../services/widget-binding.service';
import type { RuntimePlatformSnapshot } from '../../../utils/runtime-platform';

interface WorkspaceShellAndroidWidgetManualCallbackWindow {
  location: Pick<Location, 'assign' | 'replace'>;
}

interface WorkspaceShellAndroidWidgetManualCallbackOptions {
  pendingCallback: WritableSignal<AndroidWidgetBootstrapCallbackResult | null>;
  beforeUnloadManager: Pick<BeforeUnloadManagerService, 'suppressNextConfirmation'>;
  logger: Pick<CategoryLogger, 'warn'>;
  getWindow: () => WorkspaceShellAndroidWidgetManualCallbackWindow | undefined;
  getDocument: () => Document | object | undefined;
  readRuntimePlatform: () => Pick<RuntimePlatformSnapshot, 'isAndroid' | 'isTwa'>;
}

/** Coordinates Android widget callback navigation that may require a user gesture. */
export class WorkspaceShellAndroidWidgetManualCallbackController {
  constructor(private readonly options: WorkspaceShellAndroidWidgetManualCallbackOptions) {}

  navigate(callback: AndroidWidgetBootstrapCallbackResult): void {
    const windowRef = this.options.getWindow();
    if (!windowRef) return;

    const runtimePlatform = this.options.readRuntimePlatform();
    const requiresManualCallback = runtimePlatform.isAndroid
      && !runtimePlatform.isTwa
      && this.options.getDocument() !== undefined;

    if (!requiresManualCallback) {
      try {
        windowRef.location.assign(callback.callbackUrl);
      } catch (error) {
        this.safeWarn('Android widget callback 直接回跳失败，等待用户显式回跳', { error });
        this.options.pendingCallback.set(callback);
      }
      return;
    }

    this.safeWarn('Android widget callback 改为等待用户显式回跳');
    this.options.pendingCallback.set(callback);
  }

  continueManualCallback(): void {
    this.navigateWithUserGesture('assign', 'Android widget callback 使用显式确认回跳');
  }

  useIntentFallback(): void {
    this.navigateWithUserGesture('replace', 'Android widget callback 使用显式 intent fallback');
  }

  dismiss(): void {
    this.options.pendingCallback.set(null);
  }

  private navigateWithUserGesture(action: 'assign' | 'replace', logMessage: string): void {
    const callback = this.options.pendingCallback();
    const windowRef = this.options.getWindow();
    if (!callback || !windowRef) return;

    this.safeWarn(logMessage);
    try {
      windowRef.location[action](callback.callbackIntentUrl);
    } catch (error) {
      this.safeWarn('Android widget callback 回跳失败', { action, error });
      return;
    }

    try {
      this.options.beforeUnloadManager.suppressNextConfirmation();
    } catch (error) {
      this.safeWarn('Android widget callback beforeunload 抑制失败，已继续清理 pending callback', {
        action,
        error,
      });
    }
    this.options.pendingCallback.set(null);
  }

  private safeWarn(message: string, data?: unknown): void {
    try {
      if (data === undefined) {
        this.options.logger.warn(message);
      } else {
        this.options.logger.warn(message, data);
      }
    } catch {
      // Android widget callback navigation must not depend on observability sinks.
    }
  }
}
