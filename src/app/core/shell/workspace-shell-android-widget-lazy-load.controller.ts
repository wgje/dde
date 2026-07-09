import type { WritableSignal } from '@angular/core';
import type { BeforeUnloadManagerService } from '../../../services/before-unload-manager.service';
import type { CategoryLogger } from '../../../services/logger.service';
import type { AndroidWidgetBootstrapCallbackResult } from '../../../services/widget-binding.service';
import type { RuntimePlatformSnapshot } from '../../../utils/runtime-platform';
import type {
  AndroidWidgetBootstrapRequest,
  StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import { WorkspaceShellAndroidWidgetBootstrapController } from './workspace-shell-android-widget-bootstrap.controller';
import { WorkspaceShellAndroidWidgetBootstrapProcessingController } from './workspace-shell-android-widget-bootstrap-processing.controller';
import { WorkspaceShellAndroidWidgetBootstrapStorageController } from './workspace-shell-android-widget-bootstrap-storage.controller';
import { WorkspaceShellAndroidWidgetManualCallbackController } from './workspace-shell-android-widget-manual-callback.controller';

type AndroidWidgetBootstrapCompleteResult =
  | { ok: true; value: AndroidWidgetBootstrapCallbackResult }
  | { ok: false; error: { code: string; message: string } };

interface WorkspaceShellAndroidWidgetLazyLoadWindow {
  location: Pick<Location, 'assign' | 'replace'>;
}

export interface WorkspaceShellAndroidWidgetLazyLoadControllerOptions {
  getStorage: () => Storage | null;
  pendingBootstrap: WritableSignal<AndroidWidgetBootstrapRequest | null>;
  pendingCallback: WritableSignal<AndroidWidgetBootstrapCallbackResult | null>;
  deferredStartupEntryIntent: WritableSignal<StartupEntryIntent | null>;
  currentUserId: () => string | null;
  isSessionInitialized: () => boolean;
  completeAndroidBootstrap: (
    request: AndroidWidgetBootstrapRequest,
  ) => Promise<AndroidWidgetBootstrapCompleteResult>;
  consumeStartupEntryIntent: (onCleanupFailed?: () => void) => void;
  beforeUnloadManager: Pick<BeforeUnloadManagerService, 'suppressNextConfirmation'>;
  logger: Pick<CategoryLogger, 'warn'>;
  getWindow: () => WorkspaceShellAndroidWidgetLazyLoadWindow | undefined;
  getDocument: () => Document | object | undefined;
  readRuntimePlatform: () => Pick<RuntimePlatformSnapshot, 'isAndroid' | 'isTwa'>;
  warningToast: (title: string, message: string) => void;
}

export class WorkspaceShellAndroidWidgetLazyLoadController {
  private readonly storage: WorkspaceShellAndroidWidgetBootstrapStorageController;
  private readonly manualCallback: WorkspaceShellAndroidWidgetManualCallbackController;
  private readonly bootstrap: WorkspaceShellAndroidWidgetBootstrapController;
  private readonly processing: WorkspaceShellAndroidWidgetBootstrapProcessingController;

  constructor(private readonly options: WorkspaceShellAndroidWidgetLazyLoadControllerOptions) {
    this.storage = new WorkspaceShellAndroidWidgetBootstrapStorageController({
      getStorage: this.options.getStorage,
      pendingAndroidWidgetBootstrap: this.options.pendingBootstrap,
      deferredStartupEntryIntent: this.options.deferredStartupEntryIntent,
    });

    this.manualCallback = new WorkspaceShellAndroidWidgetManualCallbackController({
      pendingCallback: this.options.pendingCallback,
      beforeUnloadManager: this.options.beforeUnloadManager,
      logger: this.options.logger,
      getWindow: this.options.getWindow,
      getDocument: this.options.getDocument,
      readRuntimePlatform: this.options.readRuntimePlatform,
    });

    this.bootstrap = new WorkspaceShellAndroidWidgetBootstrapController({
      getPendingBootstrap: () => this.options.pendingBootstrap(),
      setPendingBootstrap: request => this.options.pendingBootstrap.set(request),
      setDeferredStartupEntryIntent: startupEntryIntent =>
        this.options.deferredStartupEntryIntent.set(startupEntryIntent),
      persistPendingBootstrap: request => this.storage.persistPendingBootstrap(request),
      persistDeferredStartupEntryIntent: startupEntryIntent =>
        this.storage.persistDeferredStartupEntryIntent(startupEntryIntent),
      consumeStartupEntryIntent: this.options.consumeStartupEntryIntent,
      completeAndroidBootstrap: this.options.completeAndroidBootstrap,
      currentUserId: this.options.currentUserId,
      isSessionInitialized: this.options.isSessionInitialized,
      navigateToCallback: callback => this.manualCallback.navigate(callback),
      readRuntimePlatform: this.options.readRuntimePlatform,
      warn: (message, context) => this.options.logger.warn(message, context),
      warningToast: this.options.warningToast,
    });

    this.processing = new WorkspaceShellAndroidWidgetBootstrapProcessingController({
      pendingBootstrap: () => this.options.pendingBootstrap(),
      currentUserId: this.options.currentUserId,
      isSessionInitialized: this.options.isSessionInitialized,
      isInFlight: () => this.bootstrap.isInFlight(),
      completeAndroidWidgetBootstrap: bootstrapRequest => this.complete(bootstrapRequest),
    });
  }

  restoreAll(): void {
    this.storage.restoreAll();
  }

  persistPendingBootstrap(request: AndroidWidgetBootstrapRequest | null): void {
    this.storage.persistPendingBootstrap(request);
  }

  persistDeferredStartupEntryIntent(startupEntryIntent: StartupEntryIntent | null): void {
    this.storage.persistDeferredStartupEntryIntent(startupEntryIntent);
  }

  captureFromRoute(routeUrl: string | null): boolean {
    return this.bootstrap.captureFromRoute(routeUrl);
  }

  syncProcessing(): void {
    this.processing.sync();
  }

  complete(bootstrapRequest: AndroidWidgetBootstrapRequest): Promise<void> {
    return this.bootstrap.complete(bootstrapRequest);
  }

  continueManualCallback(): void {
    this.manualCallback.continueManualCallback();
  }

  useIntentFallback(): void {
    this.manualCallback.useIntentFallback();
  }

  dismissManualCallback(): void {
    this.manualCallback.dismiss();
  }

  teardown(): void {}
}
