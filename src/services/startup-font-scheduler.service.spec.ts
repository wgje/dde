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
  });

  it('无交互时应在兜底延迟后加载增强字体', () => {
    service.initialize();
    vi.advanceTimersByTime(STARTUP_PERF_CONFIG.FONT_ENHANCED_LOAD_DELAY_MS);

    expect(appendedLinks.length).toBe(1);

    appendedLinks[0].onload?.(new Event('load'));
    expect(service.isEnhancedFontLoaded()).toBe(true);
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

  it('弱网下 timeout 触发应跳过，force 兜底应在上限时间触发', () => {
    Object.defineProperty(navigator, 'connection', {
      value: { effectiveType: '2g', downlink: 0.8, rtt: 500, saveData: true },
      configurable: true,
      writable: true,
    });

    service.initialize();
    vi.advanceTimersByTime(STARTUP_PERF_CONFIG.FONT_ENHANCED_LOAD_DELAY_MS);
    expect(appendedLinks.length).toBe(0);

    vi.advanceTimersByTime(
      STARTUP_PERF_CONFIG.FONT_ENHANCED_FORCE_LOAD_MAX_DELAY_MS -
      STARTUP_PERF_CONFIG.FONT_ENHANCED_LOAD_DELAY_MS
    );
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
});
