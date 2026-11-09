import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellStartupBreadcrumbLifecycleHost,
} from './workspace-shell-startup-breadcrumb-lifecycle-host.factory';
import type {
  WorkspaceShellStartupBreadcrumbLike,
} from './workspace-shell-startup-breadcrumb.controller';
import {
  createWorkspaceShellLazyLifecycleSpecService,
  flushWorkspaceShellLazyLifecycleMicrotasks,
  expectWorkspaceShellLazyLifecycleHostSkipsDestroyedLoad,
} from './workspace-shell-lazy-lifecycle.spec-helpers';

describe('createWorkspaceShellStartupBreadcrumbLifecycleHost', () => {
  it('delegates controller creation to the startup breadcrumb controller loader factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-startup-breadcrumb-lifecycle-host.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellStartupBreadcrumbControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-startup-breadcrumb.controller')");
    expect(source).not.toContain('new WorkspaceShellStartupBreadcrumbController');
  });

  it('returns a no-op host when the shell is already destroyed', async () => {
    await expectWorkspaceShellLazyLifecycleHostSkipsDestroyedLoad({
      createHost: options => createWorkspaceShellStartupBreadcrumbLifecycleHost({
        runtime: { destroyed: options.destroyed },
        loadStartupBreadcrumb: options.loadService,
        warn: options.warn,
      }),
      createService: () =>
        createWorkspaceShellLazyLifecycleSpecService<WorkspaceShellStartupBreadcrumbLike>(),
    });
  });

  it('wires the startup breadcrumb service loader through the lazy lifecycle host', async () => {
    const service: WorkspaceShellStartupBreadcrumbLike = {
      initialize: vi.fn(),
      teardown: vi.fn(),
    };
    const loadStartupBreadcrumb = vi.fn().mockResolvedValue(service);
    const host = await createWorkspaceShellStartupBreadcrumbLifecycleHost({
      runtime: { destroyed: () => false },
      loadStartupBreadcrumb,
      warn: vi.fn(),
    });

    host.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(loadStartupBreadcrumb).toHaveBeenCalledOnce();
    expect(service.initialize).toHaveBeenCalledOnce();
  });
});
