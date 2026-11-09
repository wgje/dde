import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FlowPaletteResizeService } from './flow-palette-resize.service';

describe('FlowPaletteResizeService', () => {
  let service: FlowPaletteResizeService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [FlowPaletteResizeService],
    });

    service = TestBed.inject(FlowPaletteResizeService);
  });

  afterEach(() => {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  it('cancels an active mouse resize and removes the window listeners', () => {
    const height = signal(200);
    service.bindHeightSignal(height);

    service.startMouseResize(new MouseEvent('mousedown', { clientY: 100, cancelable: true }));

    (service as { cancelActiveResize?: () => void }).cancelActiveResize?.();
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: 180 }));

    expect(service.isResizingPalette).toBe(false);
    expect(height()).toBe(200);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('cancels an active touch resize and removes the window listeners', () => {
    const height = signal(180);
    service.bindHeightSignal(height);

    service.startTouchResize(createTouchEvent('touchstart', 100));

    (service as { cancelActiveResize?: () => void }).cancelActiveResize?.();
    window.dispatchEvent(createTouchEvent('touchmove', 140));

    expect(service.isResizingPalette).toBe(false);
    expect(height()).toBe(180);
  });
});

function createTouchEvent(type: string, clientY: number): TouchEvent {
  const event = new Event(type, { cancelable: true }) as TouchEvent;
  Object.defineProperty(event, 'touches', {
    configurable: true,
    value: type === 'touchend' ? [] : [{ clientY }],
  });
  return event;
}
