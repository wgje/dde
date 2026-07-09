import { describe, it } from 'vitest';

import {
  createWorkspaceShellStartupBreadcrumbServiceLoader,
} from './workspace-shell-startup-breadcrumb-service-loader.factory';
import type {
  WorkspaceShellStartupBreadcrumbLike,
} from './workspace-shell-startup-breadcrumb.controller';
import {
  createWorkspaceShellLazyLifecycleSpecService,
  expectWorkspaceShellLazyLifecycleLoaderMissingInjector,
  expectWorkspaceShellLazyLifecycleLoaderUsesExplicitLoader,
} from './workspace-shell-lazy-lifecycle.spec-helpers';

describe('createWorkspaceShellStartupBreadcrumbServiceLoader', () => {
  it('uses an explicit startup breadcrumb loader when supplied', async () => {
    await expectWorkspaceShellLazyLifecycleLoaderUsesExplicitLoader({
      createLoader: loadStartupBreadcrumb =>
        createWorkspaceShellStartupBreadcrumbServiceLoader({ loadStartupBreadcrumb }),
      createService: () =>
        createWorkspaceShellLazyLifecycleSpecService<WorkspaceShellStartupBreadcrumbLike>(),
    });
  });

  it('fails with the startup breadcrumb injector message when no injector exists', async () => {
    await expectWorkspaceShellLazyLifecycleLoaderMissingInjector({
      createLoader: () => createWorkspaceShellStartupBreadcrumbServiceLoader({}),
      expectedMessage: 'WorkspaceShellStartupBreadcrumbController requires an injector',
    });
  });
});
