import { TestBed } from '@angular/core/testing';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { StartupFontSchedulerService } from './startup-font-scheduler.service';
import { LoggerService } from './logger.service';
import { STARTUP_PERF_CONFIG } from '../config/startup-performance.config';

describe('StartupFontSchedulerService', () => {
  let service: StartupFontSchedulerService;
  let appendSpy: ReturnType<typeof vi.spyOn>;
  let appendedLinks: HTMLLinkElement[];
  const originalConnection = (navigator as Navigator & { connection?: unknown }).connection;

  beforeEach(() => {
    vi.useFakeTimers();
    appendedLinks = [];
    appendSpy = vi.spyOn(document.head, 'appendChild').mockImplementation((node: Node) => {
      if (node instanceof HTMLLinkElement) {
        appendedLinks.push(node);
      }
      return node;
    });

    TestBed.configureTestingModule({
      providers: [
        StartupFontSchedulerService,
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              warn: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
      ],
    });

    service = TestBed.inject(StartupFontSchedulerService);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    appendSpy.mockRestore();
    Object.defineProperty(navigator, 'connection', {
      value: originalConnection,
      configurable: true,
      writable: true,
    });
    delete (window as Window & { __NANOFLOW_BOOT_FLAGS__?: unknown }).__NANOFLOW_BOOT_FLAGS__;
    TestBed.resetTestingModule();
  });

  it('首次交互应立即触发增强字体加载', () => {
    service.initialize();
    expect(appendedLinks.length).toBe(0);

    window.dispatchEvent(new Event('pointerdown'));
    expect(appendedLinks.length).toBe(1);

    appendedLinks[0].onload?.(new Event('load'));
    expect(service.isEnhancedFontLoaded()).toBe(true);

    // 自托管字体加载成功后应注入 CDN 补充字体
    expect(appendedLinks.length).toBe(2);
    expect(appendedLinks[1].href).toContain('cdn.jsdelivr.net');
    expect(appendedLinks[1].getAttribute('data-nanoflow-cdn-font')).toBe('true');
  });

  it('无交互时应在兜底延迟后加载增强字体', () => {
    service.initialize();
    vi.advanceTimersByTime(STARTUP_PERF_CONFIG.FONT_ENHANCED_LOAD_DELAY_MS);

    expect(appendedLinks.length).toBe(1);

    appendedLinks[0].onload?.(new Event('load'));
    expect(service.isEnhancedFontLoaded()).toBe(true);
    // CDN 补充字体也应被注入
    expect(appendedLinks.length).toBe(2);
    expect(appendedLinks[1].getAttribute('data-nanoflow-cdn-font')).toBe('true');
  });

  it('交互监听解绑失败时仍应继续加载增强字体', () => {
    service.initialize();
    const removeWindowListener = vi
      .spyOn(window, 'removeEventListener')
      .mockImplementationOnce(() => {
        throw new Error('remove pointerdown failed');
      });

    try {
      expect(() => {
        vi.advanceTimersByTime(STARTUP_PERF_CONFIG.FONT_ENHANCED_LOAD_DELAY_MS);
      }).not.toThrow();
      expect(removeWindowListener).toHaveBeenCalledWith('keydown', expect.any(Function));
      expect(removeWindowListener).toHaveBeenCalledWith('touchstart', expect.any(Function));
      expect(appendedLinks.length).toBe(1);
    } finally {
      removeWindowListener.mockRestore();
    }
  });

  it('交互监听注册失败时应回滚并允许后续 initialize 重试', () => {
    const setupError = new Error('keydown listener failed');
    const originalWindowAdd = window.addEventListener.bind(window);
    const originalWindowRemove = window.removeEventListener.bind(window);
    let addWindowListenerRestored = false;
    const addWindowListener = vi
      .spyOn(window, 'addEventListener')
      .mockImplementation((...args: Parameters<typeof window.addEventListener>) => {
        if (args[0] === 'keydown') {
          throw setupError;
        }
        return originalWindowAdd(...args);
      });
    const removeWindowListener = vi
      .spyOn(window, 'removeEventListener')
      .mockImplementation((...args: Parameters<typeof window.removeEventListener>) => {
        return originalWindowRemove(...args);
      });

    try {
      expect(() => service.initialize()).not.toThrow();
      expect(removeWindowListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));

      addWindowListener.mockRestore();
      addWindowListenerRestored = true;
      service.initialize();

      window.dispatchEvent(new Event('pointerdown'));
      expect(appendedLinks.length).toBe(1);
    } finally {
      if (!addWindowListenerRestored) {
        addWindowListener.mockRestore();
      }
      removeWindowListener.mockRestore();
    }
  });

  it('timer handle 为 0 时交互加载也应清理兜底定时器', () => {
    const timerHandle = 0 as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => timerHandle);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    try {
      service.initialize();
      window.dispatchEvent(new Event('pointerdown'));

      expect(setTimeoutSpy).toHaveBeenCalled();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      expect(appendedLinks.length).toBe(1);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('销毁后应清除增强字体失败重试，避免旧实例继续追加 link', () => {
    service.initialize();
    window.dispatchEvent(new Event('pointerdown'));
    expect(appendedLinks.length).toBe(1);

    appendedLinks[0].onerror?.(new Event('error'));
    expect(appendedLinks.length).toBe(2);
    appendedLinks[1].onerror?.(new Event('error'));

    TestBed.resetTestingModule();
    vi.advanceTimersByTime(5_000);

    expect(appendedLinks.length).toBe(2);
  });

  it('销毁后 late onload 不应标记字体已加载或注入 CDN link', () => {
    service.initialize();
    window.dispatchEvent(new Event('pointerdown'));
    expect(appendedLinks.length).toBe(1);

    TestBed.resetTestingModule();
    appendedLinks[0].onload?.(new Event('load'));

    expect(service.isEnhancedFontLoaded()).toBe(false);
    expect(appendedLinks.length).toBe(1);
  });

  it('销毁后 late onerror 不应继续追加备用字体 link', () => {
    service.initialize();
    window.dispatchEvent(new Event('pointerdown'));
    expect(appendedLinks.length).toBe(1);

    TestBed.resetTestingModule();
    appendedLinks[0].onerror?.(new Event('error'));
    vi.advanceTimersByTime(5_000);

    expect(service.isEnhancedFontLoaded()).toBe(false);
    expect(appendedLinks.length).toBe(1);
  });

  it('重复 initialize 应保持幂等且只注入一次样式链接', () => {
    service.initialize();
    service.initialize();

    window.dispatchEvent(new Event('keydown'));
    expect(appendedLinks.length).toBe(1);
  });

  it('Boot flag 关闭极致首屏时应立即加载增强字体', () => {
    (window as Window & { __NANOFLOW_BOOT_FLAGS__?: { FONT_EXTREME_FIRSTPAINT_V1?: boolean } })
      .__NANOFLOW_BOOT_FLAGS__ = { FONT_EXTREME_FIRSTPAINT_V1: false };

    service.initialize();
    expect(appendedLinks.length).toBe(1);
  });

  it('弱网下 timeout 触发不应跳过（SKIP_ON_CONSTRAINED_NETWORK=false），直接加载', () => {
    Object.defineProperty(navigator, 'connection', {
      value: { effectiveType: '2g', downlink: 0.8, rtt: 500, saveData: true },
      configurable: true,
      writable: true,
    });

    service.initialize();
    vi.advanceTimersByTime(STARTUP_PERF_CONFIG.FONT_ENHANCED_LOAD_DELAY_MS);
    // 【修复 2026-02-20】SKIP_ON_CONSTRAINED_NETWORK=false 时弱网也不跳过
    expect(appendedLinks.length).toBe(1);
  });

  it('关闭激进延后时，timeout 应不受弱网限制直接触发', () => {
    (window as Window & {
      __NANOFLOW_BOOT_FLAGS__?: { FONT_AGGRESSIVE_DEFER_V2?: boolean; FONT_EXTREME_FIRSTPAINT_V1?: boolean };
    }).__NANOFLOW_BOOT_FLAGS__ = { FONT_AGGRESSIVE_DEFER_V2: false, FONT_EXTREME_FIRSTPAINT_V1: true };

    Object.defineProperty(navigator, 'connection', {
      value: { effectiveType: '2g', downlink: 0.8, rtt: 500, saveData: true },
      configurable: true,
      writable: true,
    });

    service.initialize();
    vi.advanceTimersByTime(STARTUP_PERF_CONFIG.FONT_ENHANCED_LOAD_DELAY_MS);
    expect(appendedLinks.length).toBe(1);
  });

  it('CDN 补充字体不应重复注入', () => {
    service.initialize();
    window.dispatchEvent(new Event('pointerdown'));
    appendedLinks[0].onload?.(new Event('load'));
    // 第一次注入 CDN
    expect(appendedLinks.length).toBe(2);

    // 模拟 DOM 查询到已有 CDN link
    const originalQuerySelector = document.querySelector.bind(document);
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'link[data-nanoflow-cdn-font]') {
        return appendedLinks[1]; // 返回已注入的 CDN link
      }
      return originalQuerySelector(selector);
    });

    // 再次触发不应增加新的 link
    appendedLinks[0].onload?.(new Event('load'));
    expect(appendedLinks.length).toBe(2);
  });
});
