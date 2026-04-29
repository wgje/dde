/**
 * BeforeUnloadManagerService 单元测试（Injector 隔离 + happy-dom）
 *
 * 覆盖重点：
 * - register / unregister 生命周期
 * - 优先级排序
 * - 同 ID 重复注册时替换
 * - triggerSave 返回值与 callback 异常隔离
 * - initialize 幂等
 * - cleanup 通过 DestroyRef 移除所有监听器
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DestroyRef, Injector, runInInjectionContext } from '@angular/core';
import { BeforeUnloadManagerService } from './before-unload-manager.service';
import { LoggerService } from './logger.service';
import { createMockDestroyRef } from '../test-setup.mocks';

// 需要 window / document（happy-dom）- 引用让 classifier 归入 lane_browser_minimal
beforeAll(() => {
  if (typeof window === 'undefined') {
    throw new Error('本测试需要 DOM 环境（happy-dom）');
  }
});

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
const mockLogger = { category: vi.fn(() => mockLoggerCategory) };

describe('BeforeUnloadManagerService', () => {
  let service: BeforeUnloadManagerService;
  let destroy: () => void;
  let injector: Injector;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockDR = createMockDestroyRef();
    destroy = mockDR.destroy;
    injector = Injector.create({
      providers: [
        BeforeUnloadManagerService,
        { provide: LoggerService, useValue: mockLogger },
        { provide: DestroyRef, useValue: mockDR.destroyRef },
      ],
    });
    runInInjectionContext(injector, () => {
      service = injector.get(BeforeUnloadManagerService);
    });
  });

  afterEach(() => {
    // 始终清理，避免 window 事件监听器跨测试泄漏
    try {
      (service as unknown as { cleanup?: () => void }).cleanup?.();
      destroy();
    } catch {
      /* ignore */
    }
  });

  /**
   * 每个依赖 window.dispatchEvent 的 it 都需要一个"干净窗口"：
   * 由于所有测试共享 happy-dom window，早期测试的 initialize() 注册的监听器
   * 会在旧 service 未销毁前残留。这里通过在初始化前重建一次 addEventListener
   * spy 来确保只关注当前 service 的交互，而非历史监听器。
   */

  // ==========================================================================
  // register / unregister / triggerSave
  // ==========================================================================

  describe('register / unregister', () => {
    it('注册的回调被 triggerSave 调用', () => {
      const cb = vi.fn();
      service.register('mod-a', cb);
      service.triggerSave();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('unregister 后不再调用该回调', () => {
      const cb = vi.fn();
      service.register('mod-a', cb);
      service.unregister('mod-a');
      service.triggerSave();
      expect(cb).not.toHaveBeenCalled();
    });

    it('unregister 不存在的 id 是 no-op', () => {
      expect(() => service.unregister('nobody')).not.toThrow();
    });

    it('同 ID 重复 register 会替换旧回调（而非叠加）', () => {
      const first = vi.fn();
      const second = vi.fn();
      service.register('mod-a', first);
      service.register('mod-a', second);
      service.triggerSave();
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // 优先级排序
  // ==========================================================================

  describe('优先级', () => {
    it('按优先级升序执行（数字小的先执行）', () => {
      const order: string[] = [];
      service.register('low', () => { order.push('low'); }, 30);
      service.register('high', () => { order.push('high'); }, 0);
      service.register('mid', () => { order.push('mid'); }, 15);

      service.triggerSave();
      expect(order).toEqual(['high', 'mid', 'low']);
    });

    it('默认优先级为 10', () => {
      const order: string[] = [];
      service.register('default', () => { order.push('default'); });
      service.register('first', () => { order.push('first'); }, 0);
      service.register('last', () => { order.push('last'); }, 20);

      service.triggerSave();
      expect(order).toEqual(['first', 'default', 'last']);
    });
  });

  // ==========================================================================
  // triggerSave 返回值与异常隔离
  // ==========================================================================

  describe('triggerSave 返回值', () => {
    it('任一回调返回 true 则整体返回 true', () => {
      service.register('a', () => false);
      service.register('b', () => true);
      service.register('c', () => undefined);

      expect(service.triggerSave()).toBe(true);
    });

    it('所有回调返回 falsy 时返回 false', () => {
      service.register('a', () => false);
      service.register('b', () => undefined);
      service.register('c', () => void 0);

      expect(service.triggerSave()).toBe(false);
    });

    it('空列表返回 false', () => {
      expect(service.triggerSave()).toBe(false);
    });

    it('仅严格 true 才触发确认，非布尔真值（对象/字符串）不触发', () => {
      service.register('a', (() => 'yes') as unknown as () => boolean | void);
      service.register('b', (() => 1) as unknown as () => boolean | void);
      expect(service.triggerSave()).toBe(false);
    });
  });

  describe('suppressNextConfirmation', () => {
    it('仅跳过下一次 beforeunload 确认且仍执行保存回调', () => {
      const cb = vi.fn(() => true);
      service.register('confirming-save', cb);
      service.initialize();

      const firstEvent = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
      Object.defineProperty(firstEvent, 'returnValue', { configurable: true, writable: true, value: undefined });

      service.suppressNextConfirmation();
      window.dispatchEvent(firstEvent);

      expect(cb).toHaveBeenCalledTimes(1);
      expect(firstEvent.defaultPrevented).toBe(false);
      expect(firstEvent.returnValue).toBeUndefined();

      const secondEvent = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
      Object.defineProperty(secondEvent, 'returnValue', { configurable: true, writable: true, value: undefined });
      window.dispatchEvent(secondEvent);

      expect(cb).toHaveBeenCalledTimes(2);
      expect(secondEvent.defaultPrevented).toBe(true);
      expect(secondEvent.returnValue).toBe('您有未保存的内容，确定要离开吗？');
    });
  });

  describe('回调异常隔离', () => {
    it('单个回调抛错不阻止其他回调执行', () => {
      const later = vi.fn();
      service.register('bad', () => {
        throw new Error('callback failed');
      });
      service.register('good', later);

      expect(() => service.triggerSave()).not.toThrow();
      expect(later).toHaveBeenCalledTimes(1);
      expect(mockLoggerCategory.error).toHaveBeenCalled();
    });

    it('抛错的回调也不影响返回值的确认位', () => {
      service.register('bad', () => {
        throw new Error('x');
      });
      service.register('confirm', () => true);

      expect(service.triggerSave()).toBe(true);
    });
  });

  // ==========================================================================
  // initialize 幂等与事件监听
  // ==========================================================================

  describe('initialize', () => {
    it('initialize 向 window 注册 beforeunload / pagehide 监听器', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      service.initialize();

      const events = addSpy.mock.calls.map((c) => c[0]);
      expect(events).toContain('beforeunload');
      expect(events).toContain('pagehide');

      addSpy.mockRestore();
    });

    it('重复调用 initialize 不会重复注册监听器', () => {
      service.initialize();
      const addSpy = vi.spyOn(window, 'addEventListener');
      service.initialize();
      expect(addSpy).not.toHaveBeenCalled();
      addSpy.mockRestore();
    });

    it('window 未定义时 initialize 是 no-op', () => {
      // 模拟 SSR 环境
      // 这里无法真实移除 window，只验证不抛错
      expect(() => service.initialize()).not.toThrow();
    });
  });

  // ==========================================================================
  // DestroyRef cleanup — 仅验证回调注册与不抛异常
  // ==========================================================================

  describe('cleanup', () => {
    it('DestroyRef 销毁时触发服务清理流程（不抛异常、幂等）', () => {
      service.initialize();
      expect(() => destroy()).not.toThrow();
      // 二次销毁幂等
      expect(() => destroy()).not.toThrow();
    });

    it('清理 pagehide 监听时应使用与注册一致的 capture 选项', () => {
      const removeSpy = vi.spyOn(window, 'removeEventListener');
      service.initialize();

      (service as unknown as { cleanup: () => void }).cleanup();

      expect(removeSpy).toHaveBeenCalledWith('pagehide', expect.any(Function), { capture: true });
      removeSpy.mockRestore();
    });
  });
});
