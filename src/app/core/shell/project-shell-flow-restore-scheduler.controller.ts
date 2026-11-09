import { STARTUP_PERF_CONFIG } from '../../../config/startup-performance.config';

export interface ProjectShellFlowRestoreSchedulerControllerOptions {
  flowIntentActivated(): boolean;
  activateFlowIntent(source: 'restore-idle'): void;
  setActiveView(view: 'flow'): void;
  setFlowPrefetchOnlyActivated(value: boolean): void;
  reportFlowRestoreMode(
    mode: 'applied' | 'degraded',
    data: Record<string, unknown>,
  ): void;
}

export class ProjectShellFlowRestoreSchedulerController {
  private isDestroyed = false;
  private flowRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  private flowIdlePreloadTimer: ReturnType<typeof setTimeout> | null = null;
  private flowRestoreIdleCallbackId: number | null = null;
  private flowPreloadIdleCallbackId: number | null = null;

  constructor(
    private readonly options: ProjectShellFlowRestoreSchedulerControllerOptions,
  ) {}

  scheduleFlowIdleRestore(projectId: string): void {
    const triggerRestore = () => {
      if (this.isDestroyed || this.options.flowIntentActivated()) return;
      this.options.activateFlowIntent('restore-idle');
      this.options.setActiveView('flow');
      this.options.reportFlowRestoreMode('applied', {
        reason: 'desktop-idle-restore',
        projectId,
      });
    };

    this.flowRestoreTimer = setTimeout(() => {
      this.flowRestoreTimer = null;
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        const requestIdle = (window as Window & {
          requestIdleCallback: (
            callback: IdleRequestCallback,
            options?: IdleRequestOptions,
          ) => number;
        }).requestIdleCallback;

        this.flowRestoreIdleCallbackId = requestIdle(() => {
          this.flowRestoreIdleCallbackId = null;
          triggerRestore();
        }, { timeout: STARTUP_PERF_CONFIG.FLOW_RESTORE_IDLE_DELAY_MS });
        return;
      }

      triggerRestore();
    }, STARTUP_PERF_CONFIG.FLOW_RESTORE_IDLE_DELAY_MS);
  }

  scheduleWeakNetworkIdlePreload(projectId: string): void {
    const triggerPreload = () => {
      if (this.isDestroyed || this.options.flowIntentActivated()) return;
      this.options.setFlowPrefetchOnlyActivated(true);
      this.options.reportFlowRestoreMode('degraded', {
        reason: 'weak-network-idle-preload',
        projectId,
      });
    };

    this.flowIdlePreloadTimer = setTimeout(() => {
      this.flowIdlePreloadTimer = null;
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        const requestIdle = (window as Window & {
          requestIdleCallback: (
            callback: IdleRequestCallback,
            options?: IdleRequestOptions,
          ) => number;
        }).requestIdleCallback;

        this.flowPreloadIdleCallbackId = requestIdle(() => {
          this.flowPreloadIdleCallbackId = null;
          triggerPreload();
        }, { timeout: STARTUP_PERF_CONFIG.FLOW_RESTORE_IDLE_DELAY_MS });
        return;
      }

      triggerPreload();
    }, STARTUP_PERF_CONFIG.FLOW_IDLE_PRELOAD_DELAY_MS);
  }

  cancel(): void {
    if (this.flowRestoreTimer !== null) {
      clearTimeout(this.flowRestoreTimer);
      this.flowRestoreTimer = null;
    }
    if (this.flowIdlePreloadTimer !== null) {
      clearTimeout(this.flowIdlePreloadTimer);
      this.flowIdlePreloadTimer = null;
    }
    if (
      this.flowRestoreIdleCallbackId !== null &&
      typeof window !== 'undefined' &&
      'cancelIdleCallback' in window
    ) {
      (window as Window & { cancelIdleCallback: (handle: number) => void })
        .cancelIdleCallback(this.flowRestoreIdleCallbackId);
      this.flowRestoreIdleCallbackId = null;
    }
    if (
      this.flowPreloadIdleCallbackId !== null &&
      typeof window !== 'undefined' &&
      'cancelIdleCallback' in window
    ) {
      (window as Window & { cancelIdleCallback: (handle: number) => void })
        .cancelIdleCallback(this.flowPreloadIdleCallbackId);
      this.flowPreloadIdleCallbackId = null;
    }
  }

  destroy(): void {
    this.isDestroyed = true;
    this.cancel();
  }
}
