import { effect, type EffectRef, type Injector, type WritableSignal } from '@angular/core';

import type { UiStateService } from '../../../../services/ui-state.service';
import type { FlowDiagramService } from '../services/flow-diagram.service';
import type { FlowSwipeGestureService } from '../services/flow-swipe-gesture.service';

export interface FlowViewMobileInteractionControllerOptions {
  detailLayoutTick: WritableSignal<number>;
  diagram: FlowDiagramService;
  drawerHeight: WritableSignal<number>;
  drawerManualOverride: WritableSignal<boolean>;
  goBackToText: () => void;
  injector: Injector;
  isPaletteOpen: WritableSignal<boolean>;
  isRightPanelOpen: WritableSignal<boolean>;
  isDestroyed: () => boolean;
  loggerDebug: (message: string, context?: unknown) => void;
  scheduleTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  selectedTaskId: WritableSignal<string | null>;
  swipeGesture: FlowSwipeGestureService;
  uiState: UiStateService;
}

export class FlowViewMobileInteractionController {
  private lastMobileActiveView: 'text' | 'flow' | null = null;

  constructor(private readonly options: FlowViewMobileInteractionControllerOptions) {}

  setupMobileViewSwitchEffect(): EffectRef {
    return effect(() => {
      const isMobile = this.options.uiState.isMobile();
      const activeView = this.options.uiState.activeView();

      if (!isMobile) {
        this.lastMobileActiveView = activeView;
        return;
      }

      const previousView = this.lastMobileActiveView;
      this.lastMobileActiveView = activeView;
      if (previousView === activeView) return;

      if (activeView !== 'flow') {
        this.options.selectedTaskId.set(null);
        this.options.drawerManualOverride.set(false);
        return;
      }

      this.options.selectedTaskId.set(null);
      this.options.drawerManualOverride.set(false);
      this.options.drawerHeight.set(8);
      this.options.scheduleTimer(() => {
        if (!this.options.isDestroyed()) {
          this.bumpDetailLayoutTick();
          this.options.diagram.diagramInstance?.requestUpdate();
        }
      }, 150);
    }, { injector: this.options.injector });
  }

  expandDrawerToOptimalHeight(): void {
    this.options.drawerManualOverride.set(false);
    const minVh = 8;
    if (this.options.drawerHeight() < minVh) {
      this.options.drawerHeight.set(minVh);
    }
    this.bumpDetailLayoutTick();
  }

  onDrawerStateChange(event: { previousLayer: string; currentLayer: string; triggeredBy: string }): void {
    this.options.loggerDebug('Drawer state change:', event);
    this.options.drawerManualOverride.set(false);

    if (event.currentLayer === 'middle' && event.previousLayer !== 'middle') {
      this.options.selectedTaskId.set(null);
      this.options.drawerHeight.set(8);
      requestAnimationFrame(() => {
        if (this.options.isDestroyed()) return;
        this.options.diagram.diagramInstance?.requestUpdate();
      });
      return;
    }

    this.bumpDetailLayoutTick();
  }

  centerOnNodeFromDrawer(centerOnNode: () => void): void {
    this.options.scheduleTimer(centerOnNode, 350);
  }

  onDrawerSwipeToSwitch(direction: 'left' | 'right', toggleRightPanel: () => void): void {
    if (direction === 'right') {
      this.options.goBackToText();
    } else if (direction === 'left') {
      toggleRightPanel();
    }
  }

  toggleRightPanel(): void {
    if (this.options.uiState.isMobile()) {
      const willOpen = !this.options.isRightPanelOpen();
      if (willOpen && this.options.isPaletteOpen()) {
        this.options.isPaletteOpen.set(false);
      }
      this.options.isRightPanelOpen.set(willOpen);
    }
  }

  onDiagramAreaTouchStart(event: TouchEvent): void {
    this.options.swipeGesture.handleDiagramAreaTouchStart(event);
  }

  onDiagramAreaTouchMove(event: TouchEvent): void {
    this.options.swipeGesture.handleDiagramAreaTouchMove(event);
  }

  onDiagramAreaTouchEnd(event: TouchEvent): void {
    const result = this.options.swipeGesture.handleDiagramAreaTouchEnd(event);
    if (result === 'right') {
      this.options.isRightPanelOpen.set(true);
    } else if (result === 'left') {
      this.options.loggerDebug('滑动触发 goBackToText');
      this.options.goBackToText();
    }
  }

  bumpDetailLayoutTick(delayMs: number = 0): void {
    if (!this.options.uiState.isMobile() || this.options.isDestroyed()) return;
    if (delayMs <= 0) {
      this.options.detailLayoutTick.update((value) => value + 1);
      return;
    }
    this.options.scheduleTimer(() => {
      if (this.options.isDestroyed()) return;
      this.options.detailLayoutTick.update((value) => value + 1);
    }, delayMs);
  }
}
