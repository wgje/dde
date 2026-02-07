import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { requireAuthGuard } from './auth.guard';
import { AuthService } from '../auth.service';
import { ModalService } from '../modal.service';
import { LoggerService } from '../logger.service';
import { AUTH_CONFIG, GUARD_CONFIG } from '../../config';

describe('requireAuthGuard', () => {
  const createLoggerServiceMock = () => ({
    category: vi.fn().mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  });

  beforeEach(() => {
    localStorage.removeItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY);
    localStorage.removeItem('nanoflow.auth-cache');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('会话检查进行中，检查完成且拿到 userId 后应放行', async () => {
    vi.useFakeTimers();

    const show = vi.fn();
    let authState = { isCheckingSession: true, userId: null as string | null };
    const authMock = {
      isConfigured: true,
      authState: vi.fn(() => authState),
      currentUserId: vi.fn(() => authState.userId),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: authMock },
        { provide: ModalService, useValue: { show } },
        { provide: LoggerService, useValue: createLoggerServiceMock() },
      ],
    });

    const mockRoute = {} as ActivatedRouteSnapshot;
    const mockState = { url: '/projects' } as RouterStateSnapshot;
    const resultPromise = TestBed.runInInjectionContext(() => requireAuthGuard(mockRoute, mockState));

    setTimeout(() => {
      authState = { isCheckingSession: false, userId: 'user-1' };
    }, 100);
    await vi.advanceTimersByTimeAsync(150);

    const result = await resultPromise;

    expect(result).toBe(true);
    expect(show).not.toHaveBeenCalled();
  });

  it('会话检查超时且无缓存时应阻断并弹登录框', async () => {
    vi.useFakeTimers();

    const show = vi.fn();
    const authMock = {
      isConfigured: true,
      authState: vi.fn().mockReturnValue({ isCheckingSession: true, userId: null }),
      currentUserId: vi.fn().mockReturnValue(null),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: authMock },
        { provide: ModalService, useValue: { show } },
        { provide: LoggerService, useValue: createLoggerServiceMock() },
      ],
    });

    const mockRoute = {} as ActivatedRouteSnapshot;
    const mockState = { url: '/projects' } as RouterStateSnapshot;
    const resultPromise = TestBed.runInInjectionContext(() => requireAuthGuard(mockRoute, mockState));
    await vi.advanceTimersByTimeAsync(GUARD_CONFIG.SESSION_CHECK_TIMEOUT + 100);
    const result = await resultPromise;

    expect(result).toBe(false);
    expect(show).toHaveBeenCalledWith('login', {
      returnUrl: '/projects',
      message: '请登录以访问此页面',
    });
  });

  it('已完成会话检查且未登录时应阻断并弹登录框', async () => {
    const show = vi.fn();
    const authMock = {
      isConfigured: true,
      authState: vi.fn().mockReturnValue({ isCheckingSession: false, userId: null }),
      currentUserId: vi.fn().mockReturnValue(null),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: authMock },
        { provide: ModalService, useValue: { show } },
        { provide: LoggerService, useValue: createLoggerServiceMock() },
      ],
    });

    const mockRoute = {} as ActivatedRouteSnapshot;
    const mockState = { url: '/projects' } as RouterStateSnapshot;
    const result = await TestBed.runInInjectionContext(() => requireAuthGuard(mockRoute, mockState));

    expect(result).toBe(false);
    expect(show).toHaveBeenCalledWith('login', {
      returnUrl: '/projects',
      message: '请登录以访问此页面',
    });
  });
});
