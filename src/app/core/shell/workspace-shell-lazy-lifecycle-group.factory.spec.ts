import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createWorkspaceShellLazyLifecycleGroupController,
} from './workspace-shell-lazy-lifecycle-group.factory';
import type {
  WorkspaceShellLazyLifecycleGroupMember,
} from './workspace-shell-lazy-lifecycle-group.controller';

function createMember(label: string, record: string[]): WorkspaceShellLazyLifecycleGroupMember {
  return {
    initialize: vi.fn(() => {
      record.push(`${label}.initialize`);
    }),
    teardown: vi.fn(() => {
      record.push(`${label}.teardown`);
    }),
  };
}

async function waitForLifecycleRecord(record: string[], expectedLength: number): Promise<void> {
  await vi.waitFor(() => {
    expect(record).toHaveLength(expectedLength);
  });
}

describe('createWorkspaceShellLazyLifecycleGroupController', () => {
  it('delegates concrete lazy lifecycle group creation to the controller loader factory', () => {
    const factorySource = readFileSync(
      join(__dirname, 'workspace-shell-lazy-lifecycle-group.factory.ts'),
      'utf8',
    );
    const delegateSource = readFileSync(
      join(__dirname, 'workspace-shell-lazy-lifecycle-group-lazy-delegate.controller.ts'),
      'utf8',
    );

    expect(factorySource).not.toContain('import {\n  WorkspaceShellLazyLifecycleGroupController');
    expect(factorySource).not.toContain('createWorkspaceShellLazyLifecycleGroupControllerLoader');
    expect(factorySource).not.toContain("import('./workspace-shell-lazy-lifecycle-group.controller')");
    expect(factorySource).not.toContain('new WorkspaceShellLazyLifecycleGroupController');
    expect(delegateSource).toContain('createWorkspaceShellLazyLifecycleGroupControllerLoader');
    expect(delegateSource).not.toContain("import('./workspace-shell-lazy-lifecycle-group.controller')");
    expect(delegateSource).not.toContain('new WorkspaceShellLazyLifecycleGroupController');
  });

  it('delegates lazy lifecycle group caching to a named lazy delegate controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-lazy-lifecycle-group.factory.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellLazyLifecycleGroupLazyDelegateController');
    expect(source).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(source).not.toContain('new WorkspaceShellLazyDelegateCallHostController');
    expect(source).not.toContain('controllerInstance');
    expect(source).not.toContain('controllerPromise');
  });

  it('creates the lazy lifecycle group from shell-level dependencies outside the workspace shell component', async () => {
    const record: string[] = [];
    const keyboardShortcuts = createMember('keyboardShortcuts', record);
    const startupBreadcrumb = createMember('startupBreadcrumb', record);
    const swUpdateLifecycle = createMember('swUpdateLifecycle', record);
    const controller = createWorkspaceShellLazyLifecycleGroupController({
      runtime: { destroyed: () => false },
      warn: vi.fn(),
      createKeyboardShortcuts: () => keyboardShortcuts,
      createStartupBreadcrumb: () => startupBreadcrumb,
      createSwUpdateLifecycle: () => swUpdateLifecycle,
    });

    controller.initializeConstructorStage();
    controller.initializeNgOnInitStage();
    controller.teardownKeyboardShortcutsStage();
    controller.teardownStartupStage();

    await waitForLifecycleRecord(record, 6);

    expect(record).toEqual([
      'swUpdateLifecycle.initialize',
      'keyboardShortcuts.initialize',
      'startupBreadcrumb.initialize',
      'keyboardShortcuts.teardown',
      'startupBreadcrumb.teardown',
      'swUpdateLifecycle.teardown',
    ]);
  });
});
