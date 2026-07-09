import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellInteractionLifecycleHost,
  type WorkspaceShellInteractionLifecycleHostOptions,
} from './workspace-shell-interaction-lifecycle-host.factory';

function createOptions(
  overrides: Partial<WorkspaceShellInteractionLifecycleHostOptions> = {},
): WorkspaceShellInteractionLifecycleHostOptions {
  return {
    actions: {
      setupDocumentClickListener: vi.fn(),
      teardown: vi.fn(),
    },
    authModal: {
      teardown: vi.fn(),
    },
    sidebarResize: {
      setup: vi.fn(),
      teardown: vi.fn(),
    },
    viewportResize: {
      cleanup: vi.fn(),
      setup: vi.fn(),
    },
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellInteractionLifecycleHost', () => {
  it('creates the interaction lifecycle controller lazily and forwards lifecycle stages', async () => {
    const options = createOptions();
    const lifecycle = createWorkspaceShellInteractionLifecycleHost(options);

    expect(options.sidebarResize.setup).not.toHaveBeenCalled();

    await lifecycle.setupNgOnInitStage();

    expect(options.sidebarResize.setup).toHaveBeenCalledTimes(1);
    expect(options.viewportResize.setup).toHaveBeenCalledTimes(1);
    expect(options.actions.setupDocumentClickListener).toHaveBeenCalledTimes(1);

    await lifecycle.teardownDestroyStage();
    await lifecycle.cleanupViewportStage();

    expect(options.sidebarResize.teardown).toHaveBeenCalledTimes(1);
    expect(options.authModal.teardown).toHaveBeenCalledTimes(1);
    expect(options.actions.teardown).toHaveBeenCalledTimes(1);
    expect(options.viewportResize.cleanup).toHaveBeenCalledTimes(1);
  });

  it('delegates concrete lifecycle controller loading to the loader boundary', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-interaction-lifecycle-host.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellInteractionLifecycleHostLoader');
    expect(source).not.toContain("import('./workspace-shell-interaction-lifecycle.controller')");
    expect(source).not.toContain('new WorkspaceShellInteractionLifecycleController');
    expect(source).not.toMatch(/import\s*{[^}]*WorkspaceShellInteractionLifecycleController/s);
  });
});
