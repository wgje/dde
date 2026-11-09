import type { ElementRef, NgZone, Signal, WritableSignal } from '@angular/core';
import type * as go from 'gojs';

import { UI_CONFIG } from '../../../../config';
import type { Task } from '../../../../models';
import type { FlowDragDropService } from '../services/flow-drag-drop.service';
import type { FlowEventRegistrationService } from '../services/flow-event-registration.service';
import type { FlowCommandService } from '../services/flow-command.service';
import type { FlowDiagramRetryService } from '../services/flow-diagram-retry.service';
import type { FlowDiagramService } from '../services/flow-diagram.service';
import type { FlowSelectModeService } from '../services/flow-select-mode.service';
import type { FlowTouchService } from '../services/flow-touch.service';

interface FlowViewDiagramLifecycleLogger {
  warn(message: string, context?: unknown): void;
}

export interface FlowViewDiagramLifecycleControllerOptions {
  diagram: FlowDiagramService;
  diagramRetry: FlowDiagramRetryService;
  dragDrop: FlowDragDropService;
  eventRegistration: FlowEventRegistrationService;
  flowCommand: FlowCommandService;
  isOverviewCollapsed: WritableSignal<boolean>;
  isOverviewVisible: Signal<boolean>;
  isPaletteOpen: WritableSignal<boolean>;
  isMobile: () => boolean;
  logger: FlowViewDiagramLifecycleLogger;
  overviewDiv: () => ElementRef | undefined;
  diagramDiv: () => ElementRef | undefined;
  projectTasks: () => Task[];
  scheduleTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  selectMode: FlowSelectModeService;
  selectedTaskId: WritableSignal<string | null>;
  touch: FlowTouchService;
  useSvgMinimap: Signal<boolean>;
  zone: NgZone;
  bumpDetailLayoutTick: () => void;
  expandDrawerToOptimalHeight: () => void;
  handleDeleteKeyPressed: () => void;
  handleDiagramDrop: (taskData: Task, docPoint: go.Point) => void;
  isDestroyed: () => boolean;
  refreshDiagram: () => void;
  executeCenterOnNode: (taskId: string, openDetail: boolean) => void;
}

export class FlowViewDiagramLifecycleController {
  private overviewResizeTimer: ReturnType<typeof setTimeout> | null = null;
  private legacyOverviewExpandFrame: number | null = null;
  private legacyOverviewExpandTimer: ReturnType<typeof setTimeout> | null = null;
  private legacyOverviewExpandGeneration = 0;

  constructor(private readonly options: FlowViewDiagramLifecycleControllerOptions) {}

  getOverviewResizeTimer(): ReturnType<typeof setTimeout> | null {
    return this.overviewResizeTimer;
  }

  clearOverviewResizeTimer(): void {
    this.overviewResizeTimer = null;
    this.cancelPendingLegacyOverviewExpand();
  }

  handleResize(): void {
    this.options.bumpDetailLayoutTick();
    if (this.overviewResizeTimer !== null) clearTimeout(this.overviewResizeTimer);
    this.overviewResizeTimer = setTimeout(() => {
      this.overviewResizeTimer = null;
      if (!this.options.isDestroyed()) {
        this.syncDiagramViewportMetrics();
        if (!this.options.useSvgMinimap() && !this.options.isOverviewCollapsed()) {
          this.options.diagram.refreshOverview();
        }
      }
    }, 300);
  }

  handleOrientationChange(): void {
    this.options.bumpDetailLayoutTick();
    this.options.scheduleTimer(() => {
      if (!this.options.isDestroyed()) {
        this.syncDiagramViewportMetrics();
        if (!this.options.useSvgMinimap() && !this.options.isOverviewCollapsed()) {
          this.options.diagram.refreshOverview();
        }
      }
    }, 500);
  }

  scheduleDiagramInit(): void {
    this.options.diagramRetry.scheduleDiagramInit(
      () => this.initDiagram(),
      () => this.onDiagramInitialized(),
      this.options.scheduleTimer,
      this.options.isDestroyed,
    );
  }

  retryInitDiagram(): void {
    this.options.diagram.error.set(null);
    this.options.diagramRetry.retryInitDiagram(
      this.options.diagramDiv,
      () => this.initDiagram(),
      (delayMs) => this.onDiagramInitialized(delayMs ?? 0),
      this.options.scheduleTimer,
    );
  }

  resetAndRetryDiagram(): void {
    this.options.diagram.error.set(null);
    this.options.diagramRetry.resetAndRetryDiagram(
      this.options.diagramDiv,
      () => this.initDiagram(),
      (delayMs) => this.onDiagramInitialized(delayMs ?? 0),
      this.options.scheduleTimer,
    );
  }

  toggleOverviewCollapse(): void {
    const wasCollapsed = this.options.isOverviewCollapsed();
    this.options.isOverviewCollapsed.set(!wasCollapsed);
    this.cancelPendingLegacyOverviewExpand();

    if (this.options.useSvgMinimap()) return;

    if (wasCollapsed) {
      this.scheduleLegacyOverviewExpand();
    } else {
      this.options.diagram.disposeOverview();
    }
  }

  handleLegacyOverviewHostChange(host: ElementRef | undefined): void {
    this.cancelPendingLegacyOverviewExpand();
    if (this.options.isDestroyed() || this.options.useSvgMinimap() || !host) {
      this.options.diagram.disposeOverview();
      return;
    }
    if (!this.options.isOverviewVisible() || this.options.isOverviewCollapsed()) return;

    this.options.diagram.scheduleOverviewInit(
      host,
      true,
      false,
      this.options.zone,
      this.options.scheduleTimer,
      true,
    );
  }

  private scheduleLegacyOverviewExpand(): void {
    const generation = this.legacyOverviewExpandGeneration;
    const afterFrame = (): void => {
      if (generation !== this.legacyOverviewExpandGeneration) return;
      this.legacyOverviewExpandFrame = null;
      if (!this.canInitializeLegacyOverview()) return;

      this.legacyOverviewExpandTimer = this.options.scheduleTimer(() => {
        if (generation !== this.legacyOverviewExpandGeneration) return;
        this.legacyOverviewExpandTimer = null;
        if (!this.canInitializeLegacyOverview()) return;
        const host = this.options.overviewDiv();
        if (!host) return;
        this.options.diagram.scheduleOverviewInit(
          host,
          true,
          false,
          this.options.zone,
          this.options.scheduleTimer,
          true,
        );
      }, 100);
    };

    const requestFrame = globalThis.requestAnimationFrame;
    if (typeof requestFrame === 'function') {
      this.legacyOverviewExpandFrame = requestFrame(afterFrame);
      return;
    }
    afterFrame();
  }

  private cancelPendingLegacyOverviewExpand(): void {
    this.legacyOverviewExpandGeneration += 1;
    if (this.legacyOverviewExpandFrame !== null) {
      const cancelFrame = globalThis.cancelAnimationFrame;
      if (typeof cancelFrame === 'function') cancelFrame(this.legacyOverviewExpandFrame);
      this.legacyOverviewExpandFrame = null;
    }
    if (this.legacyOverviewExpandTimer !== null) {
      clearTimeout(this.legacyOverviewExpandTimer);
      this.legacyOverviewExpandTimer = null;
    }
  }

  private canInitializeLegacyOverview(): boolean {
    return !this.options.isDestroyed()
      && !this.options.useSvgMinimap()
      && this.options.isOverviewVisible()
      && !this.options.isOverviewCollapsed();
  }

  private onDiagramInitialized(delayMs: number = UI_CONFIG.MEDIUM_DELAY): void {
    this.options.scheduleTimer(() => {
      if (this.options.diagram.isInitialized) {
        this.options.diagram.updateDiagram(this.options.projectTasks());
      }
    }, delayMs);
  }

  private initDiagram(): void {
    const divRef = this.options.diagramDiv();
    if (!divRef?.nativeElement) {
      this.options.logger.warn('[FlowView] diagramDiv 未准备好，跳过初始化');
      return;
    }

    this.options.touch.uninstallDiagramDragGhostListeners(this.options.diagram.diagramInstance);
    this.options.touch.endDiagramNodeDragGhost();

    const success = this.options.diagram.initialize(divRef.nativeElement);
    if (!success) return;

    this.options.eventRegistration.registerAllEvents({
      isSelectMode: () => this.options.selectMode.isSelectMode(),
      selectedTaskId: this.options.selectedTaskId,
      refreshDiagram: this.options.refreshDiagram,
      expandDrawerToOptimalHeight: this.options.expandDrawerToOptimalHeight,
      handleNodeMoved: (key, loc, isUnassigned, diagram) =>
        this.options.dragDrop.handleNodeMoved(key, loc, isUnassigned, diagram),
      isPaletteOpen: this.options.isPaletteOpen,
      handleDeleteKeyPressed: this.options.handleDeleteKeyPressed,
    });

    this.options.touch.installDiagramDragGhostListeners(
      this.options.diagram.diagramInstance,
      this.options.isMobile(),
    );

    this.options.diagram.setupDropHandler((taskData, docPoint) => {
      this.options.handleDiagramDrop(taskData, docPoint);
    });

    if (!this.options.useSvgMinimap()) {
      this.options.diagram.scheduleOverviewInit(
        this.options.overviewDiv(),
        this.options.isOverviewVisible(),
        this.options.isOverviewCollapsed(),
        this.options.zone,
        this.options.scheduleTimer,
      );
    }
  }

  private syncDiagramViewportMetrics(): void {
    const diagramService = this.options.diagram as FlowDiagramService & {
      syncViewportMetrics: () => void;
    };
    diagramService.syncViewportMetrics();
  }
}
