/**
 * FlowViewComponent - selectNodeWithRetry 单元测试
 * 
 * 测试节点选中重试逻辑：
 * - 节点存在时立即选中
 * - 节点不存在时重试
 * - 达到最大重试次数后停止并记录警告
 * - 组件销毁时中止重试
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('FlowViewComponent - selectNodeWithRetry', () => {
  // 模拟 FlowViewComponent 中 selectNodeWithRetry 的核心逻辑
  // 使用独立函数进行测试，避免复杂的组件初始化
  
  interface MockDiagram {
    findNodeForKey: (key: string) => object | null;
    selectNode: (key: string) => void;
  }
  
  interface MockLogger {
    debug: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  }
  
  interface TestContext {
    isDestroyed: boolean;
    diagram: MockDiagram | null;
    logger: MockLogger;
    pendingRetryRafIds: number[];
    pendingTimers: ReturnType<typeof setTimeout>[];
  }
  
  const MAX_RETRIES = 5;
  const RETRY_DELAYS = [0, 16, 50, 100, 200];
  const fallbackRequestAnimationFrame: typeof globalThis.requestAnimationFrame =
    (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
  const fallbackCancelAnimationFrame: typeof globalThis.cancelAnimationFrame =
    (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  
  let ctx: TestContext;
  let selectNodeCalls: string[];
  let warnCalls: { message: string; data: unknown }[];
  let debugCalls: { message: string; data: unknown }[];
  let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
  let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;
  
  // 模拟 scheduleTimer 函数
  const scheduleTimer = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const timerId = setTimeout(() => {
      const index = ctx.pendingTimers.indexOf(timerId);
      if (index > -1) ctx.pendingTimers.splice(index, 1);
      if (ctx.isDestroyed) return;
      callback();
    }, delay);
    ctx.pendingTimers.push(timerId);
    return timerId;
  };
  
  // 核心 selectNodeWithRetry 逻辑（从组件中提取）
  const selectNodeWithRetry = (taskId: string, retryCount = 0): void => {
    if (ctx.isDestroyed) return;
    
    if (!ctx.diagram) return;
    
    const node = ctx.diagram.findNodeForKey(taskId);
    if (node) {
      ctx.diagram.selectNode(taskId);
      selectNodeCalls.push(taskId);
      return;
    }
    
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_DELAYS[retryCount] ?? 200;
      ctx.logger.debug('节点选中重试', { taskId, retryCount, delay });
      debugCalls.push({ message: '节点选中重试', data: { taskId, retryCount, delay } });
      
      if (delay === 0) {
        // 使用 rAF（在测试中用 setTimeout 0 模拟）
        const rafId = requestAnimationFrame(() => {
          const idx = ctx.pendingRetryRafIds.indexOf(rafId);
          if (idx > -1) ctx.pendingRetryRafIds.splice(idx, 1);
          if (ctx.isDestroyed) return;
          selectNodeWithRetry(taskId, retryCount + 1);
        });
        ctx.pendingRetryRafIds.push(rafId);
      } else {
        scheduleTimer(() => {
          selectNodeWithRetry(taskId, retryCount + 1);
        }, delay);
      }
    } else {
      ctx.logger.warn('节点选中失败：节点不存在（已重试 ' + MAX_RETRIES + ' 次）', { taskId });
      warnCalls.push({ 
        message: '节点选中失败：节点不存在（已重试 ' + MAX_RETRIES + ' 次）', 
        data: { taskId } 
      });
    }
  };
  
  // 清理函数
  const cleanup = (): void => {
    ctx.isDestroyed = true;
    ctx.pendingTimers.forEach(clearTimeout);
    ctx.pendingTimers = [];
    ctx.pendingRetryRafIds.forEach(id => cancelAnimationFrame(id));
    ctx.pendingRetryRafIds = [];
  };
  
  beforeEach(() => {
    vi.useFakeTimers();
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = fallbackRequestAnimationFrame;
    globalThis.cancelAnimationFrame = fallbackCancelAnimationFrame;
    selectNodeCalls = [];
    warnCalls = [];
    debugCalls = [];
    
    ctx = {
      isDestroyed: false,
      diagram: {
        findNodeForKey: vi.fn().mockReturnValue(null),
        selectNode: vi.fn(),
      },
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
      pendingRetryRafIds: [],
      pendingTimers: [],
    };
  });
  
  afterEach(() => {
    cleanup();
    if (typeof vi.clearAllTimers === 'function') {
      vi.clearAllTimers();
    }
    vi.useRealTimers();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame ?? fallbackRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame ?? fallbackCancelAnimationFrame;
  });
  
  describe('节点存在时', () => {
    it('应该立即选中节点，不进行重试', () => {
      // 节点存在
      ctx.diagram!.findNodeForKey = vi.fn().mockReturnValue({ key: 'task-1' });
      
      selectNodeWithRetry('task-1');
      
      expect(selectNodeCalls).toEqual(['task-1']);
      expect(debugCalls).toHaveLength(0);
      expect(warnCalls).toHaveLength(0);
    });
  });
  
  describe('节点不存在时', () => {
    it('应该按渐进延迟进行重试', async () => {
      // 节点始终不存在
      ctx.diagram!.findNodeForKey = vi.fn().mockReturnValue(null);
      
      selectNodeWithRetry('task-1');
      
      // 第一次重试（delay=0，使用 rAF）
      expect(debugCalls).toHaveLength(1);
      expect(debugCalls[0].data).toEqual({ taskId: 'task-1', retryCount: 0, delay: 0 });
      
      // 推进所有定时器
      await vi.runAllTimersAsync();
      
      // 应该尝试了所有重试
      expect(debugCalls).toHaveLength(MAX_RETRIES);
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0].data).toEqual({ taskId: 'task-1' });
    });
    
    it('节点在第 3 次重试时出现，应该停止重试并选中', async () => {
      let callCount = 0;
      ctx.diagram!.findNodeForKey = vi.fn().mockImplementation(() => {
        callCount++;
        // 第 4 次调用时（重试 3 次后）返回节点
        return callCount >= 4 ? { key: 'task-1' } : null;
      });
      
      selectNodeWithRetry('task-1');
      
      // 推进所有定时器
      await vi.runAllTimersAsync();
      
      // 应该成功选中
      expect(selectNodeCalls).toEqual(['task-1']);
      // 应该有 3 次重试日志（retryCount 0, 1, 2）
      expect(debugCalls).toHaveLength(3);
      // 不应该有警告
      expect(warnCalls).toHaveLength(0);
    });
  });
  
  describe('达到最大重试次数时', () => {
    it('应该记录警告并停止', async () => {
      ctx.diagram!.findNodeForKey = vi.fn().mockReturnValue(null);
      
      selectNodeWithRetry('task-1');
      
      // 推进所有定时器
      await vi.runAllTimersAsync();
      
      // 应该记录警告
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0].message).toContain('节点选中失败');
      expect(warnCalls[0].data).toEqual({ taskId: 'task-1' });
      
      // 不应该有选中调用
      expect(selectNodeCalls).toHaveLength(0);
    });
  });
  
  describe('组件销毁时', () => {
    it('应该中止所有待处理的重试', async () => {
      ctx.diagram!.findNodeForKey = vi.fn().mockReturnValue(null);
      
      selectNodeWithRetry('task-1');
      
      // 第一次重试已调度
      expect(debugCalls).toHaveLength(1);
      
      // 模拟组件销毁
      cleanup();
      
      // 推进所有定时器
      await vi.runAllTimersAsync();
      
      // 由于销毁，不应该有更多重试
      expect(debugCalls).toHaveLength(1);
      expect(warnCalls).toHaveLength(0);
    });
    
    it('销毁时应该取消所有追踪的 rAF', () => {
      ctx.diagram!.findNodeForKey = vi.fn().mockReturnValue(null);
      
      selectNodeWithRetry('task-1');
      
      // 应该有一个 rAF 被追踪
      expect(ctx.pendingRetryRafIds.length).toBe(1);
      
      // 模拟组件销毁
      cleanup();
      
      // rAF 列表应该被清空
      expect(ctx.pendingRetryRafIds.length).toBe(0);
    });
  });
  
  describe('边界条件', () => {
    it('diagram 为 null 时应该直接返回', () => {
      ctx.diagram = null;
      
      selectNodeWithRetry('task-1');
      
      expect(selectNodeCalls).toHaveLength(0);
      expect(debugCalls).toHaveLength(0);
      expect(warnCalls).toHaveLength(0);
    });
    
    it('已销毁时应该直接返回', () => {
      ctx.isDestroyed = true;
      
      selectNodeWithRetry('task-1');
      
      expect(selectNodeCalls).toHaveLength(0);
      expect(debugCalls).toHaveLength(0);
      expect(warnCalls).toHaveLength(0);
    });
  });
});
