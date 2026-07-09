import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellInteractionLifecycleControllerOptions,
} from './workspace-shell-interaction-lifecycle.controller';
import {
  createWorkspaceShellInteractionLifecycleHostLoader,
} from './workspace-shell-interaction-lifecycle-host-loader.factory';

function createOptions(
  overrides: Partial<WorkspaceShellInteractionLifecycleControllerOptions> = {},
): WorkspaceShellInteractionLifecycleControllerOptions {
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
    ...overrides,
  };
}

describe('createWorkspaceShellInteractionLifecycleHostLoader', () => {
  it('loads the concrete interaction lifecycle controller lazily', async () => {
    const options = createOptions();
    const loadHost = createWorkspaceShellInteractionLifecycleHostLoader({ options });

    expect(options.sidebarResize.setup).not.toHaveBeenCalled();

    const lifecycle = await loadHost();

    await lifecycle.setupNgOnInitStage();

    expect(options.sidebarResize.setup).toHaveBeenCalledTimes(1);
    expect(options.viewportResize.setup).toHaveBeenCalledTimes(1);
    expect(options.actions.setupDocumentClickListener).toHaveBeenCalledTimes(1);
  });

  it('owns the dynamic import of the concrete lifecycle controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-interaction-lifecycle-host-loader.factory.ts'),
      'utf8',
    );

    expect(source).toContain("import('./workspace-shell-interaction-lifecycle.controller')");
    expect(source).not.toMatch(/import\s*{[^}]*WorkspaceShellInteractionLifecycleController/s);
  });
});
