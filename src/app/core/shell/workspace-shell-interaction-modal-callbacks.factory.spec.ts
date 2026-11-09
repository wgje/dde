import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellInteractionModalCallbacks,
  type WorkspaceShellInteractionModalCallbacksOptions,
} from './workspace-shell-interaction-modal-callbacks.factory';
import type {
  WorkspaceShellActionsInteractionDelegate,
} from './workspace-shell-interaction-lazy-load-delegates.factory';

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

describe('createWorkspaceShellInteractionModalCallbacks', () => {
  it('builds modal callbacks from the interaction actions delegate', async () => {
    const actions = createActionsDelegate();
    const delegate = createWorkspaceShellInteractionModalCallbacks(createOptions({
      actions,
    }));
    const callbacks = await Promise.resolve(delegate.createCallbacks());

    callbacks.updateTheme?.('ocean');
    callbacks.handleMigrationComplete?.();

    expect(actions.updateTheme).toHaveBeenCalledWith('ocean');
    expect(actions.handleMigrationComplete).toHaveBeenCalledTimes(1);
  });

  it('delegates concrete modal callbacks loading to the loader boundary', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-interaction-modal-callbacks.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellInteractionModalCallbacksLoader');
    expect(source).not.toContain("import('./workspace-shell-modal-callbacks.controller')");
    expect(source).not.toContain('new WorkspaceShellModalCallbacksController');
    expect(source).not.toMatch(/import\s*{[^}]*WorkspaceShellModalCallbacksController/s);
  });
});
