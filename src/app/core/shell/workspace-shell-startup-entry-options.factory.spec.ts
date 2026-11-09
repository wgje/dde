import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellStartupEntryDelegatesOptions,
} from './workspace-shell-startup-entry-delegates.factory';
import type {
  WorkspaceShellStartupEntryControllers,
  WorkspaceShellStartupEntryControllersFactoryOptions,
} from './workspace-shell-startup-entry-controllers.factory';
import {
  readWorkspaceShellControllerGraphCallOptions,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

type WorkspaceShellStartupEntryOptionsFactory = (
  options: Record<string, unknown>,
) => WorkspaceShellStartupEntryDelegatesOptions;
type WorkspaceShellStartupEntryDelegateFactory = (
  options: Record<string, unknown>,
) => WorkspaceShellStartupEntryControllers;

function readWorkspaceShellStartupTemplateSurfacesSource(): string {
  return readFileSync(
    join(
      process.cwd(),
      'src/app/core/shell/workspace-shell-startup-template-surfaces.factory.ts',
    ),
    'utf8',
  );
}

function readStartupTemplateSurfacesCallOptions(callName: string): string {
  const source = readWorkspaceShellStartupTemplateSurfacesSource();
  const pattern = new RegExp(
    `${callName}\\(\\{(?<body>[\\s\\S]*?)\\n\\s{4}\\}\\)`,
    'm',
  );
  const match = source.match(pattern);
  if (!match?.groups?.body) {
    throw new Error(
      `Unable to find ${callName} options in startup template surfaces`,
    );
  }
  return match.groups.body;
}

async function loadFactories(): Promise<{
  createWorkspaceShellStartupEntryDelegate?:
    WorkspaceShellStartupEntryDelegateFactory;
  createWorkspaceShellStartupEntryOptions?:
    WorkspaceShellStartupEntryOptionsFactory;
  createWorkspaceShellStartupEntrySurface?:
    WorkspaceShellStartupEntryDelegateFactory;
}> {
  const modulePath = './workspace-shell-startup-entry-options.factory';
  const module = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));

  return module as {
    createWorkspaceShellStartupEntryDelegate?:
      WorkspaceShellStartupEntryDelegateFactory;
    createWorkspaceShellStartupEntryOptions?:
      WorkspaceShellStartupEntryOptionsFactory;
    createWorkspaceShellStartupEntrySurface?:
      WorkspaceShellStartupEntryDelegateFactory;
  };
}

describe('workspace shell startup entry options', () => {
  it('builds startup entry delegate options from shell dependencies', async () => {
    const { createWorkspaceShellStartupEntryOptions } = await loadFactories();

    expect(createWorkspaceShellStartupEntryOptions).toEqual(expect.any(Function));

    const routeUrl = vi.fn(() => '/projects/project-1/text');
    const uiState = { isMobile: vi.fn(() => true) };
    const projectState = {
      activeProjectId: vi.fn(() => 'project-1'),
      projects: vi.fn(() => [{ id: 'project-1' }]),
    };
    const startupLaunchSnapshot = vi.fn(() => null);
    const userSession = { currentUserId: vi.fn(() => 'user-1') };
    const bootStage = { isApplicationReady: vi.fn(() => true) };
    const focusPrefs = { isBlackBoxEnabled: vi.fn(() => true) };
    const sidebarOpen = { set: vi.fn() };
    const sidebarToolsLazyLoad = {
      loadBlackBoxRecorderComponent: vi.fn().mockResolvedValue(null),
      preload: vi.fn(),
    };
    const widgetGateMutation = { apply: vi.fn() };
    const toolControllers = {
      sidebarToolsLazyLoad,
      widgetGateMutation,
    };
    const focusStartupProbe = {
      primeWidgetWorkspaceGateSync: vi.fn(),
      recheckGate: vi.fn(),
    };
    const dockEngine = {
      refreshFocusSessionFromCloud: vi.fn().mockResolvedValue(undefined),
    };
    const authService = { sessionInitialized: vi.fn(() => true) };
    const widgetBinding = { completeAndroidBootstrap: vi.fn() };
    const router = { navigate: vi.fn() };
    const beforeUnloadManager = {};
    const logger = { warn: vi.fn() };
    const toast = { warning: vi.fn() };
    const warn = vi.fn();

    const options = createWorkspaceShellStartupEntryOptions?.({
      routeUrl,
      uiState,
      projectState,
      startupLaunchSnapshot,
      userSession,
      bootStage,
      focusPrefs,
      sidebarOpen,
      toolControllers,
      focusStartupProbe,
      dockEngine,
      authService,
      widgetBinding,
      router,
      beforeUnloadManager,
      logger,
      toast,
      warn,
    }) as WorkspaceShellStartupEntryDelegatesOptions;

    expect(options.routeState).toEqual({ routeUrl });
    expect(options.startupLaunchSnapshot).toBe(startupLaunchSnapshot);
    expect(options.userSession).toBe(userSession);
    expect(options.focusPrefs).toBe(focusPrefs);
    expect(options.sidebarOpen).toBe(sidebarOpen);
    expect(options.sidebarToolsLazyLoad).toBe(sidebarToolsLazyLoad);
    expect(options.widgetGateMutation).toBe(widgetGateMutation);
    expect(options.router).toBe(router);
    expect(options.beforeUnloadManager).toBe(beforeUnloadManager);
    expect(options.logger).toBe(logger);
    expect(options.toast).toBe(toast);
    expect(options.warn).toBe(warn);

    expect(options.isMobile()).toBe(true);
    expect(options.activeProjectId()).toBe('project-1');
    expect(options.projects()).toEqual([{ id: 'project-1' }]);
    expect(options.isApplicationReady()).toBe(true);
    expect(options.isSessionInitialized()).toBe(true);
    options.primeWidgetWorkspaceGateSync();
    options.recheckGate({ reason: 'startup' } as never);
    await options.refreshFocusSessionFromCloud('user-1');
    options.completeAndroidBootstrap({ requestId: 'bootstrap-1' } as never);

    expect(uiState.isMobile).toHaveBeenCalledOnce();
    expect(projectState.activeProjectId).toHaveBeenCalledOnce();
    expect(projectState.projects).toHaveBeenCalledOnce();
    expect(bootStage.isApplicationReady).toHaveBeenCalledOnce();
    expect(authService.sessionInitialized).toHaveBeenCalledOnce();
    expect(focusStartupProbe.primeWidgetWorkspaceGateSync).toHaveBeenCalledOnce();
    expect(focusStartupProbe.recheckGate).toHaveBeenCalledWith({ reason: 'startup' });
    expect(dockEngine.refreshFocusSessionFromCloud).toHaveBeenCalledWith('user-1');
    expect(widgetBinding.completeAndroidBootstrap).toHaveBeenCalledWith({
      requestId: 'bootstrap-1',
    });
  });

  it('creates startup entry delegates from shell dependencies in one factory call', async () => {
    const { createWorkspaceShellStartupEntryDelegate } = await loadFactories();

    expect(createWorkspaceShellStartupEntryDelegate).toEqual(expect.any(Function));

    let mappedOptions!: WorkspaceShellStartupEntryControllersFactoryOptions;
    const controllers = {} as WorkspaceShellStartupEntryControllers;
    const routeUrl = vi.fn(() => '/projects/project-1/text');
    const projectState = {
      activeProjectId: vi.fn(() => 'project-1'),
      projects: vi.fn(() => [{ id: 'project-1' }]),
    };
    const startupLaunchSnapshot = vi.fn(() => null);
    const userSession = { currentUserId: vi.fn(() => 'user-1') };
    const sidebarToolsLazyLoad = {
      loadBlackBoxRecorderComponent: vi.fn().mockResolvedValue(null),
      preload: vi.fn(),
    };
    const router = { navigate: vi.fn() };

    const result = createWorkspaceShellStartupEntryDelegate?.({
      routeUrl,
      uiState: { isMobile: vi.fn(() => true) },
      projectState,
      startupLaunchSnapshot,
      userSession,
      bootStage: { isApplicationReady: vi.fn(() => true) },
      focusPrefs: { isBlackBoxEnabled: vi.fn(() => true) },
      sidebarOpen: { set: vi.fn() },
      toolControllers: {
        sidebarToolsLazyLoad,
        widgetGateMutation: { apply: vi.fn() },
      },
      focusStartupProbe: {
        primeWidgetWorkspaceGateSync: vi.fn(),
        recheckGate: vi.fn(),
      },
      dockEngine: {
        refreshFocusSessionFromCloud: vi.fn().mockResolvedValue(undefined),
      },
      authService: { sessionInitialized: vi.fn(() => true) },
      widgetBinding: { completeAndroidBootstrap: vi.fn() },
      router,
      beforeUnloadManager: {},
      logger: { warn: vi.fn() },
      toast: { warning: vi.fn() },
      warn: vi.fn(),
      createStartupEntryControllers: (
        options: WorkspaceShellStartupEntryControllersFactoryOptions,
      ) => {
        mappedOptions = options;
        return controllers;
      },
    });

    expect(result).toBe(controllers);
    expect(mappedOptions.routeUrl()).toBe('/projects/project-1/text');
    expect(mappedOptions.currentUserId()).toBe('user-1');
    mappedOptions.preloadSidebarTools('intent');
    expect(sidebarToolsLazyLoad.preload).toHaveBeenCalledWith('intent');
    await mappedOptions.navigate(['/projects'], { replaceUrl: true });
    expect(router.navigate).toHaveBeenCalledWith(
      ['/projects'],
      { replaceUrl: true },
    );
  });

  it('creates startup entry delegates from grouped shell surfaces', async () => {
    const { createWorkspaceShellStartupEntrySurface } = await loadFactories();

    expect(createWorkspaceShellStartupEntrySurface).toEqual(expect.any(Function));

    let mappedOptions!: WorkspaceShellStartupEntryControllersFactoryOptions;
    const controllers = {} as WorkspaceShellStartupEntryControllers;
    const routeUrl = vi.fn(() => '/projects/project-1/text');
    const router = { navigate: vi.fn() };
    const projectState = {
      activeProjectId: vi.fn(() => 'project-1'),
      projects: vi.fn(() => [{ id: 'project-1' }]),
    };
    const startupLaunchSnapshot = vi.fn(() => null);
    const sidebarToolsLazyLoad = {
      loadBlackBoxRecorderComponent: vi.fn().mockResolvedValue(null),
      preload: vi.fn(),
    };
    const chrome = {
      dockEngine: {
        refreshFocusSessionFromCloud: vi.fn().mockResolvedValue(undefined),
      },
    };

    const result = createWorkspaceShellStartupEntrySurface?.({
      routing: { routeUrl, router },
      uiState: { isMobile: vi.fn(() => true), sidebarOpen: { set: vi.fn() } },
      projectState,
      launchSnapshotSurface: { startupLaunchSnapshot },
      userSession: { currentUserId: vi.fn(() => 'user-1') },
      bootStage: { isApplicationReady: vi.fn(() => true) },
      focusPrefs: { isBlackBoxEnabled: vi.fn(() => true) },
      toolControllers: {
        sidebarToolsLazyLoad,
        widgetGateMutation: { apply: vi.fn() },
      },
      lazyServiceRefs: {
        focusStartupProbe: {
          primeWidgetWorkspaceGateSync: vi.fn(),
          recheckGate: vi.fn(),
        },
      },
      chrome,
      authService: { sessionInitialized: vi.fn(() => true) },
      widgetBinding: { completeAndroidBootstrap: vi.fn() },
      beforeUnloadManager: {},
      logger: { warn: vi.fn() },
      toast: { warning: vi.fn() },
      warn: vi.fn(),
      createStartupEntryControllers: (
        options: WorkspaceShellStartupEntryControllersFactoryOptions,
      ) => {
        mappedOptions = options;
        return controllers;
      },
    });

    expect(result).toBe(controllers);
    expect(mappedOptions.routeUrl()).toBe('/projects/project-1/text');
    await mappedOptions.refreshFocusSessionFromCloud('user-1');
    expect(chrome.dockEngine.refreshFocusSessionFromCloud)
      .toHaveBeenCalledWith('user-1');
    mappedOptions.preloadSidebarTools('intent');
    expect(sidebarToolsLazyLoad.preload).toHaveBeenCalledWith('intent');
    await mappedOptions.navigate(['/projects'], { replaceUrl: true });
    expect(router.navigate).toHaveBeenCalledWith(
      ['/projects'],
      { replaceUrl: true },
    );
  });

  it('keeps startup entry option wiring outside WorkspaceShellComponent', () => {
    const source = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const startupTemplateSurfacesSource =
      readWorkspaceShellStartupTemplateSurfacesSource();
    const startupTemplateBlock = readWorkspaceShellControllerGraphCallOptions(
      'createWorkspaceShellStartupTemplateSurfaces',
    );
    const startupEntryBlock = readStartupTemplateSurfacesCallOptions(
      'createWorkspaceShellStartupEntrySurface',
    );

    expect(graphSource).toContain('createWorkspaceShellStartupTemplateSurfaces');
    expect(graphSource).not.toContain('createWorkspaceShellStartupEntrySurface');
    expect(startupTemplateSurfacesSource).toContain(
      'createWorkspaceShellStartupEntrySurface',
    );
    expect(source).not.toContain('createWorkspaceShellStartupEntryDelegate');
    expect(source).not.toContain('createWorkspaceShellStartupEntryOptions');
    expect(source).not.toContain('private readonly startupEntryOptions');
    expect(source).not.toContain('createWorkspaceShellStartupEntryDelegates');
    expect(startupTemplateBlock).toContain('...base');
    expect(startupTemplateBlock).toContain('...sessionRouting');
    expect(startupEntryBlock).toContain('...options');
    expect(startupEntryBlock).not.toContain('routeUrl: this.routing.routeUrl');
    expect(startupEntryBlock).not.toContain(
      'startupLaunchSnapshot: this.launchSnapshotSurface.startupLaunchSnapshot',
    );
    expect(startupEntryBlock).not.toContain(
      'focusStartupProbe: this.lazyServiceRefs.focusStartupProbe',
    );
    expect(startupEntryBlock).not.toContain('dockEngine: this.chrome.dockEngine');
    expect(source).not.toContain(
      'private readonly sidebarToolsLazyLoad = this.toolControllers.sidebarToolsLazyLoad',
    );
    expect(source).not.toContain(
      'private readonly widgetGateMutation = this.toolControllers.widgetGateMutation',
    );
    expect(source).not.toContain(
      'private readonly startupEntryIntentResolver =',
    );
    expect(source).not.toContain(
      'private readonly mobileRootStartupNavigation =',
    );
    expect(source).not.toContain(
      'private readonly androidWidgetLazyLoad =',
    );
    expect(source).not.toContain(
      'private readonly startupEntryIntentController =',
    );
    expect(source).not.toMatch(
      /createWorkspaceShellStartupEntryDelegates\(\{\s*routeState:/s,
    );
    expect(source).not.toContain('primeWidgetWorkspaceGateSync: () =>');
    expect(source).not.toContain('refreshFocusSessionFromCloud: (userId)');
    expect(source).not.toContain('completeAndroidBootstrap: (request)');
  });
});
