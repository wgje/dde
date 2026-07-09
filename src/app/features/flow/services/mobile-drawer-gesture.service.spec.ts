import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileDrawerGestureService } from './mobile-drawer-gesture.service';
import { DRAWER_CONFIG } from '../../../../config/drawer.config';

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
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextRafId: number;

  beforeEach(() => {
    rafCallbacks = new Map<number, FrameRequestCallback>();
    nextRafId = 1;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, callback);
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      rafCallbacks.delete(id);
    });

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
    vi.unstubAllGlobals();
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

  it('SSR 环境没有 window 时初始化和销毁不应抛出', () => {
    service.destroy();
    vi.stubGlobal('window', undefined);

    const ssrService = new MobileDrawerGestureService();

    expect(() => ssrService.initialize()).not.toThrow();
    expect(() => ssrService.destroy()).not.toThrow();
  });

  it('ResizeObserver 不可用时仍应允许绑定容器并刷新尺寸', () => {
    service.destroy();
    vi.stubGlobal('ResizeObserver', undefined);

    const localService = new MobileDrawerGestureService();
    localService.initialize();

    expect(() => localService.setContainer(container)).not.toThrow();
    expect(localService.visibleContainerHeightPx()).toBe(697);

    localService.destroy();
  });

  it('dismissGestureHint 在 timer handle 为 0 时仍应清理提示定时器', () => {
    service.destroy();
    localStorage.removeItem(DRAWER_CONFIG.GESTURE_HINT_SHOWN_KEY);

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    const localService = new MobileDrawerGestureService();
    localService.initialize();

    expect(localService.showGestureHint()).toBe(true);

    localService.dismissGestureHint();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(localService.showGestureHint()).toBe(false);

    localService.destroy();
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it('重复 initialize 不应重复注册窗口与 visualViewport 监听器', () => {
    service.destroy();
    const addWindowListener = vi.spyOn(window, 'addEventListener');
    visualViewport.addEventListener.mockClear();
    const localService = new MobileDrawerGestureService();

    localService.initialize();
    localService.initialize();

    expect(addWindowListener.mock.calls.filter(([eventName]) => eventName === 'resize')).toHaveLength(1);
    expect(addWindowListener.mock.calls.filter(([eventName]) => eventName === 'orientationchange')).toHaveLength(1);
    expect(visualViewport.addEventListener.mock.calls.filter(([eventName]) => eventName === 'resize')).toHaveLength(1);
    expect(visualViewport.addEventListener.mock.calls.filter(([eventName]) => eventName === 'scroll')).toHaveLength(1);

    localService.destroy();
  });

  it('touchcancel 后应清理拖拽状态，后续 touchmove 不应继续调整高度', () => {
    visualViewport.height = 660;
    visualViewport.offsetTop = 0;
    window.dispatchEvent(new Event('resize'));

    const visibleTop = 30;
    const visibleHeight = 630;
    const collapsedBottomHeight = visibleHeight * DRAWER_CONFIG.BOTTOM_SNAP_POINTS.COLLAPSED / 100;
    const handleCenterY = visibleTop + (visibleHeight - collapsedBottomHeight) + 10;

    expect(service.onTouchStart(createTouchEvent('touchstart', handleCenterY))).toBe(true);
    expect(service.onTouchMove(createTouchEvent('touchmove', handleCenterY - 80))).toBe(true);
    expect(service.isDragging()).toBe(true);

    const heightAfterDrag = service.bottomPanelHeight();

    service.onTouchCancel();

    expect(service.isDragging()).toBe(false);
    expect(service.onTouchMove(createTouchEvent('touchmove', handleCenterY - 160))).toBe(false);
    expect(service.bottomPanelHeight()).toBe(heightAfterDrag);
  });

  it('destroy 应中断进行中的手势并清理 dragging 状态', () => {
    visualViewport.height = 660;
    visualViewport.offsetTop = 0;
    window.dispatchEvent(new Event('resize'));

    const visibleTop = 30;
    const visibleHeight = 630;
    const collapsedBottomHeight = visibleHeight * DRAWER_CONFIG.BOTTOM_SNAP_POINTS.COLLAPSED / 100;
    const handleCenterY = visibleTop + (visibleHeight - collapsedBottomHeight) + 10;

    expect(service.onTouchStart(createTouchEvent('touchstart', handleCenterY))).toBe(true);
    expect(service.onTouchMove(createTouchEvent('touchmove', handleCenterY - 80))).toBe(true);
    expect(service.isDragging()).toBe(true);

    const heightAfterDrag = service.bottomPanelHeight();
    service.destroy();

    expect(service.isDragging()).toBe(false);
    expect(service.onTouchMove(createTouchEvent('touchmove', handleCenterY - 160))).toBe(false);
    expect(service.bottomPanelHeight()).toBe(heightAfterDrag);
  });

  it('closeDrawer 应同时收起已打开的顶部和底部抽屉', () => {
    service.openTopDrawer();
    flushAnimationFrame(rafCallbacks, DRAWER_CONFIG.ANIMATION_DURATION + 1);
    service.openBottomDrawer();
    flushAnimationFrame(rafCallbacks, DRAWER_CONFIG.ANIMATION_DURATION + 1);

    expect(service.topPanelHeight()).toBe(DRAWER_CONFIG.TOP_SNAP_POINTS.HALF);
    expect(service.bottomPanelHeight()).toBe(DRAWER_CONFIG.BOTTOM_SNAP_POINTS.HALF);

    service.closeDrawer();
    flushAnimationFrame(rafCallbacks, DRAWER_CONFIG.ANIMATION_DURATION + 1);

    expect(service.topPanelHeight()).toBe(DRAWER_CONFIG.TOP_SNAP_POINTS.COLLAPSED);
    expect(service.bottomPanelHeight()).toBe(DRAWER_CONFIG.BOTTOM_SNAP_POINTS.COLLAPSED);
    expect(service.activeLayer()).toBe('middle');
  });

  it('并行动画只在所有面板动画完成后才清除 isAnimating', () => {
    service.openTopDrawer();
    service.openBottomDrawer();

    expect(service.isAnimating()).toBe(true);

    flushOneAnimationFrame(rafCallbacks, DRAWER_CONFIG.ANIMATION_DURATION + 1);

    expect(service.isAnimating()).toBe(true);

    flushOneAnimationFrame(rafCallbacks, DRAWER_CONFIG.ANIMATION_DURATION + 1);

    expect(service.isAnimating()).toBe(false);
  });

  it('开始拖拽同一抽屉把手前应取消未完成的面板动画', () => {
    visualViewport.height = 660;
    visualViewport.offsetTop = 0;
    window.dispatchEvent(new Event('resize'));

    service.openTopDrawer();
    expect(service.isAnimating()).toBe(true);
    expect(rafCallbacks.size).toBe(1);

    const visibleTop = 30;
    const visibleHeight = 630;
    const topHeightPx = visibleHeight * DRAWER_CONFIG.TOP_SNAP_POINTS.COLLAPSED / 100;
    const handleCenterY = visibleTop + topHeightPx + 10;

    expect(service.onTouchStart(createTouchEvent('touchstart', handleCenterY))).toBe(true);

    expect(rafCallbacks.size).toBe(0);
    expect(service.isAnimating()).toBe(false);
  });
});

function createTouchEvent(type: string, clientY: number): TouchEvent {
  return {
    type,
    touches: [{ clientY }],
    changedTouches: [{ clientY }],
    cancelable: true,
    preventDefault: vi.fn(),
  } as unknown as TouchEvent;
}

function flushAnimationFrame(callbacks: Map<number, FrameRequestCallback>, elapsedMs: number): void {
  const frameCallbacks = Array.from(callbacks.entries());
  callbacks.clear();
  const now = performance.now() + elapsedMs;
  for (const [, callback] of frameCallbacks) {
    callback(now);
  }
}

function flushOneAnimationFrame(callbacks: Map<number, FrameRequestCallback>, elapsedMs: number): void {
  const [id, callback] = callbacks.entries().next().value ?? [];
  if (id === undefined || !callback) return;
  callbacks.delete(id);
  callback(performance.now() + elapsedMs);
}
