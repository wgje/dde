import { TestBed } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';

import { ExternalSourceLinkService } from './external-source-link.service';
import { remoteExternalSourceLinkRow } from './external-source-link.service.spec-helpers';

interface ExternalSourceLinkRefreshSpecContext {
  clientAsyncMock: () => ReturnType<typeof vi.fn>;
  getSelectCallCount: () => number;
  getSelectRangeCallCount: () => number;
  getSelectCursorValues: () => Array<string | null>;
  getUpsertCallCount: () => number;
  setRemoteRows: (rows: unknown[]) => void;
  setSelectError: (error: Error | null) => void;
  setUpsertCallCount: (count: number) => void;
  setVisibilityState: (state: 'visible' | 'hidden') => void;
}

export function registerExternalSourceLinkRefreshSpecs(
  context: ExternalSourceLinkRefreshSpecContext,
): void {
  it('refreshIfStale skips remote pull within the staleness window and forces it when force=true', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    await service.ensureLoaded();
    const baseline = context.clientAsyncMock().mock.calls.length;

    await service.refreshIfStale(false);
    expect(context.clientAsyncMock().mock.calls.length).toBe(baseline);

    await service.refreshIfStale(true);
    expect(context.clientAsyncMock().mock.calls.length).toBeGreaterThan(baseline);
  });

  it('refreshIfStale picks up new remote rows after force refresh', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    await service.ensureLoaded();
    expect(service.activeLinks()).toHaveLength(0);

    const now = new Date().toISOString();
    context.setRemoteRows([
      {
        id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        user_id: '00000000-0000-0000-0000-000000000001',
        task_id: 'task-remote',
        source_type: 'siyuan-block',
        target_id: '20260426999999-rem0001',
        uri: 'siyuan://blocks/20260426999999-rem0001?focus=1',
        label: null,
        hpath: null,
        role: null,
        sort_order: 0,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      },
    ]);

    await service.refreshIfStale(true);

    expect(service.firstActiveLinkForTask('task-remote')?.id).toBe(
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
    );
  });

  it('pulls all remote links across Supabase REST pages', async () => {
    context.setRemoteRows(Array.from({ length: 1001 }, (_, index) =>
      remoteExternalSourceLinkRow(`remote-${index.toString().padStart(4, '0')}`, `task-${index}`),
    ));

    const service = TestBed.inject(ExternalSourceLinkService);
    await service.ensureLoaded();

    expect(service.links()).toHaveLength(1001);
    expect(service.firstActiveLinkForTask('task-0')?.id).toBe('remote-0000');
    expect(service.firstActiveLinkForTask('task-1000')?.id).toBe('remote-1000');
    expect(context.getSelectCallCount()).toBe(2);
    expect(context.getSelectRangeCallCount()).toBe(0);
    expect(context.getSelectCursorValues()).toEqual([null, 'remote-0999']);
  });

  it('refreshIfStale does not push local links when the remote pull fails', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();
    context.setUpsertCallCount(0);
    context.setSelectError(new Error('pull failed'));

    await service.refreshIfStale(true);

    expect(context.getUpsertCallCount()).toBe(0);
  });

  it('浏览器恢复保护期内应延后 remote pull，并在保护期结束后自动补拉', async () => {
    context.setVisibilityState('hidden');
    const service = TestBed.inject(ExternalSourceLinkService);
    const refreshSpy = vi.spyOn(service, 'refreshIfStale');

    await service.ensureLoaded();
    expect(context.getSelectCallCount()).toBe(0);

    vi.useFakeTimers();
    try {
      context.setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));

      await vi.advanceTimersByTimeAsync(1549);
      expect(context.getSelectCallCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(context.getSelectCallCount()).toBeGreaterThan(0);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('hidden 期间收到 online force refresh 时应在恢复可见后保留强制补拉意图', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    await service.ensureLoaded();
    const baselineSelectCalls = context.getSelectCallCount();
    context.setRemoteRows([remoteExternalSourceLinkRow('remote-force-refresh', 'task-force-refresh')]);

    vi.useFakeTimers();
    try {
      context.setVisibilityState('hidden');
      window.dispatchEvent(new Event('online'));

      context.setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));

      await vi.advanceTimersByTimeAsync(5049);
      expect(context.getSelectCallCount()).toBe(baselineSelectCalls);

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => {
        expect(context.getSelectCallCount()).toBeGreaterThan(baselineSelectCalls);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(service.firstActiveLinkForTask('task-force-refresh')?.id).toBe('remote-force-refresh');
  });

  it('destroy cleanup 后迟到的 resume sync timer 不应再触发刷新或 flush', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    await service.ensureLoaded();
    const refreshSpy = vi.spyOn(service, 'refreshIfStale');
    const flushSpy = vi.spyOn(service, 'flushPendingLinks');
    let scheduledResumeSync: (() => void) | null = null;
    const timerId = 123 as unknown as ReturnType<typeof window.setTimeout>;
    const setTimeoutSpy = vi
      .spyOn(window, 'setTimeout')
      .mockImplementation((handler: (_: void) => void) => {
        scheduledResumeSync = () => handler(undefined);
        return timerId;
      });
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');

    try {
      window.dispatchEvent(new Event('online'));

      expect(scheduledResumeSync).toBeTypeOf('function');
      expect(refreshSpy).not.toHaveBeenCalled();
      expect(flushSpy).not.toHaveBeenCalled();

      TestBed.resetTestingModule();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId);
      scheduledResumeSync!();
      await Promise.resolve();

      expect(refreshSpy).not.toHaveBeenCalled();
      expect(flushSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
}
