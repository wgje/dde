import { describe, expect, it, vi } from 'vitest';

import type { BlackBoxService } from './black-box.service';

export interface BlackBoxLocalHydrationSpecContext {
  service: BlackBoxService;
  mockSyncService: {
    loadFromLocal: ReturnType<typeof vi.fn>;
    pullChanges: ReturnType<typeof vi.fn>;
  };
}

export function registerBlackBoxLocalHydrationSpecs(
  getContext: () => BlackBoxLocalHydrationSpecContext,
): void {
  describe('ensureLocalEntriesLoaded', () => {
    it('应在内存为空时从本地水合', async () => {
      const { service, mockSyncService } = getContext();

      await service.ensureLocalEntriesLoaded();

      expect(mockSyncService.loadFromLocal).toHaveBeenCalledTimes(1);
    });

    it('同一用户二次进入时应跳过重复本地水合', async () => {
      const { service, mockSyncService } = getContext();

      await service.ensureLocalEntriesLoaded();

      mockSyncService.loadFromLocal.mockClear();

      await service.ensureLocalEntriesLoaded();

      expect(mockSyncService.loadFromLocal).not.toHaveBeenCalled();
    });

    it('并发调用时应复用同一次本地水合', async () => {
      const { service, mockSyncService } = getContext();
      let resolveLoad: ((entries: never[]) => void) | null = null;
      mockSyncService.loadFromLocal.mockImplementation(() => new Promise(resolve => {
        resolveLoad = resolve as (entries: never[]) => void;
      }));

      const first = service.ensureLocalEntriesLoaded();
      const second = service.ensureLocalEntriesLoaded();

      expect(mockSyncService.loadFromLocal).toHaveBeenCalledTimes(1);

      resolveLoad!([]);
      await Promise.all([first, second]);
    });

    it('首次水合前已有内存条目时仍应补全本地历史快照', async () => {
      const { service, mockSyncService } = getContext();
      const createResult = service.create({ content: '仅内存新增' });
      if (!createResult.ok) throw new Error('Create failed');

      mockSyncService.loadFromLocal.mockClear();

      await service.ensureLocalEntriesLoaded();

      expect(mockSyncService.loadFromLocal).toHaveBeenCalledTimes(1);
    });

    it('水合失败后下次进入应允许重试', async () => {
      const { service, mockSyncService } = getContext();
      mockSyncService.loadFromLocal
        .mockRejectedValueOnce(new Error('load failed'))
        .mockResolvedValueOnce([]);

      await service.ensureLocalEntriesLoaded();
      await service.ensureLocalEntriesLoaded();

      expect(mockSyncService.loadFromLocal).toHaveBeenCalledTimes(2);
    });
  });

  describe('refreshForView', () => {
    it('应先补本地快照，再走轻量远端刷新', async () => {
      const { service, mockSyncService } = getContext();

      await service.refreshForView();

      expect(mockSyncService.loadFromLocal).toHaveBeenCalledTimes(1);
      expect(mockSyncService.pullChanges).toHaveBeenCalledWith({ reason: 'panel-open' });
    });

    it('本地已完成水合时仍应允许面板触发远端补新', async () => {
      const { service, mockSyncService } = getContext();

      await service.ensureLocalEntriesLoaded();
      mockSyncService.loadFromLocal.mockClear();
      mockSyncService.pullChanges.mockClear();

      await service.refreshForView();

      expect(mockSyncService.loadFromLocal).not.toHaveBeenCalled();
      expect(mockSyncService.pullChanges).toHaveBeenCalledWith({ reason: 'panel-open' });
    });
  });
}
