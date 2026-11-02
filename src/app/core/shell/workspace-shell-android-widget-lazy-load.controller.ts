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
import {
  currentWidgetBootstrapAttempt,
  isWidgetBootstrapAttemptCurrent,
  WorkspaceShellAndroidWidgetBootstrapProcessingController,
} from './workspace-shell-android-widget-bootstrap-processing.controller';
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
  private completionGeneration: number | null = null;
  private captureMutationActive = false;

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
      setPendingBootstrap: request => this.mutateBootstrapState(() =>
        this.options.pendingBootstrap.set(request)),
      setDeferredStartupEntryIntent: startupEntryIntent => this.mutateBootstrapState(() =>
        this.options.deferredStartupEntryIntent.set(startupEntryIntent)),
      persistPendingBootstrap: request => this.mutateBootstrapState(() =>
        this.storage.persistPendingBootstrap(request)),
      persistDeferredStartupEntryIntent: startupEntryIntent => this.mutateBootstrapState(() =>
        this.storage.persistDeferredStartupEntryIntent(startupEntryIntent)),
      consumeStartupEntryIntent: this.options.consumeStartupEntryIntent,
      completeAndroidBootstrap: request => this.completeCurrentBootstrap(request),
      currentUserId: this.options.currentUserId,
      isSessionInitialized: this.options.isSessionInitialized,
      navigateToCallback: callback => {
        if (this.canPublishCompletion()) this.manualCallback.navigate(callback);
      },
      readRuntimePlatform: this.options.readRuntimePlatform,
      warn: (message, context) => {
        if (this.canPublishCompletion()) this.options.logger.warn(message, context);
      },
      warningToast: (title, message) => {
        if (this.canPublishCompletion()) this.options.warningToast(title, message);
      },
    });

    this.processing = new WorkspaceShellAndroidWidgetBootstrapProcessingController({
      pendingBootstrap: () => this.options.pendingBootstrap(),
      currentUserId: this.options.currentUserId,
      isSessionInitialized: this.options.isSessionInitialized,
      isInFlight: () => this.bootstrap.isInFlight(),
      preparePendingBootstrap: (request, ownerUserId, isCurrent) =>
        this.storage.preparePendingBootstrap(request, ownerUserId, isCurrent),
      completeAndroidWidgetBootstrap: (bootstrapRequest, generation) =>
        this.complete(bootstrapRequest, generation),
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
    this.captureMutationActive = true;
    try {
      return this.bootstrap.captureFromRoute(routeUrl);
    } finally {
      this.captureMutationActive = false;
    }
  }

  syncProcessing(generation = currentWidgetBootstrapAttempt()): void {
    this.processing.sync(generation);
  }

  complete(
    bootstrapRequest: AndroidWidgetBootstrapRequest,
    generation = currentWidgetBootstrapAttempt(),
  ): Promise<void> {
    if (!isWidgetBootstrapAttemptCurrent(generation) || this.bootstrap.isInFlight()) {
      return Promise.resolve();
    }
    this.completionGeneration = generation;
    return this.bootstrap.complete(bootstrapRequest).finally(() => {
      if (this.completionGeneration === generation) this.completionGeneration = null;
    });
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

  private async completeCurrentBootstrap(
    request: AndroidWidgetBootstrapRequest,
  ): Promise<AndroidWidgetBootstrapCompleteResult> {
    const generation = this.completionGeneration;
    if (generation === null || !isWidgetBootstrapAttemptCurrent(generation)) {
      throw new Error('stale Android widget bootstrap attempt');
    }
    const result = await this.options.completeAndroidBootstrap(request);
    if (!isWidgetBootstrapAttemptCurrent(generation)) {
      throw new Error('stale Android widget bootstrap result');
    }
    return result;
  }

  private canPublishCompletion(): boolean {
    return this.completionGeneration === null
      || isWidgetBootstrapAttemptCurrent(this.completionGeneration);
  }

  private mutateBootstrapState(action: () => void): void {
    if (this.captureMutationActive || this.canPublishCompletion()) action();
  }
}
