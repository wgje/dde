import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellActionsInteractionDelegate,
} from './workspace-shell-interaction-lazy-load-delegates.factory';
import {
  createWorkspaceShellInteractionModalCallbacksLoader,
} from './workspace-shell-interaction-modal-callbacks-loader.factory';
import type {
  WorkspaceShellInteractionModalCallbacksOptions,
} from './workspace-shell-interaction-modal-callbacks.factory';

function createActionsDelegate(): WorkspaceShellActionsInteractionDelegate {
  return {
    closeMigrationModal: vi.fn(),
    confirmCreateProject: vi.fn(),
    handleImportComplete: vi.fn(),
    handleLocalModeFromModal: vi.fn(),
    handleLoginFromModal: vi.fn(),
    handleMigrationComplete: vi.fn(),
    handleResetPasswordFromModal: vi.fn(),
    handleSignupFromModal: vi.fn(),
    setupDocumentClickListener: vi.fn(),
    signOut: vi.fn(),
    teardown: vi.fn(),
    updateTheme: vi.fn(),
  } as unknown as WorkspaceShellActionsInteractionDelegate;
}

function createOptions(
  overrides: Partial<WorkspaceShellInteractionModalCallbacksOptions> = {},
): WorkspaceShellInteractionModalCallbacksOptions {
  return {
    actions: createActionsDelegate(),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellInteractionModalCallbacksLoader', () => {
  it('loads concrete modal callbacks lazily from interaction actions', async () => {
    const actions = createActionsDelegate();
    const loadCallbacks = createWorkspaceShellInteractionModalCallbacksLoader({
      options: createOptions({ actions }),
    });

    expect(actions.updateTheme).not.toHaveBeenCalled();

    const callbacks = await loadCallbacks();
    callbacks.updateTheme?.('ocean');
    callbacks.handleMigrationComplete?.();

    expect(actions.updateTheme).toHaveBeenCalledWith('ocean');
    expect(actions.handleMigrationComplete).toHaveBeenCalledTimes(1);
  });

  it('owns the dynamic import of the concrete modal callbacks controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-interaction-modal-callbacks-loader.factory.ts'),
      'utf8',
    );

    expect(source).toContain("import('./workspace-shell-modal-callbacks.controller')");
    expect(source).not.toMatch(/import\s*{[^}]*WorkspaceShellModalCallbacksController/s);
  });
});
