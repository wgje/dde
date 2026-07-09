import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerformanceTierService } from './performance-tier.service';

// TODO: 扩展测试覆盖：tier 降级/恢复逻辑、startMeasuring/stopMeasuring 引用计数、
// FPS 采样窗口边界条件、ngOnDestroy 清理等。
describe('PerformanceTierService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.runOnlyPendingTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('should initialize with T0 tier', () => {
    TestBed.configureTestingModule({
      providers: [PerformanceTierService],
    });

    const service = TestBed.inject(PerformanceTierService);
    expect(service.tier()).toBe('T0');
  });

  it('销毁后迟到的 startMeasuring 不应重新启动 RAF 采样', () => {
    const requestAnimationFrameSpy = vi.fn(() => 1);
    const cancelAnimationFrameSpy = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameSpy);
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameSpy);

    TestBed.configureTestingModule({
      providers: [PerformanceTierService],
    });

    const service = TestBed.inject(PerformanceTierService);
    service.startMeasuring();
    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);

    service.ngOnDestroy();
    expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(1);

    requestAnimationFrameSpy.mockClear();
    service.startMeasuring();

    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
  });
});
