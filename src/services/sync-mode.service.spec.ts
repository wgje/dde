/**
 * SyncModeService 单元测试
 * 
 * 覆盖场景：
 * 1. 配置迁移逻辑（旧版 interval 升级）
 * 2. 自动同步定时器启动/停止
 * 3. 模式切换
 * 4. 间隔设置边界检查
 */
import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SyncModeService, SyncMode } from './sync-mode.service';
import { LoggerService } from './logger.service';

describe('SyncModeService', () => {
  let service: SyncModeService;
  let mockLogger: any;
  
  const STORAGE_KEY = 'nanoflow.sync-mode-config';
  
  beforeEach(() => {
    // 清理 localStorage
    localStorage.clear();
    
    // 模拟 Logger
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    
    TestBed.configureTestingModule({
      providers: [
        SyncModeService,
        {
          provide: LoggerService,
          useValue: {
            category: () => mockLogger
          }
        }
      ]
    });
    
    // 使用 fake timers
    vi.useFakeTimers();
  });
  
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  describe('配置迁移', () => {
    it('应将旧版 interval (30s) 升级到 300s', () => {
      // 设置旧版配置
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'automatic',
        interval: 30 // 旧版默认值
      }));
      
      service = TestBed.inject(SyncModeService);
      
      expect(service.interval()).toBe(300);
      expect(mockLogger.info).toHaveBeenCalledWith(
        '检测到旧版同步间隔配置，已升级',
        expect.objectContaining({
          oldInterval: 30,
          newInterval: 300
        })
      );
    });
    
    it('应保留 MIN_SYNC_INTERVAL (60s) 不变（用户可能明确需要快速同步）', () => {
      // 如果用户明确设置了 MIN_SYNC_INTERVAL，应保留
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'automatic',
        interval: 60  // MIN_SYNC_INTERVAL - 用户明确设置
      }));
      
      service = TestBed.inject(SyncModeService);
      
      // 60s === MIN_SYNC_INTERVAL，不会被升级
      expect(service.interval()).toBe(60);
    });
    
    it('应将介于 MIN 和 120s 之间的值升级 (90s -> 300s)', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'automatic',
        interval: 90  // 介于 60 和 120 之间
      }));
      
      service = TestBed.inject(SyncModeService);
      
      expect(service.interval()).toBe(300);
    });
    
    it('应保留 >= 120s 的配置不变', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'automatic',
        interval: 180 // 用户设置的 3 分钟
      }));
      
      service = TestBed.inject(SyncModeService);
      
      expect(service.interval()).toBe(180);
    });
    
    it('无配置时应使用默认值 300s', () => {
      service = TestBed.inject(SyncModeService);
      
      expect(service.interval()).toBe(300);
    });
  });

  describe('自动同步定时器', () => {
    it('automatic 模式下应启动定时器', () => {
      service = TestBed.inject(SyncModeService);
      
      expect(service.mode()).toBe('automatic');
      expect(mockLogger.info).toHaveBeenCalledWith(
        '启动延迟：30 秒后开始自动同步'
      );
    });
    
    it('manual 模式下不应启动定时器', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'manual',
        interval: 300
      }));
      
      service = TestBed.inject(SyncModeService);
      
      expect(service.mode()).toBe('manual');
      expect(mockLogger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('自动同步已启动')
      );
    });
    
    it('切换到 manual 模式应停止定时器', () => {
      service = TestBed.inject(SyncModeService);
      
      // 等待启动延迟
      vi.advanceTimersByTime(31000);
      
      service.setMode('manual');
      
      expect(service.mode()).toBe('manual');
      expect(mockLogger.debug).toHaveBeenCalledWith('自动同步已停止');
    });
    
    it('切换回 automatic 模式应重启定时器', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'manual',
        interval: 300
      }));
      
      service = TestBed.inject(SyncModeService);
      service.setMode('automatic');
      
      expect(service.mode()).toBe('automatic');
      // 从 manual 切换到 automatic 后会触发 startAutoSync
      // 但由于 startupDelayCooldown = false（已经在 constructor 中设为 false），
      // 所以会直接启动定时器
      // 等待启动延迟
      vi.advanceTimersByTime(31000);
      
      expect(mockLogger.info).toHaveBeenCalledWith(
        '自动同步已启动',
        expect.objectContaining({ intervalMs: 300000 })
      );
    });
  });

  describe('间隔设置', () => {
    it('应限制最小间隔为 60s', () => {
      service = TestBed.inject(SyncModeService);
      
      service.setInterval(10); // 尝试设置 10s
      
      expect(service.interval()).toBe(60); // 被限制为最小值
    });
    
    it('应限制最大间隔为 43200s (12h)', () => {
      service = TestBed.inject(SyncModeService);
      
      service.setInterval(100000); // 尝试设置超大值
      
      expect(service.interval()).toBe(43200); // 被限制为最大值
    });
    
    it('有效间隔应正常设置', () => {
      service = TestBed.inject(SyncModeService);
      
      service.setInterval(600); // 10 分钟
      
      expect(service.interval()).toBe(600);
    });
  });

  describe('同步回调', () => {
    it('triggerSync 应调用同步回调', async () => {
      service = TestBed.inject(SyncModeService);
      
      const mockCallback = vi.fn().mockResolvedValue(undefined);
      service.setSyncCallback(mockCallback);
      
      await service.triggerSync('both');
      
      expect(mockCallback).toHaveBeenCalledWith('both');
    });
    
    it('未设置回调时 triggerSync 应记录警告', async () => {
      service = TestBed.inject(SyncModeService);
      
      await service.triggerSync('both');
      
      expect(mockLogger.warn).toHaveBeenCalledWith('未设置同步回调');
    });
    
    it('uploadOnly 应调用同步回调并传递 upload', async () => {
      service = TestBed.inject(SyncModeService);
      
      const mockCallback = vi.fn().mockResolvedValue(undefined);
      service.setSyncCallback(mockCallback);
      
      await service.uploadOnly();
      
      expect(mockCallback).toHaveBeenCalledWith('upload');
    });
    
    it('downloadOnly 应调用同步回调并传递 download', async () => {
      service = TestBed.inject(SyncModeService);
      
      const mockCallback = vi.fn().mockResolvedValue(undefined);
      service.setSyncCallback(mockCallback);
      
      await service.downloadOnly();
      
      expect(mockCallback).toHaveBeenCalledWith('download');
    });
  });

  describe('配置持久化', () => {
    it('setMode 应保存配置到 localStorage', () => {
      service = TestBed.inject(SyncModeService);
      
      service.setMode('completely-manual');
      
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      expect(saved.mode).toBe('completely-manual');
    });
    
    it('setInterval 应保存配置到 localStorage', () => {
      service = TestBed.inject(SyncModeService);
      
      service.setInterval(600);
      
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      expect(saved.interval).toBe(600);
    });
    
    it('resetToDefaults 应恢复默认配置', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'completely-manual',
        interval: 600
      }));
      
      service = TestBed.inject(SyncModeService);
      service.resetToDefaults();
      
      expect(service.mode()).toBe('automatic');
      expect(service.interval()).toBe(300);
    });
  });

  describe('计算属性', () => {
    it('isAutomatic 应正确反映模式', () => {
      service = TestBed.inject(SyncModeService);
      
      expect(service.isAutomatic()).toBe(true);
      expect(service.isManual()).toBe(false);
      expect(service.isCompletelyManual()).toBe(false);
    });
    
    it('isManual 应正确反映模式', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'manual',
        interval: 300
      }));
      
      service = TestBed.inject(SyncModeService);
      
      expect(service.isAutomatic()).toBe(false);
      expect(service.isManual()).toBe(true);
      expect(service.isCompletelyManual()).toBe(false);
    });
    
    it('isCompletelyManual 应正确反映模式', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: 'completely-manual',
        interval: 300
      }));
      
      service = TestBed.inject(SyncModeService);
      
      expect(service.isAutomatic()).toBe(false);
      expect(service.isManual()).toBe(false);
      expect(service.isCompletelyManual()).toBe(true);
    });
  });
});
