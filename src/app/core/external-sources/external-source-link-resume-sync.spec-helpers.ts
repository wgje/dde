import { TestBed } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';

import { createBrowserNetworkSuspendedError } from '../../../utils/browser-network-suspension';
import type { ExternalSourceCacheService } from './external-source-cache.service';
import type { ExternalSourceLinkService } from './external-source-link.service';
import type { ExternalSourceLink } from './external-source.model';

type SpyFn = ReturnType<typeof vi.fn>;
type UpsertError = { code?: string; status?: number; message: string } | Error | null;

export interface ExternalSourceLinkResumeSyncSpecContext {
  service: () => ExternalSourceLinkService;
  cache: () => ExternalSourceCacheService;
  createLink: (overrides?: Partial<ExternalSourceLink>) => ExternalSourceLink;
  getUpsertCallCount: () => number;
  setUpsertError: (error: UpsertError) => void;
  logger: () => { warn: SpyFn };
  setVisibilityState: (state: 'visible' | 'hidden') => void;
}

export function registerExternalSourceLinkResumeSyncSpecs(
  context: ExternalSourceLinkResumeSyncSpecContext,
): void {
  it('BrowserNetworkSuspendedError 不应消耗思源锚点 pending 的 retry budget', async () => {
    const service = context.service();
    const cache = context.cache();

    context.setUpsertError(createBrowserNetworkSuspendedError());
    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();

    const pending = await cache.loadPendingLinks();
    expect(context.getUpsertCallCount()).toBeGreaterThan(0);
    expect(pending).toHaveLength(1);
    expect(pending[0].retryCount).toBe(0);
    expect(context.logger().warn).not.toHaveBeenCalledWith(
      '推送思源锚点失败，已保留本机重试',
      expect.objectContaining({ errorCode: 'browser-network-suspended' }),
    );
  });

  it('suspension 延后 pushLocalNewerLinks 时应保留已有 pending retryCount', async () => {
    const service = context.service() as unknown as {
      pushLocalNewerLinks(localLinks: ExternalSourceLink[], remoteLinks: ExternalSourceLink[]): Promise<void>;
    };
    const cache = context.cache();
    const now = new Date().toISOString();
    const link = context.createLink({ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      createdAt: now, updatedAt: now });

    const pendingEntry = await cache.upsertPendingLink(link, { resetRetryCount: true });
    await cache.recordPendingFailure(link.id, pendingEntry.operationId, 'offline');
    context.setVisibilityState('hidden');

    await service.pushLocalNewerLinks([link], []);

    const pending = await cache.loadPendingLinks();
    expect(pending).toHaveLength(1);
    expect(pending[0].retryCount).toBe(1);
  });

  it('continues opportunistic listener cleanup when one removeEventListener throws', async () => {
    const service = context.service();
    await service.ensureLoaded();
    const documentRemoveSpy = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementationOnce(() => {
        throw new Error('visibility cleanup failed');
      });
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');
    const internals = service as unknown as { opportunisticListenersBound: boolean };

    try {
      expect(() => TestBed.resetTestingModule()).not.toThrow();
      expect(windowRemoveSpy).toHaveBeenCalledWith('online', expect.any(Function));
      expect(internals.opportunisticListenersBound).toBe(false);
    } finally {
      documentRemoveSpy.mockRestore();
      windowRemoveSpy.mockRestore();
    }
  });

  it('continues opportunistic listener cleanup when cleanup warning logging throws', async () => {
    const service = context.service();
    await service.ensureLoaded();
    const documentRemoveSpy = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementationOnce(() => {
        throw new Error('visibility cleanup failed');
      });
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');
    context.logger().warn.mockImplementationOnce(() => {
      throw new Error('logger unavailable');
    });
    const internals = service as unknown as { opportunisticListenersBound: boolean };

    try {
      expect(() => TestBed.resetTestingModule()).not.toThrow();
      expect(windowRemoveSpy).toHaveBeenCalledWith('online', expect.any(Function));
      expect(internals.opportunisticListenersBound).toBe(false);
      expect(context.logger().warn).toHaveBeenCalledWith(
        '思源锚点 visibility 监听解绑失败，继续清理其他监听',
        expect.objectContaining({ message: 'visibility cleanup failed' }),
      );
    } finally {
      documentRemoveSpy.mockRestore();
      windowRemoveSpy.mockRestore();
    }
  });

  it('resume sync timer 注册失败时不应打穿恢复事件链路', async () => {
    const service = context.service();
    await service.ensureLoaded();
    const scheduleError = new Error('schedule resume sync failed');
    const setTimeoutSpy = vi
      .spyOn(window, 'setTimeout')
      .mockImplementation(() => {
        throw scheduleError;
      });

    try {
      expect(() => {
        (service as unknown as { scheduleResumeSync: (forceRefresh?: boolean) => void })
          .scheduleResumeSync(true);
      }).not.toThrow();

      expect(context.logger().warn).toHaveBeenCalledWith(
        '思源锚点恢复 timer 注册失败，等待下一次恢复事件重试',
        expect.objectContaining({ message: 'schedule resume sync failed' }),
      );
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('destroy cleanup 清理 resume sync timer 失败时仍应完成销毁', async () => {
    const service = context.service();
    await service.ensureLoaded();
    const timerId = 456 as unknown as ReturnType<typeof window.setTimeout>;
    const setTimeoutSpy = vi
      .spyOn(window, 'setTimeout')
      .mockImplementation(() => timerId);
    const clearTimeoutSpy = vi
      .spyOn(window, 'clearTimeout')
      .mockImplementation(() => {
        throw new Error('clear resume sync failed');
      });

    try {
      (service as unknown as { scheduleResumeSync: (forceRefresh?: boolean) => void })
        .scheduleResumeSync(true);

      expect(() => TestBed.resetTestingModule()).not.toThrow();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId);
      expect(context.logger().warn).toHaveBeenCalledWith(
        '思源锚点恢复 timer 清理失败，继续清理其他资源',
        expect.objectContaining({ message: 'clear resume sync failed' }),
      );
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
}
