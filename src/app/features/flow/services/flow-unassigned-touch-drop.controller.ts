import type { NgZone } from '@angular/core';
import * as go from 'gojs';

import { UI_CONFIG } from '../../../../config';
import { Task } from '../../../../models';
import { FlowDragDropService, InsertPositionInfo } from './flow-drag-drop.service';
import { FlowTouchService } from './flow-touch.service';

type FlowUnassignedTouchDropOptions = {
  dragDrop: FlowDragDropService;
  getDiagramElement: () => HTMLElement | null;
  getDiagramInstance: () => go.Diagram | null;
  touch: FlowTouchService;
  zone: NgZone;
};

type GlobalListenerRegistration = {
  eventName: string;
  listener: EventListener;
  addOptions: AddEventListenerOptions;
  removeOptions: EventListenerOptions;
};

export class FlowUnassignedTouchDropController {
  private readonly boundGlobalTouchMove = this.handleGlobalTouchMove.bind(this);
  private readonly boundGlobalTouchEnd = this.handleGlobalTouchEnd.bind(this);
  private readonly boundGlobalTouchCancel = this.handleGlobalTouchCancel.bind(this);
  private readonly boundGlobalPointerMove = this.handleGlobalPointerMove.bind(this);
  private readonly boundGlobalPointerUp = this.handleGlobalPointerUp.bind(this);
  private readonly boundGlobalPointerCancel = this.handleGlobalPointerCancel.bind(this);
  private globalListenersInstalled = false;

  constructor(private readonly options: FlowUnassignedTouchDropOptions) {}

  get hasPending(): boolean {
    return this.options.touch.hasActiveTouchSession || !!this.options.touch.draggingId();
  }

  installGlobalListeners(): void {
    if (this.globalListenersInstalled) {
      return;
    }

    const registrations = this.createGlobalListenerRegistrations();
    this.options.zone.runOutsideAngular(() => {
      const installed: GlobalListenerRegistration[] = [];

      try {
        for (const registration of registrations) {
          document.addEventListener(registration.eventName, registration.listener, registration.addOptions);
          installed.push(registration);
        }
        this.globalListenersInstalled = true;
      } catch (error) {
        this.rollbackInstalledGlobalListeners(installed);
        this.globalListenersInstalled = false;
        throw error;
      }
    });
  }

  private createGlobalListenerRegistrations(): GlobalListenerRegistration[] {
    return [
      {
        eventName: 'touchmove',
        listener: this.boundGlobalTouchMove as EventListener,
        addOptions: { capture: true, passive: false },
        removeOptions: { capture: true },
      },
      {
        eventName: 'touchend',
        listener: this.boundGlobalTouchEnd as EventListener,
        addOptions: { capture: true, passive: false },
        removeOptions: { capture: true },
      },
      {
        eventName: 'touchcancel',
        listener: this.boundGlobalTouchCancel as EventListener,
        addOptions: { capture: true, passive: false },
        removeOptions: { capture: true },
      },
      {
        eventName: 'pointermove',
        listener: this.boundGlobalPointerMove as EventListener,
        addOptions: { capture: true, passive: false },
        removeOptions: { capture: true },
      },
      {
        eventName: 'pointerup',
        listener: this.boundGlobalPointerUp as EventListener,
        addOptions: { capture: true },
        removeOptions: { capture: true },
      },
      {
        eventName: 'pointercancel',
        listener: this.boundGlobalPointerCancel as EventListener,
        addOptions: { capture: true },
        removeOptions: { capture: true },
      },
    ];
  }

  private rollbackInstalledGlobalListeners(installed: GlobalListenerRegistration[]): void {
    for (const registration of installed.reverse()) {
      try {
        document.removeEventListener(registration.eventName, registration.listener, registration.removeOptions);
      } catch {
        // Listener rollback is best-effort; the original registration error is more useful to callers.
      }
    }
  }

  removeGlobalListeners(): void {
    if (!this.globalListenersInstalled) {
      return;
    }

    this.globalListenersInstalled = false;
    this.options.zone.runOutsideAngular(() => {
      document.removeEventListener('touchmove', this.boundGlobalTouchMove, { capture: true } as EventListenerOptions);
      document.removeEventListener('touchend', this.boundGlobalTouchEnd, { capture: true } as EventListenerOptions);
      document.removeEventListener('touchcancel', this.boundGlobalTouchCancel, { capture: true } as EventListenerOptions);
      document.removeEventListener('pointermove', this.boundGlobalPointerMove, { capture: true } as EventListenerOptions);
      document.removeEventListener('pointerup', this.boundGlobalPointerUp, { capture: true } as EventListenerOptions);
      document.removeEventListener('pointercancel', this.boundGlobalPointerCancel, { capture: true } as EventListenerOptions);
    });
  }

  handleTouchMove(event: TouchEvent): void {
    const shouldPrevent = this.options.touch.handleTouchMove(event);
    if (!shouldPrevent) return;

    if (event.cancelable) {
      event.preventDefault();
    }
    event.stopPropagation();
  }

  finish(useLastKnownPosition: boolean, event?: TouchEvent): void {
    const onDrop = this.createDropHandler();
    try {
      if (useLastKnownPosition) {
        this.options.touch.endTouchFromLastPosition(this.diagramElement(), this.diagramInstance(), onDrop);
        return;
      }

      if (!event) return;
      this.options.touch.endTouch(event, this.diagramElement(), this.diagramInstance(), onDrop);
    } finally {
      if (!this.hasPending) {
        this.removeGlobalListeners();
      }
    }
  }

  cancelIfNotDeferred(): void {
    if (this.options.touch.deferCancelForPointerFallback(() => this.removeGlobalListeners())) {
      return;
    }
    this.cancel();
  }

  private cancel(): void {
    try {
      this.options.touch.cancelTouch(this.diagramElement(), this.diagramInstance(), this.createDropHandler());
    } finally {
      this.removeGlobalListeners();
    }
  }

  private createDropHandler(): (task: Task, insertInfo: InsertPositionInfo, docPoint: go.Point) => void {
    return (task, insertInfo, docPoint) => {
      this.options.dragDrop.processDropFromInteraction(task, insertInfo, docPoint, UI_CONFIG.MEDIUM_DELAY);
    };
  }

  private diagramElement(): HTMLElement | null {
    return this.options.getDiagramElement();
  }

  private diagramInstance(): go.Diagram | null {
    return this.options.getDiagramInstance();
  }

  private shouldIgnoreTouchGlobalEvent(): boolean {
    return this.options.touch.isPointerSessionActive || !this.hasPending;
  }

  private shouldIgnorePointerGlobalEvent(event: PointerEvent): boolean {
    return event.pointerType !== 'touch' || !event.isPrimary || !this.hasPending;
  }

  private handleGlobalTouchMove(event: TouchEvent): void {
    if (this.shouldIgnoreTouchGlobalEvent()) return;
    this.handleTouchMove(event);
  }

  private handleGlobalTouchEnd(event: TouchEvent): void {
    if (this.shouldIgnoreTouchGlobalEvent()) return;
    this.options.zone.run(() => this.finish(false, event));
  }

  private handleGlobalTouchCancel(_event: TouchEvent): void {
    if (this.shouldIgnoreTouchGlobalEvent()) return;
    this.options.zone.run(() => this.cancelIfNotDeferred());
  }

  private handleGlobalPointerMove(event: PointerEvent): void {
    if (this.shouldIgnorePointerGlobalEvent(event)) return;

    const shouldPrevent = this.options.touch.handlePointerMove(event);
    if (shouldPrevent) {
      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopPropagation();
      return;
    }

    if (this.options.touch.handlePointerFallbackMove(event.clientX, event.clientY)) {
      event.stopPropagation();
    }
  }

  private handleGlobalPointerUp(event: PointerEvent): void {
    if (this.shouldIgnorePointerGlobalEvent(event)) return;
    this.options.zone.run(() => {
      try {
        if (this.options.touch.isPointerSessionActive) {
          this.options.touch.endPointer(event, this.diagramElement(), this.diagramInstance(), this.createDropHandler());
          return;
        }

        this.options.touch.endTouchAtPosition(
          this.diagramElement(),
          this.diagramInstance(),
          this.createDropHandler(),
          event.clientX,
          event.clientY,
        );
      } finally {
        this.removeGlobalListeners();
      }
    });
  }

  private handleGlobalPointerCancel(event: PointerEvent): void {
    if (this.shouldIgnorePointerGlobalEvent(event)) return;
    this.options.zone.run(() => {
      try {
        if (this.options.touch.isPointerSessionActive) {
          this.options.touch.cancelPointer(this.diagramElement(), this.diagramInstance(), this.createDropHandler());
          return;
        }

        if (this.options.touch.isAwaitingPointerFallback) {
          this.cancel();
          return;
        }

        this.cancel();
      } finally {
        this.removeGlobalListeners();
      }
    });
  }
}
