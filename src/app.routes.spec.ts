import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  requireAuthGuardMock,
  projectExistsGuardMock,
  canDeactivateMock,
} = vi.hoisted(() => ({
  requireAuthGuardMock: vi.fn(),
  projectExistsGuardMock: vi.fn(),
  canDeactivateMock: vi.fn(),
}));

vi.mock('./services/guards/auth.guard', () => ({
  requireAuthGuard: requireAuthGuardMock,
}));

vi.mock('./services/guards/project.guard', () => ({
  projectExistsGuard: projectExistsGuardMock,
}));

import {
  routes,
  requireAuthGuardLazy,
  requireAuthThenRestoreFenceGuardLazy,
  projectExistsGuardLazy,
  unsavedChangesGuardLazy,
} from './app.routes';
import { AuthService } from './services/auth.service';
import { LocalBackupUiRestorePreActionQueueFenceService } from './services/local-backup-ui-restore-pre-actionqueue-fence.service';
import { UnsavedChangesGuard } from './services/guards/unsaved-changes.guard';

describe('app.routes lazy guard wrappers', () => {
  let currentUserId: string | null;
  let authFence: string;
  const restoreFenceRun = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    currentUserId = 'owner-a';
    authFence = 'auth-generation-a';
    restoreFenceRun.mockResolvedValue({
      status: 'CLEAR', ownerUserId: currentUserId,
      recovered: false, terminalResultDigest: null,
    });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: UnsavedChangesGuard,
          useValue: { canDeactivate: canDeactivateMock },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId: () => currentUserId,
            captureAuthIdentityFence: () => authFence,
          },
        },
        {
          provide: LocalBackupUiRestorePreActionQueueFenceService,
          useValue: { run: restoreFenceRun },
        },
      ],
    });
  });

  it('路由配置应使用 lazy guard wrapper', () => {
    const projectsRoute = routes.find((route) => route.path === 'projects');
    expect(projectsRoute?.canActivate).toEqual([requireAuthThenRestoreFenceGuardLazy]);

    const projectDetailRoute = projectsRoute?.children?.find((route) => route.path === ':projectId');
    expect(projectDetailRoute?.canActivate?.[0]).toBe(projectExistsGuardLazy);
    expect(projectDetailRoute?.canDeactivate?.[0]).toBe(unsavedChangesGuardLazy);
  });

  it('registers an unguarded isolated auth callback route before the wildcard', () => {
    const callbackIndex = routes.findIndex((route) => route.path === 'auth/callback');
    const wildcardIndex = routes.findIndex((route) => route.path === '**');
    const callbackRoute = routes[callbackIndex];

    expect(callbackIndex).toBeGreaterThan(-1);
    expect(callbackIndex).toBeLessThan(wildcardIndex);
    expect(callbackRoute?.canActivate).toBeUndefined();
    expect(callbackRoute?.loadComponent).toBeTypeOf('function');
  });

  it('requireAuthGuardLazy 应转调 requireAuthGuard 并返回结果', async () => {
    requireAuthGuardMock.mockResolvedValueOnce(true);

    const result = await TestBed.runInInjectionContext(() =>
      requireAuthGuardLazy({} as never, {} as never)
    );

    expect(result).toBe(true);
    expect(requireAuthGuardMock).toHaveBeenCalledTimes(1);
  });

  it('runs auth and restore fence sequentially before allowing the workspace shell', async () => {
    let releaseAuth!: () => void;
    requireAuthGuardMock.mockReturnValueOnce(new Promise<boolean>(resolve => {
      releaseAuth = () => resolve(true);
    }));

    const guarded = TestBed.runInInjectionContext(() =>
      requireAuthThenRestoreFenceGuardLazy({} as never, { url: '/projects' } as never)
    );
    await vi.waitFor(() => expect(requireAuthGuardMock).toHaveBeenCalledOnce());
    expect(restoreFenceRun).not.toHaveBeenCalled();
    releaseAuth();

    await expect(guarded).resolves.toBe(true);
    expect(restoreFenceRun).toHaveBeenCalledOnce();
    const input = restoreFenceRun.mock.calls[0][0];
    expect(input.ownerUserId).toBe('owner-a');
    expect(input.isCurrent()).toBe(true);
    authFence = 'auth-generation-b';
    expect(input.isCurrent()).toBe(false);
  });

  it('allows offline shell rendering when the early fence returns HOLD', async () => {
    requireAuthGuardMock.mockResolvedValueOnce(true);
    restoreFenceRun.mockResolvedValueOnce({
      status: 'HOLD', ownerUserId: 'owner-a', reason: 'RECOVERY_BLOCKED',
    });

    await expect(TestBed.runInInjectionContext(() =>
      requireAuthThenRestoreFenceGuardLazy({} as never, { url: '/projects' } as never)
    )).resolves.toBe(true);
  });

  it('projectExistsGuardLazy 应转调 projectExistsGuard 并返回结果', async () => {
    projectExistsGuardMock.mockResolvedValueOnce(true);

    const result = await TestBed.runInInjectionContext(() =>
      projectExistsGuardLazy({} as never, {} as never)
    );

    expect(result).toBe(true);
    expect(projectExistsGuardMock).toHaveBeenCalledTimes(1);
  });

  it('blocks project hydration while startup recovery holds the restore fence', async () => {
    projectExistsGuardMock.mockResolvedValueOnce(true);
    restoreFenceRun.mockResolvedValueOnce({
      status: 'HOLD', ownerUserId: 'owner-a', reason: 'RECOVERY_BLOCKED',
    });

    const result = await TestBed.runInInjectionContext(() =>
      projectExistsGuardLazy({} as never, { url: '/projects/project-1' } as never)
    );

    expect(result).toBe(false);
    expect(projectExistsGuardMock).not.toHaveBeenCalled();
  });

  it('unsavedChangesGuardLazy 应通过 inject 调用类守卫并返回结果', async () => {
    canDeactivateMock.mockResolvedValueOnce(true);

    const result = await TestBed.runInInjectionContext(() =>
      unsavedChangesGuardLazy({} as never, {} as never, {} as never, {} as never)
    );

    expect(result).toBe(true);
    expect(canDeactivateMock).toHaveBeenCalledTimes(1);
  });

  it('unsavedChangesGuardLazy 在 lazy chunk 加载失败时应放行，避免导航卡死', async () => {
    vi.resetModules();
    vi.doMock('./services/guards/unsaved-changes.guard', () => {
      throw new Error('unsaved changes guard chunk missing');
    });
    const { unsavedChangesGuardLazy: isolatedGuard } = await import('./app.routes');

    const result = await TestBed.runInInjectionContext(() =>
      isolatedGuard({} as never, {} as never, {} as never, {} as never)
    );

    expect(result).toBe(true);
    vi.doUnmock('./services/guards/unsaved-changes.guard');
  });
});
