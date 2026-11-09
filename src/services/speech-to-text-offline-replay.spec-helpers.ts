import { describe, expect, it, vi } from 'vitest';
import type { WritableSignal } from '@angular/core';

import type { SpeechToTextService } from './speech-to-text.service';

type MockFn = ReturnType<typeof vi.fn>;

export interface SpeechToTextOfflineReplaySpecContext {
  service(): SpeechToTextService;
  mockAuthService(): {
    currentUserId: WritableSignal<string | null>;
  };
  mockBlackBoxService(): {
    create: MockFn;
    createDurably: MockFn;
  };
  mockToastService(): {
    warning: MockFn;
  };
  mockNetworkAwareness(): {
    isOnline: WritableSignal<boolean>;
  };
}

export function registerSpeechToTextOfflineReplaySpecs(context: SpeechToTextOfflineReplaySpecContext): void {
  describe('processOfflineCache', () => {
    it('应该处理离线缓存', async () => {
      const service = context.service();
      vi.spyOn(service as unknown as { updateOfflinePendingCount: () => Promise<void> }, 'updateOfflinePendingCount')
        .mockResolvedValueOnce();

      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        result: [],
        onsuccess: null,
        onerror: null,
        error: null,
      };
      const store = {
        getAll: vi.fn(() => request),
      };
      const tx = {
        objectStore: vi.fn(() => store),
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      const processing = service.processOfflineCache();
      request.onsuccess?.();

      const results = await processing;
      expect(results).toEqual([]);
    });

    it('应跳过属于其他用户的离线音频缓存', async () => {
      const service = context.service();
      const mockAuthService = context.mockAuthService();

      mockAuthService.currentUserId.set('user-b');
      vi.spyOn(service as unknown as { updateOfflinePendingCount: () => Promise<void> }, 'updateOfflinePendingCount')
        .mockResolvedValueOnce();

      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        result: [
          {
            id: 'audio-1',
            ownerUserId: 'user-a',
            blob: new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
            createdAt: new Date().toISOString(),
            mimeType: 'audio/webm'
          }
        ],
        onsuccess: null,
        onerror: null,
        error: null,
      };
      const store = {
        getAll: vi.fn(() => request),
      };
      const tx = {
        objectStore: vi.fn(() => store),
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      const transcribeSpy = vi.spyOn(service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> }, 'transcribeBlob');

      const processing = service.processOfflineCache();
      request.onsuccess?.();

      const results = await processing;
      expect(results).toEqual([]);
      expect(transcribeSpy).not.toHaveBeenCalled();
    });

    it('回放期间若账号切换则不应创建条目也不应删除缓存', async () => {
      const service = context.service();
      const mockAuthService = context.mockAuthService();
      const mockBlackBoxService = context.mockBlackBoxService();

      mockAuthService.currentUserId.set('user-a');
      vi.spyOn(service as unknown as { updateOfflinePendingCount: () => Promise<void> }, 'updateOfflinePendingCount')
        .mockResolvedValueOnce();

      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        result: [
          {
            id: 'audio-2',
            ownerUserId: 'user-a',
            blob: new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
            createdAt: new Date().toISOString(),
            mimeType: 'audio/webm'
          }
        ],
        onsuccess: null,
        onerror: null,
        error: null,
      };
      const store = {
        getAll: vi.fn(() => request),
      };
      const tx = {
        objectStore: vi.fn(() => store),
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      vi.spyOn(service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> }, 'transcribeBlob')
        .mockImplementationOnce(async () => {
          mockAuthService.currentUserId.set('user-b');
          return '切号后的转写';
        });
      const deleteSpy = vi.spyOn(service as unknown as { deleteFromCache: (id: string) => Promise<void> }, 'deleteFromCache');

      const processing = service.processOfflineCache();
      request.onsuccess?.();

      const results = await processing;
      expect(results).toEqual([]);
      expect(mockBlackBoxService.create).not.toHaveBeenCalled();
      expect(mockBlackBoxService.createDurably).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
    });

    it('离线回放转写应显式使用回放开始时捕获的 owner', async () => {
      const service = context.service();
      const mockAuthService = context.mockAuthService();

      mockAuthService.currentUserId.set('user-a');
      vi.spyOn(service as unknown as { updateOfflinePendingCount: () => Promise<void> }, 'updateOfflinePendingCount')
        .mockResolvedValueOnce();

      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        result: [
          {
            id: 'audio-owner-bound',
            ownerUserId: 'user-a',
            blob: new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
            createdAt: new Date().toISOString(),
            mimeType: 'audio/webm'
          }
        ],
        onsuccess: null,
        onerror: null,
        error: null,
      };
      let tx!: {
        objectStore: ReturnType<typeof vi.fn>;
        oncomplete: (() => void) | null;
        onerror: (() => void) | null;
        onabort: (() => void) | null;
        error: unknown;
      };
      const store = {
        getAll: vi.fn(() => request),
        delete: vi.fn(() => {
          const deleteRequest: { onsuccess: (() => void) | null; onerror: (() => void) | null; error: unknown } = {
            onsuccess: null,
            onerror: null,
            error: null,
          };
          setTimeout(() => {
            deleteRequest.onsuccess?.();
            tx.oncomplete?.();
          }, 0);
          return deleteRequest;
        }),
      };
      tx = {
        objectStore: vi.fn(() => store),
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      const transcribeSpy = vi.spyOn(
        service as unknown as { transcribeBlob: (blob: Blob, owner?: string | null) => Promise<string> },
        'transcribeBlob'
      ).mockResolvedValueOnce('绑定 owner 的转写');

      const processing = service.processOfflineCache();
      request.onsuccess?.();

      await processing;
      expect(transcribeSpy).toHaveBeenCalledWith(expect.any(Blob), 'user-a');
    });

    it('离线回放创建黑匣子条目时应携带稳定 operationId', async () => {
      const service = context.service();
      const mockAuthService = context.mockAuthService();
      const mockBlackBoxService = context.mockBlackBoxService();

      mockAuthService.currentUserId.set('user-a');
      vi.spyOn(service as unknown as { updateOfflinePendingCount: () => Promise<void> }, 'updateOfflinePendingCount')
        .mockResolvedValueOnce();

      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        result: [
          {
            id: 'audio-operation-id',
            ownerUserId: 'user-a',
            blob: new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
            createdAt: new Date().toISOString(),
            mimeType: 'audio/webm'
          }
        ],
        onsuccess: null,
        onerror: null,
        error: null,
      };
      let tx!: {
        objectStore: ReturnType<typeof vi.fn>;
        oncomplete: (() => void) | null;
        onerror: (() => void) | null;
        onabort: (() => void) | null;
        error: unknown;
      };
      const store = {
        getAll: vi.fn(() => request),
        delete: vi.fn(() => {
          const deleteRequest: { onsuccess: (() => void) | null; onerror: (() => void) | null; error: unknown } = {
            onsuccess: null,
            onerror: null,
            error: null,
          };
          setTimeout(() => {
            deleteRequest.onsuccess?.();
            tx.oncomplete?.();
          }, 0);
          return deleteRequest;
        }),
      };
      tx = {
        objectStore: vi.fn(() => store),
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      vi.spyOn(
        service as unknown as { transcribeBlob: (blob: Blob, owner?: string | null) => Promise<string> },
        'transcribeBlob'
      ).mockResolvedValueOnce('带幂等键的转写');

      const processing = service.processOfflineCache();
      request.onsuccess?.();

      await processing;
      expect(mockBlackBoxService.createDurably).toHaveBeenCalledWith(expect.objectContaining({
        content: '带幂等键的转写',
        userId: 'user-a',
        clientOperationId: 'speech-to-text-offline-replay:audio-operation-id',
      }));
      expect(mockBlackBoxService.create).not.toHaveBeenCalled();
    });

    it('durable 黑匣子写入失败时应保留离线缓存等待重试', async () => {
      const service = context.service();
      const mockAuthService = context.mockAuthService();
      const mockBlackBoxService = context.mockBlackBoxService();

      mockAuthService.currentUserId.set('user-a');
      mockBlackBoxService.createDurably.mockResolvedValueOnce({
        ok: false,
        error: { message: 'IDB 写入失败' },
      });
      vi.spyOn(service as unknown as { updateOfflinePendingCount: () => Promise<void> }, 'updateOfflinePendingCount')
        .mockResolvedValueOnce();

      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        result: [
          {
            id: 'audio-durable-fail',
            ownerUserId: 'user-a',
            blob: new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
            createdAt: new Date().toISOString(),
            mimeType: 'audio/webm'
          }
        ],
        onsuccess: null,
        onerror: null,
        error: null,
      };
      const store = {
        getAll: vi.fn(() => request),
        delete: vi.fn(),
      };
      const tx = {
        objectStore: vi.fn(() => store),
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      vi.spyOn(
        service as unknown as { transcribeBlob: (blob: Blob, owner?: string | null) => Promise<string> },
        'transcribeBlob'
      ).mockResolvedValueOnce('无法持久化的转写');

      const processing = service.processOfflineCache();
      request.onsuccess?.();

      await expect(processing).resolves.toEqual([]);
      expect(mockBlackBoxService.createDurably).toHaveBeenCalledWith(expect.objectContaining({
        content: '无法持久化的转写',
        userId: 'user-a',
        clientOperationId: 'speech-to-text-offline-replay:audio-durable-fail',
      }));
      expect(store.delete).not.toHaveBeenCalled();
      expect(mockBlackBoxService.create).not.toHaveBeenCalled();
    });

    it('离线回放遇到瞬时认证错误时应重新安排重试', async () => {
      const service = context.service();
      const mockAuthService = context.mockAuthService();

      mockAuthService.currentUserId.set('user-a');
      vi.spyOn(service as unknown as { updateOfflinePendingCount: () => Promise<void> }, 'updateOfflinePendingCount')
        .mockResolvedValueOnce();

      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        result: [
          {
            id: 'audio-3',
            ownerUserId: 'user-a',
            blob: new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
            createdAt: new Date().toISOString(),
            mimeType: 'audio/webm'
          }
        ],
        onsuccess: null,
        onerror: null,
        error: null,
      };
      const store = {
        getAll: vi.fn(() => request),
      };
      const tx = {
        objectStore: vi.fn(() => store),
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      vi.spyOn(service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> }, 'transcribeBlob')
        .mockRejectedValueOnce(new Error('SESSION_TEMPORARILY_UNAVAILABLE'));
      const scheduleSpy = vi.spyOn(service as unknown as { scheduleOfflineCacheReplay: (reason: string) => void }, 'scheduleOfflineCacheReplay')
        .mockImplementation(() => undefined);

      const processing = service.processOfflineCache();
      request.onsuccess?.();

      const results = await processing;
      expect(results).toEqual([]);
      expect(scheduleSpy).toHaveBeenCalledWith('offline-replay-retryable-error', 1500);
    });

    it('重复触发回放时不应取消已安排的瞬时错误重试', async () => {
      vi.useFakeTimers();
      const service = context.service();
      const mockAuthService = context.mockAuthService();

      mockAuthService.currentUserId.set('user-a');

      let releasePendingCount!: () => void;
      const pendingCountUpdate = new Promise<void>(resolve => {
        releasePendingCount = resolve;
      });
      vi.spyOn(service as unknown as { updateOfflinePendingCount: () => Promise<void> }, 'updateOfflinePendingCount')
        .mockImplementationOnce(() => pendingCountUpdate)
        .mockResolvedValue(undefined);

      const requests: Array<{
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      }> = [];
      const getAll = vi.fn(() => {
        const request: {
          result: unknown[];
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
          error: unknown;
        } = {
          result: requests.length === 0
            ? [{
                id: 'audio-retry-race',
                ownerUserId: 'user-a',
                blob: new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
                createdAt: new Date().toISOString(),
                mimeType: 'audio/webm'
              }]
            : [],
          onsuccess: null,
          onerror: null,
          error: null,
        };
        requests.push(request);
        if (requests.length > 1) {
          setTimeout(() => request.onsuccess?.(), 0);
        }
        return request;
      });
      const store = { getAll };
      const tx = {
        objectStore: vi.fn(() => store),
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      vi.spyOn(service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> }, 'transcribeBlob')
        .mockRejectedValueOnce(new Error('SESSION_TEMPORARILY_UNAVAILABLE'));
      const scheduleSpy = vi.spyOn(
        service as unknown as { scheduleOfflineCacheReplay: (reason: string, delayMs?: number) => void },
        'scheduleOfflineCacheReplay'
      );

      const replayRunner = service as unknown as { runOfflineCacheReplay: (reason: string) => Promise<void> };
      const firstRun = replayRunner.runOfflineCacheReplay('initial-retryable-error');
      const readSuccess = requests[0]?.onsuccess;
      if (!readSuccess) {
        throw new Error('offline replay read success should be assigned before invocation');
      }
      readSuccess();

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(scheduleSpy).toHaveBeenCalledWith('offline-replay-retryable-error', 1500);

      const duplicateRun = replayRunner.runOfflineCacheReplay('session-restored');
      expect(duplicateRun).toBe(firstRun);
      expect((service as unknown as { recoveryReplayTimeout: unknown | null }).recoveryReplayTimeout).not.toBeNull();
      releasePendingCount();
      await Promise.all([firstRun, duplicateRun]);
      expect((service as unknown as { recoveryReplayTimeout: unknown | null }).recoveryReplayTimeout).not.toBeNull();
      expect(getAll).toHaveBeenCalledTimes(1);
    });

    it('回放中途掉线时应停止本批剩余转写', async () => {
      const service = context.service();
      const mockAuthService = context.mockAuthService();
      const mockNetworkAwareness = context.mockNetworkAwareness();

      mockAuthService.currentUserId.set('user-a');
      mockNetworkAwareness.isOnline.set(true);
      vi.spyOn(service as unknown as { updateOfflinePendingCount: () => Promise<void> }, 'updateOfflinePendingCount')
        .mockResolvedValueOnce();

      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        result: [
          {
            id: 'audio-offline-1',
            ownerUserId: 'user-a',
            blob: new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
            createdAt: new Date().toISOString(),
            mimeType: 'audio/webm'
          },
          {
            id: 'audio-offline-2',
            ownerUserId: 'user-a',
            blob: new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
            createdAt: new Date().toISOString(),
            mimeType: 'audio/webm'
          }
        ],
        onsuccess: null,
        onerror: null,
        error: null,
      };
      const store = {
        getAll: vi.fn(() => request),
      };
      const tx = {
        objectStore: vi.fn(() => store),
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      const transcribeSpy = vi.spyOn(service as unknown as { transcribeBlob: (blob: Blob) => Promise<string> }, 'transcribeBlob')
        .mockImplementationOnce(async () => {
          mockNetworkAwareness.isOnline.set(false);
          throw new TypeError('Network request failed');
        });

      const processing = service.processOfflineCache();
      request.onsuccess?.();

      const results = await processing;
      expect(results).toEqual([]);
      expect(transcribeSpy).toHaveBeenCalledTimes(1);
    });

    it('应隔离缺少 ownerUserId 的旧版离线缓存', async () => {
      const service = context.service();
      const mockToastService = context.mockToastService();

      const request: {
        result: unknown[];
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      } = {
        result: [
          {
            id: 'legacy-audio',
            blob: new Blob([new Uint8Array(1600)], { type: 'audio/webm' }),
            createdAt: new Date().toISOString(),
            mimeType: 'audio/webm'
          }
        ],
        onsuccess: null,
        onerror: null,
      };
      const put = vi.fn();
      const store = {
        getAll: vi.fn(() => request),
        put,
      };
      const tx: {
        objectStore: ReturnType<typeof vi.fn>;
        oncomplete: (() => void) | null;
        onerror: (() => void) | null;
        error: unknown;
      } = {
        objectStore: vi.fn(() => store),
        oncomplete: null,
        onerror: null,
        error: null,
      };
      (service as unknown as { db: { transaction: (name: string, mode: string) => unknown } }).db = {
        transaction: vi.fn(() => tx),
      };

      const migrating = (service as unknown as { migrateLegacyOfflineAudioOwners: () => Promise<void> }).migrateLegacyOfflineAudioOwners();
      request.onsuccess?.();
      tx.oncomplete?.();
      await migrating;

      expect(put).toHaveBeenCalledWith(expect.objectContaining({
        id: 'legacy-audio',
        ownerUserId: '__legacy_unknown_owner__'
      }));
      expect(mockToastService.warning).toHaveBeenCalledWith(
        '发现旧版离线录音',
        '为避免转入错误账号，旧缓存录音已被隔离，不会自动转写'
      );
    });
  });
}
