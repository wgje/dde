/**
 * BlackBox 服务单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { BlackBoxService } from './black-box.service';
import { BlackBoxSyncService } from './black-box-sync.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { AUTH_CONFIG } from '../config/auth.config';
import { 
  setBlackBoxEntries 
} from '../state/focus-stores';

describe('BlackBoxService', () => {
  let service: BlackBoxService;
  let mockSyncService: {
    scheduleSync: ReturnType<typeof vi.fn>;
    pullChanges: ReturnType<typeof vi.fn>;
    loadFromLocal: ReturnType<typeof vi.fn>;
  };
  let mockAuthService: {
    currentUserId: ReturnType<typeof vi.fn>;
    isConfigured: boolean;
  };
  let mockProjectStateService: {
    activeProjectId: ReturnType<typeof signal>;
  };

  beforeEach(() => {
    // 重置状态
    setBlackBoxEntries([]);
    localStorage.removeItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY);

    mockSyncService = {
      scheduleSync: vi.fn(),
      pullChanges: vi.fn().mockResolvedValue(undefined),
      loadFromLocal: vi.fn().mockResolvedValue([])
    };

    mockAuthService = {
      currentUserId: vi.fn().mockReturnValue('test-user'),
      isConfigured: true
    };

    mockProjectStateService = {
      activeProjectId: signal('test-project')
    };

    TestBed.configureTestingModule({
      providers: [
        BlackBoxService,
        { provide: BlackBoxSyncService, useValue: mockSyncService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ProjectStateService, useValue: mockProjectStateService },
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            })),
          },
        }
      ]
    });

    service = TestBed.inject(BlackBoxService);
  });

  describe('create', () => {
    it('应该创建新条目', () => {
      const result = service.create({ content: '测试内容' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe('测试内容');
        expect(result.value.userId).toBe('test-user');
        expect(result.value.projectId).toBeNull();
      }
    });

    it('无用户时应该返回错误', () => {
      mockAuthService.currentUserId.mockReturnValue(null);

      const result = service.create({ content: '测试内容' });

      expect(result.ok).toBe(false);
    });

    it('本地模式下无用户时应该回退到 local-user', () => {
      mockAuthService.currentUserId.mockReturnValue(null);
      localStorage.setItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY, 'true');

      const result = service.create({ content: '本地模式条目' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userId).toBe(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      }
    });

    it('未配置 Supabase 时无用户也应该回退到 local-user', () => {
      mockAuthService.currentUserId.mockReturnValue(null);
      mockAuthService.isConfigured = false;

      const result = service.create({ content: '开发模式条目' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userId).toBe(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      }
    });

    it('应该调用同步服务', () => {
      service.create({ content: '测试内容' });

      expect(mockSyncService.scheduleSync).toHaveBeenCalled();
    });

    it('should preserve focusMeta for inline focus-console entries', () => {
      const result = service.create({
        content: 'inline detail',
        focusMeta: {
          source: 'focus-console-inline',
          sessionId: 'session-1',
          title: 'Inline task',
          detail: 'inline detail',
          lane: 'combo-select',
          expectedMinutes: 25,
          waitMinutes: 5,
          cognitiveLoad: 'high',
          dockEntryId: 'dock-entry-1',
        },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.focusMeta).toEqual({
          source: 'focus-console-inline',
          sessionId: 'session-1',
          title: 'Inline task',
          detail: 'inline detail',
          lane: 'combo-select',
          expectedMinutes: 25,
          waitMinutes: 5,
          cognitiveLoad: 'high',
          dockEntryId: 'dock-entry-1',
        });
      }
    });
  });

  describe('update', () => {
    it('应该更新已有条目', () => {
      const createResult = service.create({ content: '原始内容' });
      if (!createResult.ok) throw new Error('Create failed');

      const result = service.update(createResult.value.id, { content: '更新内容' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe('更新内容');
      }
    });

    it('条目不存在时应该返回错误', () => {
      const result = service.update('non-existent-id', { content: '更新' });

      expect(result.ok).toBe(false);
    });
  });

  describe('markAsRead', () => {
    it('应该标记条目为已读', () => {
      const createResult = service.create({ content: '测试' });
      if (!createResult.ok) throw new Error('Create failed');

      const result = service.markAsRead(createResult.value.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isRead).toBe(true);
      }
    });
  });

  describe('markAsCompleted', () => {
    it('应该标记条目为完成', () => {
      const createResult = service.create({ content: '测试' });
      if (!createResult.ok) throw new Error('Create failed');

      const result = service.markAsCompleted(createResult.value.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isCompleted).toBe(true);
      }
    });
  });

  describe('delete', () => {
    it('应该软删除条目', () => {
      const createResult = service.create({ content: '测试' });
      if (!createResult.ok) throw new Error('Create failed');

      const result = service.delete(createResult.value.id);

      expect(result.ok).toBe(true);
    });

    it('条目不存在时应该返回错误', () => {
      const result = service.delete('non-existent-id');

      expect(result.ok).toBe(false);
    });
  });

  describe('getEntry', () => {
    it('应该返回指定条目', () => {
      const createResult = service.create({ content: '测试' });
      if (!createResult.ok) throw new Error('Create failed');

      const entry = service.getEntry(createResult.value.id);

      expect(entry).toBeDefined();
      expect(entry?.content).toBe('测试');
    });

    it('不存在时应该返回 undefined', () => {
      const entry = service.getEntry('non-existent-id');

      expect(entry).toBeUndefined();
    });
  });

  describe('ensureLocalEntriesLoaded', () => {
    it('应在内存为空时从本地水合', async () => {
      await service.ensureLocalEntriesLoaded();

      expect(mockSyncService.loadFromLocal).toHaveBeenCalledTimes(1);
    });

    it('同一用户二次进入时应跳过重复本地水合', async () => {
      await service.ensureLocalEntriesLoaded();

      mockSyncService.loadFromLocal.mockClear();

      await service.ensureLocalEntriesLoaded();

      expect(mockSyncService.loadFromLocal).not.toHaveBeenCalled();
    });

    it('并发调用时应复用同一次本地水合', async () => {
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
      const createResult = service.create({ content: '仅内存新增' });
      if (!createResult.ok) throw new Error('Create failed');

      mockSyncService.loadFromLocal.mockClear();

      await service.ensureLocalEntriesLoaded();

      expect(mockSyncService.loadFromLocal).toHaveBeenCalledTimes(1);
    });

    it('水合失败后下次进入应允许重试', async () => {
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
      await service.refreshForView();

      expect(mockSyncService.loadFromLocal).toHaveBeenCalledTimes(1);
      expect(mockSyncService.pullChanges).toHaveBeenCalledWith({ reason: 'panel-open' });
    });

    it('本地已完成水合时仍应允许面板触发远端补新', async () => {
      await service.ensureLocalEntriesLoaded();
      mockSyncService.loadFromLocal.mockClear();
      mockSyncService.pullChanges.mockClear();

      await service.refreshForView();

      expect(mockSyncService.loadFromLocal).not.toHaveBeenCalled();
      expect(mockSyncService.pullChanges).toHaveBeenCalledWith({ reason: 'panel-open' });
    });
  });
});
