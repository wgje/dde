import { ElementRef, Injectable, NgZone } from '@angular/core';

export interface FlowDiagramOverviewRuntime {
  isInitialized: () => boolean;
  initializeOverview: (container: HTMLDivElement) => void;
}

@Injectable({ providedIn: 'root' })
export class FlowDiagramOverviewCoordinatorService {
  private idleOverviewInitHandle: number | null = null;
  private overviewContainer: HTMLDivElement | null = null;
  private shouldRestoreOverview = false;
  private pendingOverviewRestore = false;
  private scheduleGeneration = 0;

  get shouldRestore(): boolean {
    return this.shouldRestoreOverview;
  }

  get container(): HTMLDivElement | null {
    return this.overviewContainer;
  }

  setInitializedContainer(container: HTMLDivElement): void {
    this.overviewContainer = container;
    this.shouldRestoreOverview = true;
    this.pendingOverviewRestore = false;
  }

  markDisposed(): void {
    this.scheduleGeneration += 1;
    this.shouldRestoreOverview = false;
    this.pendingOverviewRestore = false;
  }

  reset(): void {
    this.scheduleGeneration += 1;
    this.overviewContainer = null;
    this.shouldRestoreOverview = false;
    this.pendingOverviewRestore = false;
    this.cancelIdleOverviewInit();
  }

  scheduleOverviewInit(
    overviewDiv: ElementRef | undefined,
    isVisible: boolean,
    isCollapsed: boolean,
    zone: NgZone,
    scheduleTimer: (cb: () => void, delay: number) => void,
    runtime: FlowDiagramOverviewRuntime,
    immediate = false,
  ): void {
    if (!isVisible || isCollapsed) {
      this.scheduleGeneration += 1;
      this.shouldRestoreOverview = false;
      return;
    }

    const generation = ++this.scheduleGeneration;

    if (overviewDiv?.nativeElement) {
      this.overviewContainer = overviewDiv.nativeElement;
      this.shouldRestoreOverview = true;
    }

    const runInit = () => {
      if (generation !== this.scheduleGeneration || !this.shouldRestoreOverview) {
        return;
      }
      if (overviewDiv?.nativeElement && runtime.isInitialized()) {
        runtime.initializeOverview(overviewDiv.nativeElement);
      }
    };
    if (immediate) { scheduleTimer(() => runInit(), 0); return; }
    if (typeof requestIdleCallback !== 'undefined') {
      if (typeof cancelIdleCallback !== 'undefined' && this.idleOverviewInitHandle !== null) {
        cancelIdleCallback(this.idleOverviewInitHandle);
      }
      this.idleOverviewInitHandle = requestIdleCallback(() => {
        this.idleOverviewInitHandle = null;
        zone.run(() => runInit());
      }, { timeout: 3000 });
    } else {
      scheduleTimer(() => runInit(), 300);
    }
  }

  cancelIdleOverviewInit(): void {
    if (this.idleOverviewInitHandle !== null && typeof cancelIdleCallback !== 'undefined') {
      cancelIdleCallback(this.idleOverviewInitHandle);
      this.idleOverviewInitHandle = null;
    }
  }

  restoreOverviewAfterRecovery(
    container: HTMLDivElement,
    runtime: FlowDiagramOverviewRuntime,
    scheduleFrame: (callback: () => void) => void,
    isDestroyed: () => boolean,
    retriesLeft = 3,
  ): void {
    scheduleFrame(() => {
      if (isDestroyed() || !this.shouldRestoreOverview) {
        return;
      }

      if (container.clientWidth <= 0 || container.clientHeight <= 0) {
        this.pendingOverviewRestore = true;
        if (retriesLeft > 0) {
          this.restoreOverviewAfterRecovery(container, runtime, scheduleFrame, isDestroyed, retriesLeft - 1);
        }
        return;
      }

      this.pendingOverviewRestore = false;
      runtime.initializeOverview(container);
    });
  }

  attemptPendingOverviewRestore(runtime: FlowDiagramOverviewRuntime, isOverviewInitialized: boolean): void {
    if (!this.pendingOverviewRestore || !this.shouldRestoreOverview || !this.overviewContainer) {
      return;
    }

    if (isOverviewInitialized) {
      this.pendingOverviewRestore = false;
      return;
    }

    if (this.overviewContainer.clientWidth <= 0 || this.overviewContainer.clientHeight <= 0) {
      return;
    }

    this.pendingOverviewRestore = false;
    runtime.initializeOverview(this.overviewContainer);
  }
}
