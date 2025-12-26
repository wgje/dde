/**
 * TabSyncService 单元测试
 * 
 * 测试覆盖：
 * - 项目打开/关闭通知
 * - 标签页追踪
 * - 冲突提示
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TabSyncService } from './tab-sync.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';

// Mock BroadcastChannel
class MockBroadcastChannel {
  name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  
  constructor(name: string) {
    this.name = name;
  }
  
  postMessage = vi.fn();
  close = vi.fn();
}

describe('TabSyncService', () => {
  let service: TabSyncService;
  let mockToastService: any;
  let mockLoggerService: any;
  let originalBroadcastChannel: typeof BroadcastChannel;
  
  beforeEach(() => {
    // 保存原始 BroadcastChannel
    originalBroadcastChannel = (globalThis as any).BroadcastChannel;
    (globalThis as any).BroadcastChannel = MockBroadcastChannel;
    
    vi.useFakeTimers();
    
    mockToastService = {
      warning: vi.fn(),
    };
    
    mockLoggerService = {
      category: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
    };
    
    TestBed.configureTestingModule({
      providers: [
        TabSyncService,
        { provide: ToastService, useValue: mockToastService },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });
    
    service = TestBed.inject(TabSyncService);
  });
  
  afterEach(() => {
    vi.useRealTimers();
    // 恢复原始 BroadcastChannel
    (globalThis as any).BroadcastChannel = originalBroadcastChannel;
  });
  
  describe('初始化', () => {
    it('应创建服务实例', () => {
      expect(service).toBeTruthy();
    });
    
    it('应创建唯一的标签页 ID', () => {
      expect((service as any).tabId).toBeDefined();
      expect(typeof (service as any).tabId).toBe('string');
    });
  });
  
  describe('notifyProjectOpen', () => {
    it('应更新当前项目信息', () => {
      service.notifyProjectOpen('project-1', 'My Project');
      
      expect((service as any).currentProjectId).toBe('project-1');
      expect((service as any).currentProjectName).toBe('My Project');
    });
    
    it('应通过 BroadcastChannel 发送消息', () => {
      service.notifyProjectOpen('project-1', 'My Project');
      
      const channel = (service as any).channel as MockBroadcastChannel;
      expect(channel.postMessage).toHaveBeenCalled();
      
      const message = channel.postMessage.mock.calls[0][0];
      expect(message.type).toBe('project-opened');
      expect(message.projectId).toBe('project-1');
    });
    
    it('切换项目时应先关闭旧项目', () => {
      service.notifyProjectOpen('project-1', 'Project 1');
      service.notifyProjectOpen('project-2', 'Project 2');
      
      const channel = (service as any).channel as MockBroadcastChannel;
      // 第一次打开 + 关闭 + 第二次打开 = 3 次调用
      expect(channel.postMessage).toHaveBeenCalledTimes(3);
    });
  });
  
  describe('notifyProjectClose', () => {
    it('应清除当前项目信息', () => {
      service.notifyProjectOpen('project-1', 'My Project');
      service.notifyProjectClose();
      
      expect((service as any).currentProjectId).toBeNull();
    });
    
    it('应发送关闭消息', () => {
      service.notifyProjectOpen('project-1', 'My Project');
      service.notifyProjectClose();
      
      const channel = (service as any).channel as MockBroadcastChannel;
      const lastCall = channel.postMessage.mock.calls.at(-1)?.[0];
      expect(lastCall.type).toBe('project-closed');
    });
  });
  
  describe('getOtherTabsCount', () => {
    it('无其他标签页时应返回 0', () => {
      const count = service.getOtherTabsCount('project-1');
      expect(count).toBe(0);
    });
  });
  
  describe('cleanup', () => {
    it('应关闭 BroadcastChannel', () => {
      const channel = (service as any).channel as MockBroadcastChannel;
      (service as any).cleanup();
      
      expect(channel.close).toHaveBeenCalled();
    });
  });
  
  describe('ngOnDestroy', () => {
    it('应调用 cleanup', () => {
      const cleanupSpy = vi.spyOn(service as any, 'cleanup');
      service.ngOnDestroy();
      
      expect(cleanupSpy).toHaveBeenCalled();
    });
  });
});
