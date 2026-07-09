import type {
  OverviewUpdateSource,
  OverviewViewportContext,
  OverviewWorldBoundsPlan,
} from './flow-overview-viewport.helpers';

export interface FlowOverviewUpdateRuntime {
  createContext: (source: OverviewUpdateSource) => OverviewViewportContext | null;
  handlePassiveUpdate: (context: OverviewViewportContext) => boolean;
  buildWorldBoundsPlan: (context: OverviewViewportContext) => OverviewWorldBoundsPlan | null;
  applyWorldBoundsPlan: (plan: OverviewWorldBoundsPlan) => void;
  finalizeUpdate: (context: OverviewViewportContext) => void;
  clearReleaseViewportIfCaughtUp: (context: OverviewViewportContext) => void;
  scheduleUpdate: (source: OverviewUpdateSource) => void;
}

export class FlowOverviewUpdateController {
  private isApplying = false;
  private queuedWhileApplying = false;

  reset(): void {
    this.isApplying = false;
    this.queuedWhileApplying = false;
  }

  apply(source: OverviewUpdateSource, runtime: FlowOverviewUpdateRuntime): void {
    if (this.isApplying) {
      this.queuedWhileApplying = true;
      return;
    }

    this.isApplying = true;
    try {
      const context = runtime.createContext(source);
      if (!context) return;
      if (runtime.handlePassiveUpdate(context)) return;

      const plan = runtime.buildWorldBoundsPlan(context);
      if (plan) {
        runtime.applyWorldBoundsPlan(plan);
      }
      runtime.finalizeUpdate(context);
      runtime.clearReleaseViewportIfCaughtUp(context);
    } finally {
      this.isApplying = false;

      if (this.queuedWhileApplying) {
        this.queuedWhileApplying = false;
        runtime.scheduleUpdate('viewport');
      }
    }
  }
}
