import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PARKING_CONFIG } from '../../../config/parking.config';
import { ParkingDockHudDragController } from './parking-dock-hud-drag.controller';

const STORAGE_KEY = PARKING_CONFIG.FOCUS_HUD_LAYOUT_STORAGE_KEY;

function createController(): ParkingDockHudDragController {
  return new ParkingDockHudDragController({
    minimalMode: signal(false),
    mobile: signal(false),
  });
}

function createHudElements(): {
  readonly shell: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly setPointerCapture: ReturnType<typeof vi.fn>;
} {
  const container = document.createElement('div');
  container.setAttribute('data-testid', 'dock-v3-status-machine-container');
  Object.defineProperty(container, 'getBoundingClientRect', {
    value: () => ({ width: 300, height: 200 }),
  });

  const shell = document.createElement('div');
  const setPointerCapture = vi.fn();
  Object.defineProperty(shell, 'setPointerCapture', {
    configurable: true,
    value: setPointerCapture,
  });

  const button = document.createElement('button');
  shell.appendChild(button);
  container.appendChild(shell);
  document.body.appendChild(container);

  return { shell, button, setPointerCapture };
}

function pointerEvent(init: {
  readonly currentTarget: HTMLElement;
  readonly target: EventTarget | null;
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerId: number;
  readonly preventDefault?: ReturnType<typeof vi.fn>;
}): PointerEvent {
  return {
    button: 0,
    clientX: init.clientX,
    clientY: init.clientY,
    currentTarget: init.currentTarget,
    target: init.target,
    pointerId: init.pointerId,
    preventDefault: init.preventDefault ?? vi.fn(),
  } as unknown as PointerEvent;
}

describe('ParkingDockHudDragController', () => {
  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    document.body.innerHTML = '';
  });

  it('starts dragging from the current HUD position and persists on release', () => {
    const controller = createController();
    const { shell, setPointerCapture } = createHudElements();
    const preventDefault = vi.fn();

    controller.hudPosition.set({ x: 100, y: 120 });
    controller.onPointerDown(pointerEvent({
      currentTarget: shell,
      target: shell,
      clientX: 130,
      clientY: 160,
      pointerId: 7,
      preventDefault,
    }));
    controller.onPointerMove(pointerEvent({
      currentTarget: shell,
      target: shell,
      clientX: 230,
      clientY: 260,
      pointerId: 7,
    }));
    controller.onPointerUp(pointerEvent({
      currentTarget: shell,
      target: shell,
      clientX: 230,
      clientY: 260,
      pointerId: 7,
    }));

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(controller.hudDragging()).toBe(false);
    expect(controller.hudPosition()).toEqual({ x: 200, y: 220 });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({ x: 200, y: 220 });
  });

  it('ignores interactive header controls so their clicks are not converted into drags', () => {
    const controller = createController();
    const { shell, button, setPointerCapture } = createHudElements();
    const preventDefault = vi.fn();

    controller.onPointerDown(pointerEvent({
      currentTarget: shell,
      target: button,
      clientX: 48,
      clientY: 48,
      pointerId: 1,
      preventDefault,
    }));

    expect(controller.hudDragging()).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(setPointerCapture).not.toHaveBeenCalled();
  });
});
