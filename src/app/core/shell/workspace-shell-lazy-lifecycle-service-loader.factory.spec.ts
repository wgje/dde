import type { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellLazyLifecycleServiceLoader,
} from './workspace-shell-lazy-lifecycle-service-loader.factory';
import type {
  WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';
import {
  createWorkspaceShellLazyLifecycleSpecService,
} from './workspace-shell-lazy-lifecycle.spec-helpers';

describe('createWorkspaceShellLazyLifecycleServiceLoader', () => {
  it('prefers the explicit service loader before resolving through the injector', async () => {
    const service = createWorkspaceShellLazyLifecycleSpecService<WorkspaceShellLazyLifecycleDelegate>();
    const loadService = vi.fn().mockResolvedValue(service);
    const resolveService = vi.fn();
    const loader = createWorkspaceShellLazyLifecycleServiceLoader({
      injector: {} as Injector,
      loadService,
      missingInjectorMessage: 'missing injector',
      resolveService,
    });

    await expect(loader()).resolves.toBe(service);

    expect(loadService).toHaveBeenCalledOnce();
    expect(resolveService).not.toHaveBeenCalled();
  });

  it('converts synchronous explicit loader failures into promise rejections', async () => {
    const error = new Error('explicit loader failed synchronously');
    const loader = createWorkspaceShellLazyLifecycleServiceLoader({
      loadService: vi.fn(() => {
        throw error;
      }),
    });

    await expect(loader()).rejects.toBe(error);
  });

  it('resolves the service through the injector when no explicit loader exists', async () => {
    const injector = {} as Injector;
    const service = createWorkspaceShellLazyLifecycleSpecService<WorkspaceShellLazyLifecycleDelegate>();
    const resolveService = vi.fn().mockResolvedValue(service);
    const loader = createWorkspaceShellLazyLifecycleServiceLoader({
      injector,
      missingInjectorMessage: 'missing injector',
      resolveService,
    });

    await expect(loader()).resolves.toBe(service);

    expect(resolveService).toHaveBeenCalledWith(injector);
  });

  it('converts synchronous injector resolver failures into promise rejections', async () => {
    const error = new Error('injector resolver failed synchronously');
    const loader = createWorkspaceShellLazyLifecycleServiceLoader({
      injector: {} as Injector,
      missingInjectorMessage: 'missing injector',
      resolveService: vi.fn(() => {
        throw error;
      }),
    });

    await expect(loader()).rejects.toBe(error);
  });

  it('rejects with the configured message when injector resolution is impossible', async () => {
    const loader = createWorkspaceShellLazyLifecycleServiceLoader({
      missingInjectorMessage: 'missing injector',
      resolveService: vi.fn(),
    });

    await expect(loader()).rejects.toThrow('missing injector');
  });
});
