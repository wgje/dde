import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellViewportResizeInteractionDelegate,
} from './workspace-shell-interaction-lazy-load-delegates.factory';
import {
  createWorkspaceShellInteractionViewportResizeHostLoader,
  type WorkspaceShellInteractionViewportResizeHostLoaderOptions,
} from './workspace-shell-interaction-viewport-resize-host-loader.factory';

function createViewportResizeDelegate(): WorkspaceShellViewportResizeInteractionDelegate {
  return {
    cleanup: vi.fn(),
    handleResize: vi.fn(),
    setup: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellInteractionViewportResizeHostLoaderOptions['options']> = {},
): WorkspaceShellInteractionViewportResizeHostLoaderOptions['options'] {
  return {
    listenToWindow: vi.fn(() => vi.fn()),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellInteractionViewportResizeHostLoader', () => {
  it('uses the provided viewport resize host lazily', async () => {
    const viewportResize = createViewportResizeDelegate();
    const createViewportResizeHost = vi.fn().mockResolvedValue(viewportResize);
    const loadHost = createWorkspaceShellInteractionViewportResizeHostLoader({
      options: createOptions({ createViewportResizeHost }),
    });

    expect(createViewportResizeHost).not.toHaveBeenCalled();

    await expect(loadHost()).resolves.toBe(viewportResize);

    expect(createViewportResizeHost).toHaveBeenCalledTimes(1);
  });

  it('owns the dynamic import of the concrete viewport resize host', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-interaction-viewport-resize-host-loader.factory.ts'),
      'utf8',
    );

    expect(source).toContain("import('./workspace-shell-viewport-resize-lazy-load-host.controller')");
    expect(source).not.toMatch(/import\\s*{[^}]*WorkspaceShellViewportResizeLazyLoadHostController/s);
  });
});
