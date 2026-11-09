import { NgZone } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggerService } from '../../../../services/logger.service';
import { FlowDiagramFontRedrawService } from './flow-diagram-font-redraw.service';

type LoadingDoneListener = () => void;

function createFontsMock() {
  let loadingDoneListener: LoadingDoneListener | null = null;
  return {
    addEventListener: vi.fn((eventName: string, listener: EventListenerOrEventListenerObject) => {
      if (eventName === 'loadingdone') {
        loadingDoneListener = listener as LoadingDoneListener;
      }
    }),
    dispatchLoadingDone: () => loadingDoneListener?.(),
    ready: new Promise<FontFaceSet>(() => undefined),
    removeEventListener: vi.fn((eventName: string, listener: EventListenerOrEventListenerObject) => {
      if (eventName === 'loadingdone' && loadingDoneListener === listener) {
        loadingDoneListener = null;
      }
    }),
  };
}

describe('FlowDiagramFontRedrawService', () => {
  let originalFontsDescriptor: PropertyDescriptor | undefined;
  let originalSetTimeout: typeof setTimeout;
  let originalClearTimeout: typeof clearTimeout;

  beforeEach(() => {
    originalFontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts')
      ?? Object.getOwnPropertyDescriptor(Document.prototype, 'fonts');
    originalSetTimeout = globalThis.setTimeout;
    originalClearTimeout = globalThis.clearTimeout;

    TestBed.configureTestingModule({
      providers: [
        FlowDiagramFontRedrawService,
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              error: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
            }),
          },
        },
        {
          provide: NgZone,
          useValue: new NgZone({ enableLongStackTrace: false }),
        },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      writable: true,
      value: originalSetTimeout,
    });
    Object.defineProperty(globalThis, 'clearTimeout', {
      configurable: true,
      writable: true,
      value: originalClearTimeout,
    });

    if (originalFontsDescriptor) {
      Object.defineProperty(document, 'fonts', originalFontsDescriptor);
    } else {
      Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('clears pending font redraw debounce timers when the timer id is 0', () => {
    const fonts = createFontsMock();
    const setTimeoutMock = vi.fn(() => 0);
    const clearTimeoutMock = vi.fn();
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: fonts,
    });
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      writable: true,
      value: setTimeoutMock,
    });
    Object.defineProperty(globalThis, 'clearTimeout', {
      configurable: true,
      writable: true,
      value: clearTimeoutMock,
    });
    const service = TestBed.inject(FlowDiagramFontRedrawService);

    service.schedulePostFontLoadRedraw(
      () => ({ requestUpdate: vi.fn(), updateAllTargetBindings: vi.fn() }) as never,
      () => true,
    );
    fonts.dispatchLoadingDone();
    fonts.dispatchLoadingDone();
    service.cleanupFontLoadListener();

    expect(setTimeoutMock).toHaveBeenCalledTimes(2);
    expect(clearTimeoutMock).toHaveBeenCalledTimes(2);
    expect(clearTimeoutMock).toHaveBeenNthCalledWith(1, 0);
    expect(clearTimeoutMock).toHaveBeenNthCalledWith(2, 0);
  });
});
