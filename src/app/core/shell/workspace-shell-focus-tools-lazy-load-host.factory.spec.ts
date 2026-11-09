import { Injector, signal, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createWorkspaceShellFocusToolsLazyLoadHost,
} from './workspace-shell-focus-tools-lazy-load-host.factory';
import type {
  WorkspaceShellFocusModePreloadLike,
  WorkspaceShellFocusToolsLoaderLike,
} from './workspace-shell-focus-tools-lazy-load.controller';

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

describe('createWorkspaceShellFocusToolsLazyLoadHost', () => {
  it('creates a focus tools host with injected preload and loader services', async () => {
    const preloadService = createPreloadService();
    const loaderService = createLoaderService();
    const focusSessionTriggerComponent = signal<Type<unknown> | null>(null);
    const blackBoxRecorderComponent = signal<Type<unknown> | null>(null);
    const injector = TestBed.inject(Injector);

    const host = await createWorkspaceShellFocusToolsLazyLoadHost({
      injector,
      focusSessionTriggerComponent,
      blackBoxRecorderComponent,
      loadFocusModePreloadService: vi.fn().mockResolvedValue(preloadService),
      loadFocusToolsLoaderService: vi.fn().mockResolvedValue(loaderService),
      warn: vi.fn(),
    });

    await host.preloadFocusMode('intent');
    await host.loadFocusSessionTriggerComponent();

    expect(preloadService.preload).toHaveBeenCalledWith('intent');
    expect(loaderService.loadFocusSessionTrigger).toHaveBeenCalledTimes(1);
    expect(focusSessionTriggerComponent()).toBe(FocusSessionTriggerFixture);
  });

  it('keeps the concrete focus tools controller behind a loader boundary', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-focus-tools-lazy-load-host.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellFocusToolsLazyLoadControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-focus-tools-lazy-load.controller')");
    expect(source).not.toMatch(/new WorkspaceShellFocusToolsLazyLoadController\s*\(/);
  });
});
