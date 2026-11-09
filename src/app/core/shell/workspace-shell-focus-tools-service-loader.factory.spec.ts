import type { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellFocusModePreloadLike,
  WorkspaceShellFocusToolsLoaderLike,
} from './workspace-shell-focus-tools-lazy-load.controller';
import {
  createWorkspaceShellFocusModePreloadServiceLoader,
  createWorkspaceShellFocusToolsLoaderServiceLoader,
} from './workspace-shell-focus-tools-service-loader.factory';

describe('workspace shell focus tools service loaders', () => {
  it('uses the provided focus mode preload service loader', async () => {
    const service: WorkspaceShellFocusModePreloadLike = {
      preload: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn(),
    };
    const loadFocusModePreloadService = vi.fn().mockResolvedValue(service);
    const loadService = createWorkspaceShellFocusModePreloadServiceLoader({
      injector: {} as Injector,
      loadFocusModePreloadService,
    });

    await expect(loadService()).resolves.toBe(service);

    expect(loadFocusModePreloadService).toHaveBeenCalledOnce();
  });

  it('uses the provided focus tools loader service loader', async () => {
    const service = {
      blackBoxRecorderComponent: vi.fn(),
      focusSessionTriggerComponent: vi.fn(),
      loadBlackBoxRecorder: vi.fn().mockResolvedValue(null),
      loadFocusSessionTrigger: vi.fn().mockResolvedValue(null),
    } as unknown as WorkspaceShellFocusToolsLoaderLike;
    const loadFocusToolsLoaderService = vi.fn().mockResolvedValue(service);
    const loadService = createWorkspaceShellFocusToolsLoaderServiceLoader({
      injector: {} as Injector,
      loadFocusToolsLoaderService,
    });

    await expect(loadService()).resolves.toBe(service);

    expect(loadFocusToolsLoaderService).toHaveBeenCalledOnce();
  });
});
