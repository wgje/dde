import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppAuthCoordinatorService } from './app-auth-coordinator.service';
import { AuthService } from '../../../services/auth.service';
import { UserSessionService } from '../../../services/user-session.service';
import { ProjectStateService } from '../../../services/project-state.service';
import { ModalService } from '../../../services/modal.service';
import { ToastService } from '../../../services/toast.service';
import { LoggerService } from '../../../services/logger.service';
import { OptimisticStateService } from '../../../services/optimistic-state.service';
import { UndoService } from '../../../services/undo.service';

vi.mock('../../../services/attachment.service', () => ({
  AttachmentService: class AttachmentService {},
}));

vi.mock('../../../services/migration.service', () => ({
  MigrationService: class MigrationService {},
}));

import { AttachmentService } from '../../../services/attachment.service';
import { MigrationService } from '../../../services/migration.service';

function setup(options?: {
  injectorGet?: (token: unknown) => unknown;
}) {
  const userId = signal<string | null>(null);
  const projects = signal<Array<{ id: string }>>([]);
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const defaultAttachmentService = {
    onUserLogout: vi.fn(),
  };
  const defaultMigrationService = {
    checkMigrationNeeded: vi.fn(() => false),
  };

  const injectorGet = vi.fn((token: unknown) => {
    if (options?.injectorGet) {
      return options.injectorGet(token);
    }
    if (token === AttachmentService) return defaultAttachmentService;
    if (token === MigrationService) return defaultMigrationService;
    throw new Error('unknown token');
  });

  const authMock = {
    isConfigured: true,
    currentUserId: userId,
    sessionEmail: vi.fn(() => null),
    signOut: vi.fn().mockResolvedValue(undefined),
    signIn: vi.fn(),
    signUp: vi.fn(),
    checkSession: vi.fn(),
    resetPassword: vi.fn(),
  };

  const userSessionMock = {
    currentUserId: userId,
    setCurrentUser: vi.fn().mockResolvedValue(undefined),
    clearAllLocalData: vi.fn().mockResolvedValue(undefined),
    loadProjects: vi.fn().mockResolvedValue(undefined),
  };

  const modalMock = {
    isOpen: vi.fn(() => false),
    getData: vi.fn(() => undefined),
    closeByType: vi.fn(),
    show: vi.fn(),
  };

  const toastMock = {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  };

  const routerMock = {
    navigateByUrl: vi.fn().mockResolvedValue(true),
  };

  TestBed.configureTestingModule({
    providers: [
      AppAuthCoordinatorService,
      { provide: Injector, useValue: { get: injectorGet } },
      { provide: AuthService, useValue: authMock },
      { provide: UserSessionService, useValue: userSessionMock },
      { provide: ProjectStateService, useValue: { projects } },
      { provide: ModalService, useValue: modalMock },
      { provide: ToastService, useValue: toastMock },
      {
        provide: LoggerService,
        useValue: {
          category: vi.fn(() => logger),
        },
      },
      {
        provide: OptimisticStateService,
        useValue: {
          onUserLogout: vi.fn(),
        },
      },
      {
        provide: UndoService,
        useValue: {
          onUserLogout: vi.fn(),
        },
      },
      { provide: Router, useValue: routerMock },
    ],
  });

  return {
    service: TestBed.inject(AppAuthCoordinatorService),
    injectorGet,
    defaultAttachmentService,
    defaultMigrationService,
    logger,
    authMock,
    userSessionMock,
    modalMock,
    toastMock,
    routerMock,
    userId,
  };
}

describe('AppAuthCoordinatorService lazy dependency loading', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('getAttachmentServiceLazy 首次并发请求应 single-flight 且返回同一实例', async () => {
    const { service, injectorGet, defaultAttachmentService } = setup();

    const [first, second] = await Promise.all([
      service.getAttachmentServiceLazy(),
      service.getAttachmentServiceLazy(),
    ]);

    expect(first).toBe(defaultAttachmentService);
    expect(second).toBe(defaultAttachmentService);
    expect(injectorGet).toHaveBeenCalledTimes(1);
    expect(injectorGet).toHaveBeenCalledWith(AttachmentService);
  });

  it('getMigrationServiceLazy 首次并发请求应 single-flight 且返回同一实例', async () => {
    const { service, injectorGet, defaultMigrationService } = setup();

    const [first, second] = await Promise.all([
      service.getMigrationServiceLazy(),
      service.getMigrationServiceLazy(),
    ]);

    expect(first).toBe(defaultMigrationService);
    expect(second).toBe(defaultMigrationService);
    expect(injectorGet).toHaveBeenCalledTimes(1);
    expect(injectorGet).toHaveBeenCalledWith(MigrationService);
  });

  it('lazy 解析失败时应降级返回 null（不抛出到调用方）', async () => {
    const { service, logger } = setup({
      injectorGet: (token: unknown) => {
        if (token === MigrationService) {
          throw new Error('inject failed');
        }
        if (token === AttachmentService) {
          return { onUserLogout: vi.fn() };
        }
        throw new Error('unknown token');
      },
    });

    const result = await service.getMigrationServiceLazy();

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('isLoginData type guard (tested indirectly via handleLogin)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('should navigate to returnUrl when modal data is a valid LoginData with returnUrl', async () => {
    const { service, authMock, modalMock, routerMock } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
    modalMock.getData.mockReturnValue({ returnUrl: '/dashboard' });

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();

    expect(routerMock.navigateByUrl).toHaveBeenCalledWith('/dashboard');
  });

  it('should not navigate when modal data is null', async () => {
    const { service, authMock, modalMock, routerMock } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
    modalMock.getData.mockReturnValue(null);

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();

    expect(routerMock.navigateByUrl).not.toHaveBeenCalled();
  });

  it('should not navigate when modal data is undefined', async () => {
    const { service, authMock, modalMock, routerMock } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
    modalMock.getData.mockReturnValue(undefined);

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();

    expect(routerMock.navigateByUrl).not.toHaveBeenCalled();
  });

  it('should not navigate when modal data is a number', async () => {
    const { service, authMock, modalMock, routerMock } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
    modalMock.getData.mockReturnValue(42);

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();

    expect(routerMock.navigateByUrl).not.toHaveBeenCalled();
  });

  it('should not navigate when modal data is a string', async () => {
    const { service, authMock, modalMock, routerMock } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
    modalMock.getData.mockReturnValue('some-string');

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();

    expect(routerMock.navigateByUrl).not.toHaveBeenCalled();
  });

  it('should not navigate when modal data is an object without returnUrl property', async () => {
    const { service, authMock, modalMock, routerMock } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
    modalMock.getData.mockReturnValue({ message: 'hello' });

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();

    expect(routerMock.navigateByUrl).not.toHaveBeenCalled();
  });

  it('should not navigate when returnUrl is "/" (root path excluded)', async () => {
    const { service, authMock, modalMock, routerMock } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
    modalMock.getData.mockReturnValue({ returnUrl: '/' });

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();

    expect(routerMock.navigateByUrl).not.toHaveBeenCalled();
  });
});

describe('handleSignup timeout protection', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should complete normally when setCurrentUser resolves before the 8s timeout', async () => {
    const { service, authMock, userSessionMock, toastMock, modalMock, userId } = setup();
    authMock.signUp.mockImplementation(async () => {
      userId.set('signup-user-1');
      return { ok: true, value: { needsConfirmation: false } };
    });
    userSessionMock.setCurrentUser.mockResolvedValue(undefined);

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');
    service.authConfirmPassword.set('password123');

    await service.handleSignup();

    expect(userSessionMock.setCurrentUser).toHaveBeenCalledWith('signup-user-1', { forceLoad: true });
    expect(toastMock.success).toHaveBeenCalled();
    expect(modalMock.closeByType).toHaveBeenCalledWith('login', { success: true, userId: 'signup-user-1' });
    expect(service.isAuthLoading()).toBe(false);
    expect(service.isSignupMode()).toBe(false);
  });

  it('should log warning and continue when setCurrentUser exceeds the 8s timeout', async () => {
    vi.useFakeTimers();
    const { service, authMock, userSessionMock, logger, toastMock, userId } = setup();
    authMock.signUp.mockImplementation(async () => {
      userId.set('signup-user-2');
      return { ok: true, value: { needsConfirmation: false } };
    });
    // setCurrentUser returns a promise that never resolves (simulates very slow load)
    userSessionMock.setCurrentUser.mockReturnValue(new Promise(() => {}));

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');
    service.authConfirmPassword.set('password123');

    const signupPromise = service.handleSignup();

    // Advance past the 8000ms timeout
    await vi.advanceTimersByTimeAsync(8000);

    await signupPromise;

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[Signup]'),
      expect.objectContaining({ timeoutMs: 8000 })
    );
    // Should still complete the signup flow despite timeout
    expect(toastMock.success).toHaveBeenCalled();
    expect(service.isAuthLoading()).toBe(false);
  });

  it('should not reach data load path when signup requires email confirmation', async () => {
    const { service, authMock, userSessionMock } = setup();
    authMock.signUp.mockResolvedValue({ ok: true, value: { needsConfirmation: true } });

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');
    service.authConfirmPassword.set('password123');

    await service.handleSignup();

    expect(userSessionMock.setCurrentUser).not.toHaveBeenCalled();
    expect(service.authError()).toBe('注册成功！请查收邮件并点击验证链接完成注册。');
    expect(service.isAuthLoading()).toBe(false);
  });

  it('should reject signup when passwords do not match', async () => {
    const { service, authMock } = setup();

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');
    service.authConfirmPassword.set('different456');

    await service.handleSignup();

    expect(authMock.signUp).not.toHaveBeenCalled();
    expect(service.authError()).toBe('两次输入的密码不一致');
  });

  it('should reject signup when password is shorter than 8 characters', async () => {
    const { service, authMock } = setup();

    service.authEmail.set('test@example.com');
    service.authPassword.set('short');
    service.authConfirmPassword.set('short');

    await service.handleSignup();

    expect(authMock.signUp).not.toHaveBeenCalled();
    expect(service.authError()).toBe('密码长度至少8位');
  });
});
