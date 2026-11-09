import { beforeEach, describe, expect, FEATURE_FLAGS, it } from './sync-coordinator.service.spec-context';
import type { SyncCoordinatorService } from './sync-coordinator.service.spec-context';
import type { SyncCoordinatorOfflineMergeSpecContext } from './sync-coordinator-offline-merge.spec-helpers';

export function registerSyncCoordinatorBlackBoxWatermarkSpecs(
  context: SyncCoordinatorOfflineMergeSpecContext,
): void {
  let service: SyncCoordinatorService;
  let mockSyncService: any;
  let mockAuthService: any;
  let mockBlackBoxSyncService: any;

  beforeEach(() => {
    service = context.service();
    mockSyncService = context.mockSyncService();
    mockAuthService = context.mockAuthService();
    mockBlackBoxSyncService = context.mockBlackBoxSyncService();
  });

  describe('black-box manifest watermark refresh', () => {
    it('refreshBlackBoxWatermarkIfNeeded 命中快路时应跳过明细拉取', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).BLACKBOX_WATERMARK_PROBE_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.blackbox-manifest-watermark.user-123', '2026-02-16T10:00:00.000Z');
      mockSyncService.getBlackBoxSyncWatermark.mockResolvedValueOnce('2026-02-16T10:00:00.000Z');

      const result = await service.refreshBlackBoxWatermarkIfNeeded('resume:test');

      expect(result).toEqual({
        skipped: true,
        watermark: '2026-02-16T10:00:00.000Z',
      });
      expect(mockBlackBoxSyncService.pullChanges).not.toHaveBeenCalled();
    });

    it('refreshBlackBoxWatermarkIfNeeded 远端前进时应拉取并更新本地水位', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).BLACKBOX_WATERMARK_PROBE_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.blackbox-manifest-watermark.user-123', '2026-02-16T10:00:00.000Z');
      mockSyncService.getBlackBoxSyncWatermark.mockResolvedValueOnce('2026-02-16T10:05:00.000Z');

      const result = await service.refreshBlackBoxWatermarkIfNeeded('resume:test');

      expect(result).toEqual({
        skipped: false,
        watermark: '2026-02-16T10:05:00.000Z',
      });
      expect(mockBlackBoxSyncService.pullChanges).toHaveBeenCalledWith({ reason: 'resume' });
      expect(localStorage.getItem('nanoflow.blackbox-manifest-watermark.user-123')).toBe('2026-02-16T10:05:00.000Z');
    });

    it('refreshBlackBoxWatermarkIfNeeded 使用预加载水位时不应重复调用 RPC', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).BLACKBOX_WATERMARK_PROBE_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.blackbox-manifest-watermark.user-123', '2026-02-16T10:00:00.000Z');

      const result = await service.refreshBlackBoxWatermarkIfNeeded('resume:test', {
        prefetchedRemoteWatermark: '2026-02-16T10:00:00.000Z',
      });

      expect(result).toEqual({
        skipped: true,
        watermark: '2026-02-16T10:00:00.000Z',
      });
      expect(mockSyncService.getBlackBoxSyncWatermark).not.toHaveBeenCalled();
      expect(mockBlackBoxSyncService.pullChanges).not.toHaveBeenCalled();
    });

    it('refreshBlackBoxWatermarkIfNeeded 远端水位返回前 owner 变化时不应拉取或写入旧结果', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).BLACKBOX_WATERMARK_PROBE_V1 = true;
      localStorage.setItem('nanoflow.blackbox-manifest-watermark.user-123', '2026-02-16T10:00:00.000Z');
      localStorage.setItem('nanoflow.blackbox-manifest-watermark.user-456', '2026-02-16T09:00:00.000Z');
      let resolveRemoteWatermark!: (watermark: string) => void;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      mockSyncService.getBlackBoxSyncWatermark.mockReturnValueOnce(new Promise<string>(resolve => {
        resolveRemoteWatermark = resolve;
      }));

      const refreshing = service.refreshBlackBoxWatermarkIfNeeded('resume:stale-owner');
      await Promise.resolve();

      mockAuthService.currentUserId.mockReturnValue('user-456');
      resolveRemoteWatermark('2026-02-16T10:05:00.000Z');

      const result = await refreshing;

      expect(result).toEqual({
        skipped: true,
        watermark: '2026-02-16T10:05:00.000Z',
      });
      expect(mockBlackBoxSyncService.pullChanges).not.toHaveBeenCalled();
      expect(localStorage.getItem('nanoflow.blackbox-manifest-watermark.user-123')).toBe('2026-02-16T10:00:00.000Z');
      expect(localStorage.getItem('nanoflow.blackbox-manifest-watermark.user-456')).toBe('2026-02-16T09:00:00.000Z');
    });

    it('refreshBlackBoxWatermarkIfNeeded 并发刷新晚到时不应回退本地水位', async () => {
      (FEATURE_FLAGS as unknown as Record<string, boolean>).BLACKBOX_WATERMARK_PROBE_V1 = true;
      mockAuthService.currentUserId.mockReturnValue('user-123');
      localStorage.setItem('nanoflow.blackbox-manifest-watermark.user-123', '2026-02-16T10:00:00.000Z');
      let resolveFirstPull!: () => void;
      mockSyncService.getBlackBoxSyncWatermark.mockReset();
      mockBlackBoxSyncService.pullChanges.mockReset();
      mockSyncService.getBlackBoxSyncWatermark
        .mockResolvedValueOnce('2026-02-16T10:05:00.000Z')
        .mockResolvedValueOnce('2026-02-16T10:10:00.000Z');
      mockBlackBoxSyncService.pullChanges
        .mockReturnValueOnce(new Promise<void>(resolve => {
          resolveFirstPull = resolve;
        }))
        .mockResolvedValueOnce(undefined);

      const first = service.refreshBlackBoxWatermarkIfNeeded('resume:race:first');
      await Promise.resolve();
      const second = service.refreshBlackBoxWatermarkIfNeeded('resume:race:second');

      await second;
      resolveFirstPull();
      await first;

      expect(localStorage.getItem('nanoflow.blackbox-manifest-watermark.user-123')).toBe('2026-02-16T10:10:00.000Z');
    });
  });
}
