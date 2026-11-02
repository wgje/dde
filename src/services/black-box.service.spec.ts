/**
 * BlackBox 服务单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { BlackBoxService } from './black-box.service';
import { BlackBoxSyncService } from './black-box-sync.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { AUTH_CONFIG } from '../config/auth.config';
import { type BlackBoxEntry } from '../models/focus';
import { 
  setBlackBoxEntries 
} from '../state/focus-stores';
import {
  registerBlackBoxLocalHydrationSpecs,
  type BlackBoxLocalHydrationSpecContext,
} from './black-box-local-hydration.spec-helpers';
import {
  registerBlackBoxCreateDurableOwnerFenceSpecs,
  type BlackBoxCreateDurableOwnerFenceSpecContext,
} from './black-box-create-durable-owner-fence.spec-helpers';

describe('BlackBoxService', () => {
  let service: BlackBoxService;
  let mockSyncService: {
    scheduleSync: ReturnType<typeof vi.fn>;
    pullChanges: ReturnType<typeof vi.fn>;
    loadFromLocal: ReturnType<typeof vi.fn>;
    saveToLocal: ReturnType<typeof vi.fn>;
  };
  let mockAuthService: {
    currentUserId: ReturnType<typeof vi.fn>;
    isConfigured: boolean;
    sessionInitialized: ReturnType<typeof vi.fn>;
    authState: ReturnType<typeof vi.fn>;
    runtimeState: ReturnType<typeof vi.fn>;
    peekPersistedSessionIdentity: ReturnType<typeof vi.fn>;
    peekPersistedOwnerHint: ReturnType<typeof vi.fn>;
    captureAuthIdentityFence: ReturnType<typeof vi.fn>;
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
      loadFromLocal: vi.fn().mockResolvedValue([]),
      saveToLocal: vi.fn().mockResolvedValue(undefined),
    };

    mockAuthService = {
      currentUserId: vi.fn().mockReturnValue('test-user'),
      isConfigured: true,
      sessionInitialized: vi.fn().mockReturnValue(true),
      authState: vi.fn().mockReturnValue({ isCheckingSession: false }),
      runtimeState: vi.fn().mockReturnValue('ready'),
      peekPersistedSessionIdentity: vi.fn().mockReturnValue(null),
      peekPersistedOwnerHint: vi.fn().mockReturnValue(null),
      captureAuthIdentityFence: vi.fn().mockReturnValue('fence-a'),
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

  afterEach(() => {
    vi.useRealTimers();
  });

  function getLocalHydrationSpecContext(): BlackBoxLocalHydrationSpecContext {
    return {
      service,
      mockSyncService,
    };
  }

  function getCreateDurableOwnerFenceSpecContext(): BlackBoxCreateDurableOwnerFenceSpecContext {
    return { service, mockAuthService, mockSyncService };
  }

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

    it('本地模式条目应标记为本地已保存而不是远端待同步', () => {
      mockAuthService.currentUserId.mockReturnValue(null);
      localStorage.setItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY, 'true');

      const result = service.create({ content: '本地模式条目' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.syncStatus).toBe('synced');
        expect(mockSyncService.saveToLocal).toHaveBeenCalledWith(expect.objectContaining({
          id: result.value.id,
          syncStatus: 'synced',
          userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
        }));
      }
      expect(mockSyncService.scheduleSync).not.toHaveBeenCalled();
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

    it('createDurably should not expose entry in UI when remote-user local persistence fails', async () => {
      mockSyncService.scheduleSync.mockRejectedValueOnce(new Error('idb write failed'));

      const result = await service.createDurably({ content: '可靠写入' });

      expect(result.ok).toBe(false);
      expect(service.entriesMap().size).toBe(0);
    });

    it('createDurably should expose entry only after durable persistence succeeds', async () => {
      let resolveScheduleSync: (() => void) | null = null;
      mockSyncService.scheduleSync.mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveScheduleSync = resolve;
      }));

      const pending = service.createDurably({ content: '可靠写入' });

      expect(service.entriesMap().size).toBe(0);
      resolveScheduleSync!();
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(service.entriesMap().size).toBe(1);
      expect(Array.from(service.entriesMap().values())[0].content).toBe('可靠写入');
    });

    it('createDurably should reuse durable local entry with the same clientOperationId after memory reset', async () => {
      const existingEntry: BlackBoxEntry = {
        id: '11111111-1111-4111-8111-111111111111',
        projectId: null,
        userId: 'test-user',
        content: '离线语音转写',
        date: '2026-06-15',
        createdAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
        completedAt: null,
        isRead: false,
        isCompleted: false,
        isArchived: false,
        deletedAt: null,
        localCreatedAt: '2026-06-15T00:00:00.000Z',
        snoozeCount: 0,
        syncStatus: 'pending',
        focusMeta: null,
        clientOperationId: 'speech-to-text-offline-replay:audio-1',
      };
      mockSyncService.loadFromLocal.mockResolvedValueOnce([existingEntry]);

      const result = await service.createDurably({
        content: '离线语音转写',
        clientOperationId: existingEntry.clientOperationId,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(existingEntry.id);
      }
      expect(mockSyncService.loadFromLocal).toHaveBeenCalledWith({
        expectedUserId: 'test-user',
        requireCurrentUser: true,
      });
      expect(mockSyncService.scheduleSync).not.toHaveBeenCalled();
      expect(service.entriesMap().get(existingEntry.id)).toEqual(existingEntry);
    });

    it('相同本地 operationId 重放时应复用已有条目而不是重复创建', () => {
      const offlineReplayPayload = {
        content: '离线语音转写',
        clientOperationId: 'speech-offline-audio:audio-1',
      } as Partial<Parameters<BlackBoxService['create']>[0]> & { clientOperationId: string };

      const first = service.create(offlineReplayPayload);
      const second = service.create({ ...offlineReplayPayload });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(second.value.id).toBe(first.value.id);
        expect(service.entriesMap().size).toBe(1);
      }
      expect(mockSyncService.scheduleSync).toHaveBeenCalledTimes(1);
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

    it('已同步条目更新后应重新标记为 pending', () => {
      setBlackBoxEntries([
        {
          id: 'entry-synced',
          projectId: null,
          userId: 'test-user',
          content: '原始内容',
          date: '2026-04-21',
          createdAt: '2026-04-21T00:00:00.000Z',
          updatedAt: '2026-04-21T00:00:00.000Z',
          isRead: false,
          isCompleted: false,
          isArchived: false,
          deletedAt: null,
          syncStatus: 'synced',
        },
      ]);

      const result = service.update('entry-synced', { content: '更新内容' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.syncStatus).toBe('pending');
      }
    });

    it('本地模式条目更新后不应显示为远端待同步', () => {
      setBlackBoxEntries([
        {
          id: 'entry-local-only',
          projectId: null,
          userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
          content: '本地内容',
          date: '2026-04-21',
          createdAt: '2026-04-21T00:00:00.000Z',
          updatedAt: '2026-04-21T00:00:00.000Z',
          isRead: false,
          isCompleted: false,
          isArchived: false,
          deletedAt: null,
          syncStatus: 'synced',
        },
      ]);

      const result = service.update('entry-local-only', { content: '本地更新' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.syncStatus).toBe('synced');
      }
      expect(mockSyncService.saveToLocal).toHaveBeenCalledWith(expect.objectContaining({
        id: 'entry-local-only',
        syncStatus: 'synced',
      }));
      expect(mockSyncService.scheduleSync).not.toHaveBeenCalled();
    });

    it('空 content 更新不能覆盖已有黑匣子正文', () => {
      setBlackBoxEntries([
        {
          id: 'entry-content-guard',
          projectId: null,
          userId: 'test-user',
          content: '保留这段正文',
          date: '2026-04-21',
          createdAt: '2026-04-21T00:00:00.000Z',
          updatedAt: '2026-04-21T00:00:00.000Z',
          isRead: false,
          isCompleted: false,
          isArchived: false,
          deletedAt: null,
          syncStatus: 'synced',
        },
      ]);

      const result = service.update('entry-content-guard', {
        content: '',
        isCompleted: true,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe('保留这段正文');
        expect(result.value.isCompleted).toBe(true);
      }
      expect(mockSyncService.scheduleSync).toHaveBeenCalledWith(expect.objectContaining({
        id: 'entry-content-guard',
        content: '保留这段正文',
        isCompleted: true,
      }));
    });
  });

  describe('markAsRead', () => {
    it('应该标记条目为已读', () => {
      const createResult = service.create({ content: '测试' });
      if (!createResult.ok) throw new Error('Create failed');
      mockSyncService.scheduleSync.mockClear();

      const result = service.markAsRead(createResult.value.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isRead).toBe(true);
      }
      expect(mockSyncService.scheduleSync).toHaveBeenCalledWith(
        expect.objectContaining({ id: createResult.value.id, isRead: true }),
        { immediate: true, widgetNotifyAction: 'read' },
      );
    });

    it('已读但未完成的条目仍应计入黑匣子条目仓数量', () => {
      const createResult = service.create({ content: '仍需处理' });
      if (!createResult.ok) throw new Error('Create failed');

      expect(service.pendingCount()).toBe(1);

      const readResult = service.markAsRead(createResult.value.id);

      expect(readResult.ok).toBe(true);
      expect(service.pendingCount()).toBe(1);
      expect(service.gatePendingCount()).toBe(0);
    });
  });

  describe('markAsReadDurably', () => {
    it('should not expose read state when local persistence fails', async () => {
      const createResult = service.create({ content: '待读内容' });
      if (!createResult.ok) throw new Error('Create failed');
      mockSyncService.scheduleSync.mockClear();
      mockSyncService.scheduleSync.mockRejectedValueOnce(new Error('idb write failed'));

      const result = await service.markAsReadDurably(createResult.value.id);

      expect(result.ok).toBe(false);
      expect(service.entriesMap().get(createResult.value.id)?.isRead).toBe(false);
    });

    it('should expose read state only after durable persistence succeeds', async () => {
      const createResult = service.create({ content: '待读内容' });
      if (!createResult.ok) throw new Error('Create failed');
      mockSyncService.scheduleSync.mockClear();
      let resolveScheduleSync: (() => void) | null = null;
      mockSyncService.scheduleSync.mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveScheduleSync = resolve;
      }));

      const pending = service.markAsReadDurably(createResult.value.id);

      expect(service.entriesMap().get(createResult.value.id)?.isRead).toBe(false);
      resolveScheduleSync!();
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(service.entriesMap().get(createResult.value.id)?.isRead).toBe(true);
    });
  });

  describe('snoozeDurably', () => {
    it('should not expose snoozed state when local persistence fails', async () => {
      const createResult = service.create({ content: '待稍后处理' });
      if (!createResult.ok) throw new Error('Create failed');
      mockSyncService.scheduleSync.mockClear();
      mockSyncService.scheduleSync.mockRejectedValueOnce(new Error('idb write failed'));

      const result = await service.snoozeDurably(createResult.value.id, '2026-06-17');

      expect(result.ok).toBe(false);
      expect(service.entriesMap().get(createResult.value.id)?.snoozeUntil).toBeUndefined();
      expect(service.entriesMap().get(createResult.value.id)?.snoozeCount).toBe(0);
    });

    it('should expose snoozed state only after durable persistence succeeds', async () => {
      const createResult = service.create({ content: '待稍后处理' });
      if (!createResult.ok) throw new Error('Create failed');
      mockSyncService.scheduleSync.mockClear();
      let resolveScheduleSync: (() => void) | null = null;
      mockSyncService.scheduleSync.mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveScheduleSync = resolve;
      }));

      const pending = service.snoozeDurably(createResult.value.id, '2026-06-17');

      expect(service.entriesMap().get(createResult.value.id)?.snoozeUntil).toBeUndefined();
      expect(service.entriesMap().get(createResult.value.id)?.snoozeCount).toBe(0);
      resolveScheduleSync!();
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(service.entriesMap().get(createResult.value.id)?.snoozeUntil).toBe('2026-06-17');
      expect(service.entriesMap().get(createResult.value.id)?.snoozeCount).toBe(1);
    });
  });

  describe('archiveDurably', () => {
    it('should not expose archived state when local persistence fails', async () => {
      const createResult = service.create({ content: '待归档内容' });
      if (!createResult.ok) throw new Error('Create failed');
      mockSyncService.scheduleSync.mockClear();
      mockSyncService.scheduleSync.mockRejectedValueOnce(new Error('idb write failed'));

      const result = await service.archiveDurably(createResult.value.id);

      expect(result.ok).toBe(false);
      expect(service.entriesMap().get(createResult.value.id)?.isArchived).toBe(false);
    });

    it('should expose archived state only after durable persistence succeeds', async () => {
      const createResult = service.create({ content: '待归档内容' });
      if (!createResult.ok) throw new Error('Create failed');
      mockSyncService.scheduleSync.mockClear();
      let resolveScheduleSync: (() => void) | null = null;
      mockSyncService.scheduleSync.mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveScheduleSync = resolve;
      }));

      const pending = service.archiveDurably(createResult.value.id);

      expect(service.entriesMap().get(createResult.value.id)?.isArchived).toBe(false);
      resolveScheduleSync!();
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(service.entriesMap().get(createResult.value.id)?.isArchived).toBe(true);
    });
  });

  describe('markAsCompleted', () => {
    it('应该标记条目为完成', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-03T09:15:00.000Z'));
      const createResult = service.create({ content: '测试' });
      if (!createResult.ok) throw new Error('Create failed');
      mockSyncService.scheduleSync.mockClear();

      const result = service.markAsCompleted(createResult.value.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isCompleted).toBe(true);
        expect(result.value.completedAt).toBe('2026-06-03T09:15:00.000Z');
      }
      expect(mockSyncService.scheduleSync).toHaveBeenCalledWith(
        expect.objectContaining({
          id: createResult.value.id,
          isCompleted: true,
          completedAt: '2026-06-03T09:15:00.000Z',
        }),
        { immediate: true, widgetNotifyAction: 'complete' },
      );
    });

    it('取消完成时应清空完成时间，避免下次完成沿用旧日期', () => {
      setBlackBoxEntries([
        {
          id: 'entry-restore-completed',
          projectId: null,
          userId: 'test-user',
          content: '待恢复',
          date: '2026-05-24',
          createdAt: '2026-05-24T08:00:00.000Z',
          updatedAt: '2026-06-03T09:15:00.000Z',
          completedAt: '2026-06-03T09:15:00.000Z',
          isRead: true,
          isCompleted: true,
          isArchived: false,
          deletedAt: null,
          syncStatus: 'synced',
        },
      ]);

      const result = service.update('entry-restore-completed', { isCompleted: false });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isCompleted).toBe(false);
        expect(result.value.completedAt).toBeNull();
      }
    });

    it('完成后应从黑匣子条目仓数量中移除', () => {
      const createResult = service.create({ content: '完成后移除' });
      if (!createResult.ok) throw new Error('Create failed');

      expect(service.pendingCount()).toBe(1);

      const result = service.markAsCompleted(createResult.value.id);

      expect(result.ok).toBe(true);
      expect(service.pendingCount()).toBe(0);
    });
  });

  describe('getEntriesByDate', () => {
    it('应只返回条目仓可见条目，排除已完成条目', () => {
      setBlackBoxEntries([
        {
          id: 'entry-open',
          projectId: null,
          userId: 'test-user',
          content: '仍在条目仓',
          date: '2026-04-21',
          createdAt: '2026-04-21T01:00:00.000Z',
          updatedAt: '2026-04-21T01:00:00.000Z',
          isRead: true,
          isCompleted: false,
          isArchived: false,
          deletedAt: null,
          syncStatus: 'synced',
        },
        {
          id: 'entry-completed',
          projectId: null,
          userId: 'test-user',
          content: '已进入历史层',
          date: '2026-04-21',
          createdAt: '2026-04-21T02:00:00.000Z',
          updatedAt: '2026-04-21T02:00:00.000Z',
          isRead: true,
          isCompleted: true,
          isArchived: false,
          deletedAt: null,
          syncStatus: 'synced',
        },
      ]);

      expect(service.getEntriesByDate('2026-04-21').map(entry => entry.id)).toEqual(['entry-open']);
    });
  });

  describe('markAsCompletedDurably', () => {
    it('should not expose completed state when local persistence fails', async () => {
      const createResult = service.create({ content: '待完成内容' });
      if (!createResult.ok) throw new Error('Create failed');
      mockSyncService.scheduleSync.mockClear();
      mockSyncService.scheduleSync.mockRejectedValueOnce(new Error('idb write failed'));

      const result = await service.markAsCompletedDurably(createResult.value.id);

      expect(result.ok).toBe(false);
      expect(service.entriesMap().get(createResult.value.id)?.isCompleted).toBe(false);
      expect(service.entriesMap().get(createResult.value.id)?.completedAt).toBeNull();
    });

    it.each([
      { identity: 'stable', transitions: [], publishes: true },
      { identity: 'A→B', transitions: [['user-b', 'fence-b']], publishes: false },
      { identity: 'A→B→A', transitions: [['user-b', 'fence-b'], ['test-user', 'fence-a2']], publishes: false },
      { identity: 'same-owner relogin', transitions: [['test-user', 'fence-a2']], publishes: false },
    ])('publishes only for a stable $identity identity fence', async ({ transitions, publishes }) => {
      const createResult = service.create({ content: '待完成内容' });
      if (!createResult.ok) throw new Error('Create failed');
      mockSyncService.scheduleSync.mockClear();
      const resolvers: Array<() => void> = [];
      mockSyncService.scheduleSync.mockImplementationOnce(() => new Promise<void>(resolve => resolvers.push(resolve)));

      const pending = service.markAsCompletedDurably(createResult.value.id);

      expect(service.entriesMap().get(createResult.value.id)?.isCompleted).toBe(false);
      for (const [owner, fence] of transitions) {
        mockAuthService.currentUserId.mockReturnValue(owner);
        mockAuthService.captureAuthIdentityFence.mockReturnValue(fence);
      }
      const [resolveScheduleSync] = resolvers;
      if (!resolveScheduleSync) throw new Error('scheduleSync resolver was not captured');
      resolveScheduleSync();
      const result = await pending;

      expect(result.ok).toBe(publishes);
      expect(service.entriesMap().get(createResult.value.id)?.isCompleted).toBe(publishes);
    });
  });

  describe('deleteDurably', () => {
    it('should not expose deleted state when local persistence fails', async () => {
      const createResult = service.create({ content: '待删除内容' });
      if (!createResult.ok) throw new Error('Create failed');
      mockSyncService.scheduleSync.mockClear();
      mockSyncService.scheduleSync.mockRejectedValueOnce(new Error('idb write failed'));

      const result = await service.deleteDurably(createResult.value.id);

      expect(result.ok).toBe(false);
      expect(service.entriesMap().get(createResult.value.id)?.deletedAt).toBeNull();
    });

    it('should expose deleted state only after durable persistence succeeds', async () => {
      const createResult = service.create({ content: '待删除内容' });
      if (!createResult.ok) throw new Error('Create failed');
      mockSyncService.scheduleSync.mockClear();
      let resolveScheduleSync: (() => void) | null = null;
      mockSyncService.scheduleSync.mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveScheduleSync = resolve;
      }));

      const pending = service.deleteDurably(createResult.value.id);

      expect(service.entriesMap().get(createResult.value.id)?.deletedAt).toBeNull();
      resolveScheduleSync!();
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(service.entriesMap().get(createResult.value.id)?.deletedAt).toEqual(expect.any(String));
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

    it('删除已同步条目时应立即写入 pending tombstone 到本地状态', () => {
      setBlackBoxEntries([
        {
          id: 'entry-delete',
          projectId: null,
          userId: 'test-user',
          content: '待删除',
          date: '2026-04-21',
          createdAt: '2026-04-21T00:00:00.000Z',
          updatedAt: '2026-04-21T00:00:00.000Z',
          isRead: false,
          isCompleted: false,
          isArchived: false,
          deletedAt: null,
          syncStatus: 'synced',
        },
      ]);

      const result = service.delete('entry-delete');

      expect(result.ok).toBe(true);
      expect(service.getEntry('entry-delete')).toEqual(
        expect.objectContaining({
          id: 'entry-delete',
          deletedAt: expect.any(String),
          updatedAt: expect.any(String),
          syncStatus: 'pending',
        })
      );
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

  registerBlackBoxLocalHydrationSpecs(getLocalHydrationSpecContext);
  registerBlackBoxCreateDurableOwnerFenceSpecs(getCreateDurableOwnerFenceSpecContext);
});
