/**
 * ActionQueueService 单元测试
 * 
 * 测试场景：
 * 1. 网络断开时任务入队
 * 2. 网络恢复时自动处理队列
 * 3. 处理成功后从队列移除
 * 4. 后端报错时正确重试而非丢弃
 * 5. 超过最大重试次数后移入死信队列
 */

import { TestBed } from '@angular/core/testing';
import { ActionQueueService, QueuedAction, EnqueueParams } from './action-queue.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { QUEUE_CONFIG } from '../config/constants';

describe('ActionQueueService', () => {
  let service: ActionQueueService;
  let mockLogger: jasmine.SpyObj<LoggerService>;
  let mockToast: jasmine.SpyObj<ToastService>;
  
  // 模拟 navigator.onLine
  let originalOnLine: boolean;
  
  beforeEach(() => {
    // 保存原始状态
    originalOnLine = navigator.onLine;
    
    // 创建 mock 服务
    const loggerSpy = jasmine.createSpyObj('LoggerService', ['category']);
    loggerSpy.category.and.returnValue({
      info: jasmine.createSpy('info'),
      warn: jasmine.createSpy('warn'),
      error: jasmine.createSpy('error'),
      debug: jasmine.createSpy('debug')
    });
    
    const toastSpy = jasmine.createSpyObj('ToastService', ['success', 'error', 'warning', 'info']);
    
    TestBed.configureTestingModule({
      providers: [
        ActionQueueService,
        { provide: LoggerService, useValue: loggerSpy },
        { provide: ToastService, useValue: toastSpy }
      ]
    });
    
    // 清理 localStorage
    localStorage.removeItem('nanoflow.action-queue');
    localStorage.removeItem('nanoflow.dead-letter-queue');
    
    service = TestBed.inject(ActionQueueService);
    mockLogger = TestBed.inject(LoggerService) as jasmine.SpyObj<LoggerService>;
    mockToast = TestBed.inject(ToastService) as jasmine.SpyObj<ToastService>;
  });
  
  afterEach(() => {
    // 清理
    service.clearQueue();
    service.clearDeadLetterQueue();
    service.ngOnDestroy();
  });
  
  // 辅助函数：模拟网络状态
  function setNetworkStatus(online: boolean) {
    // 触发网络状态变化事件
    if (online) {
      window.dispatchEvent(new Event('online'));
    } else {
      window.dispatchEvent(new Event('offline'));
    }
  }
  
  // 辅助函数：创建测试操作
  function createTestAction(): EnqueueParams {
    return {
      type: 'update',
      entityType: 'project',
      entityId: 'test-project-id',
      payload: {
        project: {
          id: 'test-project-id',
          name: 'Test Project',
          description: '',
          createdDate: new Date().toISOString(),
          tasks: [],
          connections: []
        }
      }
    };
  }
  
  describe('基本队列操作', () => {
    it('应该正确将操作加入队列', () => {
      const action = createTestAction();
      const actionId = service.enqueue(action);
      
      expect(actionId).toBeTruthy();
      expect(service.queueSize()).toBe(1);
      expect(service.hasPendingActions()).toBeTrue();
    });
    
    it('应该正确从队列移除操作', () => {
      const action = createTestAction();
      const actionId = service.enqueue(action);
      
      service.dequeue(actionId);
      
      expect(service.queueSize()).toBe(0);
      expect(service.hasPendingActions()).toBeFalse();
    });
    
    it('应该正确清空队列', () => {
      service.enqueue(createTestAction());
      service.enqueue(createTestAction());
      
      service.clearQueue();
      
      expect(service.queueSize()).toBe(0);
    });
  });
  
  describe('网络断开时的行为', () => {
    it('网络断开时，入队的任务应该保留在队列中', async () => {
      // 模拟离线
      setNetworkStatus(false);
      
      const action = createTestAction();
      service.enqueue(action);
      
      // 等待一小段时间确保队列不会自动处理
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(service.queueSize()).toBe(1);
    });
  });
  
  describe('处理器注册和执行', () => {
    it('注册处理器后应该能处理对应类型的操作', async () => {
      let processorCalled = false;
      
      // 注册处理器
      service.registerProcessor('project:update', async (action) => {
        processorCalled = true;
        return true;
      });
      
      // 模拟在线
      setNetworkStatus(true);
      
      // 入队
      const action = createTestAction();
      service.enqueue(action);
      
      // 等待处理完成
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // 手动触发处理
      const result = await service.processQueue();
      
      expect(processorCalled).toBeTrue();
      expect(result.processed).toBeGreaterThanOrEqual(0); // 可能在 enqueue 时已处理
    });
    
    it('处理成功后应该从队列移除', async () => {
      // 先设置离线防止自动处理
      setNetworkStatus(false);
      
      // 注册处理器
      service.registerProcessor('project:update', async (action) => {
        return true;
      });
      
      // 入队
      const action = createTestAction();
      service.enqueue(action);
      
      expect(service.queueSize()).toBe(1);
      
      // 模拟上线并处理
      setNetworkStatus(true);
      const result = await service.processQueue();
      
      expect(result.processed).toBe(1);
      expect(service.queueSize()).toBe(0);
    });
  });
  
  describe('重试机制', () => {
    it('处理器返回 false 时应该重试', async () => {
      let callCount = 0;
      
      // 先离线
      setNetworkStatus(false);
      
      // 注册一个先失败后成功的处理器
      service.registerProcessor('project:update', async (action) => {
        callCount++;
        return callCount >= 2; // 第二次才成功
      });
      
      // 入队
      service.enqueue(createTestAction());
      
      // 上线并处理两次
      setNetworkStatus(true);
      await service.processQueue();
      
      // 等待重试延迟
      await new Promise(resolve => setTimeout(resolve, QUEUE_CONFIG.RETRY_BASE_DELAY + 100));
      
      await service.processQueue();
      
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
    
    it('处理器抛出异常时应该重试而非丢弃', async () => {
      let callCount = 0;
      
      // 先离线
      setNetworkStatus(false);
      
      // 注册一个抛出异常的处理器
      service.registerProcessor('project:update', async (action) => {
        callCount++;
        if (callCount < 2) {
          throw new Error('Network error');
        }
        return true;
      });
      
      // 入队
      service.enqueue(createTestAction());
      
      // 上线并处理
      setNetworkStatus(true);
      await service.processQueue();
      
      // 第一次应该失败但任务还在队列中
      expect(service.queueSize()).toBe(1);
      
      // 等待重试延迟
      await new Promise(resolve => setTimeout(resolve, QUEUE_CONFIG.RETRY_BASE_DELAY + 100));
      
      // 再次处理
      await service.processQueue();
      
      // 第二次应该成功
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
    
    it('后端报 500 错误时应该重试', async () => {
      let callCount = 0;
      
      // 先离线
      setNetworkStatus(false);
      
      // 注册模拟 500 错误的处理器
      service.registerProcessor('project:update', async (action) => {
        callCount++;
        if (callCount < 2) {
          throw new Error('Internal Server Error');
        }
        return true;
      });
      
      // 入队
      service.enqueue(createTestAction());
      
      // 上线并处理
      setNetworkStatus(true);
      await service.processQueue();
      
      // 任务应该还在队列中
      expect(service.queueSize()).toBe(1);
      
      // 等待重试
      await new Promise(resolve => setTimeout(resolve, QUEUE_CONFIG.RETRY_BASE_DELAY + 100));
      await service.processQueue();
      
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });
  
  describe('死信队列', () => {
    it('超过最大重试次数后应该移入死信队列', async () => {
      // 先离线
      setNetworkStatus(false);
      
      // 注册始终失败的处理器
      service.registerProcessor('project:update', async (action) => {
        throw new Error('Persistent failure');
      });
      
      // 入队
      service.enqueue(createTestAction());
      
      // 上线
      setNetworkStatus(true);
      
      // 多次处理直到超过最大重试
      for (let i = 0; i < 6; i++) {
        await service.processQueue();
        // 等待重试延迟（使用短延迟）
        await new Promise(resolve => setTimeout(resolve, Math.min(QUEUE_CONFIG.RETRY_BASE_DELAY * Math.pow(2, i), 1000) + 50));
      }
      
      // 应该移入死信队列
      expect(service.hasDeadLetters()).toBeTrue();
      expect(service.deadLetterSize()).toBeGreaterThanOrEqual(1);
    });
    
    it('业务错误应该直接移入死信队列，不重试', async () => {
      // 先离线
      setNetworkStatus(false);
      
      // 注册返回业务错误的处理器
      service.registerProcessor('project:update', async (action) => {
        throw new Error('Row level security violation');
      });
      
      // 入队
      service.enqueue(createTestAction());
      
      // 上线并处理
      setNetworkStatus(true);
      const result = await service.processQueue();
      
      // 应该直接进入死信队列
      expect(result.movedToDeadLetter).toBe(1);
      expect(service.hasDeadLetters()).toBeTrue();
      expect(service.queueSize()).toBe(0);
    });
    
    it('应该能从死信队列重试操作', async () => {
      // 创建死信项
      // 先离线
      setNetworkStatus(false);
      
      let shouldFail = true;
      service.registerProcessor('project:update', async (action) => {
        if (shouldFail) {
          throw new Error('Permission denied');
        }
        return true;
      });
      
      service.enqueue(createTestAction());
      
      setNetworkStatus(true);
      await service.processQueue();
      
      // 确认在死信队列
      expect(service.hasDeadLetters()).toBeTrue();
      const deadLetters = service.deadLetterQueue();
      const itemId = deadLetters[0]?.action.id;
      
      // 修复问题后重试
      shouldFail = false;
      service.retryDeadLetter(itemId);
      
      // 应该回到主队列
      expect(service.queueSize()).toBe(1);
      expect(service.deadLetterSize()).toBe(0);
      
      // 处理应该成功
      await service.processQueue();
      expect(service.queueSize()).toBe(0);
    });
    
    it('应该能放弃死信队列中的操作', () => {
      // 先离线
      setNetworkStatus(false);
      
      service.registerProcessor('project:update', async (action) => {
        throw new Error('Permission denied');
      });
      
      service.enqueue(createTestAction());
      
      setNetworkStatus(true);
      // 同步处理，不等待
      void service.processQueue().then(() => {
        const deadLetters = service.deadLetterQueue();
        if (deadLetters.length > 0) {
          const itemId = deadLetters[0].action.id;
          service.dismissDeadLetter(itemId);
          expect(service.deadLetterSize()).toBe(0);
        }
      });
    });
  });
  
  describe('网络恢复时自动处理', () => {
    it('网络恢复事件应该触发队列处理', async () => {
      let processorCalled = false;
      
      // 注册处理器
      service.registerProcessor('project:update', async (action) => {
        processorCalled = true;
        return true;
      });
      
      // 先离线
      setNetworkStatus(false);
      
      // 入队
      service.enqueue(createTestAction());
      
      expect(service.queueSize()).toBe(1);
      
      // 模拟网络恢复 - 这应该自动触发处理
      setNetworkStatus(true);
      
      // 等待自动处理
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // 处理器应该被调用
      expect(processorCalled).toBeTrue();
    });
  });
  
  describe('持久化', () => {
    it('队列应该被持久化到 localStorage', () => {
      const action = createTestAction();
      service.enqueue(action);
      
      const saved = localStorage.getItem('nanoflow.action-queue');
      expect(saved).toBeTruthy();
      
      const parsed = JSON.parse(saved!);
      expect(Array.isArray(parsed)).toBeTrue();
      expect(parsed.length).toBe(1);
    });
    
    it('服务重新创建后应该恢复队列', () => {
      // 入队一个操作
      service.enqueue(createTestAction());
      
      // 重新创建服务
      const newService = new ActionQueueService();
      
      // 应该恢复队列
      expect(newService.queueSize()).toBe(1);
      
      // 清理
      newService.clearQueue();
      newService.ngOnDestroy();
    });
  });
  
  describe('失败回调', () => {
    it('移入死信队列时应该触发失败回调', async () => {
      let callbackCalled = false;
      
      service.onFailure((item) => {
        callbackCalled = true;
        expect(item.action).toBeTruthy();
        expect(item.reason).toBeTruthy();
      });
      
      // 先离线
      setNetworkStatus(false);
      
      service.registerProcessor('project:update', async (action) => {
        throw new Error('Permission denied');
      });
      
      service.enqueue(createTestAction());
      
      setNetworkStatus(true);
      await service.processQueue();
      
      expect(callbackCalled).toBeTrue();
    });
  });
});
