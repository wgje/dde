import { describe, expect, it, vi } from 'vitest';

import {
  SyncResumeRetryContinuationController,
  type RetryQueueSliceResult,
} from './sync-resume-retry-continuation.controller';

function createSliceResult(overrides: Partial<RetryQueueSliceResult> = {}): RetryQueueSliceResult {
  return {
    processed: 0,
    remaining: 0,
    durationMs: 0,
    completed: true,
    ...overrides,
  };
}

describe('SyncResumeRetryContinuationController', () => {
  it('首个后台重试切片失败后应继续调度下一轮，避免恢复链路永久停止', async () => {
    const processQueueSlice = vi.fn()
      .mockRejectedValueOnce(new Error('idb temporarily locked'))
      .mockResolvedValueOnce(createSliceResult({ processed: 1, completed: true }));
    const scheduled: Array<{ runSlice: () => void; backoffMs: number }> = [];
    const addBreadcrumb = vi.fn();
    const logger = { warn: vi.fn() };
    const controller = new SyncResumeRetryContinuationController({
      addBreadcrumb,
      logger,
      processQueueSlice,
      scheduleRetryContinuation: (runSlice, backoffMs) => {
        scheduled.push({ runSlice, backoffMs });
      },
    });

    await controller.processFirstBackgroundRetrySlice({
      reason: 'online',
      mode: 'heavy',
      retrySlice: 2,
      maxDurationMs: 80,
      maxRounds: 3,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      '恢复链路后台首个重试切片失败',
      expect.objectContaining({ reason: 'online', mode: 'heavy' }),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].backoffMs).toBe(200);

    scheduled[0].runSlice();
    await Promise.resolve();
    await Promise.resolve();

    expect(processQueueSlice).toHaveBeenCalledTimes(2);
    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        step: 'retry-queue-background-drain',
        reason: 'online',
        mode: 'heavy',
      }),
    }));
  });

  it('首个后台重试切片失败时 logger 异常不应阻断下一轮调度', async () => {
    const processQueueSlice = vi.fn()
      .mockRejectedValueOnce(new Error('idb temporarily locked'));
    const scheduled: Array<{ runSlice: () => void; backoffMs: number }> = [];
    const logger = {
      warn: vi.fn(() => {
        throw new Error('logger unavailable');
      }),
    };
    const controller = new SyncResumeRetryContinuationController({
      addBreadcrumb: vi.fn(),
      logger,
      processQueueSlice,
      scheduleRetryContinuation: (runSlice, backoffMs) => {
        scheduled.push({ runSlice, backoffMs });
      },
    });

    await expect(controller.processFirstBackgroundRetrySlice({
      reason: 'online',
      mode: 'heavy',
      retrySlice: 2,
      maxDurationMs: 80,
      maxRounds: 3,
    })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      '恢复链路后台首个重试切片失败',
      expect.objectContaining({ reason: 'online', mode: 'heavy' }),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].backoffMs).toBe(200);
  });

  it('首个后台重试切片需要续跑但调度器异常时不应中断恢复链路', async () => {
    const scheduleError = new Error('background scheduler unavailable');
    const logger = { warn: vi.fn() };
    const scheduleRetryContinuation = vi.fn(() => {
      throw scheduleError;
    });
    const controller = new SyncResumeRetryContinuationController({
      addBreadcrumb: vi.fn(),
      logger,
      processQueueSlice: vi.fn().mockResolvedValue(createSliceResult({
        processed: 2,
        remaining: 3,
        completed: false,
      })),
      scheduleRetryContinuation,
    });

    await expect(controller.processFirstBackgroundRetrySlice({
      reason: 'online',
      mode: 'heavy',
      retrySlice: 2,
      maxDurationMs: 80,
      maxRounds: 3,
    })).resolves.toBeUndefined();

    expect(scheduleRetryContinuation).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      '恢复链路后台重试续跑调度失败',
      expect.objectContaining({ reason: 'online', mode: 'heavy', error: scheduleError }),
    );
  });

  it('后台 continuation 失败时 logger 异常不应阻断重试续跑调度', () => {
    const scheduled: Array<{ runSlice: () => void; backoffMs: number }> = [];
    const logger = {
      warn: vi.fn(() => {
        throw new Error('logger unavailable');
      }),
    };
    const controller = new SyncResumeRetryContinuationController({
      addBreadcrumb: vi.fn(),
      logger,
      processQueueSlice: vi.fn().mockResolvedValue(createSliceResult()),
      scheduleRetryContinuation: (runSlice, backoffMs) => {
        scheduled.push({ runSlice, backoffMs });
      },
    });
    const options = controller.createContinuationOptions({
      reason: 'online',
      mode: 'heavy',
      retrySlice: 2,
      maxDurationMs: 80,
      maxRounds: 3,
      round: 1,
    });

    expect(() => controller.handleRetryQueueContinuationError(
      options,
      new Error('idb temporarily locked'),
    )).not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      '恢复链路后台重试切片失败',
      expect.objectContaining({ reason: 'online', mode: 'heavy' }),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].backoffMs).toBe(500);
  });

  it('后台 drain 完成时 breadcrumb 异常不应泄漏或触发额外调度', () => {
    const addBreadcrumb = vi.fn(() => {
      throw new Error('breadcrumb unavailable');
    });
    const scheduled: Array<{ runSlice: () => void; backoffMs: number }> = [];
    const controller = new SyncResumeRetryContinuationController({
      addBreadcrumb,
      logger: { warn: vi.fn() },
      processQueueSlice: vi.fn().mockResolvedValue(createSliceResult()),
      scheduleRetryContinuation: (runSlice, backoffMs) => {
        scheduled.push({ runSlice, backoffMs });
      },
    });
    const options = controller.createContinuationOptions({
      reason: 'online',
      mode: 'heavy',
      retrySlice: 2,
      maxDurationMs: 80,
      maxRounds: 3,
      round: 1,
    });

    expect(() => controller.handleRetryQueueContinuationResult(
      options,
      createSliceResult({ processed: 1, remaining: 0, completed: true }),
    )).not.toThrow();

    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        step: 'retry-queue-background-drain',
        reason: 'online',
        mode: 'heavy',
      }),
    }));
    expect(scheduled).toHaveLength(0);
  });

  it('达到 continuation 最大轮次时 breadcrumb 异常不应从失败处理链路泄漏', () => {
    const addBreadcrumb = vi.fn(() => {
      throw new Error('breadcrumb unavailable');
    });
    const scheduled: Array<{ runSlice: () => void; backoffMs: number }> = [];
    const controller = new SyncResumeRetryContinuationController({
      addBreadcrumb,
      logger: { warn: vi.fn() },
      processQueueSlice: vi.fn().mockResolvedValue(createSliceResult()),
      scheduleRetryContinuation: (runSlice, backoffMs) => {
        scheduled.push({ runSlice, backoffMs });
      },
    });
    const options = controller.createContinuationOptions({
      reason: 'online',
      mode: 'heavy',
      retrySlice: 2,
      maxDurationMs: 80,
      maxRounds: 1,
      round: 1,
    });

    expect(() => controller.handleRetryQueueContinuationError(
      options,
      new Error('idb temporarily locked'),
    )).not.toThrow();

    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        step: 'retry-queue-background-drain-max-rounds',
        reason: 'online',
        mode: 'heavy',
        maxRounds: 1,
      }),
    }));
    expect(scheduled).toHaveLength(0);
  });

  it('达到 continuation 最大轮次但队列仍有剩余时应冷却后开启下一轮 drain', async () => {
    const processQueueSlice = vi.fn()
      .mockResolvedValue(createSliceResult({ processed: 1, remaining: 0, completed: true }));
    const scheduled: Array<{ runSlice: () => void; backoffMs: number }> = [];
    const addBreadcrumb = vi.fn();
    const controller = new SyncResumeRetryContinuationController({
      addBreadcrumb,
      logger: { warn: vi.fn() },
      processQueueSlice,
      scheduleRetryContinuation: (runSlice, backoffMs) => {
        scheduled.push({ runSlice, backoffMs });
      },
    });
    const options = controller.createContinuationOptions({
      reason: 'online',
      mode: 'heavy',
      retrySlice: 2,
      maxDurationMs: 80,
      maxRounds: 1,
      round: 1,
    });

    controller.handleRetryQueueContinuationResult(
      options,
      createSliceResult({ processed: 2, remaining: 3, completed: false }),
    );

    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        step: 'retry-queue-background-drain-max-rounds',
        reason: 'online',
        mode: 'heavy',
        maxRounds: 1,
        remaining: 3,
      }),
    }));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].backoffMs).toBe(5000);

    scheduled[0].runSlice();
    await Promise.resolve();
    await Promise.resolve();

    expect(processQueueSlice).toHaveBeenCalledWith({
      maxItems: 2,
      maxDurationMs: 80,
    });
    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        step: 'retry-queue-background-drain',
        round: 1,
      }),
    }));
  });

  it('达到 continuation 最大轮次但 drain-cycle 调度器异常时不应中断恢复链路', () => {
    const scheduleError = new Error('background scheduler unavailable');
    const logger = { warn: vi.fn() };
    const scheduleRetryContinuation = vi.fn(() => {
      throw scheduleError;
    });
    const addBreadcrumb = vi.fn();
    const controller = new SyncResumeRetryContinuationController({
      addBreadcrumb,
      logger,
      processQueueSlice: vi.fn().mockResolvedValue(createSliceResult()),
      scheduleRetryContinuation,
    });
    const options = controller.createContinuationOptions({
      reason: 'online',
      mode: 'heavy',
      retrySlice: 2,
      maxDurationMs: 80,
      maxRounds: 1,
      round: 1,
    });

    expect(() => controller.handleRetryQueueContinuationResult(
      options,
      createSliceResult({ processed: 2, remaining: 3, completed: false }),
    )).not.toThrow();

    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        step: 'retry-queue-background-drain-max-rounds',
        reason: 'online',
        mode: 'heavy',
        maxRounds: 1,
        remaining: 3,
      }),
    }));
    expect(scheduleRetryContinuation).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      '恢复链路后台重试续跑调度失败',
      expect.objectContaining({ reason: 'online', mode: 'heavy', error: scheduleError }),
    );
  });
});
