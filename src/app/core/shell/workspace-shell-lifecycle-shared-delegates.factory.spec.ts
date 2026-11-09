import { describe, expect, it, vi } from 'vitest';
import type { Injector } from '@angular/core';

import {
  createWorkspaceShellLifecycleSharedDelegates,
} from './workspace-shell-lifecycle-shared-delegates.factory';
import type {
  WorkspaceShellLifecycleLazyLifecycleGroup,
} from './workspace-shell-lifecycle-delegates.factory';

function createInjector(): Injector {
  return {
    get: vi.fn(),
  } as unknown as Injector;
}

function createLazyLifecycleGroup(): WorkspaceShellLifecycleLazyLifecycleGroup {
  return {
    initializeConstructorStage: vi.fn(),
    initializeNgOnInitStage: vi.fn(),
    teardownKeyboardShortcutsStage: vi.fn(),
    teardownStartupStage: vi.fn(),
  };
}

describe('createWorkspaceShellLifecycleSharedDelegates', () => {
  it('creates the lifecycle delegates shared across startup, ngOnInit, afterViewInit, and destroy', () => {
    const flowPrewarm = {
      scheduleAggressivePrewarm: vi.fn(),
      teardown: vi.fn(),
    };
    const lazyLifecycles = createLazyLifecycleGroup();
    const startupLazyServices = {
      scheduleStartupFontInitialization: vi.fn(),
      initializeStartupDiagnosticsLazy: vi.fn(),
      teardown: vi.fn(),
    };
    const flowPrewarmOptions = {
      isDestroyed: () => false,
      warn: vi.fn(),
    };
    const lazyLifecycleOptions = {
      injector: createInjector(),
      runtime: { destroyed: () => false },
      warn: vi.fn(),
      createLazyLifecycleGroup: vi.fn(),
    };
    const startupLazyServicesOptions = {
      injector: createInjector(),
      warn: vi.fn(),
    };
    const createFlowPrewarm = vi.fn(() => flowPrewarm);
    const createLazyLifecycles = vi.fn(() => lazyLifecycles);
    const createStartupLazyServices = vi.fn(() => startupLazyServices);

    const delegates = createWorkspaceShellLifecycleSharedDelegates({
      createFlowPrewarm,
      createLazyLifecycles,
      createStartupLazyServices,
      flowPrewarm: flowPrewarmOptions,
      lazyLifecycles: lazyLifecycleOptions,
      startupLazyServices: startupLazyServicesOptions,
    });

    expect(createFlowPrewarm).toHaveBeenCalledWith(flowPrewarmOptions);
    expect(createLazyLifecycles).toHaveBeenCalledWith(lazyLifecycleOptions);
    expect(createStartupLazyServices).toHaveBeenCalledWith(startupLazyServicesOptions);
    expect(delegates).toEqual({
      flowPrewarm,
      lazyLifecycles,
      startupLazyServices,
    });
  });
});
