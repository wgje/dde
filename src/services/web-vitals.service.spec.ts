/**
 * Web Vitals Service 单元测试
 * 
 * 测试范围:
 * 1. 网络质量检测
 * 2. 动态阈值计算
 * 3. Sentry 告警过滤
 * 4. 弱网环境处理
 */

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi, type Mock, type MockedObject } from 'vitest';
import { WebVitalsService, WEB_VITALS_THRESHOLDS } from './web-vitals.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import { isDevMode } from '@angular/core';

vi.mock('@angular/core', async () => {
  const actual = await vi.importActual<typeof import('@angular/core')>('@angular/core');
  return {
    ...actual,
    isDevMode: vi.fn(),
  };
});

const isDevModeMock = vi.mocked(isDevMode);

// Mock web-vitals library
vi.mock('web-vitals', () => ({
  onLCP: vi.fn(),
  onFCP: vi.fn(),
  onCLS: vi.fn(),
  onINP: vi.fn(),
  onTTFB: vi.fn(),
}));

describe('WebVitalsService - TTFB 优化测试', () => {
  let service: WebVitalsService;
  let mockLogger: Partial<LoggerService>;

  // Mock navigator.connection
  const mockConnection = (effectiveType: string, downlink: number, rtt: number) => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { effectiveType, downlink, rtt },
      writable: true,
    });
  };

  beforeEach(() => {
    isDevModeMock.mockReturnValue(true);

    // Reset Sentry mocks
    mockSentryLazyLoaderService.setMeasurement.mockClear();
    mockSentryLazyLoaderService.captureMessage.mockClear();

    // Mock LoggerService
    mockLogger = {
      category: vi.fn().mockReturnValue({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    } as any;

    TestBed.configureTestingModule({
      providers: [
        WebVitalsService,
        { provide: LoggerService, useValue: mockLogger },
        { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
      ],
    });

    service = TestBed.inject(WebVitalsService);
  });

  afterEach(() => {
    // Clean up connection mock
    delete (navigator as any).connection;
  });

  describe('网络质量检测', () => {
    it('应该正确检测 4G 快速网络', () => {
      mockConnection('4g', 10, 50);
      
      // @ts-ignore - 访问私有方法进行测试
      const quality = service['detectNetworkQuality']();
      
      expect(quality).toBe('fast');
    });

    it('应该正确检测 3G 慢速网络', () => {
      mockConnection('3g', 1.35, 350); // 与 Sentry Alert 数据一致
      
      // @ts-ignore
      const quality = service['detectNetworkQuality']();
      
      expect(quality).toBe('slow');
    });

    it('应该正确检测 2G 网络', () => {
      mockConnection('2g', 0.4, 800);
      
      // @ts-ignore
      const quality = service['detectNetworkQuality']();
      
      expect(quality).toBe('slow');
    });

    it('应该正确检测极慢网络', () => {
      mockConnection('slow-2g', 0.1, 2000);
      
      // @ts-ignore
      const quality = service['detectNetworkQuality']();
      
      expect(quality).toBe('offline');
    });

    it('没有 Network Information API 时应该返回 unknown', () => {
      // Don't mock connection
      
      // @ts-ignore
      const quality = service['detectNetworkQuality']();
      
      expect(quality).toBe('unknown');
    });
  });

  describe('TTFB 阈值计算（生产环境）', () => {
    beforeEach(async () => {
      // Mock 生产环境
      isDevModeMock.mockReturnValue(false);
    });

    it('4G 网络应该使用标准阈值', () => {
      mockConnection('4g', 10, 50);
      
      // @ts-ignore
      const rating700 = service['getRating']('TTFB', 700);
      // @ts-ignore
      const rating1500 = service['getRating']('TTFB', 1500);
      // @ts-ignore
      const rating2000 = service['getRating']('TTFB', 2000);
      
      expect(rating700).toBe('good'); // < 800ms
      expect(rating1500).toBe('needs-improvement'); // < 1800ms
      expect(rating2000).toBe('poor'); // >= 1800ms
    });

    it('3G 网络应该使用放宽的阈值', () => {
      mockConnection('3g', 1.35, 350);
      
      // @ts-ignore
      const rating2500 = service['getRating']('TTFB', 2500);
      // @ts-ignore
      const rating2861 = service['getRating']('TTFB', 2861); // 实际 Sentry Alert 值
      // @ts-ignore
      const rating4500 = service['getRating']('TTFB', 4500);
      // @ts-ignore
      const rating5500 = service['getRating']('TTFB', 5500);
      
      expect(rating2500).toBe('good'); // < 3000ms
      expect(rating2861).toBe('good'); // < 3000ms - 关键测试！
      expect(rating4500).toBe('needs-improvement'); // < 5000ms
      expect(rating5500).toBe('poor'); // >= 5000ms
    });

    it('2G 网络应该使用放宽的阈值', () => {
      mockConnection('2g', 0.4, 800);
      
      // @ts-ignore
      const rating2900 = service['getRating']('TTFB', 2900);
      // @ts-ignore
      const rating4900 = service['getRating']('TTFB', 4900);
      
      expect(rating2900).toBe('good');
      expect(rating4900).toBe('needs-improvement');
    });
  });

  describe('Sentry 告警过滤', () => {
    beforeEach(async () => {
      // Mock 生产环境
      isDevModeMock.mockReturnValue(false);
    });

    it('3G 网络下的 poor TTFB 不应该触发告警', () => {
      mockConnection('3g', 1.35, 350);
      
      const metric = {
        name: 'TTFB',
        value: 2861,
        id: 'test-id',
        delta: 2861,
        navigationType: 'navigate',
        entries: [],
      } as any;
      
      // @ts-ignore
      service['reportToSentry'](metric, 'poor');
      
      // 不应该调用 captureMessage
      expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
      
      // 应该调用 setMeasurement（记录指标）
      expect(mockSentryLazyLoaderService.setMeasurement).toHaveBeenCalledWith('TTFB', 2861, 'millisecond');
    });

    it('4G 网络下的 poor TTFB 应该触发告警', () => {
      mockConnection('4g', 10, 50);
      
      const metric = {
        name: 'TTFB',
        value: 2861,
        id: 'test-id',
        delta: 2861,
        navigationType: 'navigate',
        entries: [],
      } as any;
      
      // @ts-ignore
      service['reportToSentry'](metric, 'poor');
      
      // 应该触发告警
      expect(mockSentryLazyLoaderService.captureMessage).toHaveBeenCalledWith(
        '性能告警: TTFB 超出阈值',
        expect.objectContaining({
          level: 'warning',
          tags: expect.objectContaining({
            'web-vital': 'TTFB',
            'rating': 'poor',
            'network-quality': 'fast',
          }),
          extra: expect.objectContaining({
            value: 2861,
            networkInfo: expect.objectContaining({
              effectiveType: '4g',
              downlink: 10,
              rtt: 50,
            }),
          }),
        })
      );
    });

    it('其他 Web Vitals 指标不受网络质量影响', () => {
      mockConnection('3g', 1.35, 350);
      
      const lcpMetric = {
        name: 'LCP',
        value: 5000,
        id: 'test-id',
        delta: 5000,
        navigationType: 'navigate',
        entries: [],
      } as any;
      
      // @ts-ignore
      service['reportToSentry'](lcpMetric, 'poor');
      
      // LCP 应该正常触发告警（不受网络质量过滤影响）
      expect(mockSentryLazyLoaderService.captureMessage).toHaveBeenCalled();
    });
  });

  describe('网络信息上下文', () => {
    it('应该正确提取网络信息', () => {
      mockConnection('3g', 1.35, 350);
      
      // @ts-ignore
      const networkInfo = service['getNetworkInfo']();
      
      expect(networkInfo).toEqual({
        effectiveType: '3g',
        downlink: 1.35,
        rtt: 350,
      });
    });

    it('没有 Network Information API 时应该返回 null', () => {
      // Don't mock connection
      
      // @ts-ignore
      const networkInfo = service['getNetworkInfo']();
      
      expect(networkInfo).toBeNull();
    });
  });

  describe('缓存机制', () => {
    it('应该缓存网络质量检测结果', () => {
      mockConnection('3g', 1.35, 350);
      
      // @ts-ignore
      const quality1 = service['detectNetworkQuality']();
      
      // 修改 connection 模拟数据
      mockConnection('4g', 10, 50);
      
      // @ts-ignore
      const quality2 = service['detectNetworkQuality']();
      
      // 第二次应该返回缓存的结果（slow），而不是重新检测（fast）
      expect(quality1).toBe('slow');
      expect(quality2).toBe('slow'); // 缓存生效
    });
  });
});
