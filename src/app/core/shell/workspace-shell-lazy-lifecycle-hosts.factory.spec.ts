import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellLazyLifecycleHosts,
} from './workspace-shell-lazy-lifecycle-hosts.factory';
import {
  createWorkspaceShellLazyLifecycleDeferred,
  createWorkspaceShellLazyLifecycleSpecMember,
  flushWorkspaceShellLazyLifecycleMicrotasks,
} from './workspace-shell-lazy-lifecycle.spec-helpers';

describe('createWorkspaceShellLazyLifecycleHosts', () => {
  it('delegates keyboard shortcuts default host creation out of the lifecycle hosts factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-lazy-lifecycle-hosts.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellKeyboardShortcutsLifecycleHost');
    expect(source).not.toContain("import('./workspace-shell-keyboard-shortcuts.controller')");
    expect(source).not.toContain('WorkspaceShellKeyboardShortcutsController');
    expect(source).not.toContain('workspace-shell-keyboard-shortcuts-lazy-load-host.controller');
    expect(source).not.toContain('workspace-shell-keyboard-shortcuts-lazy-load-resolver.controller');
  });

  it('delegates startup breadcrumb default host creation out of the lifecycle hosts factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-lazy-lifecycle-hosts.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellStartupBreadcrumbLifecycleHost');
    expect(source).not.toContain("import('./workspace-shell-startup-breadcrumb.controller')");
    expect(source).not.toContain('WorkspaceShellStartupBreadcrumbController');
    expect(source).not.toContain('workspace-shell-startup-breadcrumb-lazy-load-host.controller');
    expect(source).not.toContain('workspace-shell-startup-breadcrumb-lazy-load-resolver.controller');
  });

  it('delegates SW update lifecycle default host creation out of the lifecycle hosts factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-lazy-lifecycle-hosts.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellSwUpdateLifecycleHost');
    expect(source).not.toContain("import('./workspace-shell-sw-update-lifecycle.controller')");
    expect(source).not.toContain('WorkspaceShellSwUpdateLifecycleController');
    expect(source).not.toContain('workspace-shell-sw-update-lifecycle-host.controller');
  });

  it('delegates lifecycle wrapper construction out of the lifecycle hosts factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-lazy-lifecycle-hosts.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellLazyLifecycleHostMember');
    expect(source).not.toContain('WorkspaceShellLazyLifecycleHostController');
    expect(source).not.toMatch(/new\s+WorkspaceShellLazyLifecycleHostController/);
    expect(source).not.toContain('function createLazyLifecycleHost');
  });

  it('centralizes lazy lifecycle group member construction in one helper', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-lazy-lifecycle-hosts.factory.ts'),
      'utf8',
    );

    expect(source).toContain('function createWorkspaceShellLazyLifecycleGroupHost(');
    expect(source.match(/createWorkspaceShellLazyLifecycleHostMember\(/g))
      .toHaveLength(1);
    expect(source).not.toContain('function createKeyboardShortcutsHost(');
    expect(source).not.toContain('function createStartupBreadcrumbHost(');
    expect(source).not.toContain('function createSwUpdateLifecycleHost(');
  });

  it('builds keyboard, startup breadcrumb, and SW update hosts behind lazy lifecycle wrappers', async () => {
    const record: string[] = [];
    const createKeyboardShortcutsHost = vi.fn().mockResolvedValue(
      createWorkspaceShellLazyLifecycleSpecMember('keyboardShortcuts', record),
    );
    const createStartupBreadcrumbHost = vi.fn().mockResolvedValue(
      createWorkspaceShellLazyLifecycleSpecMember('startupBreadcrumb', record),
    );
    const createSwUpdateLifecycleHost = vi.fn().mockResolvedValue(
      createWorkspaceShellLazyLifecycleSpecMember('swUpdateLifecycle', record),
    );

    const hosts = createWorkspaceShellLazyLifecycleHosts({
      runtime: { destroyed: () => false },
      warn: vi.fn(),
      createKeyboardShortcutsHost,
      createStartupBreadcrumbHost,
      createSwUpdateLifecycleHost,
    });

    expect(createKeyboardShortcutsHost).not.toHaveBeenCalled();
    expect(createStartupBreadcrumbHost).not.toHaveBeenCalled();
    expect(createSwUpdateLifecycleHost).not.toHaveBeenCalled();

    hosts.swUpdateLifecycle.initialize();
    hosts.keyboardShortcuts.initialize();
    hosts.startupBreadcrumb.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(createSwUpdateLifecycleHost).toHaveBeenCalledTimes(1);
    expect(createKeyboardShortcutsHost).toHaveBeenCalledTimes(1);
    expect(createStartupBreadcrumbHost).toHaveBeenCalledTimes(1);
    expect(record).toEqual([
      'swUpdateLifecycle.initialize',
      'keyboardShortcuts.initialize',
      'startupBreadcrumb.initialize',
    ]);
  });

  it('coalesces duplicate startup breadcrumb initialize calls while the host is loading', async () => {
    const startupBreadcrumb = createWorkspaceShellLazyLifecycleSpecMember();
    const deferred = createWorkspaceShellLazyLifecycleDeferred<typeof startupBreadcrumb>();
    const createStartupBreadcrumbHost = vi.fn(() => deferred.promise);

    const hosts = createWorkspaceShellLazyLifecycleHosts({
      runtime: { destroyed: () => false },
      warn: vi.fn(),
      createStartupBreadcrumbHost,
    });

    hosts.startupBreadcrumb.initialize();
    hosts.startupBreadcrumb.initialize();

    expect(createStartupBreadcrumbHost).toHaveBeenCalledTimes(1);

    deferred.resolve(startupBreadcrumb);
    await deferred.promise;
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(startupBreadcrumb.initialize).toHaveBeenCalledTimes(1);
  });

  it('maps runtime destroyed state into the default lifecycle hosts', async () => {
    const warn = vi.fn();

    const hosts = createWorkspaceShellLazyLifecycleHosts({
      runtime: { destroyed: () => true },
      warn,
    });

    hosts.keyboardShortcuts.initialize();
    hosts.startupBreadcrumb.initialize();
    hosts.swUpdateLifecycle.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(warn).not.toHaveBeenCalled();
  });
});
