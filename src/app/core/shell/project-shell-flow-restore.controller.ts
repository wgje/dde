import { STARTUP_PERF_CONFIG } from '../../../config/startup-performance.config';
import {
  ProjectShellFlowRestoreSchedulerController,
} from './project-shell-flow-restore-scheduler.controller';

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
  scheduler?: Pick<
    ProjectShellFlowRestoreSchedulerController,
    | 'cancel'
    | 'destroy'
    | 'scheduleFlowIdleRestore'
    | 'scheduleWeakNetworkIdlePreload'
  >;
}

export class ProjectShellFlowRestoreController {
  private lastFlowRestoreProjectId: string | null = null;
  private readonly scheduler: Pick<
    ProjectShellFlowRestoreSchedulerController,
    | 'cancel'
    | 'destroy'
    | 'scheduleFlowIdleRestore'
    | 'scheduleWeakNetworkIdlePreload'
  >;

  constructor(private readonly options: ProjectShellFlowRestoreControllerOptions) {
    this.scheduler = options.scheduler
      ?? new ProjectShellFlowRestoreSchedulerController({
        activateFlowIntent: source => options.activateFlowIntent(source),
        flowIntentActivated: options.flowIntentActivated,
        reportFlowRestoreMode: (mode, data) => this.reportFlowRestoreMode(mode, data),
        setActiveView: view => this.setActiveView(view),
        setFlowPrefetchOnlyActivated: value =>
          options.flowPrefetchOnlyActivated.set(value),
      });
  }

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
      this.scheduler.scheduleWeakNetworkIdlePreload(projectId);
      this.reportFlowRestoreMode('degraded', {
        reason: 'weak-network-preload-only',
        projectId,
      });
      return;
    }

    this.scheduler.scheduleFlowIdleRestore(projectId);
  }

  setActiveView(view: 'text' | 'flow'): void {
    this.options.flowPrefetchOnlyActivated.set(false);
    this.options.uiState.activeView.set(view);
    this.options.uiState.persistActiveView(view);
  }

  cancelFlowStateAwareTimers(): void {
    this.scheduler.cancel();
  }

  destroy(): void {
    this.scheduler.destroy();
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
