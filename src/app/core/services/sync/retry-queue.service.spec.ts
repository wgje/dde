import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryQueueService, RetryOperationHandler } from './retry-queue.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { Task } from '../../../../models';

function createTask(id: string): Task {
  const now = new Date().toISOString();
  return {
    id,
    title: `Task ${id}`,
    content: '',
    stage: null,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: now,
    displayId: id,
    updatedAt: now
  };
}

describe('RetryQueueService', () => {
  let service: RetryQueueService;
  let loggerCategory: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  let handler: RetryOperationHandler;
  let online = false;
  let toastMock: {
    warning: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    loggerCategory = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    };

    toastMock = {
      warning: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      success: vi.fn()
    };

    TestBed.configureTestingModule({
      providers: [
        RetryQueueService,
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn().mockReturnValue(loggerCategory)
          }
        },
        {
          provide: ToastService,
          useValue: toastMock
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            captureMessage: vi.fn(),
            captureException: vi.fn(),
            setTag: vi.fn(),
            setContext: vi.fn()
          }
        }
      ]
    });

    service = TestBed.inject(RetryQueueService);

    // 测试中不依赖持久化副作用，避免 IndexedDB 异步写入噪音。
    vi.spyOn(service as unknown as { saveToStorage: () => Promise<void> }, 'saveToStorage')
      .mockResolvedValue(undefined);

    online = false;
    handler = {
      pushTask: vi.fn().mockResolvedValue(true),
      deleteTask: vi.fn().mockResolvedValue(true),
      pushProject: vi.fn().mockResolvedValue(true),
      pushConnection: vi.fn().mockResolvedValue(true),
      pushBlackBoxEntry: vi.fn().mockResolvedValue(true),
      isSessionExpired: vi.fn().mockReturnValue(false),
      isOnline: vi.fn(() => online),
      onProcessingStateChange: vi.fn()
    };
    service.setOperationHandler(handler);
  });

  it('queue_full 压力模式在容量恢复后应自动解锁', () => {
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 3;

    expect(service.add('task', 'upsert', createTask('t-1'), 'p-1')).toBe(true);
    expect(service.add('task', 'upsert', createTask('t-2'), 'p-1')).toBe(true);
    expect(service.add('task', 'upsert', createTask('t-3'), 'p-1')).toBe(true);
    expect(service.add('task', 'upsert', createTask('t-4'), 'p-1')).toBe(true);
    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('queue_full');

    service.removeByEntityId('t-1'); // 3 -> 2
    service.removeByEntityId('t-2'); // 2 -> 1
    expect(service.length).toBe(2);

    (service as unknown as { tryRecoverQueueFullPressure: (force?: boolean) => void }).tryRecoverQueueFullPressure(true);
    expect(service.queuePressure()).toBe(false);
    expect(service.queuePressureReason()).toBeNull();
  });

  it('processQueue 出现异常后应释放处理锁并回写状态', async () => {
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 3;
    service.add('task', 'upsert', createTask('t-1'), 'p-1');
    online = true;

    (service as unknown as { saveToStorage: () => Promise<void> }).saveToStorage = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('save crash');
      })
      .mockResolvedValue(undefined) as unknown as () => Promise<void>;

    await service.processQueue();

    expect((service as unknown as { isProcessingQueue: boolean }).isProcessingQueue).toBe(false);
    expect(handler.onProcessingStateChange).toHaveBeenCalledWith(true, 1);
    expect(handler.onProcessingStateChange).toHaveBeenCalledWith(false, 0);
  });

  it('满队列进入压力模式后，在线状态应触发应急处理并继续入队', async () => {
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 1;

    expect(service.add('task', 'upsert', createTask('t-1'), 'p-1')).toBe(true);
    online = true;

    expect(service.add('task', 'upsert', createTask('t-2'), 'p-1')).toBe(true);
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
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 2;
    online = false;

    expect(service.add('task', 'upsert', createTask('t-1'), 'p-1')).toBe(true);
    expect(service.add('task', 'upsert', createTask('t-2'), 'p-1')).toBe(true);

    // 新实体入队触发 queue_full 压力模式
    expect(service.add('task', 'upsert', createTask('t-3'), 'p-1')).toBe(true);
    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('queue_full');

    // 清理前一次拒绝触发的提示，验证下面不会再次触发
    toastMock.warning.mockClear();

    const updated = createTask('t-1');
    updated.title = 'Task t-1 updated';

    // 同实体更新应成功（覆盖队列项），而不是被压力模式拒绝
    expect(service.add('task', 'upsert', updated, 'p-1')).toBe(true);
    expect(service.length).toBe(3);
    expect(service.getItems().find(item => item.data.id === 't-1')?.data).toEqual(updated);
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('storage 压力恢复后应自动退出压力模式', () => {
    (service as unknown as { enterPressureMode: (reason: string) => void }).enterPressureMode('storage_quota_exceeded');
    expect(service.queuePressure()).toBe(true);
    expect(service.queuePressureReason()).toBe('storage_quota_exceeded');

    (service as unknown as { tryRecoverQueueFullPressure: (force?: boolean) => void }).tryRecoverQueueFullPressure(true);

    expect(service.queuePressure()).toBe(false);
    expect(service.queuePressureReason()).toBeNull();
  });

  // ==================== Task 2.2 / 3.1 新增测试 ====================
  
  it('getCapacityPercent 应返回正确的容量百分比', () => {
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 10;
    
    expect(service.getCapacityPercent()).toBe(0);
    
    service.add('task', 'upsert', createTask('t-1'), 'p-1');
    service.add('task', 'upsert', createTask('t-2'), 'p-1');
    service.add('task', 'upsert', createTask('t-3'), 'p-1');
    
    expect(service.getCapacityPercent()).toBe(30);
  });

  it('getCapacityPercent 队列满时应返回 100 或更高', () => {
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 2;
    
    service.add('task', 'upsert', createTask('t-1'), 'p-1');
    service.add('task', 'upsert', createTask('t-2'), 'p-1');
    
    expect(service.getCapacityPercent()).toBeGreaterThanOrEqual(100);
  });

  it('checkCapacityWarning 在 80%+ 时应记录日志（WARNING_THRESHOLD=0.8）', () => {
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 10;
    // 重置冷却时间
    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;
    
    // 添加 8 个任务达到 80%，刚好超过 WARNING_THRESHOLD(0.8) 的门槛
    for (let i = 0; i < 8; i++) {
      service.add('task', 'upsert', createTask(`cap-${i}`), 'p-1');
    }
    
    // 80% 超过阈值，应触发日志
    expect(loggerCategory.warn).toHaveBeenCalled();
  });

  it('checkCapacityWarning 在 95%+ 时应触发 error 级别日志', () => {
    (service as unknown as { maxQueueSize: number }).maxQueueSize = 20;
    
    // 先添加 19 个任务达到 95%（此过程中会内部触发 warning）
    for (let i = 0; i < 19; i++) {
      service.add('task', 'upsert', createTask(`crit-${i}`), 'p-1');
    }
    
    // 重置冷却，然后显式再次调用 checkCapacityWarning
    (service as unknown as { lastWarningTime: number }).lastWarningTime = 0;
    (service as unknown as { lastWarningPercent: number }).lastWarningPercent = 0;
    loggerCategory.error.mockClear();
    
    service.checkCapacityWarning();
    
    // 95% 应触发 error 级别日志
    expect(loggerCategory.error).toHaveBeenCalled();
  });
});
