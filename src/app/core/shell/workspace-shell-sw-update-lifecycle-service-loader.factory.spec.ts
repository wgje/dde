import { describe, it } from 'vitest';

import {
  createWorkspaceShellSwUpdateLifecycleServiceLoader,
} from './workspace-shell-sw-update-lifecycle-service-loader.factory';
import type {
  WorkspaceShellSwUpdateLifecycleLike,
} from './workspace-shell-sw-update-lifecycle.controller';
import {
  createWorkspaceShellLazyLifecycleSpecService,
  expectWorkspaceShellLazyLifecycleLoaderMissingInjector,
  expectWorkspaceShellLazyLifecycleLoaderUsesExplicitLoader,
} from './workspace-shell-lazy-lifecycle.spec-helpers';

describe('createWorkspaceShellSwUpdateLifecycleServiceLoader', () => {
  it('uses an explicit Service Worker update lifecycle loader when supplied', async () => {
    await expectWorkspaceShellLazyLifecycleLoaderUsesExplicitLoader({
      createLoader: loadSwUpdateLifecycle =>
        createWorkspaceShellSwUpdateLifecycleServiceLoader({ loadSwUpdateLifecycle }),
      createService: () =>
        createWorkspaceShellLazyLifecycleSpecService<WorkspaceShellSwUpdateLifecycleLike>(),
    });
  });

  it('fails with the Service Worker update lifecycle injector message when no injector exists', async () => {
    await expectWorkspaceShellLazyLifecycleLoaderMissingInjector({
      createLoader: () => createWorkspaceShellSwUpdateLifecycleServiceLoader({}),
      expectedMessage: 'WorkspaceShellSwUpdateLifecycleController requires an injector',
    });
  });
});
