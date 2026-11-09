import { describe, expect, it, vi } from 'vitest';

// Match the production aggregate load order before importing the concrete service.
import './task-sync-operations.service';
import { TaskSyncPositionService } from './task-sync-position.service';

function createPreflightHarness(sessionExpired: boolean, circuitAvailable: boolean) {
  const service = Object.create(TaskSyncPositionService.prototype) as TaskSyncPositionService;
  const isSessionExpired = vi.fn(() => sessionExpired);
  const checkCircuitBreaker = vi.fn(() => circuitAvailable);
  const debug = vi.fn();

  Reflect.set(service, 'syncStateService', { isSessionExpired });
  Reflect.set(service, 'retryQueueService', { checkCircuitBreaker });
  Reflect.set(service, 'logger', { debug });

  return { service, isSessionExpired, checkCircuitBreaker, debug };
}

describe('TaskSyncPositionService', () => {
  it('会话过期时应在检查熔断器前拒绝位置推送', async () => {
    const { service, isSessionExpired, checkCircuitBreaker, debug } = createPreflightHarness(
      true,
      true,
    );

    await expect(service.pushTaskPosition('task-session-expired', 10, 20)).resolves.toBe(false);

    expect(isSessionExpired).toHaveBeenCalledOnce();
    expect(checkCircuitBreaker).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith('pushTaskPosition: 会话已过期，跳过推送');
  });

  it('熔断器打开时应在获取 client 和校验 owner 前拒绝位置推送', async () => {
    const { service, isSessionExpired, checkCircuitBreaker, debug } = createPreflightHarness(
      false,
      false,
    );

    await expect(service.pushTaskPosition('task-circuit-open', 30, 40)).resolves.toBe(false);

    expect(isSessionExpired).toHaveBeenCalledOnce();
    expect(checkCircuitBreaker).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledWith(
      'Circuit Breaker: 熔断中，跳过位置推送',
      { taskId: 'task-circuit-open' },
    );
  });
});
