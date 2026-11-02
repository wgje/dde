import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerformanceTierService } from './performance-tier.service';
import { PARKING_CONFIG } from '../config/parking.config';

type FrameCallback = (timestamp: number) => void;

/**
 * RAF 采样窗口驱动器：按目标 fps 推进一个完整采样窗口。
 * frames 帧在 FOCUS_PERF_SAMPLE_WINDOW_MS 内均匀到达，最后一帧恰好触达窗口边界，
 * 使 evaluateTier 收到的 fps 正好等于 frames。
 */
function createFrameDriver(getCallback: () => FrameCallback | null) {
  let now = 0;

  return {
    runWindow(frames: number): void {
      const windowMs = PARKING_CONFIG.FOCUS_PERF_SAMPLE_WINDOW_MS;
      const base = now;
      for (let frame = 1; frame <= frames; frame += 1) {
        // 最后一帧精确落在窗口边界，避免浮点步长累加后 elapsed 差一丁点关不上窗口
        now = frame === frames ? base + windowMs : base + (windowMs * frame) / frames;
        getCallback()?.(now);
      }
    },
  };
}

describe('PerformanceTierService', () => {
  let frameCallback: FrameCallback | null;
  let rafSpy: ReturnType<typeof vi.fn>;
  let cafSpy: ReturnType<typeof vi.fn>;

  function createService(): PerformanceTierService {
    TestBed.configureTestingModule({
      providers: [PerformanceTierService],
    });
    return TestBed.inject(PerformanceTierService);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    frameCallback = null;
    let rafId = 0;
    rafSpy = vi.fn((callback: FrameCallback) => {
      frameCallback = callback;
      rafId += 1;
      return rafId;
    });
    cafSpy = vi.fn(() => {
      frameCallback = null;
    });
    vi.stubGlobal('requestAnimationFrame', rafSpy);
    vi.stubGlobal('cancelAnimationFrame', cafSpy);
    vi.spyOn(performance, 'now').mockReturnValue(0);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.runOnlyPendingTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('should initialize with T0 tier', () => {
    const service = createService();
    expect(service.tier()).toBe('T0');
  });

  it('degrades to T1 only after the hysteresis window count of low-fps samples', () => {
    const service = createService();
    const driver = createFrameDriver(() => frameCallback);
    service.startMeasuring();
    const lowFps = PARKING_CONFIG.FOCUS_PERF_T1_FPS - 5;

    driver.runWindow(lowFps);

    // 单个低帧率窗口不降级：迟滞窗口未满
    expect(service.tier()).toBe('T0');
    expect(service.lastMeasuredFps()).toBe(lowFps);

    driver.runWindow(lowFps);

    expect(service.tier()).toBe('T1');
    expect(service.isTier1Plus()).toBe(true);
    expect(service.isTier2()).toBe(false);
  });

  it('degrades straight to T2 when fps stays below the T2 threshold', () => {
    const service = createService();
    const driver = createFrameDriver(() => frameCallback);
    service.startMeasuring();
    const criticalFps = PARKING_CONFIG.FOCUS_PERF_T2_FPS - 10;

    driver.runWindow(criticalFps);
    driver.runWindow(criticalFps);

    expect(service.tier()).toBe('T2');
    expect(service.isTier2()).toBe(true);
  });

  it('recovers to T0 only after sustained high-fps windows', () => {
    const service = createService();
    const driver = createFrameDriver(() => frameCallback);
    service.startMeasuring();
    const lowFps = PARKING_CONFIG.FOCUS_PERF_T1_FPS - 5;
    const recoveredFps = PARKING_CONFIG.FOCUS_PERF_RECOVER_FPS + 4;

    driver.runWindow(lowFps);
    driver.runWindow(lowFps);
    expect(service.tier()).toBe('T1');

    driver.runWindow(recoveredFps);

    // 恢复同样受迟滞保护：单个高帧率窗口不回 T0
    expect(service.tier()).toBe('T1');

    driver.runWindow(recoveredFps);

    expect(service.tier()).toBe('T0');
  });

  it('resets the degrade streak when a neutral window interrupts low-fps samples', () => {
    const service = createService();
    const driver = createFrameDriver(() => frameCallback);
    service.startMeasuring();
    const lowFps = PARKING_CONFIG.FOCUS_PERF_T1_FPS - 5;
    // 处于降级线与恢复线之间的“中性”帧率
    const neutralFps = PARKING_CONFIG.FOCUS_PERF_RECOVER_FPS - 2;

    driver.runWindow(lowFps);
    driver.runWindow(neutralFps);
    driver.runWindow(lowFps);

    // 非连续低帧率窗口不得累计触发降级
    expect(service.tier()).toBe('T0');

    driver.runWindow(lowFps);

    expect(service.tier()).toBe('T1');
  });

  it('reference-counts startMeasuring so sampling starts once and stops with the last consumer', () => {
    const service = createService();

    service.startMeasuring();
    service.startMeasuring();

    // 两个消费方共享同一 RAF 采样循环
    expect(rafSpy).toHaveBeenCalledTimes(1);

    service.stopMeasuring();

    expect(cafSpy).not.toHaveBeenCalled();

    service.stopMeasuring();

    expect(cafSpy).toHaveBeenCalledTimes(1);
  });

  it('restarts sampling when a new consumer arrives after the last one stopped', () => {
    const service = createService();

    service.startMeasuring();
    service.stopMeasuring();
    expect(cafSpy).toHaveBeenCalledTimes(1);

    service.startMeasuring();

    expect(rafSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps extra stopMeasuring calls from underflowing the consumer count', () => {
    const service = createService();

    service.stopMeasuring();
    service.startMeasuring();

    // 多余的 stop 不得把引用计数打成负数导致后续 start 失效
    expect(rafSpy).toHaveBeenCalledTimes(1);
  });

  it('销毁后迟到的 startMeasuring 不应重新启动 RAF 采样', () => {
    const service = createService();
    service.startMeasuring();
    expect(rafSpy).toHaveBeenCalledTimes(1);

    service.ngOnDestroy();
    expect(cafSpy).toHaveBeenCalledWith(1);

    rafSpy.mockClear();
    service.startMeasuring();

    expect(rafSpy).not.toHaveBeenCalled();
  });
});
