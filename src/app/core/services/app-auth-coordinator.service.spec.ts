import { Injector, runInInjectionContext, signal } from '@angular/core';
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
import { WidgetBindingService } from '../../../services/widget-binding.service';
import { ProjectDataService } from './sync/project-data.service';

vi.mock('../../../services/guards', async () => {
  const actual = await vi.importActual<typeof import('../../../services/guards')>('../../../services/guards');
  return {
    ...actual,
    enableLocalMode: vi.fn(),
    disableLocalMode: vi.fn(),
  };
});

vi.mock('../../../services/attachment.service', () => ({
  AttachmentService: class AttachmentService {},
}));

vi.mock('../../../services/migration.service', () => ({
  MigrationService: class MigrationService {},
}));

import { AttachmentService } from '../../../services/attachment.service';
import { MigrationService } from '../../../services/migration.service';
import { disableLocalMode } from '../../../services/guards';

async function flushAsyncTimers(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

function setup(options?: {
  injectorGet?: (token: unknown) => unknown;
}) {
  const userId = signal<string | null>(null);
  const projects = signal<Array<{ id: string; syncSource?: 'local-only' | 'synced' }>>([]);
  const activeProjectId = signal<string | null>(null);
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
    checkMigrationNeeded: vi.fn((..._args: unknown[]): boolean => false),
  };
  const projectDataMock = {
    loadProjectListMetadataFromCloud: vi.fn().mockResolvedValue([]),
  };

  const injectorGet = vi.fn((token: unknown) => {
    if (options?.injectorGet) {
      return options.injectorGet(token);
    }
    if (token === AttachmentService) return defaultAttachmentService;
    if (token === MigrationService) return defaultMigrationService;
    if (token === ProjectDataService) return projectDataMock;
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
    runtimeState: vi.fn(() => 'idle' as const),
    sessionInitialized: vi.fn(() => false),
  };

  const userSessionMock = {
    currentUserId: userId,
    canAuthoritativelyRejectProjectRoute: vi.fn(() => true),
    isProjectAuthoritativelyAccessible: vi.fn((projectId: string) => projects().some(project => project.id === projectId)),
    startupProjectCatalogStage: vi.fn(() => 'resolved' as const),
    setCurrentUser: vi.fn().mockImplementation(async (nextUserId: string | null) => {
      userId.set(nextUserId);
    }),
    clearAllLocalData: vi.fn().mockResolvedValue(undefined),
    loadProjects: vi.fn().mockResolvedValue(undefined),
  };

  const modalMock = {
    isOpen: vi.fn(() => false),
    getData: vi.fn((): unknown => undefined),
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
    url: '/',
    navigateByUrl: vi.fn().mockResolvedValue(true),
  };

  const widgetBindingMock = {
    revokeAllBindings: vi.fn().mockResolvedValue({ ok: true as const, value: { revokedCount: 0 } }),
  };

  const injector = Injector.create({
    providers: [
      { provide: AppAuthCoordinatorService, useClass: AppAuthCoordinatorService },
      { provide: Injector, useValue: { get: injectorGet } },
      { provide: AuthService, useValue: authMock },
      { provide: UserSessionService, useValue: userSessionMock },
      { provide: ProjectStateService, useValue: { projects, activeProjectId } },
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
      { provide: WidgetBindingService, useValue: widgetBindingMock },
      { provide: Router, useValue: routerMock },
    ],
  });

  return {
    service: runInInjectionContext(injector, () => injector.get(AppAuthCoordinatorService)),
    injectorGet,
    defaultAttachmentService,
    defaultMigrationService,
    logger,
    authMock,
    userSessionMock,
    modalMock,
    toastMock,
    routerMock,
    widgetBindingMock,
    userId,
    projects,
    activeProjectId,
    projectDataMock,
  };
}

describe('AppAuthCoordinatorService lazy dependency loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('getProjectDataServiceLazy 首次并发请求应 single-flight 且返回同一实例', async () => {
    const { service, injectorGet, projectDataMock } = setup();

    const [first, second] = await Promise.all([
      service.getProjectDataServiceLazy(),
      service.getProjectDataServiceLazy(),
    ]);

    expect(first).toBe(projectDataMock);
    expect(second).toBe(projectDataMock);
    expect(injectorGet).toHaveBeenCalledTimes(1);
    expect(injectorGet).toHaveBeenCalledWith(ProjectDataService);
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

describe('signOut resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clearAllLocalData 失败时仍应完成登出并提示用户', async () => {
    const { service, userSessionMock, authMock, toastMock, userId, logger } = setup();
    userId.set('user-1');
    userSessionMock.clearAllLocalData.mockRejectedValueOnce(new Error('indexeddb blocked'));

    await expect(service.signOut()).resolves.toBe(true);

    expect(authMock.signOut).toHaveBeenCalledOnce();
    expect(userSessionMock.setCurrentUser).toHaveBeenCalledWith(null, {
      skipPersistentReload: true,
    });
    expect(toastMock.warning).toHaveBeenCalledWith(
      '本地清理未完成',
      expect.stringContaining('已退出登录')
    );
    expect(logger.error).toHaveBeenCalledWith('本地数据清理失败，继续完成登出流程', expect.any(Error));
  });

  it('Widget 远端吊销失败时应中断登出并提示重试', async () => {
    const { service, authMock, toastMock, userId, logger, widgetBindingMock, userSessionMock } = setup();
    userId.set('user-1');
    widgetBindingMock.revokeAllBindings.mockResolvedValueOnce({
      ok: false as const,
      error: {
        code: 'OPERATION_FAILED',
        message: 'Widget revoke-all 超时',
      },
    });

    await expect(service.signOut()).resolves.toBe(false);

    expect(authMock.signOut).not.toHaveBeenCalled();
    expect(userSessionMock.setCurrentUser).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('Widget 远端吊销失败，中断登出流程', {
      code: 'OPERATION_FAILED',
      message: 'Widget revoke-all 超时',
    });
    expect(toastMock.error).toHaveBeenCalledWith(
      '设备吊销失败',
      expect.stringContaining('当前不会退出登录')
    );
  });

  it('应在 auth.signOut 清空 currentUserId 前先执行 userSession teardown', async () => {
    const { service, userSessionMock, authMock, userId, widgetBindingMock } = setup();
    userId.set('user-1');
    authMock.signOut.mockImplementation(async () => {
      userId.set(null);
    });

    await expect(service.signOut()).resolves.toBe(true);

    expect(userSessionMock.setCurrentUser).toHaveBeenCalledWith(null, {
      skipPersistentReload: true,
    });
    expect(widgetBindingMock.revokeAllBindings).toHaveBeenCalledOnce();
    expect(widgetBindingMock.revokeAllBindings.mock.invocationCallOrder[0]).toBeLessThan(
      userSessionMock.setCurrentUser.mock.invocationCallOrder[0]
    );
    expect(userSessionMock.setCurrentUser.mock.invocationCallOrder[0]).toBeLessThan(
      authMock.signOut.mock.invocationCallOrder[0]
    );
  });
});

describe('isLoginData type guard (tested indirectly via handleLogin)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('登录后若返回路径指向当前账号不可访问的旧项目，应回退到项目列表', async () => {
    const { service, authMock, modalMock, routerMock, projects } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
    modalMock.getData.mockReturnValue({ returnUrl: '/projects/proj-stale/text' });
    projects.set([{ id: 'proj-actual', syncSource: 'synced' }]);

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();

    expect(routerMock.navigateByUrl).toHaveBeenCalledWith('/projects');
  });

  it('登录后若项目目录尚未 authoritative，应保留显式 returnUrl 等待后续校验', async () => {
    const { service, authMock, modalMock, routerMock, userSessionMock } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
    modalMock.getData.mockReturnValue({ returnUrl: '/projects/proj-stale/text' });
    userSessionMock.canAuthoritativelyRejectProjectRoute.mockReturnValue(false);
    userSessionMock.startupProjectCatalogStage.mockReturnValue('partial');

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();

    expect(routerMock.navigateByUrl).toHaveBeenCalledWith('/projects/proj-stale/text');
  });

  it('登录后若本地仍保留不可访问的幽灵项目，也应回退到项目列表', async () => {
    const { service, authMock, modalMock, routerMock, projects, userSessionMock } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
    modalMock.getData.mockReturnValue({ returnUrl: '/projects/proj-stale/text' });
    projects.set([{ id: 'proj-stale', syncSource: 'synced' }]);
    userSessionMock.isProjectAuthoritativelyAccessible.mockReturnValue(false);

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();

    expect(routerMock.navigateByUrl).toHaveBeenCalledWith('/projects');
  });

  it('should preserve the auth service login error message', async () => {
    const { service, authMock } = setup();
    authMock.signIn.mockResolvedValue({
      ok: false,
      error: { code: 'SYNC_AUTH_EXPIRED', message: '用户名或密码错误' },
    });

    service.authEmail.set('wrong@example.com');
    service.authPassword.set('bad-password');

    await service.handleLogin();

    expect(service.authError()).toBe('用户名或密码错误');
  });

  it('登录成功结果缺少 userId 时不应继续进入成功流程', async () => {
    const { service, authMock, userSessionMock, modalMock, toastMock } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: {} });

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();

    expect(userSessionMock.setCurrentUser).not.toHaveBeenCalled();
    expect(modalMock.closeByType).not.toHaveBeenCalledWith('login', expect.anything());
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(service.authError()).toBe('登录成功，但会话初始化失败，请重新登录。');
  });

  it('登录后若 store 中只有 local-only 影子项目，应基于真实云端项目列表判断迁移', async () => {
    const { service, authMock, projects, projectDataMock, defaultMigrationService, modalMock } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
    projects.set([{ id: 'proj-shadow', syncSource: 'local-only' }]);
    projectDataMock.loadProjectListMetadataFromCloud.mockResolvedValue([{ id: 'proj-remote', syncSource: 'synced' }]);
    defaultMigrationService.checkMigrationNeeded.mockReturnValue(true);

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();
    await flushAsyncTimers();

    expect(projectDataMock.loadProjectListMetadataFromCloud).toHaveBeenCalledWith('user-1');
    expect(defaultMigrationService.checkMigrationNeeded).toHaveBeenCalledWith([
      { id: 'proj-remote', syncSource: 'synced' },
    ]);
    expect(modalMock.show).toHaveBeenCalledWith('migration');
  });

  it('登录后即使 store 中有陈旧 synced 缓存，也应以真实云端项目列表为准', async () => {
    const { service, authMock, projects, projectDataMock, defaultMigrationService } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
    projects.set([
      { id: 'proj-stale', syncSource: 'synced' },
      { id: 'proj-shadow', syncSource: 'local-only' },
    ]);
    projectDataMock.loadProjectListMetadataFromCloud.mockResolvedValue([{ id: 'proj-actual', syncSource: 'synced' }]);
    defaultMigrationService.checkMigrationNeeded.mockReturnValue(false);

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();
    await flushAsyncTimers();

    expect(projectDataMock.loadProjectListMetadataFromCloud).toHaveBeenCalledWith('user-1');
    expect(defaultMigrationService.checkMigrationNeeded).toHaveBeenCalledWith([
      { id: 'proj-actual', syncSource: 'synced' },
    ]);
  });

  it('登录后若真实云端项目元数据无法确认，应跳过本次迁移提示以避免误判', async () => {
    const { service, authMock, projects, projectDataMock, defaultMigrationService, modalMock, logger } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
    projects.set([{ id: 'proj-shadow', syncSource: 'local-only' }]);
    projectDataMock.loadProjectListMetadataFromCloud.mockResolvedValue(null);
    defaultMigrationService.checkMigrationNeeded.mockReturnValue(true);

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();
    await flushAsyncTimers();

    expect(defaultMigrationService.checkMigrationNeeded).not.toHaveBeenCalled();
    expect(modalMock.show).not.toHaveBeenCalledWith('migration');
    expect(logger.warn).toHaveBeenCalledWith('登录后迁移检查无法确认云端项目，已跳过本次迁移提示');
  });

  it('登录后即使迁移元数据探测很慢，也不应阻塞登录完成', async () => {
    const { service, authMock, projectDataMock, modalMock } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
    projectDataMock.loadProjectListMetadataFromCloud.mockReturnValue(new Promise(() => {}));

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();

    expect(service.isAuthLoading()).toBe(false);
    expect(modalMock.closeByType).toHaveBeenCalledWith('login', { success: true, userId: 'user-1' });
  });

  it('迁移探测期间若当前会话已切换，应丢弃旧登录的迁移结果', async () => {
    const { service, authMock, projectDataMock, defaultMigrationService, modalMock, userId } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
    defaultMigrationService.checkMigrationNeeded.mockReturnValue(true);

    let resolveRemoteProjects: ((value: Array<{ id: string; syncSource: 'synced' }>) => void) | null = null;
    projectDataMock.loadProjectListMetadataFromCloud.mockImplementation(() => {
      return new Promise<Array<{ id: string; syncSource: 'synced' }>>(resolve => {
        resolveRemoteProjects = resolve;
      });
    });

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();
    await flushAsyncTimers();
    userId.set('user-2');
    // @ts-expect-error TS2349 - closure reassignment defeats CFA
    resolveRemoteProjects?.([{ id: 'proj-remote', syncSource: 'synced' }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(modalMock.show).not.toHaveBeenCalledWith('migration');
  });

  it('同一用户重新登录后，上一轮迁移探测结果也必须失效', async () => {
    const { service, authMock, projectDataMock, defaultMigrationService, modalMock, userId } = setup();
    authMock.signIn.mockResolvedValue({ ok: true, value: { userId: 'user-1' } });
    defaultMigrationService.checkMigrationNeeded.mockImplementation((remoteProjects: unknown) => (remoteProjects as unknown[]).length > 0);

    let resolveFirstProbe: ((value: Array<{ id: string; syncSource: 'synced' }>) => void) | null = null;
    projectDataMock.loadProjectListMetadataFromCloud
      .mockImplementationOnce(() => {
        return new Promise<Array<{ id: string; syncSource: 'synced' }>>(resolve => {
          resolveFirstProbe = resolve;
        });
      })
      .mockResolvedValueOnce([]);

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');

    await service.handleLogin();
    await flushAsyncTimers();

    userId.set(null);
    await service.handleLogin();
    await flushAsyncTimers();

    // @ts-expect-error TS2349 - closure reassignment defeats CFA
    resolveFirstProbe?.([{ id: 'proj-old', syncSource: 'synced' }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(modalMock.show).not.toHaveBeenCalledWith('migration');
  });
});

describe('handleSignup timeout protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should complete normally when setCurrentUser resolves before the 8s timeout', async () => {
    const { service, authMock, userSessionMock, toastMock, modalMock } = setup();
    authMock.signUp.mockResolvedValue({ ok: true, value: { needsConfirmation: false, userId: 'signup-user-1' } });
    userSessionMock.setCurrentUser.mockResolvedValue(undefined);

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');
    service.authConfirmPassword.set('password123');

    await service.handleSignup();

  expect(disableLocalMode).toHaveBeenCalled();
    expect(userSessionMock.setCurrentUser).toHaveBeenCalledWith('signup-user-1', { forceLoad: true });
    expect(toastMock.success).toHaveBeenCalled();
    expect(modalMock.closeByType).toHaveBeenCalledWith('login', { success: true, userId: 'signup-user-1' });
    expect(service.isAuthLoading()).toBe(false);
    expect(service.isSignupMode()).toBe(false);
  });

  it('should log warning and continue when setCurrentUser exceeds the 8s timeout', async () => {
    vi.useFakeTimers();
    const { service, authMock, userSessionMock, logger, toastMock } = setup();
    authMock.signUp.mockResolvedValue({ ok: true, value: { needsConfirmation: false, userId: 'signup-user-2' } });
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

  it('should use signUp result userId even when auth currentUserId signal is not prefilled', async () => {
    const { service, authMock, userSessionMock, modalMock } = setup();
    authMock.signUp.mockResolvedValue({ ok: true, value: { needsConfirmation: false, userId: 'signup-user-direct' } });
    userSessionMock.setCurrentUser.mockResolvedValue(undefined);

    service.authEmail.set('test@example.com');
    service.authPassword.set('password123');
    service.authConfirmPassword.set('password123');

    await service.handleSignup();

    expect(userSessionMock.setCurrentUser).toHaveBeenCalledWith('signup-user-direct', { forceLoad: true });
    expect(modalMock.closeByType).toHaveBeenCalledWith('login', { success: true, userId: 'signup-user-direct' });
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

  it('should preserve the auth service signup error message', async () => {
    const { service, authMock } = setup();
    authMock.signUp.mockResolvedValue({
      ok: false,
      error: { code: 'UNKNOWN', message: '该邮箱已被注册' },
    });

    service.authEmail.set('existing@example.com');
    service.authPassword.set('password123');
    service.authConfirmPassword.set('password123');

    await service.handleSignup();

    expect(service.authError()).toBe('该邮箱已被注册');
  });
});

describe('handleResetPassword error propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should preserve the auth service reset password error message', async () => {
    const { service, authMock } = setup();
    authMock.resetPassword.mockResolvedValue({
      ok: false,
      error: { code: 'UNKNOWN', message: '邮箱格式不正确或未验证' },
    });

    service.authEmail.set('invalid-email');

    await service.handleResetPassword();

    expect(service.authError()).toBe('邮箱格式不正确或未验证');
  });
});

describe('bootstrapSession forceLoad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('冷启动 bootstrapSession 应传 forceLoad: true 给 setCurrentUser', async () => {
    const { service, authMock, userSessionMock, userId } = setup();
    // 补充 bootstrapSession 内部使用的 signal 属性
    authMock.checkSession.mockImplementation(async () => {
      userId.set('cold-start-user');
      return { userId: 'cold-start-user', email: 'test@x.com' };
    });
    userSessionMock.setCurrentUser.mockResolvedValue(undefined);

    // 触发 bootstrap
    await (service as unknown as { bootstrapSession: () => Promise<void> }).bootstrapSession();

    expect(userSessionMock.setCurrentUser).toHaveBeenCalledWith('cold-start-user', { forceLoad: true });
  });

  it('bootstrap 超时转后台后若用户已登出，旧后台失败不应再次触发普通匿名重载', async () => {
    const { service, authMock, userSessionMock, userId } = setup();
    authMock.checkSession.mockResolvedValue({ userId: 'cold-start-user', email: 'test@x.com' });

    let rejectBackgroundLoad: ((reason?: unknown) => void) | null = null;
    const defaultSetCurrentUser = userSessionMock.setCurrentUser.getMockImplementation();
    userSessionMock.setCurrentUser
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        userId.set('cold-start-user');
        rejectBackgroundLoad = reject;
      }))
      .mockImplementation(defaultSetCurrentUser ?? (async (nextUserId: string | null) => {
        userId.set(nextUserId);
      }));

    vi.spyOn(service as unknown as {
      waitWithTimeout: <T>(promise: Promise<T>, timeoutMs: number) => Promise<'completed' | 'timeout'>;
    }, 'waitWithTimeout').mockResolvedValue('timeout');

    await (service as unknown as { bootstrapSession: () => Promise<void> }).bootstrapSession();
    await expect(service.signOut()).resolves.toBe(true);

    // @ts-expect-error TS2349 - closure reassignment defeats CFA
    rejectBackgroundLoad?.(new Error('background load failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(userSessionMock.setCurrentUser).toHaveBeenCalledTimes(2);
    expect(userSessionMock.setCurrentUser).toHaveBeenNthCalledWith(1, 'cold-start-user', { forceLoad: true });
    expect(userSessionMock.setCurrentUser).toHaveBeenNthCalledWith(2, null, { skipPersistentReload: true });
  });
});
