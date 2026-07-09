import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellLazyLifecycleGroupController,
  type WorkspaceShellLazyLifecycleGroupMember,
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

function createThrowingMember(
  label: string,
  record: string[],
  failures: Partial<Record<'initialize' | 'teardown', Error>>,
): WorkspaceShellLazyLifecycleGroupMember {
  return {
    initialize: vi.fn(() => {
      record.push(`${label}.initialize`);
      const error = failures.initialize;
      if (error) throw error;
    }),
    teardown: vi.fn(() => {
      record.push(`${label}.teardown`);
      const error = failures.teardown;
      if (error) throw error;
    }),
  };
}

function createController() {
  const record: string[] = [];
  const keyboardShortcuts = createMember('keyboardShortcuts', record);
  const startupBreadcrumb = createMember('startupBreadcrumb', record);
  const swUpdateLifecycle = createMember('swUpdateLifecycle', record);
  const controller = new WorkspaceShellLazyLifecycleGroupController({
    runtime: { destroyed: () => false },
    warn: vi.fn(),
    createKeyboardShortcuts: () => keyboardShortcuts,
    createStartupBreadcrumb: () => startupBreadcrumb,
    createSwUpdateLifecycle: () => swUpdateLifecycle,
  });

  return { controller, keyboardShortcuts, record, startupBreadcrumb, swUpdateLifecycle };
}

describe('WorkspaceShellLazyLifecycleGroupController', () => {
  it('delegates concrete lazy host construction to the lifecycle hosts factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-lazy-lifecycle-group.controller.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellLazyLifecycleHosts');
    expect(source).not.toContain('WorkspaceShellLazyLifecycleHostController');
    expect(source).not.toContain("import('./workspace-shell-keyboard-shortcuts-lazy-load-host.controller')");
    expect(source).not.toContain("import('./workspace-shell-startup-breadcrumb-lazy-load-host.controller')");
    expect(source).not.toContain("import('./workspace-shell-sw-update-lifecycle-host.controller')");
  });

  it('delegates lazy lifecycle stage failure handling to the stage runner controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-lazy-lifecycle-group.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellLazyLifecycleStageRunnerController');
    expect(source).not.toContain('private runLifecycleStep');
    expect(source).not.toContain('private warnLifecycleStepFailure');
  });

  it('keeps constructor-stage SW lifecycle separate from ngOnInit-stage lazy lifecycles', () => {
    const { controller, keyboardShortcuts, record, startupBreadcrumb, swUpdateLifecycle } = createController();

    controller.initializeConstructorStage();

    expect(record).toEqual(['swUpdateLifecycle.initialize']);
    expect(swUpdateLifecycle.initialize).toHaveBeenCalledTimes(1);
    expect(keyboardShortcuts.initialize).not.toHaveBeenCalled();
    expect(startupBreadcrumb.initialize).not.toHaveBeenCalled();

    controller.initializeNgOnInitStage();

    expect(record).toEqual([
      'swUpdateLifecycle.initialize',
      'keyboardShortcuts.initialize',
      'startupBreadcrumb.initialize',
    ]);
  });

  it('preserves the existing split teardown order for keyboard and startup lifecycles', () => {
    const { controller, record } = createController();

    controller.teardownKeyboardShortcutsStage();
    controller.teardownStartupStage();

    expect(record).toEqual([
      'keyboardShortcuts.teardown',
      'startupBreadcrumb.teardown',
      'swUpdateLifecycle.teardown',
    ]);
  });

  it('can build default lifecycle hosts through deferred factories', async () => {
    const record: string[] = [];
    const createKeyboardShortcutsHost = vi.fn().mockResolvedValue(createMember('keyboardShortcuts', record));
    const createStartupBreadcrumbHost = vi.fn().mockResolvedValue(createMember('startupBreadcrumb', record));
    const createSwUpdateLifecycleHost = vi.fn().mockResolvedValue(createMember('swUpdateLifecycle', record));
    const controller = new WorkspaceShellLazyLifecycleGroupController({
      runtime: { destroyed: () => false },
      warn: vi.fn(),
      createKeyboardShortcutsHost,
      createStartupBreadcrumbHost,
      createSwUpdateLifecycleHost,
    });

    expect(createKeyboardShortcutsHost).not.toHaveBeenCalled();
    expect(createStartupBreadcrumbHost).not.toHaveBeenCalled();
    expect(createSwUpdateLifecycleHost).not.toHaveBeenCalled();

    controller.initializeConstructorStage();
    controller.initializeNgOnInitStage();

    expect(createSwUpdateLifecycleHost).toHaveBeenCalledTimes(1);
    expect(createKeyboardShortcutsHost).toHaveBeenCalledTimes(1);
    expect(createStartupBreadcrumbHost).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(record).toEqual([
        'swUpdateLifecycle.initialize',
        'keyboardShortcuts.initialize',
        'startupBreadcrumb.initialize',
      ]);
    });
  });

  it('continues ngOnInit lazy lifecycles when keyboard shortcuts initialize fails', () => {
    const error = new Error('keyboard shortcuts initialize failed');
    const warn = vi.fn();
    const record: string[] = [];
    const controller = new WorkspaceShellLazyLifecycleGroupController({
      runtime: { destroyed: () => false },
      warn,
      createKeyboardShortcuts: () =>
        createThrowingMember('keyboardShortcuts', record, { initialize: error }),
      createStartupBreadcrumb: () => createMember('startupBreadcrumb', record),
      createSwUpdateLifecycle: () => createMember('swUpdateLifecycle', record),
    });

    expect(() => controller.initializeNgOnInitStage()).not.toThrow();
    expect(record).toEqual([
      'keyboardShortcuts.initialize',
      'startupBreadcrumb.initialize',
    ]);
    expect(warn).toHaveBeenCalledWith(
      '工作区懒生命周期步骤 keyboardShortcuts.initialize 执行失败，已继续后续生命周期',
      error,
    );
  });

  it('continues startup teardown when startup breadcrumb teardown fails', () => {
    const error = new Error('startup breadcrumb teardown failed');
    const warn = vi.fn();
    const record: string[] = [];
    const controller = new WorkspaceShellLazyLifecycleGroupController({
      runtime: { destroyed: () => false },
      warn,
      createKeyboardShortcuts: () => createMember('keyboardShortcuts', record),
      createStartupBreadcrumb: () =>
        createThrowingMember('startupBreadcrumb', record, { teardown: error }),
      createSwUpdateLifecycle: () => createMember('swUpdateLifecycle', record),
    });

    expect(() => controller.teardownStartupStage()).not.toThrow();
    expect(record).toEqual([
      'startupBreadcrumb.teardown',
      'swUpdateLifecycle.teardown',
    ]);
    expect(warn).toHaveBeenCalledWith(
      '工作区懒生命周期步骤 startupBreadcrumb.teardown 执行失败，已继续后续生命周期',
      error,
    );
  });
});
