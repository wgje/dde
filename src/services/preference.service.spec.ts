import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  Injector,
  runInInjectionContext,
  ɵChangeDetectionScheduler as ChangeDetectionScheduler,
  ɵEffectScheduler as EffectScheduler,
} from '@angular/core';
import { PreferenceService } from './preference.service';
import { LoggerService } from './logger.service';
import { RealtimePollingService } from '../app/core/services/sync/realtime-polling.service';
import { UserPreferencesSyncService } from '../app/core/services/sync/user-preferences-sync.service';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { ThemeService } from './theme.service';
import { AUTH_CONFIG } from '../config/auth.config';
import { PendingPreferenceOutboxService } from './pending-preference-outbox.service';
import { UserPreferencesBaselineStore } from './user-preferences-baseline.store';

const mockLoggerCategory = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
};

const mockSyncService = {
  saveUserPreferences: vi.fn(),
  loadUserPreferences: vi.fn(),
  setUserPreferencesChangeCallback: vi.fn(),
};

const mockActionQueue = {
  enqueue: vi.fn(),
  enqueueForOwner: vi.fn(),
  enqueueDurablyForOwner: vi.fn(),
};

const mockPendingPreferenceOutbox = {
  savePendingPreference: vi.fn(),
  readPendingPreference: vi.fn(),
  removePendingPreference: vi.fn(),
};

const mockBaselineStore = {
  read: vi.fn().mockResolvedValue('2026-07-14T01:00:00.000Z'),
};

const mockThemeService = {
  theme: vi.fn(() => 'system'),
  setTheme: vi.fn(),
  loadUserTheme: vi.fn(),
};

const mockChangeDetectionScheduler: ChangeDetectionScheduler = {
  notify: vi.fn(),
  runningTick: false,
};

const mockEffectScheduler: EffectScheduler = {
  schedule: (effect: { run: () => void }) => {
    queueMicrotask(() => effect.run());
  },
  flush: vi.fn(),
  remove: vi.fn(),
};

describe('PreferenceService', () => {
  let service: PreferenceService;
  let currentUserId: string | null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPendingPreferenceOutbox.savePendingPreference.mockResolvedValue(undefined);
    mockPendingPreferenceOutbox.readPendingPreference.mockResolvedValue(null);
    mockPendingPreferenceOutbox.removePendingPreference.mockResolvedValue(undefined);
    mockBaselineStore.read.mockResolvedValue('2026-07-14T01:00:00.000Z');
    localStorage.clear();
    currentUserId = null;
    const injector = Injector.create({
      providers: [
        { provide: PreferenceService, useClass: PreferenceService },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: RealtimePollingService, useValue: mockSyncService },
        { provide: UserPreferencesSyncService, useValue: mockSyncService },
        { provide: ActionQueueService, useValue: mockActionQueue },
        { provide: PendingPreferenceOutboxService, useValue: mockPendingPreferenceOutbox },
        { provide: UserPreferencesBaselineStore, useValue: mockBaselineStore },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => currentUserId) } },
        { provide: ThemeService, useValue: mockThemeService },
        { provide: ChangeDetectionScheduler, useValue: mockChangeDetectionScheduler },
        { provide: EffectScheduler, useValue: mockEffectScheduler },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(PreferenceService));
  });

  describe('signals', () => {
    it('autoResolveConflicts 默认 true', () => {
      if (!service) return;
      expect(service.autoResolveConflicts()).toBe(true);
    });
  });

  describe('setAutoResolveConflicts', () => {
    it('设置为 false', () => {
      if (!service) return;
      service.setAutoResolveConflicts(false);
      expect(service.autoResolveConflicts()).toBe(false);
    });
  });

  describe('loadLocalPreferences', () => {
    it('加载不出错', () => {
      expect(() => service.loadLocalPreferences()).not.toThrow();
    });
  });

  describe('saveUserPreferences', () => {
    it('本地模式用户不应保存云端偏好或加入云端队列', async () => {
      currentUserId = AUTH_CONFIG.LOCAL_MODE_USER_ID;

      const result = await service.saveUserPreferences(AUTH_CONFIG.LOCAL_MODE_USER_ID, { theme: 'default' });

      expect(result).toBe(false);
      expect(mockSyncService.saveUserPreferences).not.toHaveBeenCalled();
      expect(mockActionQueue.enqueueForOwner).not.toHaveBeenCalled();
      expect(mockActionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();
    });

    it('保存偏好应先 durable 入队并从前台链路解耦远端请求', async () => {
      mockActionQueue.enqueueDurablyForOwner.mockResolvedValueOnce('queued-preference');

      const result = await service.saveUserPreferences('user-1', { theme: 'default' });

      expect(result).toBe(true);
      expect(mockSyncService.saveUserPreferences).not.toHaveBeenCalled();
      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          payload: {
            preferences: { theme: 'default' },
            userId: 'user-1',
            sourceUserId: 'user-1',
            baseUpdatedAt: '2026-07-14T01:00:00.000Z',
          },
        }),
      );
    });

    it('成功入队前应合并并清理既有 pending preference，避免旧恢复记录覆盖新变更', async () => {
      mockPendingPreferenceOutbox.readPendingPreference.mockResolvedValue({
        userId: 'user-1',
        preferences: {
          colorMode: 'dark',
          localBackupEnabled: true,
        },
        operationId: '00000000-0000-4000-8000-000000000011',
        baseUpdatedAt: '2026-06-14T23:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
      });
      mockActionQueue.enqueueDurablyForOwner.mockResolvedValueOnce('queued-preference');

      const result = await service.saveUserPreferences('user-1', {
        lastBackupProofAt: '2026-04-23T08:00:00+08:00',
      });

      expect(result).toBe(true);
      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          payload: {
            preferences: {
              colorMode: 'dark',
              localBackupEnabled: true,
              lastBackupProofAt: '2026-04-23T00:00:00.000Z',
            },
            userId: 'user-1',
            sourceUserId: 'user-1',
            baseUpdatedAt: '2026-06-14T23:00:00.000Z',
          },
        }),
      );
      expect(mockPendingPreferenceOutbox.removePendingPreference).toHaveBeenCalledWith('user-1');
      expect(mockPendingPreferenceOutbox.savePendingPreference).not.toHaveBeenCalled();
    });

    it('队列持久化失败时应返回 false 且不尝试远端保存', async () => {
      mockActionQueue.enqueueDurablyForOwner.mockResolvedValueOnce('');

      const result = await service.saveUserPreferences('user-1', { theme: 'ocean' });

      expect(result).toBe(false);
      expect(mockSyncService.saveUserPreferences).not.toHaveBeenCalled();
      expect(mockPendingPreferenceOutbox.savePendingPreference).toHaveBeenCalledWith({
        userId: 'user-1',
        preferences: { theme: 'ocean' },
        operationId: expect.any(String),
        baseUpdatedAt: '2026-07-14T01:00:00.000Z',
      });
      expect(mockLoggerCategory.error).toHaveBeenCalledWith(
        '用户偏好写入离线队列失败',
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('durable 入队异常时应返回 false 并保留 pending preference outbox', async () => {
      mockActionQueue.enqueueDurablyForOwner.mockRejectedValueOnce(new Error('idb unavailable'));

      const result = await service.saveUserPreferences('user-1', { localBackupEnabled: true });

      expect(result).toBe(false);
      expect(mockSyncService.saveUserPreferences).not.toHaveBeenCalled();
      expect(mockPendingPreferenceOutbox.savePendingPreference).toHaveBeenCalledWith({
        userId: 'user-1',
        preferences: { localBackupEnabled: true },
        operationId: expect.any(String),
        baseUpdatedAt: '2026-07-14T01:00:00.000Z',
      });
      expect(mockLoggerCategory.error).toHaveBeenCalledWith(
        '用户偏好写入离线队列异常',
        expect.objectContaining({
          userId: 'user-1',
          error: expect.any(Error),
        }),
      );
    });

    it('加载偏好时应恢复 pending preference Outbox', async () => {
      currentUserId = 'user-1';
      mockPendingPreferenceOutbox.readPendingPreference.mockResolvedValueOnce({
        userId: 'user-1',
        preferences: {
          focusPreferences: {
            gateEnabled: true,
            strataEnabled: true,
            blackBoxEnabled: true,
            maxSnoozePerDay: 3,
            routineResetHourLocal: 5,
            restReminderHighLoadMinutes: 20,
            restReminderLowLoadMinutes: 40,
          },
        },
        operationId: '00000000-0000-4000-8000-000000000003',
        baseUpdatedAt: '2026-06-14T22:00:00.000Z',
        updatedAt: '2026-06-15T00:00:00.000Z',
      });
      mockActionQueue.enqueueDurablyForOwner.mockResolvedValueOnce('restored-preference');

      await service.loadUserPreferences();

      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          operationId: '00000000-0000-4000-8000-000000000003',
          entityType: 'preference',
          entityId: 'user-1',
          payload: expect.objectContaining({
            sourceUserId: 'user-1',
            baseUpdatedAt: '2026-06-14T22:00:00.000Z',
          }),
        }),
      );
      expect(mockPendingPreferenceOutbox.removePendingPreference).toHaveBeenCalledWith('user-1');
    });

    it('恢复 pending preference 入队异常时应保留 pending 并继续加载', async () => {
      currentUserId = 'user-1';
      mockPendingPreferenceOutbox.readPendingPreference.mockResolvedValueOnce({
        userId: 'user-1',
        preferences: { localBackupEnabled: true },
        operationId: '00000000-0000-4000-8000-000000000004',
        updatedAt: '2026-06-15T00:00:00.000Z',
      });
      mockActionQueue.enqueueDurablyForOwner.mockRejectedValueOnce(new Error('queue unavailable'));

      await expect(service.loadUserPreferences()).resolves.toBeUndefined();

      expect(mockPendingPreferenceOutbox.removePendingPreference).not.toHaveBeenCalledWith('user-1');
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        'pending 用户偏好恢复入队失败，保留本地恢复记录',
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('应规范化并缓存 lastBackupProofAt', async () => {
      mockActionQueue.enqueueDurablyForOwner.mockResolvedValueOnce('queued-preference');

      await service.saveUserPreferences('user-1', { lastBackupProofAt: '2026-04-23T08:00:00+08:00' });

      expect(service.lastBackupProofAt()).toBe('2026-04-23T00:00:00.000Z');
      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          payload: expect.objectContaining({
            preferences: {
              lastBackupProofAt: '2026-04-23T00:00:00.000Z',
            },
          }),
        }),
      );
    });
  });

  describe('loadUserPreferences', () => {
    it('本地模式用户不应加载云端备份 proof', async () => {
      currentUserId = AUTH_CONFIG.LOCAL_MODE_USER_ID;

      await service.loadUserPreferences();

      expect(mockThemeService.loadUserTheme).toHaveBeenCalled();
      expect(mockSyncService.loadUserPreferences).not.toHaveBeenCalled();
    });
  });

  describe('local backup cloud sync', () => {
    it('本地模式用户不应同步或加载云端本地备份设置', async () => {
      currentUserId = AUTH_CONFIG.LOCAL_MODE_USER_ID;

      await expect(service.syncLocalBackupSettings({
        autoBackupEnabled: true,
        autoBackupIntervalMs: 30 * 60 * 1000,
      })).resolves.toBe(false);
      await expect(service.loadLocalBackupSettingsFromCloud()).resolves.toBeNull();

      expect(mockSyncService.saveUserPreferences).not.toHaveBeenCalled();
      expect(mockSyncService.loadUserPreferences).not.toHaveBeenCalled();
    });
  });
});
