/**
 * DataPreloaderService 单元测试
 *
 * 测试覆盖：
 * 1. 构造函数从 window.__PRELOADED_DATA__ 读取并清理引用
 * 2. 构造函数处理缺失的 __PRELOADED_DATA__
 * 3. getPreloadedServerTime 数据有效时返回值
 * 4. getPreloadedServerTime 无预加载数据时返回 null
 * 5. getPreloadedServerTime 数据过期时返回 null（TTL 超过 30 秒）
 * 6. getPreloadedServerTime 第二次调用返回 null（一次性使用）
 * 7. getPreloadedProjects 数据有效时返回值
 * 8. getPreloadedProjects 无预加载数据时返回 null
 * 9. getPreloadedProjects 数据过期时返回 null
 * 10. getPreloadedProjects 第二次调用返回 null（一次性使用）
 * 11. getPreloadScript 返回包含 script 标签的字符串
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { DataPreloaderService } from './data-preloader.service';

/** 扩展 window 类型以支持预加载数据 */
interface WindowWithPreload extends Window {
  __PRELOADED_DATA__?: {
    serverTime: number | null;
    projects: unknown[] | null;
    timestamp: number;
  };
}

/**
 * 创建服务实例的辅助函数
 * 由于服务在构造函数中读取 window.__PRELOADED_DATA__，
 * 必须在实例化前设置好 window 上的数据
 */
function createService(): DataPreloaderService {
  const injector = Injector.create({
    providers: [
      { provide: DataPreloaderService, useClass: DataPreloaderService },
    ],
  });

  return runInInjectionContext(injector, () => injector.get(DataPreloaderService));
}

describe('DataPreloaderService', () => {
  const win = window as unknown as WindowWithPreload;

  afterEach(() => {
    // 每次测试后清理 window 上的预加载数据
    delete win.__PRELOADED_DATA__;
    vi.restoreAllMocks();
  });

  // ==================== 构造函数 ====================

  describe('构造函数', () => {
    it('从 window.__PRELOADED_DATA__ 读取数据并清理 window 引用', () => {
      // 设置预加载数据
      win.__PRELOADED_DATA__ = {
        serverTime: 1700000000000,
        projects: [{ id: 'proj-1' }],
        timestamp: Date.now(),
      };

      const service = createService();

      // window 上的引用应被清除
      expect(win.__PRELOADED_DATA__).toBeUndefined();

      // 服务应能返回有效数据（证明已正确读取）
      expect(service.getPreloadedServerTime()).toBe(1700000000000);
    });

    it('window 上无 __PRELOADED_DATA__ 时正常初始化', () => {
      // 不设置任何预加载数据
      delete win.__PRELOADED_DATA__;

      const service = createService();

      // 不应抛出异常，且返回 null
      expect(service.getPreloadedServerTime()).toBeNull();
      expect(service.getPreloadedProjects()).toBeNull();
    });
  });

  // ==================== getPreloadedServerTime ====================

  describe('getPreloadedServerTime', () => {
    it('数据有效时返回 serverTime', () => {
      const mockServerTime = 1700000000000;
      win.__PRELOADED_DATA__ = {
        serverTime: mockServerTime,
        projects: null,
        timestamp: Date.now(),
      };

      const service = createService();

      expect(service.getPreloadedServerTime()).toBe(mockServerTime);
    });

    it('无预加载数据时返回 null', () => {
      // 不设置 window.__PRELOADED_DATA__
      const service = createService();

      expect(service.getPreloadedServerTime()).toBeNull();
    });

    it('数据过期时返回 null（TTL 超过 30 秒）', () => {
      const now = Date.now();
      win.__PRELOADED_DATA__ = {
        serverTime: 1700000000000,
        projects: null,
        // 设置为 31 秒前的时间戳，超过 30 秒 TTL
        timestamp: now - 31000,
      };

      const service = createService();

      expect(service.getPreloadedServerTime()).toBeNull();
    });

    it('第二次调用返回 null（一次性使用）', () => {
      win.__PRELOADED_DATA__ = {
        serverTime: 1700000000000,
        projects: null,
        timestamp: Date.now(),
      };

      const service = createService();

      // 第一次调用应返回值
      expect(service.getPreloadedServerTime()).toBe(1700000000000);

      // 第二次调用应返回 null（已被设为 null）
      expect(service.getPreloadedServerTime()).toBeNull();
    });

    it('serverTime 为 null 时返回 null', () => {
      win.__PRELOADED_DATA__ = {
        serverTime: null,
        projects: [{ id: 'proj-1' }],
        timestamp: Date.now(),
      };

      const service = createService();

      expect(service.getPreloadedServerTime()).toBeNull();
    });
  });

  // ==================== getPreloadedProjects ====================

  describe('getPreloadedProjects', () => {
    it('数据有效时返回 projects', () => {
      const mockProjects = [{ id: 'proj-1', name: 'Test' }, { id: 'proj-2', name: 'Demo' }];
      win.__PRELOADED_DATA__ = {
        serverTime: null,
        projects: mockProjects,
        timestamp: Date.now(),
      };

      const service = createService();

      expect(service.getPreloadedProjects()).toEqual(mockProjects);
    });

    it('无预加载数据时返回 null', () => {
      const service = createService();

      expect(service.getPreloadedProjects()).toBeNull();
    });

    it('数据过期时返回 null（TTL 超过 30 秒）', () => {
      const now = Date.now();
      win.__PRELOADED_DATA__ = {
        serverTime: null,
        projects: [{ id: 'proj-1' }],
        // 设置为 31 秒前的时间戳
        timestamp: now - 31000,
      };

      const service = createService();

      expect(service.getPreloadedProjects()).toBeNull();
    });

    it('第二次调用返回 null（一次性使用）', () => {
      const mockProjects = [{ id: 'proj-1' }];
      win.__PRELOADED_DATA__ = {
        serverTime: null,
        projects: mockProjects,
        timestamp: Date.now(),
      };

      const service = createService();

      // 第一次调用应返回值
      expect(service.getPreloadedProjects()).toEqual(mockProjects);

      // 第二次调用应返回 null（已被设为 null）
      expect(service.getPreloadedProjects()).toBeNull();
    });

    it('projects 为 null 时返回 null', () => {
      win.__PRELOADED_DATA__ = {
        serverTime: 1700000000000,
        projects: null,
        timestamp: Date.now(),
      };

      const service = createService();

      expect(service.getPreloadedProjects()).toBeNull();
    });
  });

  // ==================== TTL 边界测试 ====================

  describe('数据有效期边界', () => {
    it('timestamp 恰好在 30 秒内时数据有效', () => {
      const now = Date.now();
      // 使用 vi.spyOn 固定 Date.now，确保精确控制时间
      const dateNowSpy = vi.spyOn(Date, 'now');

      // 构造函数运行时使用真实时间
      win.__PRELOADED_DATA__ = {
        serverTime: 1700000000000,
        projects: [{ id: 'proj-1' }],
        timestamp: now,
      };

      const service = createService();

      // 模拟过了 29.9 秒（仍在 TTL 内）
      dateNowSpy.mockReturnValue(now + 29900);
      expect(service.getPreloadedServerTime()).toBe(1700000000000);
    });

    it('timestamp 恰好到 30 秒时数据过期', () => {
      const now = Date.now();
      const dateNowSpy = vi.spyOn(Date, 'now');

      win.__PRELOADED_DATA__ = {
        serverTime: 1700000000000,
        projects: [{ id: 'proj-1' }],
        timestamp: now,
      };

      // 构造函数中 Date.now 使用真实值
      dateNowSpy.mockReturnValue(now);
      const service = createService();

      // 模拟恰好过了 30 秒（不满足 < 30000 条件）
      dateNowSpy.mockReturnValue(now + 30000);
      expect(service.getPreloadedServerTime()).toBeNull();
    });

    it('getPreloadedProjects 和 getPreloadedServerTime 各自独立（消耗一个不影响另一个）', () => {
      win.__PRELOADED_DATA__ = {
        serverTime: 1700000000000,
        projects: [{ id: 'proj-1' }],
        timestamp: Date.now(),
      };

      const service = createService();

      // 先消耗 serverTime
      expect(service.getPreloadedServerTime()).toBe(1700000000000);

      // projects 仍然可用
      expect(service.getPreloadedProjects()).toEqual([{ id: 'proj-1' }]);
    });
  });

  // ==================== getPreloadScript 静态方法 ====================

  describe('getPreloadScript', () => {
    it('返回包含 script 标签的字符串', () => {
      const script = DataPreloaderService.getPreloadScript();

      expect(typeof script).toBe('string');
      expect(script).toContain('<script>');
      expect(script).toContain('__PRELOADED_DATA__');
    });
  });
});
