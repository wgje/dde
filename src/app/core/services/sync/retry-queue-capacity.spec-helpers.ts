import { expect, it, vi } from 'vitest';

import type { RetryQueueCapacityAndSliceSpecContext } from './retry-queue-capacity-and-slice.spec-helpers';

type MockFn = ReturnType<typeof vi.fn>;

export function registerRetryQueueCapacitySpecs(
  getContext: () => RetryQueueCapacityAndSliceSpecContext,
): void {
  it('满队列进入压力模式后，在线状态应触发应急处理并继续入队', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;

    expect(service.add(
      'task', 'upsert', createTask('t-1'), 'p-1', undefined, undefined, 'task_full_upsert',
    )).toBe(true);
    setOnline(true);

    expect(service.add(
      'task', 'upsert', createTask('t-2'), 'p-1', undefined, undefined, 'task_full_upsert',
    )).toBe(true);
    expect(service.queuePressure()).toBe(true);

    await vi.waitFor(() => {
      expect(handler.pushTask).toHaveBeenCalledTimes(1);
    }, { timeout: 200, interval: 10 });
    expect(service.length).toBe(1);

    await service.processQueue();
    expect(handler.pushTask).toHaveBeenCalledTimes(2);
    expect(service.length).toBe(0);
  });

  it('queue_full 压力模式下应允许同实体更新覆盖（不视为新增入队）', () => {
    const { service, toastMock, setOnline, createTask, stableUUID } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 2;
    setOnline(false);

    expect(service.add('task', 'upsert', createTask('t-1'), 'p-1')).toBe(true);
    expect(service.add('task', 'upsert', createTask('t-2'), 'p-1')).toBe(true);

    expect(service.add('task', 'upsert', createTask('t-3'), 'p-1')).toBe(true);
    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('queue_full');

    toastMock.warning.mockClear();

    const updated = createTask('t-1');
    updated.title = 'Task t-1 updated';

    expect(service.add('task', 'upsert', updated, 'p-1')).toBe(true);
    expect(service.length).toBe(3);
    expect(service.getItems().find(item => item.data.id === stableUUID('t-1'))?.data).toEqual(updated);
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('缺失 ID 的入队拒绝日志异常不应阻断 add 返回 false', () => {
    const { service, loggerCategory, createTask } = getContext();
    const task = { ...createTask('missing-id-boundary'), id: '' };
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('warn failed');
    });
    let accepted = true;

    expect(() => {
      accepted = service.add('task', 'upsert', task, 'p-pressure');
    }).not.toThrow();

    expect(accepted).toBe(false);
    expect(service.length).toBe(0);
  });

  it('非法 UUID 的入队拒绝日志异常不应阻断 add 返回 false', () => {
    const { service, loggerCategory, createTask } = getContext();
    const task = { ...createTask('invalid-id-boundary'), id: 'not-a-uuid' };
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('warn failed');
    });
    let accepted = true;

    expect(() => {
      accepted = service.add('task', 'upsert', task, 'p-pressure');
    }).not.toThrow();

    expect(accepted).toBe(false);
    expect(service.length).toBe(0);
  });

  it('软上限压力模式 warning 异常不应阻断 add 入队和应急处理', () => {
    const { service, loggerCategory, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;
    setOnline(true);
    const processQueueSpy = vi.spyOn(service, 'processQueue').mockResolvedValue(undefined);
    expect(service.add('task', 'upsert', createTask('soft-limit-warn-1'), 'p-pressure')).toBe(true);
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('warn failed');
    });
    let accepted = false;

    expect(() => {
      accepted = service.add('task', 'upsert', createTask('soft-limit-warn-2'), 'p-pressure');
    }).not.toThrow();

    expect(accepted).toBe(true);
    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('queue_full');
    expect(service.length).toBe(2);
    expect(processQueueSpy).toHaveBeenCalled();
  });

  it('压力模式续加入 warning 异常不应阻断 add 入队和应急处理', () => {
    const { service, loggerCategory, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;
    setOnline(true);
    const processQueueSpy = vi.spyOn(service, 'processQueue').mockResolvedValue(undefined);
    expect(service.add('task', 'upsert', createTask('pressure-warn-1'), 'p-pressure')).toBe(true);
    expect(service.add('task', 'upsert', createTask('pressure-warn-2'), 'p-pressure')).toBe(true);
    processQueueSpy.mockClear();
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('warn failed');
    });
    let accepted = false;

    expect(() => {
      accepted = service.add('task', 'upsert', createTask('pressure-warn-3'), 'p-pressure');
    }).not.toThrow();

    expect(accepted).toBe(true);
    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('queue_full');
    expect(service.length).toBe(3);
    expect(processQueueSpy).toHaveBeenCalled();
  });

  it('进入 queue_full 压力模式的 Sentry tag 异常不应阻断 add 入队', () => {
    const { service, sentryLazyLoaderMock, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;
    setOnline(false);
    expect(service.add('task', 'upsert', createTask('pressure-tag-1'), 'p-pressure')).toBe(true);
    sentryLazyLoaderMock.setTag.mockImplementationOnce(() => {
      throw new Error('setTag failed');
    });

    expect(() => {
      service.add('task', 'upsert', createTask('pressure-tag-2'), 'p-pressure');
    }).not.toThrow();

    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('queue_full');
    expect(service.length).toBe(2);
  });

  it('进入 queue_full 压力模式的 Sentry context 异常不应阻断 add 入队', () => {
    const { service, sentryLazyLoaderMock, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;
    setOnline(false);
    expect(service.add('task', 'upsert', createTask('pressure-context-1'), 'p-pressure')).toBe(true);
    sentryLazyLoaderMock.setContext.mockImplementationOnce(() => {
      throw new Error('setContext failed');
    });

    expect(() => {
      service.add('task', 'upsert', createTask('pressure-context-2'), 'p-pressure');
    }).not.toThrow();

    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('queue_full');
    expect(service.length).toBe(2);
  });

  it('退出 queue_full 压力模式的 Sentry tag 异常不应阻断解锁', () => {
    const { service, sentryLazyLoaderMock, setOnline, createTask, stableUUID } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 3;
    setOnline(false);
    expect(service.add('task', 'upsert', createTask('pressure-clear-tag-1'), 'p-pressure')).toBe(true);
    expect(service.add('task', 'upsert', createTask('pressure-clear-tag-2'), 'p-pressure')).toBe(true);
    expect(service.add('task', 'upsert', createTask('pressure-clear-tag-3'), 'p-pressure')).toBe(true);
    expect(service.add('task', 'upsert', createTask('pressure-clear-tag-4'), 'p-pressure')).toBe(true);
    expect(service.queuePressure()).toBe(true);
    service.removeByEntityId(stableUUID('pressure-clear-tag-1'));
    service.removeByEntityId(stableUUID('pressure-clear-tag-2'));
    sentryLazyLoaderMock.setTag.mockImplementationOnce(() => {
      throw new Error('setTag failed');
    });

    expect(() => {
      (service as unknown as { tryRecoverQueueFullPressure: (force?: boolean) => void }).tryRecoverQueueFullPressure(true);
    }).not.toThrow();

    expect(service.queuePressure()).toBe(false);
    expect(service.queuePressureReason()).toBeNull();
  });

  it('storage 压力恢复后应自动退出压力模式', () => {
    const { service } = getContext();
    (service as unknown as { enterPressureMode: (reason: string) => void }).enterPressureMode('storage_quota_exceeded');
    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('storage_quota_exceeded');

    (service as unknown as { tryRecoverQueueFullPressure: (force?: boolean) => void }).tryRecoverQueueFullPressure(true);

    expect(service.queuePressure()).toBe(false);
    expect(service.queuePressureReason()).toBeNull();
  });

  it('storage 压力恢复日志异常不应阻断压力模式退出', () => {
    const { service, loggerCategory } = getContext();
    (service as unknown as { enterPressureMode: (reason: string) => void }).enterPressureMode('storage_quota_exceeded');
    loggerCategory.info.mockImplementationOnce(() => {
      throw new Error('info failed');
    });

    expect(() => {
      (service as unknown as { tryRecoverQueueFullPressure: (force?: boolean) => void }).tryRecoverQueueFullPressure(true);
    }).not.toThrow();

    expect(service.queuePressure()).toBe(false);
    expect(service.queuePressureReason()).toBeNull();
  });

  it('getCapacityPercent 应返回正确的容量百分比', () => {
    const { service, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 10;

    expect(service.getCapacityPercent()).toBe(0);

    service.add('task', 'upsert', createTask('t-1'), 'p-1');
    service.add('task', 'upsert', createTask('t-2'), 'p-1');
    service.add('task', 'upsert', createTask('t-3'), 'p-1');

    expect(service.getCapacityPercent()).toBe(30);
  });

  it('getCapacityPercent 队列满时应返回 100 或更高', () => {
    const { service, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 2;

    service.add('task', 'upsert', createTask('t-1'), 'p-1');
    service.add('task', 'upsert', createTask('t-2'), 'p-1');

    expect(service.getCapacityPercent()).toBeGreaterThanOrEqual(100);
  });

  it('checkCapacityWarning 在 80%+ 时应记录日志（WARNING_THRESHOLD=0.8）', () => {
    const { service, loggerCategory, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 10;
    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;

    for (let i = 0; i < 8; i += 1) {
      service.add('task', 'upsert', createTask(`cap-${i}`), 'p-1');
    }

    expect(loggerCategory.warn).toHaveBeenCalled();
  });

  it('80% 容量告警日志异常不应阻断 add 入队', () => {
    const { service, loggerCategory, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 10;
    (service as unknown as { lastWarningTime: number }).lastWarningTime = Date.now();
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 80;
    for (let i = 0; i < 7; i += 1) {
      service.add('task', 'upsert', createTask(`warn-log-boundary-${i}`), 'p-capacity');
    }
    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('warn failed');
    });

    expect(() => {
      service.add('task', 'upsert', createTask('warn-log-boundary-7'), 'p-capacity');
    }).not.toThrow();

    expect(service.length).toBe(8);
  });

  it('85% 容量告警 toast 异常不应阻断 add 入队', () => {
    const { service, toastMock, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 20;
    (service as unknown as { lastWarningTime: number }).lastWarningTime = Date.now();
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 80;
    for (let i = 0; i < 16; i += 1) {
      service.add('task', 'upsert', createTask(`toast-boundary-${i}`), 'p-capacity');
    }
    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;
    toastMock.warning.mockImplementationOnce(() => {
      throw new Error('toast failed');
    });

    expect(() => {
      service.add('task', 'upsert', createTask('toast-boundary-16'), 'p-capacity');
    }).not.toThrow();

    expect(service.length).toBe(17);
  });

  it('checkCapacityWarning 在 95%+ 时应触发 error 级别日志', () => {
    const { service, loggerCategory, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 20;

    for (let i = 0; i < 19; i += 1) {
      service.add('task', 'upsert', createTask(`crit-${i}`), 'p-1');
    }

    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;
    loggerCategory.error.mockClear();

    service.checkCapacityWarning();

    expect(loggerCategory.error).toHaveBeenCalled();
  });

  it('95% 容量告警 error 日志异常不应阻断 add 入队', () => {
    const { service, loggerCategory, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 20;
    (service as unknown as { lastWarningTime: number }).lastWarningTime = Date.now();
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 90;
    for (let i = 0; i < 18; i += 1) {
      service.add('task', 'upsert', createTask(`error-log-boundary-${i}`), 'p-capacity');
    }
    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;
    loggerCategory.error.mockImplementationOnce(() => {
      throw new Error('error failed');
    });

    expect(() => {
      service.add('task', 'upsert', createTask('error-log-boundary-18'), 'p-capacity');
    }).not.toThrow();

    expect(service.length).toBe(19);
  });

  it('95% 容量告警 toast 异常不应阻断 add 入队', () => {
    const { service, toastMock, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 20;
    (service as unknown as { lastWarningTime: number }).lastWarningTime = Date.now();
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 90;
    for (let i = 0; i < 18; i += 1) {
      service.add('task', 'upsert', createTask(`error-toast-boundary-${i}`), 'p-capacity');
    }
    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;
    toastMock.error.mockImplementationOnce(() => {
      throw new Error('toast failed');
    });

    expect(() => {
      service.add('task', 'upsert', createTask('error-toast-boundary-18'), 'p-capacity');
    }).not.toThrow();

    expect(service.length).toBe(19);
  });

  it('95% 容量告警 Sentry 异常不应阻断 add 入队', () => {
    const { service, sentryLazyLoaderMock, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 20;
    (service as unknown as { lastWarningTime: number }).lastWarningTime = Date.now();
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 90;
    for (let i = 0; i < 18; i += 1) {
      service.add('task', 'upsert', createTask(`sentry-boundary-${i}`), 'p-capacity');
    }
    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;
    sentryLazyLoaderMock.captureMessage.mockImplementationOnce(() => {
      throw new Error('sentry failed');
    });

    expect(() => {
      service.add('task', 'upsert', createTask('sentry-boundary-18'), 'p-capacity');
    }).not.toThrow();

    expect(service.length).toBe(19);
  });

  it('absolute limit 拒绝入队日志异常不应阻断 add 返回 false', () => {
    const { service, loggerCategory, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;
    setOnline(false);
    for (let i = 0; i < 5; i += 1) {
      expect(service.add('task', 'upsert', createTask(`reject-log-boundary-${i}`), 'p-capacity')).toBe(true);
    }
    loggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('warn failed');
    });
    let accepted = true;

    expect(() => {
      accepted = service.add('task', 'upsert', createTask('reject-log-boundary-5'), 'p-capacity');
    }).not.toThrow();

    expect(accepted).toBe(false);
    expect(service.length).toBe(5);
  });

  it('absolute limit 拒绝入队 toast 异常不应阻断 add 返回 false', () => {
    const { service, toastMock, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;
    setOnline(false);
    for (let i = 0; i < 5; i += 1) {
      expect(service.add('task', 'upsert', createTask(`reject-toast-boundary-${i}`), 'p-capacity')).toBe(true);
    }
    toastMock.warning.mockImplementationOnce(() => {
      throw new Error('toast failed');
    });
    let accepted = true;

    expect(() => {
      accepted = service.add('task', 'upsert', createTask('reject-toast-boundary-5'), 'p-capacity');
    }).not.toThrow();

    expect(accepted).toBe(false);
    expect(service.length).toBe(5);
  });

  it('absolute limit 拒绝入队 Sentry 异常不应阻断 add 返回 false', () => {
    const { service, sentryLazyLoaderMock, setOnline, createTask } = getContext();
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;
    setOnline(false);
    for (let i = 0; i < 5; i += 1) {
      expect(service.add('task', 'upsert', createTask(`reject-sentry-boundary-${i}`), 'p-capacity')).toBe(true);
    }
    sentryLazyLoaderMock.captureMessage.mockImplementationOnce(() => {
      throw new Error('sentry failed');
    });
    let accepted = true;

    expect(() => {
      accepted = service.add('task', 'upsert', createTask('reject-sentry-boundary-5'), 'p-capacity');
    }).not.toThrow();

    expect(accepted).toBe(false);
    expect(service.length).toBe(5);
  });
}
