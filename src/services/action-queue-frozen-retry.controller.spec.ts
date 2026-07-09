import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionQueueFrozenRetryController } from './action-queue-frozen-retry.controller';

describe('ActionQueueFrozenRetryController', () => {
  let logger: {
    warn(message: string, context?: unknown): void;
    info(message: string, context?: unknown): void;
    debug(message: string, context?: unknown): void;
  };
  let toast: {
    success(title: string, message: string): void;
  };
  let queueFrozen = true;
  let saveQueueToStorage: () => void;
  let saveQueueToStorageMock: ReturnType<typeof vi.fn<() => void>>;
  let controller: ActionQueueFrozenRetryController;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    toast = {
      success: vi.fn(),
    };
    queueFrozen = true;
    saveQueueToStorageMock = vi.fn<() => void>();
    saveQueueToStorage = saveQueueToStorageMock;
    controller = new ActionQueueFrozenRetryController({
      logger,
      toast,
      isQueueFrozen: () => queueFrozen,
      saveQueueToStorage,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    });
  });

  afterEach(() => {
    controller.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('停止后迟到的冻结重试 timer 不应再次落盘', () => {
    controller.start();
    controller.stop();

    vi.advanceTimersByTime(100);

    expect(saveQueueToStorage).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(
      '冻结期定时重试落盘',
      expect.anything(),
    );
  });

  it('存储恢复后应提示一次并停止后续冻结重试', () => {
    saveQueueToStorageMock.mockImplementationOnce(() => {
      queueFrozen = false;
    });

    controller.start();
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(1000);

    expect(saveQueueToStorage).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('存储恢复，队列自动解冻');
    expect(toast.success).toHaveBeenCalledWith('存储恢复', '同步队列已自动解冻');
  });

  it('冻结重试日志失败时仍应执行本次落盘', () => {
    vi.mocked(logger.info).mockImplementationOnce(() => {
      throw new Error('logger failed');
    });

    controller.start();

    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(saveQueueToStorage).toHaveBeenCalledTimes(1);
  });

  it('冻结重试失败日志失败时仍应调度下一轮重试', () => {
    saveQueueToStorageMock.mockImplementation(() => {
      throw new Error('storage still frozen');
    });
    vi.mocked(logger.debug).mockImplementationOnce(() => {
      throw new Error('debug failed');
    });

    controller.start();

    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    vi.advanceTimersByTime(200);

    expect(saveQueueToStorage).toHaveBeenCalledTimes(2);
  });

  it('落盘期间重入 start 不应重置冻结重试退避状态', () => {
    saveQueueToStorageMock.mockImplementationOnce(() => {
      controller.start();
    });

    controller.start();
    vi.advanceTimersByTime(100);
    expect(saveQueueToStorage).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(199);
    expect(saveQueueToStorage).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);

    expect(saveQueueToStorage).toHaveBeenCalledTimes(2);
  });

  it('落盘期间 stop 后即使本次写入失败也不应重新调度冻结重试', () => {
    saveQueueToStorageMock.mockImplementationOnce(() => {
      controller.stop();
      throw new Error('storage still frozen after stop');
    });

    controller.start();
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(1000);

    expect(saveQueueToStorage).toHaveBeenCalledTimes(1);
  });

  it('达到冻结重试上限后应允许下一次 start 重新调度恢复尝试', () => {
    controller = new ActionQueueFrozenRetryController({
      logger,
      toast,
      isQueueFrozen: () => queueFrozen,
      saveQueueToStorage,
      maxRetries: 1,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    });

    controller.start();
    vi.advanceTimersByTime(100);
    expect(saveQueueToStorage).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('冻结期重试已达上限，停止自动重试', { count: 1 });

    controller.start();
    vi.advanceTimersByTime(100);

    expect(saveQueueToStorage).toHaveBeenCalledTimes(2);
  });
});
