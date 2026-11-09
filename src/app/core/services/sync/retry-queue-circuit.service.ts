import { CIRCUIT_BREAKER_CONFIG } from '../../../../config';
import { classifyErrorType as classifyErrorTypePure } from './retry-queue-fingerprint';
import { RetryQueueLegacyReviewLayer } from './retry-queue-legacy-review.service';

export abstract class RetryQueueCircuitLayer extends RetryQueueLegacyReviewLayer {
  // ==================== 熔断器 ====================
  
  /** 【P2-19 修复】从 sessionStorage 恢复熔断器状态 */
  protected readonly CIRCUIT_STORAGE_KEY = 'nanoflow.circuit-breaker';
  
  protected loadCircuitState(): void {
    try {
      const stored = sessionStorage.getItem(this.CIRCUIT_STORAGE_KEY);
      if (stored) {
        const { state, openedAt, failures } = JSON.parse(stored) as {
          state: unknown;
          openedAt: unknown;
          failures: unknown;
        };
        const validStates = ['open', 'half-open'] as const;
        if (validStates.includes(state as typeof validStates[number]) &&
            typeof openedAt === 'number') {
          this.circuitState = state as 'open' | 'half-open';
          this.circuitOpenedAt = openedAt;
          this.consecutiveFailures = typeof failures === 'number' ? failures : 0;
        }
      }
    } catch { /* ignore */ }
  }
  
  protected saveCircuitState(): void {
    try {
      sessionStorage.setItem(this.CIRCUIT_STORAGE_KEY, JSON.stringify({
        state: this.circuitState,
        openedAt: this.circuitOpenedAt,
        failures: this.consecutiveFailures,
      }));
    } catch { /* ignore */ }
  }
  
  /**
   * 从 Error 对象推断错误类型（用于未携带 errorType 的异常）
   */
  protected classifyErrorType(error: Error): string {
    return classifyErrorTypePure(error);
  }
  
  checkCircuitBreaker(): boolean {
    if (this.circuitState === 'closed') return true;
    if (this.circuitState === 'open') {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed >= CIRCUIT_BREAKER_CONFIG.RECOVERY_TIME) {
        this.circuitState = 'half-open';
        this.saveCircuitState();
        this.logger.info('Circuit Breaker: 进入半开状态');
        return true;
      }
      return false;
    }
    return true;
  }

  recordCircuitSuccess(): void {
    if (this.circuitState === 'half-open') {
      this.circuitState = 'closed';
      this.consecutiveFailures = 0;
      this.saveCircuitState();
      this.logger.info('Circuit Breaker: 恢复正常');
    } else {
      this.consecutiveFailures = 0;
    }
  }

  recordCircuitFailure(errorType: string): void {
    if (!CIRCUIT_BREAKER_CONFIG.TRIGGER_ERROR_TYPES.includes(errorType)) return;
    this.consecutiveFailures++;
    if (this.circuitState === 'half-open') {
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      this.saveCircuitState();
      this.logger.warn('Circuit Breaker: 半开状态失败，重新熔断');
      return;
    }
    if (this.consecutiveFailures >= CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD) {
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      this.saveCircuitState();
      this.logger.warn(`Circuit Breaker: 触发熔断，连续失败 ${this.consecutiveFailures} 次`);
    }
  }
}
