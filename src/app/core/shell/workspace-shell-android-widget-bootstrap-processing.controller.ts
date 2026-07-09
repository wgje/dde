import type { AndroidWidgetBootstrapRequest } from '../../../utils/startup-entry-intent';
import { AUTH_CONFIG } from '../../../config/auth.config';

export interface WorkspaceShellAndroidWidgetBootstrapProcessingControllerOptions {
  pendingBootstrap: () => AndroidWidgetBootstrapRequest | null;
  currentUserId: () => string | null;
  isSessionInitialized: () => boolean;
  isInFlight: () => boolean;
  completeAndroidWidgetBootstrap: (bootstrapRequest: AndroidWidgetBootstrapRequest) => Promise<void> | void;
}

export class WorkspaceShellAndroidWidgetBootstrapProcessingController {
  constructor(private readonly options: WorkspaceShellAndroidWidgetBootstrapProcessingControllerOptions) {}

  sync(): void {
    const bootstrapRequest = this.options.pendingBootstrap();
    const currentUserId = this.options.currentUserId();
    if (
      !bootstrapRequest
      || !this.options.isSessionInitialized()
      || !currentUserId
      || currentUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID
      || this.options.isInFlight()
    ) {
      return;
    }

    try {
      const completion = this.options.completeAndroidWidgetBootstrap(bootstrapRequest);
      if (completion) {
        void completion.catch(() => undefined);
      }
    } catch {
      // Keep this self-running effect retryable; the bootstrap controller owns user-facing failure handling.
    }
  }
}
