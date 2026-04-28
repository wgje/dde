import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  Injector,
  runInInjectionContext,
  ɵChangeDetectionScheduler as ChangeDetectionScheduler,
  ɵEffectScheduler as EffectScheduler,
} from '@angular/core';
import { PreferenceService } from './preference.service';
import { LoggerService } from './logger.service';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { ThemeService } from './theme.service';

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

  beforeEach(() => {
    vi.clearAllMocks();
    const injector = Injector.create({
      providers: [
        { provide: PreferenceService, useClass: PreferenceService },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: ActionQueueService, useValue: mockActionQueue },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => null) } },
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
    it('云端失败时入队的 payload 应携带 sourceUserId', async () => {
      mockSyncService.saveUserPreferences.mockResolvedValueOnce(false);

      await service.saveUserPreferences('user-1', { theme: 'default' });

      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          payload: {
            preferences: { theme: 'default' },
            userId: 'user-1',
            sourceUserId: 'user-1',
          },
        }),
      );
    });

    it('云端异常时入队的 payload 应携带 sourceUserId', async () => {
      mockSyncService.saveUserPreferences.mockRejectedValueOnce(new Error('network down'));

      await service.saveUserPreferences('user-1', { layoutDirection: 'ltr' });

      expect(mockActionQueue.enqueueForOwner).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          payload: {
            preferences: { layoutDirection: 'ltr' },
            userId: 'user-1',
            sourceUserId: 'user-1',
          },
        }),
      );
    });

    it('应规范化并缓存 lastBackupProofAt', async () => {
      mockSyncService.saveUserPreferences.mockResolvedValueOnce(true);

      await service.saveUserPreferences('user-1', { lastBackupProofAt: '2026-04-23T08:00:00+08:00' });

      expect(service.lastBackupProofAt()).toBe('2026-04-23T00:00:00.000Z');
      expect(mockSyncService.saveUserPreferences).toHaveBeenCalledWith('user-1', {
        lastBackupProofAt: '2026-04-23T00:00:00.000Z',
      });
    });
  });
});
