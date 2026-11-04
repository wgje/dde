import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createWorkspaceShellInteractionActionsHost,
  type WorkspaceShellInteractionActionsHostOptions,
} from './workspace-shell-interaction-actions-host.factory';
import type {
  WorkspaceShellActionsInteractionDelegate,
} from './workspace-shell-interaction-lazy-load-delegates.factory';

function createActionsDelegate(): WorkspaceShellActionsInteractionDelegate {
  return {
    closeMigrationModal: vi.fn(),
    confirmDeleteProject: vi.fn(),
    confirmCreateProject: vi.fn(),
    handleImportComplete: vi.fn(),
    handleLocalModeFromModal: vi.fn(),
    handleLoginFromModal: vi.fn(),
    handleMigrationComplete: vi.fn(),
    handleResetPasswordFromModal: vi.fn(),
    handleSignupFromModal: vi.fn(),
    openTrashModal: vi.fn(),
    setupDocumentClickListener: vi.fn(),
    signOut: vi.fn(),
    teardown: vi.fn(),
    updateTheme: vi.fn(),
  } as unknown as WorkspaceShellActionsInteractionDelegate;
}

function createOptions(
  overrides: Partial<WorkspaceShellInteractionActionsHostOptions> = {},
): WorkspaceShellInteractionActionsHostOptions {
  return {
    authModal: {} as never,
    getDocument: () => undefined,
    warn: vi.fn(),
    ...overrides,
  } as WorkspaceShellInteractionActionsHostOptions;
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('createWorkspaceShellInteractionActionsHost', () => {
  it('uses the provided actions host without loading the default host', async () => {
    const actions = createActionsDelegate();
    const createActionsHost = vi.fn(() => actions);
    const host = createWorkspaceShellInteractionActionsHost(createOptions({
      createActionsHost,
    }));

    expect(createActionsHost).not.toHaveBeenCalled();

    await host.signOut();

    expect(createActionsHost).toHaveBeenCalledTimes(1);
    expect(actions.signOut).toHaveBeenCalledTimes(1);
  });

  it('routes action failures through the shared warn boundary', async () => {
    const error = new Error('action failed');
    const warn = vi.fn();
    const actions = createActionsDelegate();
    vi.mocked(actions.signOut).mockRejectedValue(error);
    const host = createWorkspaceShellInteractionActionsHost(createOptions({
      createActionsHost: () => actions,
      warn,
    }));

    await host.signOut();

    expect(warn).toHaveBeenCalledWith(
      '工作区操作执行失败，已跳过本次操作',
      error,
    );
  });

  it('captures the delete owner before lazy loading and relays the clicked owner', async () => {
    const clickedOwner = Object.freeze({ projectId: 'project-a', generation: 1 });
    let currentOwner: { projectId: string; generation: number } = clickedOwner;
    const captureActiveProjectOwner = vi.fn(() => currentOwner);
    const actions = createActionsDelegate();
    const event = { stopPropagation: vi.fn() } as unknown as Event;
    const host = createWorkspaceShellInteractionActionsHost(createOptions({
      createActionsHost: () => actions,
      projectCoord: { captureActiveProjectOwner } as never,
    }));

    const completion = host.confirmDeleteProject('project-a', 'Project A', event);
    const captureCountBeforeDelegateLoad = captureActiveProjectOwner.mock.calls.length;
    currentOwner = { projectId: 'project-b', generation: 2 };
    await completion;

    expect(captureCountBeforeDelegateLoad).toBe(1);
    expect(captureActiveProjectOwner).toHaveBeenCalledOnce();
    expect(actions.confirmDeleteProject).toHaveBeenCalledWith(
      'project-a', 'Project A', event, clickedOwner,
    );
  });

  it('keeps the concrete actions host behind a dynamic import', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-interaction-actions-host.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellInteractionActionsHostLoader');
    expect(source).not.toContain("import('./workspace-shell-actions-lazy-load-host.controller')");
    expect(source).not.toContain('createWorkspaceShellActionsLazyLoadHost');
  });
});
