import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Injector } from '@angular/core';
import { RealtimePollingService } from './realtime-polling.service';
import { RealtimeTransportCircuitService } from './realtime-transport-circuit.service';
import {
  createRealtimePollingSpecEnvironment,
  REALTIME_CIRCUIT_STORAGE_KEY,
  readLatestRealtimeStatusCallback,
  setVisibilityState,
  type RealtimePollingHarness,
} from './realtime-polling.service.spec-helpers';

const realtimeSpec = createRealtimePollingSpecEnvironment();
const {
  strategySignal,
  mockChannel,
  mockClient,
  mockSupabase,
  mockLogger,
  mockSyncStateService,
  mockSentryLazyLoaderService,
} = realtimeSpec;

describe('RealtimePollingService', () => {
  let service: RealtimePollingService;
  let injector: Injector;

  beforeEach(() => {
    ({ service, injector } = realtimeSpec.setup());
  });

  afterEach(() => {
    realtimeSpec.teardown();
  });

  it('应跟随移动端同步策略切换 Realtime 开关', async () => {
    expect(service.isRealtimeEnabled()).toBe(true);

    strategySignal.set({ enableRealtime: false });
    await vi.waitFor(() => {
      expect(service.isRealtimeEnabled()).toBe(false);
    });

    strategySignal.set({ enableRealtime: true });
    await vi.waitFor(() => {
      expect(service.isRealtimeEnabled()).toBe(true);
    });
  });

  it('策略变化时应重新配置当前项目的传输方式', async () => {
    const startPollingSpy = vi.spyOn(
      service as unknown as { startPolling: (projectId: string, userId: string | null, transportGeneration: number) => void },
      'startPolling'
    );

    await service.subscribeToProject('project-1', 'user-123');
    expect(service.getCurrentProjectId()).toBe('project-1');

    strategySignal.set({ enableRealtime: false });

    await vi.waitFor(() => {
      expect(service.isRealtimeEnabled()).toBe(false);
      expect(mockClient.removeChannel).toHaveBeenCalled();
      expect(startPollingSpy).toHaveBeenCalled();
      expect(service.getCurrentProjectId()).toBe('project-1');
    });
  });

  it('同值启用 realtime 时不应重复重建当前项目传输', async () => {
    await service.subscribeToProject('project-1', 'user-123');
    expect(service.isRealtimeEnabled()).toBe(true);
    expect(service.getCurrentProjectId()).toBe('project-1');

    mockClient.channel.mockClear();
    mockClient.removeChannel.mockClear();
    mockChannel.unsubscribe.mockClear();

    service.setRealtimeEnabled(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockClient.removeChannel).not.toHaveBeenCalled();
    expect(mockChannel.unsubscribe).not.toHaveBeenCalled();
    expect(mockClient.channel).not.toHaveBeenCalled();
    expect(service.getCurrentProjectId()).toBe('project-1');
  });

  it('DestroyRef 销毁后晚到订阅不应重新激活传输', async () => {
    await service.subscribeToProject('project-before-destroy', 'user-before-destroy');
    expect(service.getCurrentProjectId()).toBe('project-before-destroy');

    realtimeSpec.destroyRealtimePollingService(injector);
    const channelCallsAfterDestroy = mockClient.channel.mock.calls.length;

    await service.subscribeToProject('project-after-destroy', 'user-after-destroy');

    expect(mockClient.channel).toHaveBeenCalledTimes(channelCallsAfterDestroy);
    expect(service.getCurrentProjectId()).toBeNull();
  });

  it('DestroyRef 销毁时无法取得 Supabase client 仍应兜底取消旧 Realtime channel', async () => {
    await service.subscribeToProject('project-before-client-failure', 'user-before-client-failure');
    mockSupabase.client.mockImplementation(() => {
      throw new Error('client unavailable during teardown');
    });

    realtimeSpec.destroyRealtimePollingService(injector);

    expect(mockClient.removeChannel).not.toHaveBeenCalledWith(mockChannel);
    expect(mockChannel.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('DestroyRef 销毁时 removeChannel 同步抛错不应打断清理', async () => {
    await service.subscribeToProject('project-before-sync-remove-failure', 'user-before-sync-remove-failure');
    const removeError = new Error('remove channel sync failure');
    mockClient.removeChannel.mockImplementationOnce(() => {
      throw removeError;
    });

    expect(() => realtimeSpec.destroyRealtimePollingService(injector)).not.toThrow();

    expect(mockClient.removeChannel).toHaveBeenCalledWith(mockChannel);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      '清理时移除 Realtime 通道失败',
      expect.objectContaining({ error: removeError }),
    );
  });

  it('DestroyRef 销毁后晚到立即同步触发不应调用远程回调', async () => {
    const onRemoteChange = vi.fn().mockResolvedValue(undefined);
    service.setOnRemoteChange(onRemoteChange);

    realtimeSpec.destroyRealtimePollingService(injector);

    await expect(service.triggerRemoteChange({
      eventType: 'late-resume',
      projectId: 'project-after-destroy',
    })).resolves.toBe(false);

    expect(onRemoteChange).not.toHaveBeenCalled();
  });

  it('传输切换期间若旧订阅已 teardown，不应重新挂回旧项目', async () => {
    const startPollingSpy = vi.spyOn(
      service as unknown as { startPolling: (projectId: string, userId: string | null, transportGeneration: number) => void },
      'startPolling'
    );

    await service.subscribeToProject('project-1', 'user-123');

    let resolveRemoveChannel: (() => void) | null = null;
    mockClient.removeChannel.mockImplementationOnce(() => new Promise<void>(resolve => {
      resolveRemoveChannel = resolve;
    }));

    service.setRealtimeEnabled(false);
    await Promise.resolve();

    await service.unsubscribeFromProject();
    resolveRemoveChannel!();
    await Promise.resolve();
    await Promise.resolve();

    expect(startPollingSpy).not.toHaveBeenCalled();
    expect(service.getCurrentProjectId()).toBeNull();
  });

  it('旧通道移除失败时仍应重新激活当前项目传输', async () => {
    await service.subscribeToProject('project-old', 'user-123');
    const removeError = new Error('remove stale channel failed');
    mockClient.removeChannel.mockRejectedValueOnce(removeError);

    await expect(service.subscribeToProject('project-new', 'user-123')).resolves.toBeUndefined();

    expect(mockClient.removeChannel).toHaveBeenCalledWith(mockChannel);
    expect(mockClient.channel).toHaveBeenCalledTimes(2);
    expect(service.getCurrentProjectId()).toBe('project-new');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Realtime 旧通道移除失败，继续切换传输',
      expect.objectContaining({ error: removeError }),
    );
  });

  it('挂起传输后应保留项目上下文，并在恢复时重新激活', async () => {
    await service.subscribeToProject('project-1', 'user-123');
    expect(service.getCurrentProjectId()).toBe('project-1');
    expect(mockClient.channel).toHaveBeenCalledTimes(1);

    await service.suspendTransport();
    expect(mockClient.removeChannel).toHaveBeenCalledTimes(1);
    expect(service.getCurrentProjectId()).toBe('project-1');

    await service.resumeTransport();
    expect(mockClient.channel).toHaveBeenCalledTimes(2);
    expect(service.getCurrentProjectId()).toBe('project-1');
  });

  it('挂起期间切换 Realtime 开关不应恢复远端传输或清除挂起状态', async () => {
    const internals = service as unknown as RealtimePollingHarness;
    await service.subscribeToProject('project-suspended-toggle', 'user-suspended-toggle');
    expect(mockClient.channel).toHaveBeenCalledTimes(1);

    await service.suspendTransport();
    expect(internals.transportSuspended).toBe(true);

    service.setRealtimeEnabled(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockClient.channel).toHaveBeenCalledTimes(1);
    expect(internals.transportSuspended).toBe(true);
    expect(service.getCurrentProjectId()).toBe('project-suspended-toggle');
  });

  it('离线态订阅后恢复时应自动重新激活传输', async () => {
    mockSyncStateService.syncState.set({ isOnline: true, offlineMode: true });

    await service.subscribeToProject('project-2', 'user-456');

    expect(service.getCurrentProjectId()).toBe('project-2');
    expect(mockClient.channel).not.toHaveBeenCalled();

    mockSyncStateService.syncState.set({ isOnline: true, offlineMode: false });
    await service.resumeTransport();

    expect(mockClient.channel).toHaveBeenCalledTimes(1);
    expect(service.getCurrentProjectId()).toBe('project-2');
  });

  it('挂起窗口内的 Realtime 通道错误不应上报 Sentry', async () => {
    await service.subscribeToProject('project-3', 'user-789');
    const statusCallback = readLatestRealtimeStatusCallback(mockChannel);

    expect(statusCallback).toBeTypeOf('function');

    setVisibilityState('hidden');
    statusCallback?.('CHANNEL_ERROR', { message: 'network suspended' });

    expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
  });

  it('应仅在连续失败达到阈值后上报 Sentry 并降级到轮询', async () => {
    const fallbackSpy = vi.spyOn(
      service as unknown as { fallbackToPolling: (projectId: string, userId: string, transportGeneration: number) => void },
      'fallbackToPolling'
    );

    await service.subscribeToProject('project-4', 'user-321');
    const statusCallback = readLatestRealtimeStatusCallback(mockChannel);

    statusCallback?.('CHANNEL_ERROR', { message: 'first transient failure' });
    statusCallback?.('TIMED_OUT', { message: 'second transient failure' });

    expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();

    statusCallback?.('CHANNEL_ERROR', { message: 'third failure' });

    expect(mockSentryLazyLoaderService.captureMessage).toHaveBeenCalledTimes(1);
    expect(mockSentryLazyLoaderService.captureMessage).toHaveBeenCalledWith(
      'Realtime 订阅错误',
      expect.objectContaining({
        extra: expect.objectContaining({
          consecutiveErrors: 3,
          degradedToPolling: true,
        })
      })
    );
    expect(fallbackSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(REALTIME_CIRCUIT_STORAGE_KEY) ?? '{}')).toEqual(
      expect.objectContaining({
        failures: 3,
        lastError: 'third failure',
      })
    );
  });

  it('Realtime 通道错误与轮询降级应写入迁移指标 breadcrumb', async () => {
    await service.subscribeToProject('project-metric', 'user-metric');
    const statusCallback = readLatestRealtimeStatusCallback(mockChannel);

    statusCallback?.('CHANNEL_ERROR', { message: 'first failure' });
    statusCallback?.('TIMED_OUT', { message: 'second failure' });
    statusCallback?.('CHANNEL_ERROR', { message: 'third failure' });

    expect(mockSentryLazyLoaderService.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      category: 'realtime',
      level: 'warning',
      message: 'realtime_channel_error',
      data: expect.objectContaining({
        status: 'CHANNEL_ERROR',
        projectId: 'project-metric',
        consecutiveErrors: 1,
      }),
    }));
    expect(mockSentryLazyLoaderService.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      category: 'realtime',
      level: 'warning',
      message: 'realtime_fallback_polling_started',
      data: expect.objectContaining({
        projectId: 'project-metric',
        reason: 'realtime_channel_error',
        consecutiveErrors: 3,
      }),
    }));
  });

  it('Realtime 降级到轮询时 removeChannel 同步抛错仍应启动轮询', async () => {
    const startPollingSpy = vi.spyOn(
      service as unknown as { startPolling: (projectId: string, userId: string | null, transportGeneration: number) => void },
      'startPolling'
    );
    await service.subscribeToProject('project-sync-remove-failure', 'user-sync-remove-failure');
    const statusCallback = readLatestRealtimeStatusCallback(mockChannel);
    const removeError = new Error('fallback remove channel sync failure');
    mockClient.removeChannel.mockImplementationOnce(() => {
      throw removeError;
    });

    expect(() => {
      statusCallback?.('CHANNEL_ERROR', { message: 'failure 1' });
      statusCallback?.('CHANNEL_ERROR', { message: 'failure 2' });
      statusCallback?.('CHANNEL_ERROR', { message: 'failure 3' });
    }).not.toThrow();

    expect(startPollingSpy).toHaveBeenCalledWith(
      'project-sync-remove-failure',
      'user-sync-remove-failure',
      expect.any(Number),
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      '移除 Realtime 通道失败（可能已断开）',
      expect.objectContaining({ error: removeError }),
    );
  });

  it('SUBSCRIBED 应重置连续失败计数', async () => {
    const fallbackSpy = vi.spyOn(
      service as unknown as { fallbackToPolling: (projectId: string, userId: string, transportGeneration: number) => void },
      'fallbackToPolling'
    );

    await service.subscribeToProject('project-5', 'user-654');
    const statusCallback = readLatestRealtimeStatusCallback(mockChannel);

    statusCallback?.('CHANNEL_ERROR', { message: 'first failure' });
    statusCallback?.('SUBSCRIBED');
    statusCallback?.('CHANNEL_ERROR', { message: 'second first failure' });
    statusCallback?.('CHANNEL_ERROR', { message: 'second second failure' });

    expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('Realtime 禁用时的通道错误不应上报或降级', async () => {
    await service.subscribeToProject('project-6', 'user-987');
    const fallbackSpy = vi.spyOn(
      service as unknown as { fallbackToPolling: (projectId: string, userId: string, transportGeneration: number) => void },
      'fallbackToPolling'
    );
    const statusCallback = readLatestRealtimeStatusCallback(mockChannel);

    service.setRealtimeEnabled(false);
    statusCallback?.('CHANNEL_ERROR', { message: 'teardown failure' });

    expect(mockSentryLazyLoaderService.captureMessage).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('降级后的冷却期内重新订阅应继续使用轮询', async () => {
    const startPollingSpy = vi.spyOn(
      service as unknown as { startPolling: (projectId: string, userId: string | null, transportGeneration: number) => void },
      'startPolling'
    );

    await service.subscribeToProject('project-7', 'user-741');
    const statusCallback = readLatestRealtimeStatusCallback(mockChannel);

    statusCallback?.('CHANNEL_ERROR', { message: 'failure 1' });
    statusCallback?.('CHANNEL_ERROR', { message: 'failure 2' });
    statusCallback?.('CHANNEL_ERROR', { message: 'failure 3' });

    expect(mockClient.channel).toHaveBeenCalledTimes(1);

    await service.subscribeToProject('project-7', 'user-741');

    expect(mockClient.channel).toHaveBeenCalledTimes(1);
    expect(startPollingSpy).toHaveBeenCalled();
  });

  it('离线达到 Realtime 错误阈值后不应保留失败通道阻断恢复', async () => {
    const startPollingSpy = vi.spyOn(
      service as unknown as { startPolling: (projectId: string, userId: string | null, transportGeneration: number) => void },
      'startPolling'
    );

    await service.subscribeToProject('project-offline-fallback', 'user-offline-fallback');
    const statusCallback = readLatestRealtimeStatusCallback(mockChannel);

    mockSyncStateService.syncState.set({ isOnline: false, offlineMode: false });
    statusCallback?.('CHANNEL_ERROR', { message: 'failure 1' });
    statusCallback?.('CHANNEL_ERROR', { message: 'failure 2' });
    statusCallback?.('CHANNEL_ERROR', { message: 'failure 3' });

    mockSyncStateService.syncState.set({ isOnline: true, offlineMode: false });
    await service.resumeTransport();

    expect(startPollingSpy).toHaveBeenCalledWith(
      'project-offline-fallback',
      'user-offline-fallback',
      expect.any(Number),
    );
  });

  it('旧通道迟到的 SUBSCRIBED 不应清掉降级冷却期', async () => {
    const startPollingSpy = vi.spyOn(
      service as unknown as { startPolling: (projectId: string, userId: string | null, transportGeneration: number) => void },
      'startPolling'
    );

    await service.subscribeToProject('project-8', 'user-852');
    const statusCallback = readLatestRealtimeStatusCallback(mockChannel);

    statusCallback?.('CHANNEL_ERROR', { message: 'failure 1' });
    statusCallback?.('CHANNEL_ERROR', { message: 'failure 2' });
    statusCallback?.('CHANNEL_ERROR', { message: 'failure 3' });
    statusCallback?.('SUBSCRIBED');

    await service.subscribeToProject('project-8', 'user-852');

    expect(mockClient.channel).toHaveBeenCalledTimes(1);
    expect(startPollingSpy).toHaveBeenCalled();
  });

  it('恢复 Realtime 更新时应重启因暂停停止的轮询兜底', async () => {
    vi.useFakeTimers();
    try {
      const startPollingSpy = vi.spyOn(
        service as unknown as { startPolling: (projectId: string, userId: string | null, transportGeneration: number) => void },
        'startPolling'
      );
      service.setOnRemoteChange(vi.fn().mockResolvedValue(undefined));

      await service.subscribeToProject('project-paused-polling', 'user-paused-polling');
      const statusCallback = readLatestRealtimeStatusCallback(mockChannel);
      statusCallback?.('CHANNEL_ERROR', { message: 'failure 1' });
      statusCallback?.('CHANNEL_ERROR', { message: 'failure 2' });
      statusCallback?.('CHANNEL_ERROR', { message: 'failure 3' });
      await Promise.resolve();
      await Promise.resolve();
      expect(startPollingSpy).toHaveBeenCalledTimes(1);

      service.pauseRealtimeUpdates();
      await vi.runOnlyPendingTimersAsync();
      expect(startPollingSpy).toHaveBeenCalledTimes(1);

      service.resumeRealtimeUpdates();

      expect(startPollingSpy).toHaveBeenCalledTimes(2);
      expect(startPollingSpy).toHaveBeenLastCalledWith(
        'project-paused-polling',
        'user-paused-polling',
        expect.any(Number),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('恢复 Realtime 更新时已有活跃轮询不应重复启动兜底', async () => {
    vi.useFakeTimers();
    try {
      const startPollingSpy = vi.spyOn(
        service as unknown as { startPolling: (projectId: string, userId: string | null, transportGeneration: number) => void },
        'startPolling'
      );
      service.setOnRemoteChange(vi.fn().mockResolvedValue(undefined));

      await service.subscribeToProject('project-paused-polling-active-timer', 'user-paused-polling');
      const statusCallback = readLatestRealtimeStatusCallback(mockChannel);
      statusCallback?.('CHANNEL_ERROR', { message: 'failure 1' });
      statusCallback?.('CHANNEL_ERROR', { message: 'failure 2' });
      statusCallback?.('CHANNEL_ERROR', { message: 'failure 3' });
      await Promise.resolve();
      await Promise.resolve();
      expect(startPollingSpy).toHaveBeenCalledTimes(1);

      vi.spyOn((service as unknown as {
        pollingScheduler: { hasActivePolling: () => boolean };
      }).pollingScheduler, 'hasActivePolling').mockReturnValue(true);
      service.pauseRealtimeUpdates();
      service.resumeRealtimeUpdates();

      expect(startPollingSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('会在熔断窗口内直接跳过 Realtime 尝试', async () => {
    sessionStorage.setItem(REALTIME_CIRCUIT_STORAGE_KEY, JSON.stringify({
      until: Date.now() + 60_000,
      ownerUserId: 'user-111',
      failures: 3,
      lastError: 'websocket blocked',
      lastToastAt: 0,
    }));

    service = realtimeSpec.createService();
    const startPollingSpy = vi.spyOn(
      service as unknown as { startPolling: (projectId: string, userId: string | null, transportGeneration: number) => void },
      'startPolling'
    );

    await service.subscribeToProject('project-9', 'user-111');

    expect(mockClient.channel).not.toHaveBeenCalled();
    expect(startPollingSpy).toHaveBeenCalled();
  });

  it('不同 userId 订阅时应清理旧会话的 Realtime 熔断状态', async () => {
    sessionStorage.setItem(REALTIME_CIRCUIT_STORAGE_KEY, JSON.stringify({
      until: Date.now() + 60_000,
      ownerUserId: 'user-old',
      failures: 3,
      lastError: 'stale token',
      lastToastAt: 0,
    }));

    service = realtimeSpec.createService();

    await service.subscribeToProject('project-11', 'user-new');

    expect(mockClient.channel).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(REALTIME_CIRCUIT_STORAGE_KEY)).toBeNull();
  });

  it('SUBSCRIBED 后应清理会话级 Realtime 熔断状态', async () => {
    await service.subscribeToProject('project-10', 'user-222');
    const statusCallback = readLatestRealtimeStatusCallback(mockChannel);

    sessionStorage.setItem(REALTIME_CIRCUIT_STORAGE_KEY, JSON.stringify({
      until: Date.now() + 60_000,
      ownerUserId: 'user-222',
      failures: 3,
      lastError: 'websocket blocked',
      lastToastAt: 0,
    }));

    injector.get(RealtimeTransportCircuitService).loadState();
    statusCallback?.('SUBSCRIBED');

    expect(sessionStorage.getItem(REALTIME_CIRCUIT_STORAGE_KEY)).toBeNull();
  });

  it('重连扇出与轮询首 tick 在去重窗口内不应双发活动项目拉取', async () => {
    // P1 回归：轮询首 tick 此前直连裸回调绕过 remoteChangeDedup，
    // 且 'polling' 与 'reconnect' 按 eventType 分键互不去重，
    // 一次重连会在同一秒发出两次活动项目拉取
    vi.useFakeTimers();
    try {
      const onRemoteChange = vi.fn().mockResolvedValue(undefined);
      service.setOnRemoteChange(onRemoteChange);
      await service.subscribeToProject('project-double-pull', 'user-double-pull');
      onRemoteChange.mockClear();

      await expect(service.triggerRemoteChange({
        eventType: 'reconnect',
        projectId: 'project-double-pull',
      })).resolves.toBe(true);
      expect(onRemoteChange).toHaveBeenCalledTimes(1);

      const runtime = (service as unknown as {
        createPollingRuntime(): {
          onRemoteChange(payload?: { eventType?: string; projectId?: string }): Promise<void>;
        };
      }).createPollingRuntime();

      await runtime.onRemoteChange({ eventType: 'polling', projectId: 'project-double-pull' });
      expect(onRemoteChange).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2000);
      await runtime.onRemoteChange({ eventType: 'polling', projectId: 'project-double-pull' });
      expect(onRemoteChange).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('同一项目 reconnect 回调进行中时不应并发触发重复增量同步', async () => {
    vi.useFakeTimers();
    let resolveReconnect = (): void => {};
    const reconnectPromise = new Promise<void>(resolve => {
      resolveReconnect = resolve;
    });
    const onRemoteChange = vi.fn().mockReturnValue(reconnectPromise);
    service.setOnRemoteChange(onRemoteChange);

    await service.subscribeToProject('project-reconnect-dedupe', 'user-reconnect-dedupe');
    const statusCallback = readLatestRealtimeStatusCallback(mockChannel);

    statusCallback?.('CHANNEL_ERROR', { message: 'temporary disconnect' });
    statusCallback?.('SUBSCRIBED');
    await Promise.resolve();

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    const duplicateReconnect = service.triggerRemoteChange({
      eventType: 'reconnect',
      projectId: 'project-reconnect-dedupe',
    });
    await Promise.resolve();

    try {
      expect(onRemoteChange).toHaveBeenCalledTimes(1);
    } finally {
      resolveReconnect();
      await duplicateReconnect.catch(() => false);
      await Promise.resolve();
    }

    await expect(duplicateReconnect).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(service.triggerRemoteChange({
      eventType: 'reconnect',
      projectId: 'project-reconnect-dedupe',
    })).resolves.toBe(true);
    expect(onRemoteChange).toHaveBeenCalledTimes(2);
  });

  it('同一项目 reconnect 回调刚完成后仍应在远程变更窗口内去重', async () => {
    vi.useFakeTimers();
    const onRemoteChange = vi.fn().mockResolvedValue(undefined);
    service.setOnRemoteChange(onRemoteChange);

    await service.subscribeToProject('project-reconnect-window', 'user-reconnect-window');
    const statusCallback = readLatestRealtimeStatusCallback(mockChannel);

    statusCallback?.('TIMED_OUT', { message: 'temporary timeout' });
    statusCallback?.('SUBSCRIBED');
    await Promise.resolve();

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    await expect(service.triggerRemoteChange({
      eventType: 'reconnect',
      projectId: 'project-reconnect-window',
    })).resolves.toBe(false);
    expect(onRemoteChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    await expect(service.triggerRemoteChange({
      eventType: 'reconnect',
      projectId: 'project-reconnect-window',
    })).resolves.toBe(true);
    expect(onRemoteChange).toHaveBeenCalledTimes(2);
  });

  it('轮询模式在熔断窗口结束后应主动尝试恢复 Realtime', async () => {
    const internals = service as unknown as RealtimePollingHarness;
    internals.currentProjectId = 'project-12';
    internals.currentUserId = 'user-333';
    internals.transportGeneration = 1;

    sessionStorage.setItem(REALTIME_CIRCUIT_STORAGE_KEY, JSON.stringify({
      until: Date.now() - 1,
      ownerUserId: 'user-333',
      failures: 3,
      lastError: 'websocket blocked',
      lastToastAt: 0,
    }));
    injector.get(RealtimeTransportCircuitService).loadState();

    const activateSpy = vi.spyOn(
      internals,
      'activateProjectTransport',
    ).mockImplementation(async () => {
      internals.realtimeChannel = mockChannel;
    });

    const reentered = await internals.maybeReenterRealtimeFromPolling('project-12', 'user-333', 1);

    expect(reentered).toBe(true);
    expect(activateSpy).toHaveBeenCalledWith('project-12', 'user-333', 1);
  });

  it('轮询恢复 Realtime 失败时应继续保留轮询调度', async () => {
    const internals = service as unknown as RealtimePollingHarness;
    internals.currentProjectId = 'project-13';
    internals.currentUserId = 'user-444';
    internals.transportGeneration = 1;

    const activateError = new Error('realtime restore failed');
    const activateSpy = vi.spyOn(
      internals,
      'activateProjectTransport',
    ).mockRejectedValue(activateError);
    const stopPollingSpy = vi.spyOn(internals, 'stopPolling');

    await expect(
      internals.maybeReenterRealtimeFromPolling('project-13', 'user-444', 1),
    ).resolves.toBe(false);

    expect(activateSpy).toHaveBeenCalledWith('project-13', 'user-444', 1);
    expect(stopPollingSpy).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Realtime 轮询恢复订阅失败，继续保留轮询兜底',
      expect.objectContaining({ projectId: 'project-13', error: activateError }),
    );
  });

  it('轮询恢复 Realtime 时若 WebSocket 不可用，不应在当前轮询 tick 内重新启动轮询', async () => {
    const internals = service as unknown as RealtimePollingHarness;
    internals.currentProjectId = 'project-no-websocket';
    internals.currentUserId = 'user-no-websocket';
    internals.transportGeneration = 1;
    vi.spyOn(internals, 'hasRealtimeTransportSupport').mockReturnValue(false);
    const startPollingSpy = vi.spyOn(internals, 'startPolling');

    await expect(
      internals.maybeReenterRealtimeFromPolling('project-no-websocket', 'user-no-websocket', 1),
    ).resolves.toBe(false);

    expect(startPollingSpy).not.toHaveBeenCalled();
    expect(mockClient.channel).not.toHaveBeenCalled();
  });

  it('轮询恢复 Realtime 等待期间上下文失效时不应停止当前轮询', async () => {
    const internals = service as unknown as RealtimePollingHarness;
    internals.currentProjectId = 'project-stale';
    internals.currentUserId = 'user-stale';
    internals.transportGeneration = 1;

    const activateSpy = vi.spyOn(
      internals,
      'activateProjectTransport',
    ).mockImplementation(async () => {
      await service.unsubscribeFromProject();
      internals.realtimeChannel = mockChannel;
    });
    const stopPollingSpy = vi.spyOn(internals, 'stopPolling');

    await expect(
      internals.maybeReenterRealtimeFromPolling('project-stale', 'user-stale', 1),
    ).resolves.toBe(false);

    expect(activateSpy).toHaveBeenCalledWith('project-stale', 'user-stale', 1);
    expect(stopPollingSpy).toHaveBeenCalledTimes(1);
    expect(service.getCurrentProjectId()).toBeNull();
  });

  it('应忽略已切换项目后的旧 project payload 远端触发', async () => {
    const onRemoteChange = vi.fn().mockResolvedValue(undefined);
    service.setOnRemoteChange(onRemoteChange);

    await service.subscribeToProject('project-old', 'user-123');
    await service.subscribeToProject('project-new', 'user-123');

    await expect(service.triggerRemoteChange({
      eventType: 'resume',
      projectId: 'project-old',
    })).resolves.toBe(false);

    expect(onRemoteChange).not.toHaveBeenCalled();

    await expect(service.triggerRemoteChange({
      eventType: 'resume',
      projectId: 'project-new',
    })).resolves.toBe(true);

    expect(onRemoteChange).toHaveBeenCalledWith({
      eventType: 'resume',
      projectId: 'project-new',
    });
  });
});
