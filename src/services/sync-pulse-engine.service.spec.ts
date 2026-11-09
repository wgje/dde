import { vi, describe, it, expect } from 'vitest';
import { SyncPulseEngineService, type EventDrivenSyncPulseLike } from './sync-pulse-engine.service';

type SyncPulseEnginePrivate = {
  initialize: () => void;
  destroy: () => void;
  trigger: (reason: 'focus-entry' | 'manual') => Promise<unknown>;
  logger: { warn: ReturnType<typeof vi.fn> };
  ref: EventDrivenSyncPulseLike | null;
  loadPromise: Promise<EventDrivenSyncPulseLike | null> | null;
  lifecycleGeneration: number;
};

function createContext(): SyncPulseEnginePrivate {
  const context = Object.create(SyncPulseEngineService.prototype) as SyncPulseEnginePrivate;
  context.logger = { warn: vi.fn() };
  context.ref = null;
  context.loadPromise = null;
  context.lifecycleGeneration = 0;
  return context;
}

function makeEngine(): EventDrivenSyncPulseLike & {
  initialize: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  triggerNow: ReturnType<typeof vi.fn>;
} {
  return {
    initialize: vi.fn(),
    destroy: vi.fn(),
    triggerNow: vi.fn().mockResolvedValue({ status: 'success' }),
  } as unknown as EventDrivenSyncPulseLike & {
    initialize: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    triggerNow: ReturnType<typeof vi.fn>;
  };
}

describe('SyncPulseEngineService', () => {
  it('initialize 应在已缓存引擎上调用 initialize', async () => {
    const context = createContext();
    const engine = makeEngine();
    context.ref = engine;

    context.initialize();
    await Promise.resolve();

    expect(engine.initialize).toHaveBeenCalledTimes(1);
  });

  it('destroy 应在已缓存引擎上同步调用 destroy', () => {
    const context = createContext();
    const engine = makeEngine();
    context.ref = engine;

    context.destroy();

    expect(engine.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroy 降级 warn 自身失败时不应向外抛出', () => {
    const context = createContext();
    const engine = makeEngine();
    const error = new Error('engine destroy failed');
    context.ref = engine;
    engine.destroy.mockImplementationOnce(() => {
      throw error;
    });
    context.logger.warn.mockImplementationOnce(() => {
      throw new Error('logger unavailable');
    });

    expect(() => context.destroy()).not.toThrow();

    expect(context.logger.warn).toHaveBeenCalledWith(
      'EventDrivenSyncPulseService 销毁失败，已忽略迟到清理错误',
      error,
    );
  });

  it('destroy 在仅有在途加载时应等待并销毁', async () => {
    const context = createContext();
    const engine = makeEngine();
    context.loadPromise = Promise.resolve(engine);

    context.destroy();
    await context.loadPromise;
    await Promise.resolve();

    expect(engine.destroy).toHaveBeenCalledTimes(1);
  });

  it('重复 destroy 仅有在途加载时只应销毁一次 resolved 引擎', async () => {
    const context = createContext();
    const engine = makeEngine();
    context.loadPromise = Promise.resolve(engine);

    context.destroy();
    context.destroy();
    await context.loadPromise;
    await Promise.resolve();

    expect(engine.destroy).toHaveBeenCalledTimes(1);
  });

  it('在途加载完成后的 destroy 失败应降级为 warn，避免未处理异步失败', async () => {
    const context = createContext();
    const engine = makeEngine();
    const error = new Error('engine destroy failed');
    context.loadPromise = Promise.resolve(engine);
    engine.destroy.mockImplementationOnce(() => {
      throw error;
    });

    context.destroy();
    await context.loadPromise;

    await vi.waitFor(() => {
      expect(context.logger.warn).toHaveBeenCalledWith(
        'EventDrivenSyncPulseService 销毁失败，已忽略迟到清理错误',
        error,
      );
    });
  });

  it('destroy 先于在途 initialize resolve 时不应迟到初始化引擎', async () => {
    const context = createContext();
    const engine = makeEngine();
    context.loadPromise = Promise.resolve(engine);

    context.initialize();
    context.destroy();
    await context.loadPromise;
    await Promise.resolve();

    expect(engine.initialize).not.toHaveBeenCalled();
    expect(engine.destroy).toHaveBeenCalledTimes(1);
  });

  it('懒加载完成后的 initialize 失败应降级为 warn，避免未处理异步失败', async () => {
    const context = createContext();
    const engine = makeEngine();
    const error = new Error('engine initialize failed');
    context.loadPromise = Promise.resolve(engine);
    engine.initialize.mockImplementationOnce(() => {
      throw error;
    });

    context.initialize();
    await context.loadPromise;

    await vi.waitFor(() => {
      expect(context.logger.warn).toHaveBeenCalledWith(
        'EventDrivenSyncPulseService 初始化失败，降级关闭 pulse',
        error,
      );
    });
  });

  it('initialize 降级 warn 自身失败时不应产生未处理异步失败', async () => {
    const context = createContext();
    const engine = makeEngine();
    const error = new Error('engine initialize failed');
    context.loadPromise = Promise.resolve(engine);
    engine.initialize.mockImplementationOnce(() => {
      throw error;
    });
    context.logger.warn.mockImplementation(() => {
      throw new Error('logger unavailable');
    });

    context.initialize();
    await context.loadPromise;
    await Promise.resolve();
    await Promise.resolve();

    expect(context.logger.warn).toHaveBeenCalledWith(
      'EventDrivenSyncPulseService 初始化失败，降级关闭 pulse',
      error,
    );
  });

  it('destroy 先于在途 trigger resolve 时不应迟到触发引擎', async () => {
    const context = createContext();
    const engine = makeEngine();
    let resolveLoad: ((value: EventDrivenSyncPulseLike) => void) | null = null;
    context.loadPromise = new Promise<EventDrivenSyncPulseLike>((resolve) => {
      resolveLoad = resolve;
    });

    const triggerPromise = context.trigger('manual');
    context.destroy();
    resolveLoad!(engine);
    const result = await triggerPromise;
    await Promise.resolve();

    expect(result).toBeNull();
    expect(engine.triggerNow).not.toHaveBeenCalled();
    expect(engine.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroy 后直接 trigger 应返回 null，直到 initialize 重新打开生命周期', async () => {
    const context = createContext();
    const engine = makeEngine();
    context.ref = engine;

    context.destroy();

    await expect(context.trigger('manual')).resolves.toBeNull();
    expect(engine.triggerNow).not.toHaveBeenCalled();

    context.initialize();
    await Promise.resolve();
    await expect(context.trigger('manual')).resolves.toEqual({ status: 'success' });

    expect(engine.initialize).toHaveBeenCalledTimes(1);
    expect(engine.triggerNow).toHaveBeenCalledTimes(1);
  });

  it('trigger 应转发 reason 给引擎 triggerNow', async () => {
    const context = createContext();
    const engine = makeEngine();
    context.ref = engine;

    const result = await context.trigger('focus-entry');

    expect(engine.triggerNow).toHaveBeenCalledWith('focus-entry');
    expect(result).toEqual({ status: 'success' });
  });

  it('triggerNow 拒绝时应降级为 warn 并返回 null', async () => {
    const context = createContext();
    const engine = makeEngine();
    const error = new Error('engine trigger failed');
    context.ref = engine;
    engine.triggerNow.mockRejectedValueOnce(error);

    const result = await context.trigger('manual');

    expect(result).toBeNull();
    expect(context.logger.warn).toHaveBeenCalledWith(
      'EventDrivenSyncPulseService 触发失败，已跳过本次 pulse',
      error,
    );
  });
});
