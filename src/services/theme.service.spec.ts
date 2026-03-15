import { TestBed } from '@angular/core/testing';
import { PLATFORM_ID } from '@angular/core';
import { Meta } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeService } from './theme.service';
import { SimpleSyncService } from '../core-bridge';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';

describe('ThemeService', () => {
  const syncService = {
    loadUserPreferences: vi.fn(),
    saveUserPreferences: vi.fn().mockResolvedValue(undefined),
  };
  const authService = {
    currentUserId: vi.fn(() => null),
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
        { provide: SimpleSyncService, useValue: syncService },
        { provide: AuthService, useValue: authService },
        { provide: ToastService, useValue: toastService },
        { provide: LoggerService, useValue: logger },
      ],
    });

    return TestBed.inject(ThemeService);
  }

  it('setColorMode 应更新 data-color-mode 与本地覆盖缓存', () => {
    const getComputedStyleSpy = vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: () => '',
    } as CSSStyleDeclaration);
    const service = createService();
    const meta = TestBed.inject(Meta);

    service.setColorMode('dark');

    expect(document.documentElement.getAttribute('data-color-mode')).toBe('dark');
    expect(localStorage.getItem('nanoflow.colorMode.local')).toBe(JSON.stringify('dark'));
    expect(meta.getTag('name="theme-color"')?.content).toBe('#1a1a1a');

    getComputedStyleSpy.mockRestore();
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
});
