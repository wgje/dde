import { computed, signal, type Signal } from '@angular/core';

import { PARKING_CONFIG } from '../../../config/parking.config';
import {
  clampHudPosition,
  defaultHudPosition,
  loadHudPosition,
  persistHudPosition,
  resolveHudSize,
  type HudPosition,
  type HudSize,
} from './utils/dock-hud-position';
import * as DockFocusUi from './utils/dock-focus-ui';

interface ParkingDockHudDragControllerOptions {
  readonly minimalMode: Signal<boolean>;
  readonly mobile: Signal<boolean>;
}

export class ParkingDockHudDragController {
  readonly hudSize = signal<HudSize>({
    width: PARKING_CONFIG.HUD_FULL_MAX_WIDTH_PX,
    height: PARKING_CONFIG.HUD_FULL_MAX_HEIGHT_PX,
  });

  readonly hudPosition = signal<HudPosition | null>(loadHudPosition(this.hudSize()));
  readonly hudDragging = signal(false);

  readonly hudContainerStyle = computed<Record<string, string>>(() => DockFocusUi.resolveHudContainerStyle({
    minimalMode: this.options.minimalMode(),
    mobile: this.options.mobile(),
    dragging: this.hudDragging(),
    position: this.hudPosition(),
    fallbackPosition: defaultHudPosition(this.hudSize()),
  }));

  private hudDragPointerId: number | null = null;
  private hudDragOffset: HudPosition | null = null;

  constructor(private readonly options: ParkingDockHudDragControllerOptions) {}

  onPointerMove(event: PointerEvent): void {
    if (!this.hudDragging()) return;
    if (this.hudDragPointerId !== null && event.pointerId !== this.hudDragPointerId) return;
    if (!this.hudDragOffset) return;

    this.hudPosition.set(clampHudPosition({
      x: event.clientX - this.hudDragOffset.x,
      y: event.clientY - this.hudDragOffset.y,
    }, this.hudSize()));
  }

  onPointerUp(event: PointerEvent): void {
    if (!this.hudDragging()) return;
    if (this.hudDragPointerId !== null && event.pointerId !== this.hudDragPointerId) return;

    this.hudDragging.set(false);
    this.hudDragPointerId = null;
    this.hudDragOffset = null;
    this.persist();
  }

  onPointerDown(event: PointerEvent): void {
    if (this.options.minimalMode()) return;
    if (event.button !== 0) return;
    if (this.shouldIgnorePointerDown(event.target)) return;
    if (!(event.currentTarget instanceof HTMLElement)) return;

    const container = event.currentTarget
      .closest('[data-testid="dock-v3-status-machine-container"]') as HTMLElement | null;
    const size = resolveHudSize(container?.getBoundingClientRect(), this.hudSize());
    const current = this.hudPosition() ?? defaultHudPosition(size);
    const clamped = clampHudPosition(current, size);

    this.hudSize.set(size);
    this.hudPosition.set(clamped);
    this.hudDragging.set(true);
    this.hudDragPointerId = event.pointerId;
    this.hudDragOffset = {
      x: event.clientX - clamped.x,
      y: event.clientY - clamped.y,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  persist(): void {
    persistHudPosition(this.hudPosition());
  }

  private shouldIgnorePointerDown(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;

    return target.closest(
      [
        'button',
        'a',
        'input',
        'textarea',
        'select',
        'label',
        'summary',
        '[role="button"]',
        '[contenteditable="true"]',
        '[data-hud-drag-ignore]',
      ].join(','),
    ) !== null;
  }
}
