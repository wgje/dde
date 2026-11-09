import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  WorkspaceShellLazyLifecycleGroupMember,
} from './workspace-shell-lazy-lifecycle-hosts.factory';

const lifecycleHostFactoryFiles = [
  'workspace-shell-lazy-lifecycle-controller-host.factory.ts',
];

interface WorkspaceShellNoopLifecycleHostModule {
  createWorkspaceShellNoopLifecycleHost: () => WorkspaceShellLazyLifecycleGroupMember;
}

describe('workspace shell no-op lifecycle host factory', () => {
  it('creates an inert lifecycle host member', async () => {
    const helperPath = join(__dirname, 'workspace-shell-noop-lifecycle-host.factory.ts');

    expect(existsSync(helperPath)).toBe(true);

    const module = (
      await import(`./${'workspace-shell-noop-lifecycle-host.factory'}`)
    ) as WorkspaceShellNoopLifecycleHostModule;
    const host = module.createWorkspaceShellNoopLifecycleHost();

    expect(host.initialize()).toBeUndefined();
    expect(host.teardown()).toBeUndefined();
  });

  it('centralizes destroyed lifecycle fallback in the shared controller host', () => {
    for (const fileName of lifecycleHostFactoryFiles) {
      const source = readFileSync(join(__dirname, fileName), 'utf8');

      expect(source).toContain('createWorkspaceShellNoopLifecycleHost');
      expect(source).toContain('./workspace-shell-noop-lifecycle-host.factory');
      expect(source).not.toContain('function createNoopLifecycleHost');
    }
  });
});
