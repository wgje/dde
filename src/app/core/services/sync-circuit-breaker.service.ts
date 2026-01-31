import { Injectable, inject } from '@angular/core';
import { LoggerService } from '../../../services/logger.service';
import { CIRCUIT_BREAKER_CONFIG } from '../../../config';

type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * 熔断器服务
 * 实现 Circuit Breaker 模式，防止连续失败时持续请求后端
 */
@Injectable({ providedIn: 'root' })
export class SyncCircuitBreakerService {
  private readonly logger = inject(LoggerService).category('CircuitBreaker');

  /** 当前熔断状态 */
  private circuitState: CircuitState = 'closed';

  /** 熔断器打开时间 */
  private circuitOpenedAt = 0;

  /** 连续失败次数 */
  private consecutiveFailures = 0;

  /**
   * 检查是否应该执行请求
   * @returns true 如果可以执行请求，false 如果熔断中
   */
  check(): boolean {
    if (this.circuitState === 'closed') {
      return true;
    }

    if (this.circuitState === 'open') {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed >= CIRCUIT_BREAKER_CONFIG.RECOVERY_TIME) {
        // 转入半开状态，允许试探请求
        this.circuitState = 'half-open';
        this.logger.info('进入半开状态，尝试恢复');
        return true;
      }
      // 仍在熔断期
      return false;
    }

    // half-open 状态：允许请求
    return true;
  }

  /**
   * 记录请求成功
   */
  recordSuccess(): void {
    if (this.circuitState === 'half-open') {
      // 半开状态下成功，关闭熔断器
      this.circuitState = 'closed';
      this.consecutiveFailures = 0;
      this.logger.info('恢复正常');
    } else {
      this.consecutiveFailures = 0;
    }
  }

  /**
   * 记录请求失败
   */
  recordFailure(errorType: string): void {
    // 只有特定错误类型触发熔断
    if (!CIRCUIT_BREAKER_CONFIG.TRIGGER_ERROR_TYPES.includes(errorType)) {
      return;
    }

    this.consecutiveFailures++;

    if (this.circuitState === 'half-open') {
      // 半开状态下失败，重新打开熔断器
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      this.logger.warn('半开状态失败，重新熔断');
      return;
    }

    if (this.consecutiveFailures >= CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD) {
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      this.logger.warn(`触发熔断，连续失败 ${this.consecutiveFailures} 次，暂停 ${CIRCUIT_BREAKER_CONFIG.RECOVERY_TIME / 1000} 秒`);
    }
  }

  /**
   * 获取当前熔断状态
   */
  getState(): CircuitState {
    return this.circuitState;
  }

  /**
   * 获取连续失败次数
   */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * 重置熔断器（用于测试或强制恢复）
   */
  reset(): void {
    this.circuitState = 'closed';
    this.consecutiveFailures = 0;
    this.circuitOpenedAt = 0;
    this.logger.info('熔断器已重置');
  }
}
