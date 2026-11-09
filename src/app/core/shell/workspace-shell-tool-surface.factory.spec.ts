import type { Injector } from '@angular/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellToolControllers,
  WorkspaceShellToolControllersOptions,
} from './workspace-shell-tool-controllers.factory';
import {
  readCallOptionsFromSource,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

type WorkspaceShellToolSurfaceFactory = (options: Record<string, unknown>) =>
  WorkspaceShellToolControllers;

async function loadFactory(): Promise<{
  createWorkspaceShellToolSurface?: WorkspaceShellToolSurfaceFactory;
}> {
  const modulePath = './workspace-shell-tool-surface.factory';
  const module = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));

  return module as {
    createWorkspaceShellToolSurface?: WorkspaceShellToolSurfaceFactory;
  };
}

function createToolControllers(): WorkspaceShellToolControllers {
  const sidebarToolsLazyLoad = {
    loadFocusSessionTriggerComponent: vi.fn(),
    loadBlackBoxRecorderComponent: vi.fn(),
    onToolsIntent: vi.fn(),
    onVoiceTranscribed: vi.fn(),
    preload: vi.fn(),
    preloadFocusModeAssets: vi.fn(),
    scheduleFocusModePreload: vi.fn(),
    teardown: vi.fn(),
  };
  const toolTemplateBindings = {
    focusSessionTriggerComponent: vi.fn(),
    blackBoxRecorderComponent: vi.fn(),
    blackBoxRecorderOutletInputs: {
      appearance: 'obsidian',
      onTranscribed: vi.fn(),
    },
  } as unknown as WorkspaceShellToolControllers['toolTemplateBindings'];

  return {
    sidebarToolsLazyLoad,
    toolLazyLoad: {
      focusToolsLazyLoad: { preload: vi.fn(), teardown: vi.fn() },
      sidebarToolsLazyLoad,
      focusSessionTriggerComponent: vi.fn(),
      blackBoxRecorderComponent: vi.fn(),
      blackBoxRecorderOutletInputs: {
        appearance: 'obsidian',
        onTranscribed: vi.fn(),
      },
      templateBindings: toolTemplateBindings,
      teardown: vi.fn(),
    } as unknown as WorkspaceShellToolControllers['toolLazyLoad'],
    toolTemplateBindings,
    widgetGateMutation: {
      apply: vi.fn(async () => undefined),
    } as unknown as WorkspaceShellToolControllers['widgetGateMutation'],
  };
}

describe('workspace shell tool surface', () => {
  it('maps shell lazy refs into tool controller options', async () => {
    const { createWorkspaceShellToolSurface } = await loadFactory();

    expect(createWorkspaceShellToolSurface).toEqual(expect.any(Function));

    let mappedOptions!: WorkspaceShellToolControllersOptions;
    const toolControllers = createToolControllers();
    const blackBoxService = {
      createDurably: vi.fn(async () => ({ ok: true }) as const),
      markAsRead: vi.fn(() => ({ ok: true }) as const),
      markAsReadDurably: vi.fn(async () => ({ ok: true }) as const),
      markAsCompleted: vi.fn(() => ({ ok: true }) as const),
      markAsCompletedDurably: vi.fn(async () => ({ ok: true }) as const),
    };

    const result = createWorkspaceShellToolSurface?.({
      injector: {} as Injector,
      lazyServiceRefs: { blackBoxService },
      uiState: { sidebarOpen: { set: vi.fn() } },
      toast: { warning: vi.fn() },
      focusPrefs: { isBlackBoxEnabled: vi.fn(() => true) },
      sentryLazyLoader: { addBreadcrumb: vi.fn() },
      logger: { info: vi.fn() },
      warn: vi.fn(),
      createToolControllers: (options: WorkspaceShellToolControllersOptions) => {
        mappedOptions = options;
        return toolControllers;
      },
    });

    expect(result).toBe(toolControllers);
    expect(mappedOptions.blackBoxService).toBe(blackBoxService);
    expect(mappedOptions.sidebarOpen).toBeDefined();
    expect(mappedOptions).not.toHaveProperty('lazyServiceRefs');
    expect(mappedOptions).not.toHaveProperty('uiState');
  }, 10000);

  it('keeps tool controller option assembly outside WorkspaceShellComponent', () => {
    const source = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const baseSurfacesSource = readFileSync(
      join(
        process.cwd(),
        'src/app/core/shell/workspace-shell-base-surfaces.factory.ts',
      ),
      'utf8',
    );
    const toolOptions = readCallOptionsFromSource(
      baseSurfacesSource,
      'createWorkspaceShellToolSurface',
      'base surfaces',
    );

    expect(graphSource).toContain('createWorkspaceShellBaseSurfaces');
    expect(graphSource).not.toContain('createWorkspaceShellToolSurface');
    expect(baseSurfacesSource).toContain('createWorkspaceShellToolSurface');
    expect(source).not.toContain('createWorkspaceShellToolControllers');
    expect(source).not.toContain('blackBoxService: this.lazyServiceRefs.blackBoxService');
    expect(toolOptions).toContain('...context');
    expect(toolOptions).toContain('lazyServiceRefs');
    expect(source).not.toContain('sidebarOpen: this.uiState.sidebarOpen');
  });
});
