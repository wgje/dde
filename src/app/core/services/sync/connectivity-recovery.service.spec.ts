/**
 * ConnectivityRecoveryService 单元测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConnectivityRecoveryService } from './connectivity-recovery.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { SessionManagerService } from './session-manager.service';
import { RealtimePollingService } from './realtime-polling.service';
import { RetryQueueService } from './retry-queue.service';
import { SyncStateService } from './sync-state.service';
import { BlackBoxSyncService } from '../../../../services/black-box-sync.service';
import { WidgetBindingService } from '../../../../services/widget-binding.service';
import { AttachmentCleanupOutboxService } from '../../../../services/attachment-cleanup-outbox.service';
import { DockDirectWidgetNotifyOutboxService } from '../../../../services/dock-direct-widget-notify-outbox.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';

const mockStorageClient = {
  functions: {
    invoke: vi.fn(),
  },
  storage: {
    from: vi.fn(),
  },
};

const mockSupabase = {
  isOfflineMode: signal(false),
  probeReachability: vi.fn().mockResolvedValue(true),
  clientAsync: vi.fn().mockResolvedValue(mockStorageClient),
};

const mockCategoryLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockLogger = {
  category: vi.fn().mockReturnValue(mockCategoryLogger),
};

const mockSessionManager = {
  getRecentValidationSnapshot: vi.fn().mockReturnValue({ valid: true }),
  validateOrRefreshOnResume: vi.fn().mockResolvedValue({ ok: true, deferred: false }),
};

const mockRealtimePolling = {
  suspendTransport: vi.fn().mockResolvedValue(undefined),
  resumeTransport: vi.fn().mockResolvedValue(undefined),
  resumeRealtimeUpdates: vi.fn(),
  hasRemoteChangeCallback: vi.fn().mockReturnValue(false),
  getCurrentProjectId: vi.fn().mockReturnValue(null),
  triggerRemoteChange: vi.fn().mockResolvedValue(undefined),
};

const mockRetryQueue = {
  processQueue: vi.fn(),
  length: 0,
};

const mockSyncState = {
  setOfflineMode: vi.fn(),
};

const mockBlackBoxSync = {
  pullChanges: vi.fn().mockResolvedValue({ success: true }),
};

const mockWidgetBinding = {
  flushPendingRevokeAllBindings: vi.fn().mockResolvedValue({
    ok: true,
    value: { revokedCount: 0, syncStatus: 'synced' },
  }),
};

const mockAttachmentCleanupOutbox = {
  flushPendingCleanups: vi.fn().mockResolvedValue({
    ok: true,
    deletedCount: 0,
    remainingCount: 0,
    errors: [],
  }),
};

const mockDirectWidgetNotifyOutbox = {
  flushPendingNotifications: vi.fn().mockResolvedValue({
    ok: true,
    sentCount: 0,
    remainingCount: 0,
    errors: [],
  }),
};

describe('ConnectivityRecoveryService', () => {
  let service: ConnectivityRecoveryService;

  const flushMicrotasks = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const setDocumentVisible = (): void => {
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
  };

  const setDocumentHidden = (): void => {
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
  };

  const setNavigatorOnline = (online: boolean): void => {
    Object.defineProperty(navigator, 'onLine', {
      value: online,
      configurable: true,
    });
  };

  beforeEach(() => {
    vi.useRealTimers();
    resetBrowserNetworkSuspensionTrackingForTests();
    setDocumentVisible();
    setNavigatorOnline(true);
    mockSupabase.isOfflineMode.set(false);
    mockSupabase.probeReachability.mockReset();
    mockSupabase.probeReachability.mockResolvedValue(true);
    mockSupabase.clientAsync.mockReset();
    mockSupabase.clientAsync.mockResolvedValue(mockStorageClient);

    mockLogger.category.mockReset();
    mockLogger.category.mockReturnValue(mockCategoryLogger);
    mockCategoryLogger.debug.mockReset();
    mockCategoryLogger.info.mockReset();
    mockCategoryLogger.warn.mockReset();
    mockCategoryLogger.error.mockReset();
    mockSessionManager.getRecentValidationSnapshot.mockReset();
    mockSessionManager.getRecentValidationSnapshot.mockReturnValue({ valid: true, userId: 'test-user' });
    mockSessionManager.validateOrRefreshOnResume.mockReset();
    mockSessionManager.validateOrRefreshOnResume.mockResolvedValue({ ok: true, deferred: false });
    mockRealtimePolling.suspendTransport.mockReset();
    mockRealtimePolling.suspendTransport.mockResolvedValue(undefined);
    mockRealtimePolling.resumeTransport.mockReset();
    mockRealtimePolling.resumeTransport.mockResolvedValue(undefined);
    mockRealtimePolling.resumeRealtimeUpdates.mockReset();
    mockRealtimePolling.hasRemoteChangeCallback.mockReset();
    mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(false);
    mockRealtimePolling.getCurrentProjectId.mockReset();
    mockRealtimePolling.getCurrentProjectId.mockReturnValue(null);
    mockRealtimePolling.triggerRemoteChange.mockReset();
    mockRealtimePolling.triggerRemoteChange.mockResolvedValue(undefined);
    mockRetryQueue.processQueue.mockReset();
    mockRetryQueue.length = 0;
    mockSyncState.setOfflineMode.mockReset();
    mockBlackBoxSync.pullChanges.mockReset();
    mockBlackBoxSync.pullChanges.mockResolvedValue({ success: true });
    mockWidgetBinding.flushPendingRevokeAllBindings.mockReset();
    mockWidgetBinding.flushPendingRevokeAllBindings.mockResolvedValue({
      ok: true,
      value: { revokedCount: 0, syncStatus: 'synced' },
    });
    mockAttachmentCleanupOutbox.flushPendingCleanups.mockReset();
    mockAttachmentCleanupOutbox.flushPendingCleanups.mockResolvedValue({
      ok: true,
      deletedCount: 0,
      remainingCount: 0,
      errors: [],
    });
    mockDirectWidgetNotifyOutbox.flushPendingNotifications.mockReset();
    mockDirectWidgetNotifyOutbox.flushPendingNotifications.mockResolvedValue({
      ok: true,
      sentCount: 0,
      remainingCount: 0,
      errors: [],
    });

    TestBed.configureTestingModule({
      providers: [
        ConnectivityRecoveryService,
        { provide: SupabaseClientService, useValue: mockSupabase },
        { provide: LoggerService, useValue: mockLogger },
        { provide: SessionManagerService, useValue: mockSessionManager },
        { provide: RealtimePollingService, useValue: mockRealtimePolling },
        { provide: RetryQueueService, useValue: mockRetryQueue },
        { provide: SyncStateService, useValue: mockSyncState },
        { provide: BlackBoxSyncService, useValue: mockBlackBoxSync },
        { provide: WidgetBindingService, useValue: mockWidgetBinding },
        { provide: AttachmentCleanupOutboxService, useValue: mockAttachmentCleanupOutbox },
        { provide: DockDirectWidgetNotifyOutboxService, useValue: mockDirectWidgetNotifyOutbox },
      ],
    });

    service = TestBed.inject(ConnectivityRecoveryService);
  });

  afterEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    setDocumentVisible();
    setNavigatorOnline(true);
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should start runtime', () => {
    service.startRuntime();
    // Runtime started - connectivity recovery is now active
  });

  it('should stop runtime', () => {
    service.startRuntime();
    service.stopRuntime();
    // Runtime stopped - connectivity recovery is now inactive
  });

  it('should handle connectivity change to offline', () => {
    service.startRuntime();
    service.handleSupabaseConnectivityChange(
      { offline: true, source: 'request' },
      true
    );

    expect(mockSyncState.setOfflineMode).toHaveBeenCalledWith(true);
    expect(mockRealtimePolling.suspendTransport).toHaveBeenCalled();
  });

  it('should handle connectivity change to online', async () => {
    service.startRuntime();
    service.handleSupabaseConnectivityChange(
      { offline: false, source: 'request' },
      true
    );

    expect(mockSyncState.setOfflineMode).toHaveBeenCalledWith(false);

    await flushMicrotasks();
  });

  it('request restored 到达时若浏览器状态仍离线，不应清除 offlineMode', async () => {
    service.startRuntime();

    service.handleSupabaseConnectivityChange(
      { offline: false, source: 'request' },
      false,
    );

    expect(mockSyncState.setOfflineMode).not.toHaveBeenCalledWith(false);
    expect(mockRealtimePolling.resumeTransport).not.toHaveBeenCalled();
  });

  it('runtime 未启动且浏览器仍离线时不应因 Supabase 恢复事件清除 offlineMode', () => {
    service.handleSupabaseConnectivityChange(
      { offline: false, source: 'request' },
      false,
    );

    expect(mockSyncState.setOfflineMode).not.toHaveBeenCalledWith(false);
    expect(mockRealtimePolling.resumeTransport).not.toHaveBeenCalled();
  });

  it('should probe remote reachability successfully', async () => {
    const result = await service.probeRemoteReachability('test-reason');

    expect(result).toBe(true);
    expect(mockSupabase.probeReachability).toHaveBeenCalled();
    expect(mockSyncState.setOfflineMode).toHaveBeenCalledWith(false);
  });

  it('should handle unreachable remote', async () => {
    (mockSupabase.probeReachability as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const result = await service.probeRemoteReachability('test-reason');

    expect(result).toBe(false);
    expect(mockSyncState.setOfflineMode).toHaveBeenCalledWith(true);
    expect(mockRealtimePolling.suspendTransport).toHaveBeenCalled();
  });

  it('should schedule connectivity recovery', () => {
    service.startRuntime();

    vi.useFakeTimers();
    service.scheduleConnectivityRecovery('test-reason', 100);

    expect(vi.getTimerCount()).toBe(1);

    vi.runAllTimers();
    vi.useRealTimers();
  });

  it('隐藏页跳过连接恢复 timer 时应保留可见后补跑的 pending intent', async () => {
    service.startRuntime();
    vi.useFakeTimers();
    setDocumentHidden();

    service.scheduleConnectivityRecovery('hidden-recovery', 100);

    expect(vi.getTimerCount()).toBe(0);
    expect(mockRealtimePolling.resumeTransport).not.toHaveBeenCalled();

    setDocumentVisible();
    expect(service.flushPendingConnectivityRecovery('visibility-threshold')).toBe(true);
    await vi.advanceTimersByTimeAsync(99);
    expect(mockRealtimePolling.resumeTransport).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledOnce();
    expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledOnce();
  });

  it('连接恢复 timer 到点但浏览器仍离线时应保留 online 后补跑的 pending intent', async () => {
    service.startRuntime();
    vi.useFakeTimers();
    setNavigatorOnline(false);

    service.scheduleConnectivityRecovery('offline-at-deadline', 100);
    await vi.advanceTimersByTimeAsync(100);

    expect(mockRealtimePolling.resumeTransport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    setNavigatorOnline(true);
    expect(service.flushPendingConnectivityRecovery('online')).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledOnce();
    expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledOnce();
  });

  it('should replace a later scheduled recovery with an earlier deadline', async () => {
    service.startRuntime();

    vi.useFakeTimers();
    service.scheduleConnectivityRecovery('background-delay', 10_000);
    service.scheduleConnectivityRecovery('urgent-resume', 100);

    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(100);

    expect(mockRealtimePolling.resumeTransport).toHaveBeenCalledOnce();
    expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
  });

  it('ignores a stale scheduled recovery callback after a newer timer replaces it', async () => {
    const scheduledCallbacks = new Map<number, () => void>();
    let nextTimerId = 1;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      const timerId = nextTimerId++;
      scheduledCallbacks.set(timerId, callback as () => void);
      return timerId as unknown as ReturnType<typeof setTimeout>;
    });
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    service.startRuntime();

    service.scheduleConnectivityRecovery('background-delay', 10_000);
    service.scheduleConnectivityRecovery('urgent-resume', 100);

    scheduledCallbacks.get(1)?.();
    await flushMicrotasks();

    expect(mockRealtimePolling.resumeTransport).not.toHaveBeenCalled();
    expect(mockRealtimePolling.resumeRealtimeUpdates).not.toHaveBeenCalled();
  });

  it('should restore remote connectivity', async () => {
    service.startRuntime();

    await service.restoreRemoteConnectivity('test-reason');

    // Verify connectivity restoration flow completed
    expect(mockRealtimePolling.resumeTransport).toHaveBeenCalled();
    expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalled();
  });

  it('远端连接恢复后应自动同步 Widget revoke-all outbox', async () => {
    service.startRuntime();

    await service.restoreRemoteConnectivity('test-reason');

    expect(mockWidgetBinding.flushPendingRevokeAllBindings).toHaveBeenCalledOnce();
  });

  it('远端连接恢复后应自动同步附件清理 cleanup outbox', async () => {
    service.startRuntime();

    await service.restoreRemoteConnectivity('test-reason');
    await flushMicrotasks();

    expect(mockSupabase.clientAsync).toHaveBeenCalled();
    expect(mockAttachmentCleanupOutbox.flushPendingCleanups).toHaveBeenCalledWith(mockStorageClient, { ownerUserId: 'test-user' });
  });

  it('远端连接恢复后应自动同步 Widget direct notify outbox', async () => {
    service.startRuntime();

    await service.restoreRemoteConnectivity('test-reason');
    await flushMicrotasks();

    expect(mockDirectWidgetNotifyOutbox.flushPendingNotifications).toHaveBeenCalledWith(mockStorageClient);
  });

  it('连接恢复 fan-out 中单个副作用失败不应阻断其余恢复副作用', async () => {
    const queueError = new Error('queue failed');
    mockRetryQueue.length = 1;
    mockRetryQueue.processQueue.mockImplementationOnce(() => {
      throw queueError;
    });
    mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
    mockRealtimePolling.getCurrentProjectId.mockReturnValue('project-1');
    service.startRuntime();

    await expect(service.restoreRemoteConnectivity('test-reason')).resolves.toBeUndefined();

    expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledOnce();
    expect(mockRetryQueue.processQueue).toHaveBeenCalledOnce();
    expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledWith({
      eventType: 'reconnect',
      projectId: 'project-1',
    });
    expect(mockBlackBoxSync.pullChanges).toHaveBeenCalledWith({ reason: 'resume' });
    expect(mockCategoryLogger.warn).toHaveBeenCalledWith(
      '远端连接恢复后重试队列处理失败',
      { reason: 'test-reason', error: queueError },
    );
  });

  it('Widget revoke-all outbox 同步失败不应阻断其余连接恢复副作用', async () => {
    const widgetError = new Error('widget outbox failed');
    mockWidgetBinding.flushPendingRevokeAllBindings.mockRejectedValueOnce(widgetError);
    mockRetryQueue.length = 1;
    mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
    mockRealtimePolling.getCurrentProjectId.mockReturnValue('project-1');
    service.startRuntime();

    await expect(service.restoreRemoteConnectivity('test-reason')).resolves.toBeUndefined();
    await flushMicrotasks();

    expect(mockWidgetBinding.flushPendingRevokeAllBindings).toHaveBeenCalledOnce();
    expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledOnce();
    expect(mockRetryQueue.processQueue).toHaveBeenCalledOnce();
    expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledWith({
      eventType: 'reconnect',
      projectId: 'project-1',
    });
    expect(mockBlackBoxSync.pullChanges).toHaveBeenCalledWith({ reason: 'resume' });
    expect(mockCategoryLogger.warn).toHaveBeenCalledWith(
      '远端连接恢复后 Widget 绑定队列同步失败',
      { reason: 'test-reason', error: widgetError },
    );
  });

  it('附件清理 cleanup outbox 同步失败不应阻断其余连接恢复副作用', async () => {
    const cleanupError = new Error('attachment cleanup failed');
    mockAttachmentCleanupOutbox.flushPendingCleanups.mockRejectedValueOnce(cleanupError);
    mockRetryQueue.length = 1;
    mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
    mockRealtimePolling.getCurrentProjectId.mockReturnValue('project-1');
    service.startRuntime();

    await expect(service.restoreRemoteConnectivity('test-reason')).resolves.toBeUndefined();
    await flushMicrotasks();

    expect(mockAttachmentCleanupOutbox.flushPendingCleanups).toHaveBeenCalledOnce();
    expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledOnce();
    expect(mockRetryQueue.processQueue).toHaveBeenCalledOnce();
    expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledWith({
      eventType: 'reconnect',
      projectId: 'project-1',
    });
    expect(mockBlackBoxSync.pullChanges).toHaveBeenCalledWith({ reason: 'resume' });
    expect(mockCategoryLogger.warn).toHaveBeenCalledWith(
      '远端连接恢复后附件清理队列同步失败',
      { reason: 'test-reason', error: cleanupError },
    );
  });

  it('连接恢复 fan-out 中 retry queue 异步拒绝不应泄露未处理拒绝并应记录', async () => {
    const queueError = new Error('queue async failed');
    mockRetryQueue.length = 1;
    mockRetryQueue.processQueue.mockRejectedValueOnce(queueError);
    mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
    mockRealtimePolling.getCurrentProjectId.mockReturnValue('project-1');
    service.startRuntime();

    await expect(service.restoreRemoteConnectivity('test-reason')).resolves.toBeUndefined();
    await flushMicrotasks();

    expect(mockRealtimePolling.resumeRealtimeUpdates).toHaveBeenCalledOnce();
    expect(mockRetryQueue.processQueue).toHaveBeenCalledOnce();
    expect(mockRealtimePolling.triggerRemoteChange).toHaveBeenCalledWith({
      eventType: 'reconnect',
      projectId: 'project-1',
    });
    expect(mockBlackBoxSync.pullChanges).toHaveBeenCalledWith({ reason: 'resume' });
    expect(mockCategoryLogger.warn).toHaveBeenCalledWith(
      '远端连接恢复后重试队列处理失败',
      { reason: 'test-reason', error: queueError },
    );
  });

  it('恢复过程中再次收到 request offline 应作废旧 restore，避免离线态 finalize', async () => {
    let resolveProbe: ((reachable: boolean) => void) | null = null;
    mockSupabase.probeReachability.mockReturnValueOnce(new Promise<boolean>(resolve => {
      resolveProbe = resolve;
    }));
    mockRetryQueue.length = 1;
    mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
    mockRealtimePolling.getCurrentProjectId.mockReturnValue('project-1');
    service.startRuntime();

    const restoring = service.restoreRemoteConnectivity('request-restored');
    await Promise.resolve();

    service.handleSupabaseConnectivityChange({ offline: true, source: 'request' }, true);
    resolveProbe!(true);
    await restoring;

    expect(mockRealtimePolling.resumeTransport).not.toHaveBeenCalled();
    expect(mockRealtimePolling.resumeRealtimeUpdates).not.toHaveBeenCalled();
    expect(mockRetryQueue.processQueue).not.toHaveBeenCalled();
    expect(mockRealtimePolling.triggerRemoteChange).not.toHaveBeenCalled();
    expect(mockBlackBoxSync.pullChanges).not.toHaveBeenCalled();
  });

  it('cancelScheduledRecovery 应作废已在执行的 restore，避免旧恢复完成后 fan-out', async () => {
    let resolveResumeTransport: (() => void) | null = null;
    mockRealtimePolling.resumeTransport.mockReturnValueOnce(new Promise<void>(resolve => {
      resolveResumeTransport = resolve;
    }));
    mockRetryQueue.length = 1;
    mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
    mockRealtimePolling.getCurrentProjectId.mockReturnValue('project-1');
    service.startRuntime();

    const restoring = service.restoreRemoteConnectivity('scheduled:online-event');
    await vi.waitFor(() => {
      expect(resolveResumeTransport).toBeTypeOf('function');
    });

    service.cancelScheduledRecovery();
    resolveResumeTransport!();
    await restoring;

    expect(mockRealtimePolling.resumeRealtimeUpdates).not.toHaveBeenCalled();
    expect(mockRetryQueue.processQueue).not.toHaveBeenCalled();
    expect(mockRealtimePolling.triggerRemoteChange).not.toHaveBeenCalled();
    expect(mockBlackBoxSync.pullChanges).not.toHaveBeenCalled();
  });

  it('连续探测失败应指数退避重排，成功后复位基线间隔', async () => {
    // 长离线（地铁/飞行）下固定 15s 间隔每小时 240 次真实 fetch；
    // 退避到 120s 上限后省 ~75% 探测量，事件驱动恢复路径不受影响
    vi.useFakeTimers();
    const scheduleSpy = vi.spyOn(service, 'scheduleConnectivityRecovery');
    mockSupabase.probeReachability.mockRejectedValue(new Error('probe failed'));
    service.startRuntime();

    await service.probeRemoteReachability('backoff-1');
    await service.probeRemoteReachability('backoff-2');
    await service.probeRemoteReachability('backoff-3');
    await service.probeRemoteReachability('backoff-4');
    await service.probeRemoteReachability('backoff-5');

    expect(scheduleSpy.mock.calls.map(call => call[1])).toEqual([
      15000,
      30000,
      60000,
      120000,
      120000,
    ]);

    mockSupabase.probeReachability.mockResolvedValue(true);
    await expect(service.probeRemoteReachability('recovered')).resolves.toBe(true);

    mockSupabase.probeReachability.mockRejectedValueOnce(new Error('probe failed again'));
    await service.probeRemoteReachability('after-reset');
    expect(scheduleSpy.mock.calls.at(-1)?.[1]).toBe(15000);
  });

  it('probe 抛错时 restoreRemoteConnectivity 不应拒绝并应保留恢复重试', async () => {
    vi.useFakeTimers();
    const probeError = new Error('probe failed');
    mockSupabase.probeReachability.mockRejectedValueOnce(probeError);
    service.startRuntime();

    await expect(service.restoreRemoteConnectivity('probe-failure')).resolves.toBeUndefined();

    expect(mockCategoryLogger.warn).toHaveBeenCalledWith(
      'Supabase 远端可达性探测失败，保持连接恢复重试',
      expect.objectContaining({ reason: 'probe-failure', error: probeError }),
    );
    expect(mockRealtimePolling.resumeTransport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('resumeTransport 抛错时 restoreRemoteConnectivity 不应拒绝并应保留恢复重试', async () => {
    vi.useFakeTimers();
    const resumeError = new Error('resume failed');
    mockRealtimePolling.resumeTransport.mockRejectedValueOnce(resumeError);
    mockRetryQueue.length = 1;
    service.startRuntime();

    await expect(service.restoreRemoteConnectivity('resume-transport-failure')).resolves.toBeUndefined();

    expect(mockCategoryLogger.warn).toHaveBeenCalledWith(
      'Realtime 传输恢复失败，保持连接恢复重试',
      expect.objectContaining({ reason: 'resume-transport-failure', error: resumeError }),
    );
    expect(mockRealtimePolling.resumeRealtimeUpdates).not.toHaveBeenCalled();
    expect(mockRetryQueue.processQueue).not.toHaveBeenCalled();
    expect(mockBlackBoxSync.pullChanges).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('会话恢复校验拒绝时 restoreRemoteConnectivity 不应拒绝并应保留恢复重试', async () => {
    vi.useFakeTimers();
    const sessionError = new Error('session failed');
    mockSessionManager.getRecentValidationSnapshot.mockReturnValueOnce(null);
    mockSessionManager.validateOrRefreshOnResume.mockRejectedValueOnce(sessionError);
    service.startRuntime();

    await expect(service.restoreRemoteConnectivity('session-failure')).resolves.toBeUndefined();

    expect(mockCategoryLogger.warn).toHaveBeenCalledWith(
      '连接恢复会话校验失败，保持连接恢复重试',
      expect.objectContaining({ reason: 'session-failure', error: sessionError }),
    );
    expect(mockRealtimePolling.resumeTransport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('远端不可达且 suspendTransport 拒绝时 restoreRemoteConnectivity 不应拒绝', async () => {
    vi.useFakeTimers();
    const suspendError = new Error('suspend failed');
    mockSupabase.probeReachability.mockResolvedValueOnce(false);
    mockRealtimePolling.suspendTransport.mockRejectedValueOnce(suspendError);
    service.startRuntime();

    await expect(service.restoreRemoteConnectivity('unreachable-suspend-failure')).resolves.toBeUndefined();

    expect(mockCategoryLogger.warn).toHaveBeenCalledWith(
      'Realtime 传输挂起失败，继续连接恢复流程',
      expect.objectContaining({ reason: 'unreachable-suspend-failure', error: suspendError }),
    );
    expect(mockRealtimePolling.resumeTransport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('request offline 的 suspendTransport 拒绝时不应泄露未处理拒绝并应继续调度恢复', async () => {
    vi.useFakeTimers();
    const suspendError = new Error('request offline suspend failed');
    mockRealtimePolling.suspendTransport.mockRejectedValueOnce(suspendError);
    service.startRuntime();

    service.handleSupabaseConnectivityChange({ offline: true, source: 'request' }, true);
    await flushMicrotasks();

    expect(mockCategoryLogger.warn).toHaveBeenCalledWith(
      '请求离线后 Realtime 传输挂起失败',
      expect.objectContaining({ reason: 'supabase-request-offline', error: suspendError }),
    );
    expect(vi.getTimerCount()).toBe(1);
  });

  it('should not restore connectivity if runtime not started', async () => {
    await service.restoreRemoteConnectivity('test-reason');

    expect(mockSupabase.probeReachability).not.toHaveBeenCalled();
    expect(mockSyncState.setOfflineMode).not.toHaveBeenCalled();
    expect(mockRealtimePolling.resumeTransport).not.toHaveBeenCalled();
    expect(mockRealtimePolling.resumeRealtimeUpdates).not.toHaveBeenCalled();
    expect(mockRetryQueue.processQueue).not.toHaveBeenCalled();
    expect(mockBlackBoxSync.pullChanges).not.toHaveBeenCalled();
  });

  it('warns when reconnect remote-change callback fails', async () => {
    const error = new Error('remote change failed');
    mockRealtimePolling.hasRemoteChangeCallback.mockReturnValue(true);
    mockRealtimePolling.getCurrentProjectId.mockReturnValue('project-1');
    mockRealtimePolling.triggerRemoteChange.mockRejectedValueOnce(error);
    service.startRuntime();

    await service.restoreRemoteConnectivity('test-reason');
    await Promise.resolve();

    expect(mockCategoryLogger.warn).toHaveBeenCalledWith('远端连接恢复后远端变更回调失败', {
      reason: 'test-reason',
      error,
    });
  });
});
