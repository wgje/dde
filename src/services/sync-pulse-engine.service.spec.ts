import { vi, describe, it, expect } from 'vitest';
import { SyncPulseEngineService, type EventDrivenSyncPulseLike } from './sync-pulse-engine.service';

type SyncPulseEnginePrivate = {
  initialize: () => void;
  destroy: () => void;
  trigger: (reason: 'focus-entry' | 'manual') => Promise<unknown>;
  ref: EventDrivenSyncPulseLike | null;
  loadPromise: Promise<EventDrivenSyncPulseLike | null> | null;
};

function createContext(): SyncPulseEnginePrivate {
  const context = Object.create(SyncPulseEngineService.prototype) as SyncPulseEnginePrivate;
  context.ref = null;
  context.loadPromise = null;
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

  it('destroy 在仅有在途加载时应等待并销毁', async () => {
    const context = createContext();
    const engine = makeEngine();
    context.loadPromise = Promise.resolve(engine);

    context.destroy();
    await context.loadPromise;
    await Promise.resolve();

    expect(engine.destroy).toHaveBeenCalledTimes(1);
  });

  it('trigger 应转发 reason 给引擎 triggerNow', async () => {
    const context = createContext();
    const engine = makeEngine();
    context.ref = engine;

    const result = await context.trigger('focus-entry');

    expect(engine.triggerNow).toHaveBeenCalledWith('focus-entry');
    expect(result).toEqual({ status: 'success' });
  });
});
