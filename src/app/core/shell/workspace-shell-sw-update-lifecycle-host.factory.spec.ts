import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellSwUpdateLifecycleHost,
} from './workspace-shell-sw-update-lifecycle-host.factory';
import {
  createWorkspaceShellLazyLifecycleSpecMember,
  expectWorkspaceShellLazyLifecycleHostSkipsDestroyedLoad,
} from './workspace-shell-lazy-lifecycle.spec-helpers';

describe('createWorkspaceShellSwUpdateLifecycleHost', () => {
  it('returns a no-op host when the shell is already destroyed', async () => {
    await expectWorkspaceShellLazyLifecycleHostSkipsDestroyedLoad({
      createHost: options => createWorkspaceShellSwUpdateLifecycleHost({
        runtime: { destroyed: options.destroyed },
        warn: options.warn,
      }),
      createService: () => createWorkspaceShellLazyLifecycleSpecMember(),
    });
  });

  it('delegates controller creation to the SW update controller loader factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-sw-update-lifecycle-host.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellLazyLifecycleControllerHost');
    expect(source).toContain('destroyed: options.runtime.destroyed');
    expect(source).toContain('createWorkspaceShellSwUpdateLifecycleControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-sw-update-lifecycle.controller')");
    expect(source).not.toContain('new WorkspaceShellSwUpdateLifecycleController');
    expect(source).not.toContain('createWorkspaceShellNoopLifecycleHost');
  });
});
