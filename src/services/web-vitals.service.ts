/**
 * Web Vitals 真实用户监控 (RUM) 服务
 * 
 * 职责：
 * - 收集 Core Web Vitals 指标 (LCP, FID, CLS, INP, TTFB)
 * - 将指标上报到 Sentry 用于性能监控
 * - 支持自定义阈值告警
 * 
 * 【性能优化 2026-01-17】
 * 实现策划案中的 "真实用户监控 (RUM)" 建议
 * 参考: docs/performance-analysis-report.md
 * 
 * 使用方式：
 * 在 main.ts 中调用 inject(WebVitalsService).init()
 */

import { Injectable, inject, isDevMode } from '@angular/core';
import { onLCP, onCLS, onINP, onTTFB, onFCP, type Metric } from 'web-vitals';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { LoggerService } from './logger.service';

/** Web Vitals 阈值配置 (基于 Google 推荐值) */
export const WEB_VITALS_THRESHOLDS = {
  /** 最大内容绘制 - 良好 < 2.5s, 需改进 < 4s, 差 >= 4s */
  LCP: { good: 2500, needsImprovement: 4000 },
  /** 首次内容绘制 - 良好 < 1.8s, 需改进 < 3s, 差 >= 3s */
  FCP: { good: 1800, needsImprovement: 3000 },
  /** 累积布局偏移 - 良好 < 0.1, 需改进 < 0.25, 差 >= 0.25 */
  CLS: { good: 0.1, needsImprovement: 0.25 },
  /** 下一次绘制的交互延迟 - 良好 < 200ms, 需改进 < 500ms, 差 >= 500ms */
  INP: { good: 200, needsImprovement: 500 },
  /** 首字节时间 - 良好 < 800ms, 需改进 < 1800ms, 差 >= 1800ms */
  TTFB: { good: 800, needsImprovement: 1800 },
} as const;

/**
 * 生产环境弱网 TTFB 阈值（移动端 3G/2G 网络）
 * 背景: Sentry Alert - 2861ms TTFB on 3G (downlink 1.35Mbps, RTT 350ms)
 * 原因: TTFB 主要受网络延迟影响，弱网条件下 3s 是可接受的
 * 参考: WebPageTest 建议 - 3G 网络 TTFB < 3000ms 为 "Good"
 */
const MOBILE_SLOW_NETWORK_TTFB_THRESHOLDS = { good: 3000, needsImprovement: 5000 };

/**
 * 开发环境 TTFB 阈值（放宽）
 * 原因：GitHub Codespaces / 本地开发服务器的网络延迟是正常的
 * TTFB 是服务器响应时间，不是客户端代码问题
 */
const DEV_TTFB_THRESHOLDS = { good: 3000, needsImprovement: 5000 };

/** 指标评级 */
export type MetricRating = 'good' | 'needs-improvement' | 'poor';

/** 网络质量等级 */
type NetworkQuality = 'fast' | 'moderate' | 'slow' | 'offline' | 'unknown';

/** 网络信息（来自 NetworkInformation API） */
interface NetworkInfo {
  effectiveType: string;  // '4g', '3g', '2g', 'slow-2g'
  downlink: number;       // Mbps
  rtt: number;            // ms
  saveData?: boolean;     // 用户是否启用省流模式
}

@Injectable({
  providedIn: 'root'
})
export class WebVitalsService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('WebVitals');
  
  /** 是否已初始化 */
  private initialized = false;
  
  /** 收集到的指标缓存 */
  private metricsCache = new Map<string, Metric>();
  
  /** 当前网络质量（缓存，避免重复计算） */
  private cachedNetworkQuality: NetworkQuality | null = null;
  
  /**
   * 检测当前网络质量
   * 使用 Network Information API (navigator.connection)
   */
  private detectNetworkQuality(): NetworkQuality {
    if (this.cachedNetworkQuality) return this.cachedNetworkQuality;
    
    // 尝试使用 Network Information API
    const nav = navigator as Navigator & { connection?: NetworkInfo; mozConnection?: NetworkInfo; webkitConnection?: NetworkInfo };
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
    
    if (!connection) {
      this.cachedNetworkQuality = 'unknown';
      return 'unknown';
    }
    
    const effectiveType = connection.effectiveType || '';
    const downlink = connection.downlink || 0;
    const rtt = connection.rtt || 0;
    const saveData = !!connection.saveData;
    
    // 先用真实链路指标判定弱网，避免 "4g + 低带宽" 误判为 moderate
    const constrainedByTelemetry =
      saveData ||
      (downlink > 0 && downlink < 1.5) ||
      (rtt > 0 && rtt >= 180);
    
    // 分类网络质量
    // 参考: Chrome DevTools Network Throttling Presets
    if (effectiveType === 'slow-2g' || saveData) {
      this.cachedNetworkQuality = 'offline'; // 极慢网络/省流模式
    } else if (effectiveType === '2g' || constrainedByTelemetry) {
      this.cachedNetworkQuality = 'slow'; // 2G 或链路受限
    } else if (effectiveType === '3g' && downlink <= 2) {
      this.cachedNetworkQuality = 'slow'; // 典型 3G
    } else if (effectiveType === '4g' && downlink >= 8 && rtt > 0 && rtt < 80) {
      this.cachedNetworkQuality = 'fast'; // 4G 快速网络
    } else if (effectiveType === '4g' || effectiveType === '3g') {
      this.cachedNetworkQuality = 'moderate'; // 常规移动网络
    } else {
      this.cachedNetworkQuality = 'unknown';
    }
    
    this.logger.info(`网络质量检测: ${this.cachedNetworkQuality}`, { effectiveType, downlink, rtt, saveData });
    return this.cachedNetworkQuality;
  }
  
  /**
   * 获取网络信息（用于 Sentry 上下文）
   */
  private getNetworkInfo(): NetworkInfo | null {
    const nav = navigator as Navigator & { connection?: NetworkInfo; mozConnection?: NetworkInfo; webkitConnection?: NetworkInfo };
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
    return connection ? {
      effectiveType: connection.effectiveType || 'unknown',
      downlink: connection.downlink || 0,
      rtt: connection.rtt || 0,
      saveData: !!connection.saveData,
    } : null;
  }
  
  /**
   * 初始化 Web Vitals 监控
   * 应在应用启动时调用一次
   */
  init(): void {
    if (this.initialized) {
      this.logger.warn('WebVitalsService 已初始化，跳过重复调用');
      return;
    }
    
    this.initialized = true;
    
    // 注册 Core Web Vitals 回调
    // 注意：FID 已在 web-vitals v4 中被 INP 替代
    onLCP((metric: Metric) => this.handleMetric(metric));
    onFCP((metric: Metric) => this.handleMetric(metric));
    onCLS((metric: Metric) => this.handleMetric(metric));
    onINP((metric: Metric) => this.handleMetric(metric));
    onTTFB((metric: Metric) => this.handleMetric(metric));
    
    this.logger.info('Web Vitals 监控已启动');
  }
  
  /**
   * 处理收集到的指标
   */
  private handleMetric(metric: Metric): void {
    // 缓存指标
    this.metricsCache.set(metric.name, metric);
    
    // 计算评级
    const rating = this.getRating(metric.name, metric.value);
    
    // 开发模式下打印到控制台
    if (isDevMode()) {
      this.logMetric(metric, rating);
    }
    
    // 上报到 Sentry（仅生产环境或评级差时上报）
    if (!isDevMode() || rating === 'poor') {
      this.reportToSentry(metric, rating);
    }
  }
  
  /**
   * 根据指标值计算评级
   * 注意：TTFB 根据环境和网络条件使用不同阈值
   */
  private getRating(name: string, value: number): MetricRating {
    // 开发环境下 TTFB 使用放宽的阈值
    // TTFB 是服务器响应时间（网络延迟），不是客户端代码问题
    // GitHub Codespaces / 本地开发服务器的延迟是正常的
    if (name === 'TTFB' && isDevMode()) {
      if (value <= DEV_TTFB_THRESHOLDS.good) return 'good';
      if (value <= DEV_TTFB_THRESHOLDS.needsImprovement) return 'needs-improvement';
      return 'poor';
    }
    
    // 生产环境下，根据网络条件调整 TTFB 阈值
    // 背景: Sentry Alert 2861ms TTFB on 3G - 这是网络条件导致的，不应该告警
    if (name === 'TTFB' && !isDevMode()) {
      const networkQuality = this.detectNetworkQuality();
      
      // 慢速网络（3G/2G）使用放宽的阈值
      if (networkQuality === 'slow' || networkQuality === 'offline') {
        if (value <= MOBILE_SLOW_NETWORK_TTFB_THRESHOLDS.good) return 'good';
        if (value <= MOBILE_SLOW_NETWORK_TTFB_THRESHOLDS.needsImprovement) return 'needs-improvement';
        return 'poor';
      }
    }
    
    const thresholds = WEB_VITALS_THRESHOLDS[name as keyof typeof WEB_VITALS_THRESHOLDS];
    if (!thresholds) return 'good';
    
    if (value <= thresholds.good) return 'good';
    if (value <= thresholds.needsImprovement) return 'needs-improvement';
    return 'poor';
  }
  
  /**
   * 在控制台打印指标（开发模式）
   */
  private logMetric(metric: Metric, rating: MetricRating): void {
    const emoji = rating === 'good' ? '✅' : rating === 'needs-improvement' ? '⚠️' : '🔴';
    const value = metric.name === 'CLS' 
      ? metric.value.toFixed(4) 
      : `${metric.value.toFixed(0)}ms`;
    
    this.logger.debug(`${emoji} ${metric.name}: ${value} (${rating})`);
  }
  
  /**
   * 上报指标到 Sentry
   */
  private reportToSentry(metric: Metric, rating: MetricRating): void {
    // 使用 Sentry 的 transaction 记录性能指标
    this.sentryLazyLoader.setMeasurement(metric.name, metric.value, metric.name === 'CLS' ? '' : 'millisecond');
    
    // 开发环境下不对 TTFB 发送告警
    // TTFB 是服务器响应时间，开发环境的网络延迟是正常的
    if (metric.name === 'TTFB' && isDevMode()) {
      return;
    }
    
    // 生产环境下，过滤弱网环境的 TTFB 告警噪音
    // 背景: 移动端 3G 网络 TTFB 2861ms 是正常的，不应该告警
    if (metric.name === 'TTFB' && !isDevMode() && rating === 'poor') {
      const networkQuality = this.detectNetworkQuality();
      const networkInfo = this.getNetworkInfo();
      
      // 慢速网络下，TTFB 不符合标准阈值是预期的，不发送告警
      if (networkQuality === 'slow' || networkQuality === 'offline') {
        this.logger.info(`TTFB ${metric.value}ms (弱网环境 ${networkQuality}，跳过告警)`, networkInfo);
        return;
      }
    }
    
    // 如果评级差，额外发送告警消息
    if (rating === 'poor') {
      const networkInfo = this.getNetworkInfo();
      const networkQuality = this.detectNetworkQuality();
      
      this.sentryLazyLoader.captureMessage(`性能告警: ${metric.name} 超出阈值`, {
        level: 'warning',
        tags: {
          'web-vital': metric.name,
          'rating': rating,
          'network-quality': networkQuality,
        },
        extra: {
          value: metric.value,
          id: metric.id,
          delta: metric.delta,
          navigationType: metric.navigationType,
          networkInfo: networkInfo, // 添加网络上下文
          entries: metric.entries?.map((e: PerformanceEntry) => ({
            name: e.name,
            startTime: e.startTime,
            duration: (e as PerformanceEntry & { duration?: number }).duration,
          })),
        },
      });
    }
  }
  
  /**
   * 获取所有已收集的指标
   */
  getMetrics(): Map<string, Metric> {
    return new Map(this.metricsCache);
  }
  
  /**
   * 获取指标摘要（用于调试面板）
   */
  getMetricsSummary(): Record<string, { value: number; rating: MetricRating }> {
    const summary: Record<string, { value: number; rating: MetricRating }> = {};
    
    for (const [name, metric] of this.metricsCache) {
      summary[name] = {
        value: metric.value,
        rating: this.getRating(name, metric.value),
      };
    }
    
    return summary;
  }
}
