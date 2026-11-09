import type {
  AndroidWidgetBootstrapRequest,
  StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import type { RuntimePlatformSnapshot } from '../../../utils/runtime-platform';
import type { AndroidWidgetBootstrapCallbackResult } from '../../../services/widget-binding.service';
import {
  WorkspaceShellAndroidWidgetBootstrapCompletionController,
  type WorkspaceShellAndroidWidgetBootstrapCompleteResult,
} from './workspace-shell-android-widget-bootstrap-completion.controller';
import {
  WorkspaceShellAndroidWidgetBootstrapCaptureController,
} from './workspace-shell-android-widget-bootstrap-capture.controller';

export interface WorkspaceShellAndroidWidgetBootstrapControllerOptions {
  getPendingBootstrap: () => AndroidWidgetBootstrapRequest | null;
  setPendingBootstrap: (request: AndroidWidgetBootstrapRequest | null) => void;
  setDeferredStartupEntryIntent: (startupEntryIntent: StartupEntryIntent | null) => void;
  persistPendingBootstrap: (request: AndroidWidgetBootstrapRequest | null) => void;
  persistDeferredStartupEntryIntent: (startupEntryIntent: StartupEntryIntent | null) => void;
  consumeStartupEntryIntent: (onCleanupFailed?: () => void) => void;
  completeAndroidBootstrap: (
    request: AndroidWidgetBootstrapRequest,
  ) => Promise<WorkspaceShellAndroidWidgetBootstrapCompleteResult>;
  currentUserId: () => string | null;
  isSessionInitialized: () => boolean;
  navigateToCallback: (callback: AndroidWidgetBootstrapCallbackResult) => void;
  readRuntimePlatform: () => Pick<RuntimePlatformSnapshot, 'isAndroid' | 'isTwa'>;
  warn: (message: string, context?: unknown) => void;
  warningToast: (title: string, message: string) => void;
  completionController?: Pick<
    WorkspaceShellAndroidWidgetBootstrapCompletionController,
    'complete' | 'isInFlight'
  >;
  captureController?: Pick<
    WorkspaceShellAndroidWidgetBootstrapCaptureController,
    'captureFromRoute' | 'clearCompletedBootstrapState'
  >;
}

export class WorkspaceShellAndroidWidgetBootstrapController {
  private readonly captureController: Pick<
    WorkspaceShellAndroidWidgetBootstrapCaptureController,
    'captureFromRoute' | 'clearCompletedBootstrapState'
  >;
  private readonly completionController: Pick<
    WorkspaceShellAndroidWidgetBootstrapCompletionController,
    'complete' | 'isInFlight'
  >;

  constructor(private readonly options: WorkspaceShellAndroidWidgetBootstrapControllerOptions) {
    this.captureController = options.captureController
      ?? new WorkspaceShellAndroidWidgetBootstrapCaptureController({
        getPendingBootstrap: options.getPendingBootstrap,
        setPendingBootstrap: options.setPendingBootstrap,
        setDeferredStartupEntryIntent: options.setDeferredStartupEntryIntent,
        persistPendingBootstrap: options.persistPendingBootstrap,
        persistDeferredStartupEntryIntent: options.persistDeferredStartupEntryIntent,
        consumeStartupEntryIntent: options.consumeStartupEntryIntent,
        readRuntimePlatform: options.readRuntimePlatform,
        warn: options.warn,
      });
    this.completionController = options.completionController
      ?? new WorkspaceShellAndroidWidgetBootstrapCompletionController({
        completeAndroidBootstrap: options.completeAndroidBootstrap,
        currentUserId: options.currentUserId,
        isSessionInitialized: options.isSessionInitialized,
        navigateToCallback: options.navigateToCallback,
        settleBootstrapState: () => this.captureController.clearCompletedBootstrapState(),
        warn: options.warn,
        warningToast: options.warningToast,
      });
  }

  isInFlight(): boolean {
    return this.completionController.isInFlight();
  }

  captureFromRoute(routeUrl: string | null): boolean {
    return this.captureController.captureFromRoute(routeUrl);
  }

  complete(bootstrapRequest: AndroidWidgetBootstrapRequest): Promise<void> {
    return this.completionController.complete(bootstrapRequest);
  }
}
