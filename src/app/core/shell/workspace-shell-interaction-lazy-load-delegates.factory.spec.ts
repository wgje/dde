import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellInteractionLazyLoadDelegates,
  type WorkspaceShellInteractionLazyLoadDelegateOptions,
} from './workspace-shell-interaction-lazy-load-delegates.factory';

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

function createMouseEvent(): MouseEvent {
  let defaultPrevented = false;

  return {
    get defaultPrevented() {
      return defaultPrevented;
    },
    preventDefault: vi.fn(() => {
      defaultPrevented = true;
    }),
  } as unknown as MouseEvent;
}

function createDelegateOptions(
  overrides: Partial<WorkspaceShellInteractionLazyLoadDelegateOptions> = {},
): WorkspaceShellInteractionLazyLoadDelegateOptions {
  return {
    activeProjectId: () => null,
    activeView: () => 'text',
    authCoord: {} as never,
    checkGateForMobileProjectEntry: vi.fn(),
    currentUserId: () => 'user-1',
    destroyed: () => false,
    dockEngine: {} as never,
    injector: {} as never,
    isMobile: () => true,
    modalCoord: {} as never,
    navigateByUrl: vi.fn(),
    parkingService: {} as never,
    preferenceService: {} as never,
    projectCoord: {} as never,
    searchController: {} as never,
    searchLazyLoad: {} as never,
    setIsMobile: vi.fn(),
    setSidebarOpen: vi.fn(),
    sidebarOpen: {} as never,
    signOutController: {} as never,
    storageEscape: {} as never,
    taskStore: {} as never,
    toast: {} as never,
    uiState: {} as never,
    userSession: {} as never,
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellInteractionLazyLoadDelegates', () => {
  it('does not keep a second auth modal lazy-load cache in the interaction factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-interaction-lazy-load-delegates.factory.ts'),
      'utf8',
    );

    expect(source).toMatch(/import\s*{[^}]*createWorkspaceShellInteractionAuthModalHost/s);
    expect(source).not.toContain('authModalPromise');
    expect(source).not.toContain('authModalInstance');
    expect(source).not.toContain('factory lazy-load');
    expect(source).not.toContain("import('./workspace-shell-auth-modal-lazy-load-delegate.factory')");
    expect(source).not.toContain('function createAuthModalDelegate');
  });

  it('delegates sidebar resize lazy host creation out of the interaction factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-interaction-lazy-load-delegates.factory.ts'),
      'utf8',
    );

    expect(source).toMatch(/import\s*{[^}]*createWorkspaceShellInteractionSidebarResizeHost/s);
    expect(source).not.toContain('WorkspaceShellInteractionSidebarResizeLazyDelegateController');
    expect(source).not.toContain("import('./workspace-shell-sidebar-resize.factory')");
    expect(source).not.toContain('class WorkspaceShellInteractionSidebarResizeLazyDelegate');
    expect(source).not.toContain('function createSidebarResizeHost');
    expect(source).not.toContain('let pendingResize');
    expect(source).not.toContain('delegatePromise');
  });

  it('delegates interaction lifecycle host creation out of the interaction factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-interaction-lazy-load-delegates.factory.ts'),
      'utf8',
    );

    expect(source).toMatch(/import\s*{[^}]*createWorkspaceShellInteractionLifecycleHost/s);
    expect(source).not.toContain("import { WorkspaceShellInteractionLifecycleController }");
    expect(source).toMatch(/import type\s*{[^}]*WorkspaceShellInteractionLifecycleController/s);
    expect(source).not.toContain("import('./workspace-shell-interaction-lifecycle.controller')");
    expect(source).not.toContain('function createInteractionLifecycle');
  });

  it('delegates touch gesture lazy host creation out of the interaction factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-interaction-lazy-load-delegates.factory.ts'),
      'utf8',
    );

    expect(source).toMatch(/import\s*{[^}]*createWorkspaceShellInteractionTouchGesturesHost/s);
    expect(source).not.toContain("import('./workspace-shell-touch-gesture-lazy-load.controller')");
    expect(source).not.toContain('function createTouchGesturesHost');
  });

  it('delegates modal callbacks creation out of the interaction factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-interaction-lazy-load-delegates.factory.ts'),
      'utf8',
    );

    expect(source).toMatch(/import\s*{[^}]*createWorkspaceShellInteractionModalCallbacks/s);
    expect(source).not.toMatch(/import\s*{[^}]*WorkspaceShellModalCallbacksController/s);
    expect(source).not.toContain("import('./workspace-shell-modal-callbacks.controller')");
    expect(source).not.toContain('function createModalCallbacks');
  });

  it('creates actions synchronously while keeping touch and viewport hosts lazy', async () => {
    const touchGestures = {
      onMainTouchEnd: vi.fn(),
      onMainTouchMove: vi.fn(),
      onMainTouchStart: vi.fn(),
      onSidebarTouchEnd: vi.fn(),
      onSidebarTouchMove: vi.fn(),
      onSidebarTouchStart: vi.fn(),
    };
    const createTouchGesturesHost = vi.fn().mockResolvedValue(touchGestures);
    const documentAddEventListener = vi.fn();
    const documentRemoveEventListener = vi.fn();
    const windowAddEventListener = vi.fn();
    const windowRemoveEventListener = vi.fn();

    const delegates = createWorkspaceShellInteractionLazyLoadDelegates(createDelegateOptions({
      getDocument: () => ({
        addEventListener: documentAddEventListener,
        removeEventListener: documentRemoveEventListener,
      } as unknown as Document),
      getWindow: () => ({
        addEventListener: windowAddEventListener,
        removeEventListener: windowRemoveEventListener,
      } as unknown as Window),
      warn: vi.fn(),
      createTouchGesturesHost: createTouchGesturesHost as never,
    }));

    expect(createTouchGesturesHost).not.toHaveBeenCalled();

    await Promise.all([
      delegates.touchGestures.onSidebarTouchStart({} as TouchEvent) as unknown as Promise<unknown>,
      delegates.viewportResize.setup() as unknown as Promise<unknown>,
      delegates.actions.setupDocumentClickListener() as unknown as Promise<unknown>,
    ]);
    await flushMicrotasks();

    expect(documentAddEventListener).toHaveBeenCalledWith('click', expect.any(Function));
    expect(windowAddEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(createTouchGesturesHost).toHaveBeenCalledTimes(1);
    expect(touchGestures.onSidebarTouchStart).toHaveBeenCalledTimes(1);

    await Promise.all([
      delegates.actions.teardown() as unknown as Promise<unknown>,
      delegates.viewportResize.cleanup() as unknown as Promise<unknown>,
    ]);
    await flushMicrotasks();

    expect(documentRemoveEventListener).toHaveBeenCalledWith('click', expect.any(Function));
    expect(windowRemoveEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('returns sidebar resize with the other interaction delegates', () => {
    const delegates = createWorkspaceShellInteractionLazyLoadDelegates(createDelegateOptions());

    expect('sidebarResize' in delegates).toBe(true);
  });

  it('keeps the sidebar resize host lazy while exposing synchronous resize state', async () => {
    const sidebarResize = {
      setup: vi.fn(),
      teardown: vi.fn(),
      isResizingAny: vi.fn(() => false),
      startSidebarResize: vi.fn(),
      startContentResize: vi.fn(),
      onMouseMove: vi.fn(),
      onMouseUp: vi.fn(),
    };
    const createSidebarResizeFactoryHost = vi.fn().mockResolvedValue(sidebarResize);
    const delegates = createWorkspaceShellInteractionLazyLoadDelegates(createDelegateOptions({
      createSidebarResizeFactoryHost,
    }));
    const event = createMouseEvent();

    expect(createSidebarResizeFactoryHost).not.toHaveBeenCalled();
    expect(delegates.sidebarResize.isResizingAny()).toBe(false);

    delegates.sidebarResize.startSidebarResize(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(delegates.sidebarResize.isResizingAny()).toBe(true);

    await flushMicrotasks();

    expect(createSidebarResizeFactoryHost).toHaveBeenCalledTimes(1);
    expect(sidebarResize.setup).toHaveBeenCalledTimes(1);
    expect(sidebarResize.startSidebarResize).toHaveBeenCalledWith(event);
    expect(delegates.sidebarResize.isResizingAny()).toBe(false);
  });


  it('returns an interaction lifecycle delegate built from the lazy delegates', async () => {
    const record: string[] = [];
    const push = (label: string) => vi.fn(() => record.push(label));
    const delegates = createWorkspaceShellInteractionLazyLoadDelegates(createDelegateOptions({
      createActionsHost: () => ({
        setupDocumentClickListener: push('actions.setupDocumentClickListener'),
        teardown: push('actions.teardown'),
      } as never),
      createViewportResizeHost: async () => ({
        setup: push('viewportResize.setup'),
        cleanup: push('viewportResize.cleanup'),
      } as never),
      createSidebarResizeFactoryHost: async () => ({
        setup: push('sidebarResize.setup'),
        teardown: push('sidebarResize.teardown'),
        isResizingAny: vi.fn(),
        startSidebarResize: vi.fn(),
        startContentResize: vi.fn(),
        onMouseMove: vi.fn(),
        onMouseUp: vi.fn(),
      }),
      createAuthModalHostDelegate: async () => ({
        teardown: push('authModal.teardown'),
        handleLocalModeFromModal: vi.fn(),
        handleLoginFromModal: vi.fn(),
        handleResetPasswordFromModal: vi.fn(),
        handleSignupFromModal: vi.fn(),
      }),
    }));

    delegates.lifecycle.setupNgOnInitStage();
    await vi.waitFor(() => {
      expect(record).toEqual(expect.arrayContaining([
        'actions.setupDocumentClickListener',
        'viewportResize.setup',
      ]));
    });
    expect(record).toHaveLength(2);

    record.length = 0;
    delegates.lifecycle.teardownDestroyStage();
    delegates.lifecycle.cleanupViewportStage();
    await flushMicrotasks();

    expect(record).toEqual([
      'actions.teardown',
      'viewportResize.cleanup',
    ]);
  });

  it('returns modal callbacks built from the interaction actions delegate', async () => {
    const actions = {
      signOut: vi.fn(),
      updateTheme: vi.fn(),
      handleImportComplete: vi.fn(),
      handleLoginFromModal: vi.fn(),
      handleSignupFromModal: vi.fn(),
      handleResetPasswordFromModal: vi.fn(),
      handleLocalModeFromModal: vi.fn(),
      confirmCreateProject: vi.fn(),
      handleMigrationComplete: vi.fn(),
      closeMigrationModal: vi.fn(),
      setupDocumentClickListener: vi.fn(),
      teardown: vi.fn(),
    };
    const delegates = createWorkspaceShellInteractionLazyLoadDelegates(createDelegateOptions({
      createActionsHost: () => actions as never,
    }));
    const callbacks = await Promise.resolve(delegates.modalCallbacks.createCallbacks());

    await Promise.resolve(callbacks.updateTheme?.('ocean') as unknown);
    await Promise.resolve(callbacks.handleMigrationComplete?.() as unknown);

    expect(actions.updateTheme).toHaveBeenCalledWith('ocean');
    expect(actions.handleMigrationComplete).toHaveBeenCalledTimes(1);
  });

  it('routes modal callback action failures through the interaction action warn boundary', async () => {
    const error = new Error('modal callback action failed');
    const warn = vi.fn();
    const actions = {
      signOut: vi.fn().mockRejectedValue(error),
      updateTheme: vi.fn(),
      handleImportComplete: vi.fn(),
      handleLoginFromModal: vi.fn(),
      handleSignupFromModal: vi.fn(),
      handleResetPasswordFromModal: vi.fn(),
      handleLocalModeFromModal: vi.fn(),
      confirmCreateProject: vi.fn(),
      handleMigrationComplete: vi.fn(),
      closeMigrationModal: vi.fn(),
      setupDocumentClickListener: vi.fn(),
      teardown: vi.fn(),
    };
    const delegates = createWorkspaceShellInteractionLazyLoadDelegates(createDelegateOptions({
      createActionsHost: () => actions as never,
      warn,
    }));
    const callbacks = await Promise.resolve(delegates.modalCallbacks.createCallbacks());

    callbacks.signOut?.();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        '工作区操作执行失败，已跳过本次操作',
        error,
      );
    });
  });

  it('creates and returns the auth modal delegate for actions', async () => {
    const authModal = {
      handleLocalModeFromModal: vi.fn().mockResolvedValue(undefined),
      handleLoginFromModal: vi.fn().mockResolvedValue(undefined),
      handleResetPasswordFromModal: vi.fn().mockResolvedValue(undefined),
      handleSignupFromModal: vi.fn().mockResolvedValue(undefined),
    };
    const createAuthModalHostDelegate = vi.fn().mockResolvedValue(authModal);
    const delegates = createWorkspaceShellInteractionLazyLoadDelegates(createDelegateOptions({
      createAuthModalHostDelegate,
    }));
    const data = { email: 'u@example.com', password: 'pw' };

    expect(createAuthModalHostDelegate).not.toHaveBeenCalled();

    await delegates.authModal.handleLoginFromModal(data);

    expect(createAuthModalHostDelegate).toHaveBeenCalledTimes(1);
    expect(authModal.handleLoginFromModal).toHaveBeenCalledWith(data);
  });
});
