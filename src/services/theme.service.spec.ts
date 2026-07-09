import { TestBed } from '@angular/core/testing';
import { PLATFORM_ID } from '@angular/core';
import { Meta } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeService } from './theme.service';
import { UserPreferencesSyncService } from '../core-bridge';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { ActionQueueService } from './action-queue.service';
import { PendingPreferenceOutboxService } from './pending-preference-outbox.service';

describe('ThemeService', () => {
  const syncService = {
    loadUserPreferences: vi.fn(),
    saveUserPreferences: vi.fn().mockResolvedValue(undefined),
  };
  const authService: {
    currentUserId: ReturnType<typeof vi.fn<() => string | null>>;
  } = {
    currentUserId: vi.fn<() => string | null>(() => null),
  };
  const actionQueue = {
    enqueueDurablyForOwner: vi.fn().mockResolvedValue('queued-preference'),
  };
  const pendingPreferenceOutbox = {
    savePendingPreference: vi.fn().mockResolvedValue(undefined),
    readPendingPreference: vi.fn().mockResolvedValue(null),
    removePendingPreference: vi.fn().mockResolvedValue(undefined),
  };
  const toastService = {
    warning: vi.fn(),
  };
  const logger = {
    category: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    authService.currentUserId.mockReturnValue(null);
    actionQueue.enqueueDurablyForOwner.mockResolvedValue('queued-preference');
    pendingPreferenceOutbox.savePendingPreference.mockResolvedValue(undefined);
    pendingPreferenceOutbox.readPendingPreference.mockResolvedValue(null);
    pendingPreferenceOutbox.removePendingPreference.mockResolvedValue(undefined);
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-color-mode');
    document.documentElement.style.removeProperty('--theme-bg');
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    (window as unknown as { __NANOFLOW_INITIAL_COLOR_MODE__?: string }).__NANOFLOW_INITIAL_COLOR_MODE__ = 'light';
    (window as unknown as { __NANOFLOW_SYSTEM_COLOR_MODE__?: string }).__NANOFLOW_SYSTEM_COLOR_MODE__ = 'light';
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-color-mode');
    localStorage.clear();
  });

  function createService(): ThemeService {
    TestBed.configureTestingModule({
      providers: [
        ThemeService,
        Meta,
        { provide: PLATFORM_ID, useValue: 'browser' },
        { provide: UserPreferencesSyncService, useValue: syncService },
        { provide: AuthService, useValue: authService },
        { provide: ActionQueueService, useValue: actionQueue },
        { provide: PendingPreferenceOutboxService, useValue: pendingPreferenceOutbox },
        { provide: ToastService, useValue: toastService },
        { provide: LoggerService, useValue: logger },
      ],
    });

    return TestBed.inject(ThemeService);
  }

  it('setColorMode 应更新 data-color-mode 与本地覆盖缓存', () => {
    const getComputedStyleSpy = vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration);
    const service = createService();
    const meta = TestBed.inject(Meta);

    service.setColorMode('dark');

    expect(document.documentElement.getAttribute('data-color-mode')).toBe('dark');
    expect(localStorage.getItem('nanoflow.colorMode.local')).toBe(JSON.stringify('dark'));
    expect(meta.getTag('name="theme-color"')?.content).toBe('#1a1a1a');

    getComputedStyleSpy.mockRestore();
  });

  it('setTheme 本地缓存写入失败时不应暴露未持久化主题或写入云端队列', async () => {
    authService.currentUserId.mockReturnValue('user-1');
    const setItemSpy = vi.spyOn(localStorage, 'setItem')
      .mockImplementationOnce(() => {
        throw new Error('quota exceeded');
      });
    const service = createService();

    await expect(service.setTheme('ocean')).resolves.toBe(false);

    expect(service.theme()).toBe('default');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    expect(actionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();
    expect(pendingPreferenceOutbox.savePendingPreference).not.toHaveBeenCalled();

    setItemSpy.mockRestore();
  });

  it('setColorMode 本地缓存写入失败时不应暴露未持久化颜色模式或写入云端队列', async () => {
    authService.currentUserId.mockReturnValue('user-1');
    const setItemSpy = vi.spyOn(localStorage, 'setItem')
      .mockImplementationOnce(() => {
        throw new Error('quota exceeded');
      });
    const service = createService();

    await expect(service.setColorMode('dark')).resolves.toBe(false);

    expect(service.colorMode()).toBe('system');
    expect(document.documentElement.getAttribute('data-color-mode')).toBeNull();
    expect(actionQueue.enqueueDurablyForOwner).not.toHaveBeenCalled();
    expect(pendingPreferenceOutbox.savePendingPreference).not.toHaveBeenCalled();

    setItemSpy.mockRestore();
  });

  it('主题偏好同步应 durable 入队并避免前台直连远端保存', async () => {
    authService.currentUserId.mockReturnValue('user-1');
    const service = createService();

    await service.setTheme('ocean');
    await vi.advanceTimersByTimeAsync(1000);

    expect(syncService.saveUserPreferences).not.toHaveBeenCalled();
    expect(actionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        type: 'update',
        entityType: 'preference',
        entityId: 'user-1',
        payload: expect.objectContaining({
          userId: 'user-1',
          sourceUserId: 'user-1',
          preferences: expect.objectContaining({
            theme: 'ocean',
          }),
        }),
      }),
    );
  });

  it('setTheme 应在本地变更时立即持久化 preference Outbox，不等待防抖定时器', async () => {
    authService.currentUserId.mockReturnValue('user-1');
    const service = createService();

    await service.setTheme('ocean');

    expect(actionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        type: 'update',
        entityType: 'preference',
        entityId: 'user-1',
        payload: expect.objectContaining({
          userId: 'user-1',
          sourceUserId: 'user-1',
          preferences: expect.objectContaining({
            theme: 'ocean',
            colorMode: 'system',
          }),
        }),
      }),
    );
  });

  it('setTheme 成功入队前应合并 pending 偏好，避免清理恢复记录时丢失其他字段', async () => {
    authService.currentUserId.mockReturnValue('user-1');
    pendingPreferenceOutbox.readPendingPreference.mockResolvedValue({
      userId: 'user-1',
      preferences: {
        focusPreferences: {
          gateEnabled: true,
          strataEnabled: true,
          blackBoxEnabled: false,
          maxSnoozePerDay: 4,
          routineResetHourLocal: 6,
          restReminderHighLoadMinutes: 30,
          restReminderLowLoadMinutes: 15,
        },
        localBackupEnabled: true,
      },
      operationId: '00000000-0000-4000-8000-000000000012',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    const service = createService();

    await service.setTheme('ocean');

    expect(actionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        type: 'update',
        entityType: 'preference',
        entityId: 'user-1',
        payload: expect.objectContaining({
          userId: 'user-1',
          sourceUserId: 'user-1',
          preferences: {
            focusPreferences: {
              gateEnabled: true,
              strataEnabled: true,
              blackBoxEnabled: false,
              maxSnoozePerDay: 4,
              routineResetHourLocal: 6,
              restReminderHighLoadMinutes: 30,
              restReminderLowLoadMinutes: 15,
            },
            localBackupEnabled: true,
            theme: 'ocean',
            colorMode: 'system',
          },
        }),
      }),
    );
    expect(pendingPreferenceOutbox.removePendingPreference).toHaveBeenCalledWith('user-1');
    expect(pendingPreferenceOutbox.savePendingPreference).not.toHaveBeenCalled();
  });

  it('setTheme 返回 true 前应等待 ActionQueue durable 恢复点写入完成', async () => {
    authService.currentUserId.mockReturnValue('user-1');
    pendingPreferenceOutbox.readPendingPreference.mockResolvedValueOnce({
      userId: 'user-1',
      preferences: {
        colorMode: 'dark',
      },
      operationId: '00000000-0000-4000-8000-000000000013',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    let resolveEnqueue: ((actionId: string) => void) | null = null;
    actionQueue.enqueueDurablyForOwner.mockImplementationOnce(() => new Promise<string>(resolve => {
      resolveEnqueue = resolve;
    }));
    const service = createService();

    const resultPromise = service.setTheme('forest');
    let resolved = false;
    void resultPromise.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(resolved).toBe(false);
    expect(actionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        type: 'update',
        entityType: 'preference',
        entityId: 'user-1',
      }),
    );

    const completeEnqueue = resolveEnqueue as ((actionId: string) => void) | null;
    expect(completeEnqueue).not.toBeNull();
    completeEnqueue?.('queued-preference');

    await expect(resultPromise).resolves.toBe(true);
    expect(pendingPreferenceOutbox.removePendingPreference).toHaveBeenCalledWith('user-1');
  });

  it('setColorMode 应在本地变更时立即持久化 preference Outbox，不等待防抖定时器', async () => {
    authService.currentUserId.mockReturnValue('user-1');
    const service = createService();

    const resultPromise = service.setColorMode('dark');
    await Promise.resolve();
    await Promise.resolve();

    expect(actionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        type: 'update',
        entityType: 'preference',
        entityId: 'user-1',
        payload: expect.objectContaining({
          userId: 'user-1',
          sourceUserId: 'user-1',
          preferences: expect.objectContaining({
            theme: 'default',
            colorMode: 'dark',
          }),
        }),
      }),
    );
    await expect(resultPromise).resolves.toBe(true);
  });

  it('setColorMode durable 入队异常时应等待 pending preference outbox 写入后再返回 true', async () => {
    authService.currentUserId.mockReturnValue('user-1');
    actionQueue.enqueueDurablyForOwner.mockRejectedValueOnce(new Error('idb unavailable'));
    let resolvePending: (() => void) | null = null;
    pendingPreferenceOutbox.savePendingPreference.mockImplementationOnce(() => new Promise<void>(resolve => {
      resolvePending = resolve;
    }));
    const service = createService();

    const resultPromise = service.setColorMode('dark');
    let resolved = false;
    void resultPromise.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(resolved).toBe(false);
    expect(pendingPreferenceOutbox.savePendingPreference).toHaveBeenCalledWith({
      userId: 'user-1',
      preferences: {
        theme: 'default',
        colorMode: 'dark',
      },
      operationId: expect.any(String),
    });

    const completePendingSave = resolvePending as (() => void) | null;
    expect(completePendingSave).not.toBeNull();
    completePendingSave?.();

    await expect(resultPromise).resolves.toBe(true);
  });

  it('preference durable 入队失败时应保留 pending 快照并在下次加载时恢复入队', async () => {
    authService.currentUserId.mockReturnValue('user-1');
    actionQueue.enqueueDurablyForOwner
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('recovered-preference');
    const service = createService();

    await service.setTheme('forest');
    await vi.runAllTimersAsync();

    expect(pendingPreferenceOutbox.savePendingPreference).toHaveBeenCalledWith({
      userId: 'user-1',
      preferences: {
        theme: 'forest',
        colorMode: 'system',
      },
      operationId: expect.any(String),
    });

    pendingPreferenceOutbox.readPendingPreference.mockResolvedValueOnce({
      userId: 'user-1',
      preferences: {
        theme: 'forest',
        colorMode: 'system',
      },
      operationId: '00000000-0000-4000-8000-000000000001',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });

    await service.loadUserTheme();
    await vi.runAllTimersAsync();

    expect(actionQueue.enqueueDurablyForOwner).toHaveBeenLastCalledWith(
      'user-1',
      expect.objectContaining({
        operationId: '00000000-0000-4000-8000-000000000001',
        entityType: 'preference',
        entityId: 'user-1',
        payload: expect.objectContaining({
          preferences: {
            theme: 'forest',
            colorMode: 'system',
          },
        }),
      }),
    );
    expect(pendingPreferenceOutbox.removePendingPreference).toHaveBeenCalledWith('user-1');
  });

  it('恢复 pending 主题偏好时不应被随后加载的旧云端偏好覆盖', async () => {
    authService.currentUserId.mockReturnValue('user-1');
    localStorage.setItem('nanoflow.theme', 'forest');
    syncService.loadUserPreferences.mockResolvedValueOnce({
      theme: 'ocean',
      colorMode: 'light',
      layoutDirection: 'ltr',
      floatingWindowPref: 'auto',
    });
    pendingPreferenceOutbox.readPendingPreference.mockResolvedValueOnce({
      userId: 'user-1',
      preferences: {
        theme: 'forest',
        colorMode: 'dark',
      },
      operationId: '00000000-0000-4000-8000-000000000004',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    actionQueue.enqueueDurablyForOwner.mockResolvedValueOnce('restored-preference');
    const service = createService();

    await service.loadUserTheme();

    expect(service.theme()).toBe('forest');
    expect(service.colorMode()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('forest');
    expect(document.documentElement.getAttribute('data-color-mode')).toBe('dark');
  });

  it('恢复 pending 主题偏好入队异常时不应阻断加载链路', async () => {
    authService.currentUserId.mockReturnValue('user-1');
    syncService.loadUserPreferences.mockResolvedValueOnce({
      theme: 'ocean',
      colorMode: 'light',
      layoutDirection: 'ltr',
      floatingWindowPref: 'auto',
    });
    pendingPreferenceOutbox.readPendingPreference.mockResolvedValueOnce({
      userId: 'user-1',
      preferences: {
        theme: 'forest',
        colorMode: 'dark',
      },
      operationId: '00000000-0000-4000-8000-000000000005',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    actionQueue.enqueueDurablyForOwner.mockRejectedValueOnce(new Error('idb unavailable'));
    const service = createService();

    await expect(service.loadUserTheme()).resolves.toBeUndefined();

    expect(service.theme()).toBe('forest');
    expect(service.colorMode()).toBe('dark');
    expect(pendingPreferenceOutbox.removePendingPreference).not.toHaveBeenCalledWith('user-1');
  });

  it('setTheme 应更新 data-theme 并同步 theme-color 为当前主题背景色', async () => {
    const getComputedStyleSpy = vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => (name === '--theme-bg' ? '#0c1929' : ''),
    } as CSSStyleDeclaration);
    const service = createService();
    const meta = TestBed.inject(Meta);

    await service.setTheme('ocean');

    expect(document.documentElement.getAttribute('data-theme')).toBe('ocean');
    expect(localStorage.getItem('nanoflow.theme')).toBe('ocean');
    expect(meta.getTag('name="theme-color"')?.content).toBe('#0c1929');

    getComputedStyleSpy.mockRestore();
  });

  it('destroy 时应移除系统颜色偏好监听器', () => {
    const mediaQuery = {
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.mocked(window.matchMedia).mockReturnValue(mediaQuery as unknown as MediaQueryList);

    createService();

    expect(mediaQuery.addEventListener).toHaveBeenCalledTimes(1);
    const [eventName, handler] = mediaQuery.addEventListener.mock.calls[0];

    TestBed.resetTestingModule();

    expect(mediaQuery.removeEventListener).toHaveBeenCalledWith(eventName, handler);
  });
});
