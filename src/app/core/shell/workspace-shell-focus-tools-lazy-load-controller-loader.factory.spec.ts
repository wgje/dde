import { Injector, signal, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellFocusModePreloadLike,
  WorkspaceShellFocusToolsLoaderLike,
} from './workspace-shell-focus-tools-lazy-load.controller';
import {
  createWorkspaceShellFocusToolsLazyLoadControllerLoader,
} from './workspace-shell-focus-tools-lazy-load-controller-loader.factory';

class FocusSessionTriggerFixture {}

function createPreloadService(): WorkspaceShellFocusModePreloadLike {
  return {
    preload: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn(),
  };
}

function createLoaderService(): WorkspaceShellFocusToolsLoaderLike {
  return {
    focusSessionTriggerComponent: signal<Type<unknown> | null>(null),
    blackBoxRecorderComponent: signal<Type<unknown> | null>(null),
    loadFocusSessionTrigger: vi.fn().mockResolvedValue(FocusSessionTriggerFixture),
    loadBlackBoxRecorder: vi.fn().mockResolvedValue(null),
  };
}

describe('createWorkspaceShellFocusToolsLazyLoadControllerLoader', () => {
  it('creates the default focus tools lazy-load controller lazily', async () => {
    const preloadService = createPreloadService();
    const loaderService = createLoaderService();
    const loadFocusModePreloadService = vi.fn().mockResolvedValue(preloadService);
    const loadFocusToolsLoaderService = vi.fn().mockResolvedValue(loaderService);
    const focusSessionTriggerComponent = signal<Type<unknown> | null>(null);
    const blackBoxRecorderComponent = signal<Type<unknown> | null>(null);
    const loadController = createWorkspaceShellFocusToolsLazyLoadControllerLoader({
      injector: TestBed.inject(Injector),
      focusSessionTriggerComponent,
      blackBoxRecorderComponent,
      loadFocusModePreloadService,
      loadFocusToolsLoaderService,
      warn: vi.fn(),
    });

    expect(loadFocusModePreloadService).not.toHaveBeenCalled();
    expect(loadFocusToolsLoaderService).not.toHaveBeenCalled();

    const controller = await loadController();
    await controller.preloadFocusMode('intent');
    await controller.loadFocusSessionTriggerComponent();

    expect(loadFocusModePreloadService).toHaveBeenCalledTimes(1);
    expect(loadFocusToolsLoaderService).toHaveBeenCalledTimes(1);
    expect(preloadService.preload).toHaveBeenCalledWith('intent');
    expect(loaderService.loadFocusSessionTrigger).toHaveBeenCalledTimes(1);
    expect(focusSessionTriggerComponent()).toBe(FocusSessionTriggerFixture);
  });
});
