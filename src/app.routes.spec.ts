import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireAuthGuardMock = vi.fn();
const projectExistsGuardMock = vi.fn();
const canDeactivateMock = vi.fn();

vi.mock('./services/guards/auth.guard', () => ({
  requireAuthGuard: requireAuthGuardMock,
}));

vi.mock('./services/guards/project.guard', () => ({
  projectExistsGuard: projectExistsGuardMock,
}));

import {
  routes,
  requireAuthGuardLazy,
  projectExistsGuardLazy,
  unsavedChangesGuardLazy,
} from './app.routes';
import { UnsavedChangesGuard } from './services/guards/unsaved-changes.guard';

describe('app.routes lazy guard wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: UnsavedChangesGuard,
          useValue: { canDeactivate: canDeactivateMock },
        },
      ],
    });
  });

  it('路由配置应使用 lazy guard wrapper', () => {
    const projectsRoute = routes.find((route) => route.path === 'projects');
    expect(projectsRoute?.canActivate?.[0]).toBe(requireAuthGuardLazy);

    const projectDetailRoute = projectsRoute?.children?.find((route) => route.path === ':projectId');
    expect(projectDetailRoute?.canActivate?.[0]).toBe(projectExistsGuardLazy);
    expect(projectDetailRoute?.canDeactivate?.[0]).toBe(unsavedChangesGuardLazy);
  });

  it('requireAuthGuardLazy 应转调 requireAuthGuard 并返回结果', async () => {
    requireAuthGuardMock.mockResolvedValueOnce(true);

    const result = await TestBed.runInInjectionContext(() =>
      requireAuthGuardLazy({} as never, {} as never)
    );

    expect(result).toBe(true);
    expect(requireAuthGuardMock).toHaveBeenCalledTimes(1);
  });

  it('projectExistsGuardLazy 应转调 projectExistsGuard 并返回结果', async () => {
    projectExistsGuardMock.mockResolvedValueOnce(true);

    const result = await TestBed.runInInjectionContext(() =>
      projectExistsGuardLazy({} as never, {} as never)
    );

    expect(result).toBe(true);
    expect(projectExistsGuardMock).toHaveBeenCalledTimes(1);
  });

  it('unsavedChangesGuardLazy 应通过 inject 调用类守卫并返回结果', async () => {
    canDeactivateMock.mockResolvedValueOnce(true);

    const result = await TestBed.runInInjectionContext(() =>
      unsavedChangesGuardLazy({} as never, {} as never, {} as never, {} as never)
    );

    expect(result).toBe(true);
    expect(canDeactivateMock).toHaveBeenCalledTimes(1);
  });
});
