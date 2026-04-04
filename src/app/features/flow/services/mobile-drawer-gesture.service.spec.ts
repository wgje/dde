import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileDrawerGestureService } from './mobile-drawer-gesture.service';

interface MockVisualViewport {
  height: number;
  offsetTop: number;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

describe('MobileDrawerGestureService', () => {
  const originalVisualViewport = window.visualViewport;

  let service: MobileDrawerGestureService;
  let visualViewport: MockVisualViewport;
  let container: HTMLElement;

  beforeEach(() => {
    visualViewport = {
      height: 727,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    });

    service = new MobileDrawerGestureService();
    service.initialize();

    container = document.createElement('div');
    vi.spyOn(container, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0,
      y: 30,
      width: 393,
      height: 697,
      top: 30,
      bottom: 727,
      left: 0,
      right: 393,
      toJSON: () => ({}),
    }));

    service.setContainer(container);
  });

  afterEach(() => {
    service.destroy();
    vi.restoreAllMocks();
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: originalVisualViewport,
    });
  });

  it('应使用容器与 visualViewport 的交集作为可见高度', () => {
    visualViewport.height = 660;
    visualViewport.offsetTop = 0;

    window.dispatchEvent(new Event('resize'));

    expect(service.visibleContainerOffsetTopPx()).toBe(0);
    expect(service.visibleContainerHeightPx()).toBe(630);
  });

  it('应在 visualViewport 上边缘切入容器时同步顶部偏移', () => {
    visualViewport.height = 620;
    visualViewport.offsetTop = 54;

    window.dispatchEvent(new Event('resize'));

    expect(service.visibleContainerOffsetTopPx()).toBe(24);
    expect(service.visibleContainerHeightPx()).toBe(620);
  });

  it('应基于可见高度命中底部把手，避免隐藏区域导致点击失效', () => {
    visualViewport.height = 660;
    visualViewport.offsetTop = 0;

    window.dispatchEvent(new Event('resize'));

    const visibleTop = 30;
    const visibleHeight = 630;
    const collapsedBottomHeight = visibleHeight * 0.03;
    const handleCenterY = visibleTop + (visibleHeight - collapsedBottomHeight) + 10;

    expect(service.detectHandleTouch(handleCenterY)).toBe('bottom');
  });
});