import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellInteractionDelegates,
  type WorkspaceShellInteractionDelegatesOptions,
} from './workspace-shell-interaction-delegates.factory';
import type {
  WorkspaceShellInteractionLazyLoadDelegateOptions,
  WorkspaceShellInteractionLazyLoadDelegates,
} from './workspace-shell-interaction-lazy-load-delegates.factory';
import {
  readWorkspaceShellControllerGraphCallOptions,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellInteractionSurfacesCallOptions,
  readWorkspaceShellInteractionSurfacesSource,
  readWorkspaceShellSource,
  readWorkspaceShellTemplates,
} from './workspace-shell-source.spec-helpers';

describe('createWorkspaceShellInteractionDelegates', () => {
  it('moves interaction delegate option wiring out of WorkspaceShellComponent', () => {
    const componentSource = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const interactionSurfacesSource = readWorkspaceShellInteractionSurfacesSource();

    expect(graphSource).toContain('createWorkspaceShellInteractionSurfaces');
    expect(interactionSurfacesSource).toContain(
      'createWorkspaceShellInteractionBoundarySurface',
    );
    expect(componentSource).not.toContain('createWorkspaceShellInteractionDelegates');
    expect(componentSource).not.toContain('createWorkspaceShellInteractionLazyLoadDelegates');
    expect(componentSource).not.toContain('private readonly interactionLazyLoad =');
  });

  it('keeps low-level interaction callback adapters out of WorkspaceShellComponent', () => {
    const surfaceOptions = readWorkspaceShellControllerGraphCallOptions(
      'createWorkspaceShellInteractionSurfaces',
    );
    const interactionOptions = readWorkspaceShellInteractionSurfacesCallOptions(
      'createWorkspaceShellInteractionBoundarySurface',
    );

    expect(surfaceOptions).toContain('...context');
    expect(surfaceOptions).toContain('...base');
    expect(surfaceOptions).toContain('...sessionRouting');
    expect(interactionOptions).toContain('session: { authService: options.authService }');
    expect(interactionOptions).toContain('...options');
    expect(interactionOptions).not.toContain('navigation: {');
    expect(interactionOptions).not.toContain('router: this.routing.router');
    expect(interactionOptions).not.toContain(
      'focus: { mobileFocusGate: this.focusSyncControllers.mobileFocusGate }',
    );
    expect(interactionOptions).not.toContain(
      'runtime: { lazyServiceRefs: this.lazyServiceRefs }',
    );
    expect(interactionOptions).not.toContain(
      'layout: { uiState: this.uiState, sidebarOpen: this.uiState.sidebarOpen }',
    );
    expect(interactionOptions).not.toMatch(/\n\s{6}authService: this\.authService,/);
    expect(interactionOptions).not.toMatch(/\n\s{6}router: this\.router,/);
    expect(interactionOptions).not.toMatch(/\n\s{6}projectState: this\.projectState,/);
    expect(interactionOptions).not.toMatch(/\n\s{6}mobileFocusGate: this\.mobileFocusGate,/);
    expect(interactionOptions).not.toMatch(/\n\s{6}lazyServiceRefs: this\.lazyServiceRefs,/);
    expect(interactionOptions).not.toMatch(/\n\s{6}sidebarOpen: this\.isSidebarOpen,/);
    expect(interactionOptions).not.toContain('this.isSidebarOpen');
    expect(interactionOptions).not.toMatch(/\n\s{6}uiState: this\.uiState,/);
    expect(interactionOptions).not.toContain('setSidebarOpen: (open)');
    expect(interactionOptions).not.toContain('currentUserId: () =>');
    expect(interactionOptions).not.toContain('navigateByUrl: (url)');
    expect(interactionOptions).not.toContain('activeProjectId: () =>');
    expect(interactionOptions).not.toContain('previewParkedTask: (taskId)');
    expect(interactionOptions).not.toContain('setIsMobile: (isMobile)');
  });

  it('exposes interaction delegates to the template through one interaction surface', () => {
    const componentSource = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const interactionSurfacesSource = readWorkspaceShellInteractionSurfacesSource();
    // 中文注释：交互绑定分布在根模板与拆分后的侧栏/覆盖层子模板中，用联合视图断言
    const template = readWorkspaceShellTemplates();

    expect(graphSource).toContain('createWorkspaceShellInteractionSurfaces({');
    expect(interactionSurfacesSource).toContain(
      'createWorkspaceShellInteractionBoundarySurface({',
    );
    expect(graphSource).toContain('...interaction');
    expect(componentSource).not.toContain(
      'createWorkspaceShellInteractionTemplateSurface(',
    );
    expect(componentSource).not.toContain(
      'readonly touchGestures = this.interactionDelegates.touchGestures;',
    );
    expect(componentSource).not.toContain(
      'readonly actions = this.interactionDelegates.actions;',
    );
    expect(componentSource).not.toContain(
      'readonly sidebarResize = this.interactionDelegates.sidebarResize;',
    );
    expect(template).toContain('template.interaction.actions.createNewProject()');
    expect(template).toContain(
      'template.interaction.touchGestures.onSidebarTouchStart($event)',
    );
    expect(template).toContain(
      'template.interaction.sidebarResize.startSidebarResize($event)',
    );
    expect(template).not.toMatch(/(?<!template\.)interaction\./);
  });

  it('adapts structured interaction dependencies into lazy-load delegate callbacks', async () => {
    const isMobile = Object.assign(vi.fn(() => false), { set: vi.fn() });
    const uiState = {
      activeView: vi.fn(() => 'text'),
      filterMode: { set: vi.fn() },
      floatingWindowPref: { set: vi.fn() },
      isMobile,
      layoutDirection: { set: vi.fn() },
    };
    const sidebarOpen = { set: vi.fn() };
    const router = { navigateByUrl: vi.fn(async () => true) };
    const projectState = { activeProjectId: vi.fn(() => 'project-1') };
    const authService = { currentUserId: vi.fn(() => 'user-1') };
    const mobileFocusGate = { checkGateForMobileProjectEntry: vi.fn() };
    const parkingService = { previewTask: vi.fn() };
    const delegates = {
      actions: {},
      authModal: {},
      lifecycle: {},
      modalCallbacks: {},
      sidebarResize: {},
      touchGestures: {},
      viewportResize: {},
    } as unknown as WorkspaceShellInteractionLazyLoadDelegates;
    const createInteractionLazyLoadDelegates = vi.fn((
      _: WorkspaceShellInteractionLazyLoadDelegateOptions,
    ) => delegates);

    expect(createWorkspaceShellInteractionDelegates({
      authCoord: {} as WorkspaceShellInteractionDelegatesOptions['authCoord'],
      destroyed: vi.fn(() => false),
      dockEngine: {},
      focus: { mobileFocusGate },
      injector: {},
      layout: { sidebarOpen, uiState },
      modalCoord: {},
      navigation: { projectState, router },
      preferenceService: {},
      projectCoord: {},
      runtime: { lazyServiceRefs: { parkingService } },
      searchController: {},
      searchLazyLoad: {},
      session: { authService },
      signOutController: {},
      storageEscape: {},
      taskStore: {},
      toast: {},
      userSession: {},
      warn: vi.fn(),
      createInteractionLazyLoadDelegates,
    } as unknown as WorkspaceShellInteractionDelegatesOptions)).toBe(delegates);

    const lazyOptions = createInteractionLazyLoadDelegates.mock.calls[0]?.[0];
    expect(lazyOptions).toBeDefined();
    expect(lazyOptions.activeProjectId()).toBe('project-1');
    expect(lazyOptions.activeView()).toBe('text');
    expect(lazyOptions.currentUserId()).toBe('user-1');
    expect(lazyOptions.isMobile()).toBe(false);
    expect(await lazyOptions.navigateByUrl('/projects/project-1')).toBe(true);
    expect(lazyOptions.sidebarOpen).toBe(sidebarOpen);
    lazyOptions.checkGateForMobileProjectEntry();
    lazyOptions.parkingService.previewTask('task-1');
    expect(lazyOptions.setIsMobile).toEqual(expect.any(Function));
    lazyOptions.setIsMobile?.(true);
    lazyOptions.setSidebarOpen(false);

    expect(router.navigateByUrl).toHaveBeenCalledWith('/projects/project-1');
    expect(mobileFocusGate.checkGateForMobileProjectEntry).toHaveBeenCalledOnce();
    expect(parkingService.previewTask).toHaveBeenCalledWith('task-1');
    expect(isMobile.set).toHaveBeenCalledWith(true);
    expect(sidebarOpen.set).toHaveBeenCalledWith(false);
    expect(lazyOptions.uiState).toBe(uiState);
  });
});
