import type { AndroidWidgetBootstrapRequest } from '../../../utils/startup-entry-intent';
import { AUTH_CONFIG } from '../../../config/auth.config';
import type { AndroidWidgetBootstrapPreparation } from './workspace-shell-android-widget-bootstrap-storage.controller';

let latestWidgetBootstrapAttempt = 0;
const pendingWidgetBootstrapAttempts: number[] = [];

export function startWidgetBootstrapAttempt(action: () => void): void {
  const generation = ++latestWidgetBootstrapAttempt;
  pendingWidgetBootstrapAttempts.push(generation);
  try {
    action();
  } catch (error) {
    const index = pendingWidgetBootstrapAttempts.indexOf(generation);
    if (index >= 0) pendingWidgetBootstrapAttempts.splice(index, 1);
    throw error;
  }
}

export function captureWidgetBootstrapAttempt(): number {
  return pendingWidgetBootstrapAttempts.shift() ?? currentWidgetBootstrapAttempt();
}

export function currentWidgetBootstrapAttempt(): number {
  if (latestWidgetBootstrapAttempt === 0) latestWidgetBootstrapAttempt = 1;
  return latestWidgetBootstrapAttempt;
}

export function isWidgetBootstrapAttemptCurrent(generation: number): boolean {
  return generation === latestWidgetBootstrapAttempt;
}

export interface WorkspaceShellAndroidWidgetBootstrapProcessingControllerOptions {
  pendingBootstrap: () => AndroidWidgetBootstrapRequest | null;
  currentUserId: () => string | null;
  isSessionInitialized: () => boolean;
  isInFlight: () => boolean;
  preparePendingBootstrap: (
    request: AndroidWidgetBootstrapRequest,
    ownerUserId: string,
    isCurrent: () => boolean,
  ) => AndroidWidgetBootstrapPreparation;
  completeAndroidWidgetBootstrap: (
    bootstrapRequest: AndroidWidgetBootstrapRequest,
    generation: number,
  ) => Promise<void> | void;
}

export class WorkspaceShellAndroidWidgetBootstrapProcessingController {
  constructor(private readonly options: WorkspaceShellAndroidWidgetBootstrapProcessingControllerOptions) {}

  sync(): void {
    const generation = captureWidgetBootstrapAttempt();
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
      const isCurrent = () => isWidgetBootstrapAttemptCurrent(generation)
        && this.options.isSessionInitialized()
        && this.options.currentUserId() === currentUserId
        && !this.options.isInFlight();
      if (!isCurrent()) return;
      const preparation = this.options.preparePendingBootstrap(
        bootstrapRequest,
        currentUserId,
        isCurrent,
      );
      if (preparation.kind !== 'ready' || !isCurrent()) return;

      const completion = this.options.completeAndroidWidgetBootstrap(
        preparation.request,
        generation,
      );
      if (completion) {
        void completion.catch(() => undefined);
      }
    } catch {
      // Keep this self-running effect retryable; the bootstrap controller owns user-facing failure handling.
    }
  }
}
