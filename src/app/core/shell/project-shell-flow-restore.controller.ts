import { STARTUP_PERF_CONFIG } from '../../../config/startup-performance.config';

interface NetworkInformationLike {
  effectiveType?: '4g' | '3g' | '2g' | 'slow-2g';
  saveData?: boolean;
  downlink?: number;
  rtt?: number;
}

type SignalSetter<T> = {
  set(value: T): void;
};

export interface ProjectShellFlowRestoreControllerOptions {
  flowStateAwareRestoreEnabled: boolean;
  flowIntentActivated(): boolean;
  flowPrefetchOnlyActivated: SignalSetter<boolean>;
  uiState: {
    isMobile(): boolean;
    activeView: SignalSetter<'text' | 'flow'>;
    getLastActiveView(): 'text' | 'flow' | null;
    persistActiveView(view: 'text' | 'flow'): void;
  };
  activateFlowIntent(source: 'route' | 'restore-idle'): void;
}

export class ProjectShellFlowRestoreController {
  private isDestroyed = false;
  private flowRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  private flowIdlePreloadTimer: ReturnType<typeof setTimeout> | null = null;
  private flowRestoreIdleCallbackId: number | null = null;
  private flowPreloadIdleCallbackId: number | null = null;
  private lastFlowRestoreProjectId: string | null = null;

  constructor(private readonly options: ProjectShellFlowRestoreControllerOptions) {}

  applyStateAwareFlowRestore(currentUrl: string, projectId?: string): void {
    if (!projectId) {
      return;
    }
    this.options.flowPrefetchOnlyActivated.set(false);

    if (this.options.uiState.isMobile()) {
      this.options.uiState.activeView.set('text');
      this.reportFlowRestoreMode('degraded', {
        reason: 'mobile-default-text',
        projectId,
      });
      return;
    }

    if (!this.options.flowStateAwareRestoreEnabled) {
      this.options.activateFlowIntent('route');
      this.setActiveView('flow');
      return;
    }

    if (!/^\/projects\/[^/?#]+$/.test(currentUrl)) {
      return;
    }

    if (this.lastFlowRestoreProjectId === projectId) {
      return;
    }
    this.lastFlowRestoreProjectId = projectId;
    this.cancelFlowStateAwareTimers();

    const lastView = this.options.uiState.getLastActiveView();
    if (lastView !== 'flow') {
      this.setActiveView('text');
      this.reportFlowRestoreMode('degraded', {
        reason: 'last-view-text',
        projectId,
      });
      return;
    }

    const weakNetwork = this.isWeakNetworkForFlowRestore();
    if (weakNetwork) {
      this.options.uiState.activeView.set('text');
      this.scheduleWeakNetworkIdlePreload(projectId);
      this.reportFlowRestoreMode('degraded', {
        reason: 'weak-network-preload-only',
        projectId,
      });
      return;
    }

    this.scheduleFlowIdleRestore(projectId);
  }

  setActiveView(view: 'text' | 'flow'): void {
    this.options.flowPrefetchOnlyActivated.set(false);
    this.options.uiState.activeView.set(view);
    this.options.uiState.persistActiveView(view);
  }

  cancelFlowStateAwareTimers(): void {
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
    this.cancelFlowStateAwareTimers();
  }

  private scheduleFlowIdleRestore(projectId: string): void {
    const triggerRestore = () => {
      if (this.isDestroyed) return;
      this.options.activateFlowIntent('restore-idle');
      this.setActiveView('flow');
      this.reportFlowRestoreMode('applied', {
        reason: 'desktop-idle-restore',
        projectId,
      });
    };

    this.flowRestoreTimer = setTimeout(() => {
      this.flowRestoreTimer = null;
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        const requestIdle = (window as Window & {
          requestIdleCallback: (cb: IdleRequestCallback, options?: IdleRequestOptions) => number;
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

  private scheduleWeakNetworkIdlePreload(projectId: string): void {
    const triggerPreload = () => {
      if (this.isDestroyed || this.options.flowIntentActivated()) return;
      this.options.flowPrefetchOnlyActivated.set(true);
      this.reportFlowRestoreMode('degraded', {
        reason: 'weak-network-idle-preload',
        projectId,
      });
    };

    this.flowIdlePreloadTimer = setTimeout(() => {
      this.flowIdlePreloadTimer = null;

      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        const requestIdle = (window as Window & {
          requestIdleCallback: (cb: IdleRequestCallback, options?: IdleRequestOptions) => number;
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

  private isWeakNetworkForFlowRestore(): boolean {
    if (typeof navigator === 'undefined') {
      return false;
    }

    const nav = navigator as Navigator & {
      connection?: NetworkInformationLike;
      mozConnection?: NetworkInformationLike;
      webkitConnection?: NetworkInformationLike;
    };
    const connection = nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
    if (!connection) {
      return false;
    }

    if (connection.saveData) {
      return true;
    }

    const effectiveType = connection.effectiveType ?? '';
    if (effectiveType === '2g' || effectiveType === 'slow-2g') {
      return true;
    }

    const rtt = typeof connection.rtt === 'number' ? connection.rtt : 0;
    if (rtt > STARTUP_PERF_CONFIG.FLOW_RESTORE_MAX_RTT_MS) {
      return true;
    }

    const downlink = typeof connection.downlink === 'number' ? connection.downlink : 0;
    if (
      downlink > 0 &&
      downlink < STARTUP_PERF_CONFIG.FLOW_IDLE_PRELOAD_MIN_DOWNLINK_MBPS
    ) {
      return true;
    }

    return false;
  }

  private reportFlowRestoreMode(
    mode: 'applied' | 'degraded',
    data: Record<string, unknown>,
  ): void {
    if (typeof window === 'undefined') {
      return;
    }
    window.dispatchEvent(new CustomEvent('nanoflow:flow-restore-status', {
      detail: {
        mode,
        ...data,
      },
    }));
  }
}
