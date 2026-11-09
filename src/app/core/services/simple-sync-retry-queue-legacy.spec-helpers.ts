import { describe, expect, it, vi } from 'vitest';
import type { SimpleSyncService } from './simple-sync.service';
import { createMockTask, type RetryQueueItem } from './simple-sync.test-harness';

export interface SimpleSyncRetryQueueLegacySpecContext {
  service(): SimpleSyncService;
  mockRetryQueueService(): any;
  mockToast(): any;
  mockLoggerCategory(): any;
  mockCaptureMessage(): any;
}

export function registerSimpleSyncRetryQueueLegacySpecs(
  context: SimpleSyncRetryQueueLegacySpecContext,
): void {
  let service: SimpleSyncService;
  let mockRetryQueueService: any;
  let mockToast: any;
  let mockLoggerCategory: any;
  let mockSentryLazyLoaderService: { captureMessage: any };

  function loadContext(): void {
    service = context.service();
    mockRetryQueueService = context.mockRetryQueueService();
    mockToast = context.mockToast();
    mockLoggerCategory = context.mockLoggerCategory();
    mockSentryLazyLoaderService = { captureMessage: context.mockCaptureMessage() };
  }

  describe.skip('队列容量警告节流', () => {
    it('checkQueueCapacityWarning 应该有 5 分钟冷却时间', () => {
      // 验证冷却时间配置存在（修复：从 60s 增加到 5 分钟）
      expect(mockRetryQueueService.WARNING_COOLDOWN).toBe(300_000);
    });

    it('低于阈值时不应该显示警告', async () => {
      // 添加少量任务（低于 80% 阈值）
      for (let i = 0; i < 70; i++) {
        const task = createMockTask({ id: `task-${i}` });
        await service.pushTask(task, 'project-1');
      }

      // 手动调用容量检查
      mockRetryQueueService.checkCapacityWarning();

      // 不应该显示错误 Toast
      expect(mockToast.error).not.toHaveBeenCalled();
    });

    it('达到阈值时应该显示警告（首次）', async () => {
      // 重置 Toast mock
      mockToast.error.mockClear();

      // 模拟队列达到 80% 容量
      mockRetryQueueService.queue = Array.from({ length: 85 }, (_, i) => ({
        id: `item-${i}`,
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask({ id: `task-${i}` }),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }));

      // 调用容量检查
      mockRetryQueueService.checkCapacityWarning();

      // 应该显示警告
      expect(mockToast.error).toHaveBeenCalledWith(
        '⚠️ 同步队列即将满载',
        '请连接网络以防止数据丢失',
        { duration: 30_000 }
      );
    });

    it('冷却时间内不应该重复显示警告', async () => {
      // 使用 fake timers
      vi.useFakeTimers();

      // 重置状态
      mockToast.error.mockClear();
      mockRetryQueueService.lastWarningTime = 0;
      mockRetryQueueService.lastWarningPercent = 0;

      // 模拟队列达到阈值
      mockRetryQueueService.queue = Array.from({ length: 85 }, (_, i) => ({
        id: `item-${i}`,
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask({ id: `task-${i}` }),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }));

      // 第一次调用 - 应该显示
      mockRetryQueueService.checkCapacityWarning();
      expect(mockToast.error).toHaveBeenCalledTimes(1);

      // 立即再次调用 - 应该被节流跳过
      mockRetryQueueService.checkCapacityWarning();
      expect(mockToast.error).toHaveBeenCalledTimes(1);

      // 2 分钟后调用 - 仍在冷却期内（冷却时间是 5 分钟）
      vi.advanceTimersByTime(120_000);
      mockRetryQueueService.checkCapacityWarning();
      expect(mockToast.error).toHaveBeenCalledTimes(1);

      // 5 分钟后调用 - 冷却结束，应该再次显示
      vi.advanceTimersByTime(180_000 + 1000); // 再过 3 分钟 + 1 秒 = 总共 5 分 1 秒
      mockRetryQueueService.checkCapacityWarning();
      expect(mockToast.error).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('情况恶化时应该记录 Sentry 警告（绕过冷却）', async () => {
      // 使用 fake timers
      vi.useFakeTimers();

      // 重置状态
      mockToast.error.mockClear();
      mockSentryLazyLoaderService.captureMessage.mockClear();
      mockRetryQueueService.lastWarningTime = Date.now();
      mockRetryQueueService.lastWarningPercent = 85; // 上次警告时是 85%

      // 模拟队列情况恶化到 96%（增加超过 10%）
      mockRetryQueueService.queue = Array.from({ length: 96 }, (_, i) => ({
        id: `item-${i}`,
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask({ id: `task-${i}` }),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }));

      // 调用容量检查
      mockRetryQueueService.checkCapacityWarning();

      // 情况恶化时应该记录 Sentry（即使在冷却期内）
      expect(mockSentryLazyLoaderService.captureMessage).toHaveBeenCalledWith(
        'RetryQueue capacity warning',
        expect.objectContaining({
          level: 'warning',
          tags: expect.objectContaining({
            percentUsed: '96'
          })
        })
      );

      // Toast 只在冷却时间过后显示（减少用户打扰）
      // 在冷却期内情况恶化时不显示 Toast
      expect(mockToast.error).toHaveBeenCalledTimes(0);

      vi.useRealTimers();
    });

    it('恢复正常后应该重置警告状态', async () => {
      // 设置上次警告状态
      mockRetryQueueService.lastWarningPercent = 85;

      // 模拟队列恢复正常（低于阈值）
      mockRetryQueueService.queue = Array.from({ length: 50 }, (_, i) => ({
        id: `item-${i}`,
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask({ id: `task-${i}` }),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }));

      // 调用容量检查
      mockRetryQueueService.checkCapacityWarning();

      // 验证状态被重置
      expect(mockRetryQueueService.lastWarningPercent).toBe(0);

      // 验证记录了恢复日志
      expect(mockLoggerCategory.info).toHaveBeenCalledWith(
        'RetryQueue 容量恢复正常',
        expect.objectContaining({ currentSize: 50 })
      );
    });

    it('队列满载时应该记录诊断信息', () => {
      // 重置状态
      mockToast.error.mockClear();
      mockLoggerCategory.warn.mockClear();
      mockRetryQueueService.lastWarningTime = 0;
      mockRetryQueueService.lastWarningPercent = 0;

      // 设置离线状态（防止触发 processRetryQueue 清空队列）
      service['syncStateService'].update({ isOnline: false, sessionExpired: false });

      // 模拟队列达到 85%（高于阈值但低于 90%，避免触发强制处理）
      mockRetryQueueService.queue = Array.from({ length: 85 }, (_, i) => ({
        id: `item-${i}`,
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask({ id: `task-${i}` }),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }));

      // 调用容量检查
      mockRetryQueueService.checkCapacityWarning();

      // 验证记录了队列容量警告日志（包含诊断信息）
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        'RetryQueue 容量警告',
        expect.objectContaining({
          currentSize: 85,
          maxSize: 100,
          percentUsed: 85,
          isOnline: false,
          isSyncing: expect.any(Boolean),
          circuitState: expect.any(String),
          retryQueueTypes: expect.objectContaining({
            task: 85,
            project: 0,
            connection: 0
          })
        })
      );
    });

    it('队列阻塞且 isSyncing 时应该强制重置 isSyncing', () => {
      // 重置状态
      mockLoggerCategory.warn.mockClear();
      mockRetryQueueService.lastWarningTime = 0;
      mockRetryQueueService.lastWarningPercent = 0;

      // Mock processRetryQueue 以防止它修改 isSyncing 状态
      const processRetryQueueSpy = vi.spyOn(service as unknown as { processRetryQueue: () => Promise<void> }, 'processRetryQueue').mockImplementation(() => Promise.resolve());

      // 模拟 isSyncing 卡住的状态（通过 syncState signal 设置）
      // 【修复 2026-02-02】新增 isProcessingQueue 为 false，模拟状态不一致情况
      service['syncStateService'].update({ isOnline: true, sessionExpired: false, isSyncing: true });
      mockRetryQueueService.isProcessingQueue = false; // 状态不一致：isSyncing=true 但 isProcessingQueue=false

      // 模拟队列达到 90%+ 容量
      mockRetryQueueService.queue = Array.from({ length: 92 }, (_, i) => ({
        id: `item-${i}`,
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask({ id: `task-${i}` }),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }));

      // 调用容量检查
      mockRetryQueueService.checkCapacityWarning();

      // 【修复 2026-02-02】验证记录了 isSyncing 状态不一致警告
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        'isSyncing 状态不一致，重置',
        expect.objectContaining({ percentUsed: 92 })
      );

      // 验证 isSyncing 被重置
      expect(service['syncState']().isSyncing).toBe(false);

      // 验证 processRetryQueue 被调用（强制处理尝试）
      expect(processRetryQueueSpy).toHaveBeenCalled();

      // 恢复 spy
      processRetryQueueSpy.mockRestore();
    });

    it('getQueueTypeBreakdown 应该正确统计队列类型', () => {
      // 模拟混合类型队列
      mockRetryQueueService.queue = [
        { id: '1', type: 'task' as const, operation: 'upsert' as const, data: { id: 't1' }, projectId: 'p1', retryCount: 0, createdAt: Date.now() },
        { id: '2', type: 'task' as const, operation: 'upsert' as const, data: { id: 't2' }, projectId: 'p1', retryCount: 0, createdAt: Date.now() },
        { id: '3', type: 'project' as const, operation: 'upsert' as const, data: { id: 'p1' }, retryCount: 0, createdAt: Date.now() },
        { id: '4', type: 'connection' as const, operation: 'upsert' as const, data: { id: 'c1' }, projectId: 'p1', retryCount: 0, createdAt: Date.now() },
      ] as unknown as RetryQueueItem[];

      const breakdown = mockRetryQueueService.getTypeBreakdown();

      expect(breakdown).toEqual({
        task: 2,
        project: 1,
        connection: 1
      });
    });
  });

  // ==================== P0 修复：Session Expired 阻止队列溢出 ====================
  // 【技术债务重构】此测试组部分测试依赖于子服务内部行为，需要重新设计
  describe.skip('【P0 修复】Session Expired 导致队列溢出', () => {

    it('addToRetryQueue 应在 sessionExpired 时跳过添加', () => {
      // 设置会话过期状态
      service['syncStateService'].update({ sessionExpired: true });

      const initialQueueLength = mockRetryQueueService.queue.length;
      const task = createMockTask();

      // 尝试添加到重试队列
      service.addToRetryQueue('task', 'upsert', task, 'project-1');

      // 验证队列长度未变化
      expect(mockRetryQueueService.queue.length).toBe(initialQueueLength);

      // 验证记录了跳过日志
      expect(mockLoggerCategory.debug).toHaveBeenCalledWith(
        '会话已过期，跳过添加到重试队列',
        expect.objectContaining({ type: 'task', dataId: task.id })
      );
    });

    it('addToRetryQueue 应在会话正常时正常添加', () => {
      // 确保会话正常
      service['syncStateService'].update({ sessionExpired: false });

      const initialQueueLength = mockRetryQueueService.queue.length;
      const task = createMockTask({ id: 'new-task-for-queue' });

      // 添加到重试队列
      service.addToRetryQueue('task', 'upsert', task, 'project-1');

      // 验证队列长度增加
      expect(mockRetryQueueService.queue.length).toBe(initialQueueLength + 1);
    });

    it('resetSessionExpired 应正确重置会话状态', () => {
      // 设置会话过期状态
      service['syncStateService'].update({ sessionExpired: true });

      // 添加一些队列项
      mockRetryQueueService.queue = [{
        id: 'test-item',
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask(),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }];

      // 调用重置方法
      service.resetSessionExpired();

      // 验证会话状态被重置
      expect(service.syncState().sessionExpired).toBe(false);

      // 验证记录了恢复日志
      expect(mockLoggerCategory.info).toHaveBeenCalledWith(
        '会话状态已重置',
        expect.objectContaining({ previousQueueLength: 1 })
      );
    });

    it('resetSessionExpired 应在会话未过期时不做任何操作', () => {
      // 确保会话正常
      service['syncStateService'].update({ sessionExpired: false });

      // 清空日志 mock
      mockLoggerCategory.info.mockClear();

      // 调用重置方法
      service.resetSessionExpired();

      // 验证没有记录日志（因为没有需要重置的状态）
      expect(mockLoggerCategory.info).not.toHaveBeenCalledWith(
        '会话状态已重置',
        expect.anything()
      );
    });

    it('startRetryLoop 应在 sessionExpired 时跳过处理', async () => {
      vi.useFakeTimers();

      // 设置会话过期状态
      service['syncStateService'].update({ sessionExpired: true, isOnline: true });

      // 添加队列项
      mockRetryQueueService.queue = [{
        id: 'test-item',
        type: 'task' as const,
        operation: 'upsert' as const,
        data: createMockTask(),
        projectId: 'project-1',
        retryCount: 0,
        createdAt: Date.now()
      }];

      // 创建 processRetryQueue spy
      const processRetryQueueSpy = vi.spyOn(service as unknown as { processRetryQueue: () => Promise<void> }, 'processRetryQueue');

      // 前进一个重试间隔
      vi.advanceTimersByTime(5000);

      // 验证 processRetryQueue 没有被调用（因为 sessionExpired 在 setInterval 回调中被检查）
      // 注意：实际上 processRetryQueue 可能被调用，但它会立即返回
      // 我们验证队列项没有被处理（retryCount 没有增加）
      const queueItem = mockRetryQueueService.queue[0];
      expect(queueItem.retryCount).toBe(0);

      vi.useRealTimers();
    });
  });
}
