import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellLazyLifecycleDeferred,
  expectWorkspaceShellLazyLifecycleHostSkipsDestroyedLoad,
  expectWorkspaceShellLazyLifecycleLoaderMissingInjector,
  expectWorkspaceShellLazyLifecycleLoaderUsesExplicitLoader,
  createWorkspaceShellLazyLifecycleSpecService,
  createWorkspaceShellLazyLifecycleSpecMember,
  flushWorkspaceShellLazyLifecycleMicrotasks,
} from './workspace-shell-lazy-lifecycle.spec-helpers';

describe('workspace shell lazy lifecycle spec helpers', () => {
  it('creates lifecycle members that can record initialize and teardown calls', () => {
    const record: string[] = [];
    const member = createWorkspaceShellLazyLifecycleSpecMember('member', record);

    member.initialize();
    member.teardown();

    expect(member.initialize).toHaveBeenCalledOnce();
    expect(member.teardown).toHaveBeenCalledOnce();
    expect(record).toEqual(['member.initialize', 'member.teardown']);
  });

  it('creates typed lifecycle service fakes for service loader specs', () => {
    type SpecService = {
      initialize: () => void;
      teardown: () => void;
    };

    const service = createWorkspaceShellLazyLifecycleSpecService<SpecService>();

    service.initialize();
    service.teardown();

    expect(service.initialize).toHaveBeenCalledOnce();
    expect(service.teardown).toHaveBeenCalledOnce();
  });

  it('asserts explicit lazy lifecycle service loaders', async () => {
    await expectWorkspaceShellLazyLifecycleLoaderUsesExplicitLoader({
      createLoader: loadService => () => loadService(),
      createService: () => createWorkspaceShellLazyLifecycleSpecService(),
    });
  });

  it('asserts missing injector failures for lazy lifecycle service loaders', async () => {
    await expectWorkspaceShellLazyLifecycleLoaderMissingInjector({
      createLoader: () => () => Promise.reject(new Error('missing injector')),
      expectedMessage: 'missing injector',
    });
  });

  it('flushes queued microtasks for lazy lifecycle specs', async () => {
    const callback = vi.fn();

    void Promise.resolve().then(callback);
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(callback).toHaveBeenCalledOnce();
  });

  it('creates deferred promises for resolving lazy lifecycle services', async () => {
    const member = createWorkspaceShellLazyLifecycleSpecMember();
    const deferred = createWorkspaceShellLazyLifecycleDeferred<typeof member>();

    deferred.resolve(member);

    await expect(deferred.promise).resolves.toBe(member);
  });

  it('asserts destroyed lazy lifecycle host fallback behavior', async () => {
    await expectWorkspaceShellLazyLifecycleHostSkipsDestroyedLoad({
      createHost: options => Promise.resolve(
        options.destroyed()
          ? createWorkspaceShellLazyLifecycleSpecMember()
          : options.loadService(),
      ),
      createService: () => createWorkspaceShellLazyLifecycleSpecService(),
    });
  });
});
