import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellLazyLifecycleGroupControllerLoader,
} from './workspace-shell-lazy-lifecycle-group-controller-loader.factory';
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

describe('createWorkspaceShellLazyLifecycleGroupControllerLoader', () => {
  it('creates the default lazy lifecycle group controller lazily', async () => {
    const record: string[] = [];
    const loadController = createWorkspaceShellLazyLifecycleGroupControllerLoader({
      runtime: { destroyed: () => false },
      warn: vi.fn(),
      createKeyboardShortcuts: () => createMember('keyboardShortcuts', record),
      createStartupBreadcrumb: () => createMember('startupBreadcrumb', record),
      createSwUpdateLifecycle: () => createMember('swUpdateLifecycle', record),
    });

    const controller = await loadController();
    controller.initializeConstructorStage();
    controller.initializeNgOnInitStage();
    controller.teardownKeyboardShortcutsStage();
    controller.teardownStartupStage();

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
