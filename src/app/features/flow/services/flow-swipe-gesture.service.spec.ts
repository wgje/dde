import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggerService } from '../../../../services/logger.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { FlowSwipeGestureService } from './flow-swipe-gesture.service';

describe('FlowSwipeGestureService', () => {
  let service: FlowSwipeGestureService;
  const isMobile = signal(true);

  beforeEach(() => {
    isMobile.set(true);

    TestBed.configureTestingModule({
      providers: [
        FlowSwipeGestureService,
        {
          provide: LoggerService,
          useValue: {
            category: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
          },
        },
        {
          provide: UiStateService,
          useValue: { isMobile },
        },
      ],
    });

    service = TestBed.inject(FlowSwipeGestureService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
  });

  it('clears a pending diagram-area swipe when the touch ends after leaving mobile mode', () => {
    service.handleDiagramAreaTouchStart(createTouchEvent('touchstart', 200, 100));
    service.handleDiagramAreaTouchMove(createTouchEvent('touchmove', 120, 104));
    isMobile.set(false);

    expect(service.handleDiagramAreaTouchEnd(createTouchEvent('touchend', 120, 104))).toBe('none');

    isMobile.set(true);
    expect(service.handleDiagramAreaTouchEnd(createTouchEvent('touchend', 80, 104))).toBe('none');
  });

  it('ignores diagram-area move and end events without an accepted touchstart', () => {
    service.handleDiagramAreaTouchMove(createTouchEvent('touchmove', 90, 4));

    expect(service.handleDiagramAreaTouchEnd(createTouchEvent('touchend', 100, 4))).toBe('none');
  });
});

function createTouchEvent(type: string, clientX: number, clientY: number): TouchEvent {
  return {
    type,
    touches: type === 'touchend' ? [] : [{ clientX, clientY }],
    changedTouches: [{ clientX, clientY }],
  } as unknown as TouchEvent;
}
