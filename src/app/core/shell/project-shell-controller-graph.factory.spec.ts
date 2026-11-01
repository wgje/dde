import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import {
  createProjectShellControllerGraphFromContext,
} from './project-shell-controller-graph.factory';
import type {
  ProjectShellGraphContext,
} from './project-shell-graph-context.factory';

function createContext(): ProjectShellGraphContext {
  const activeView = signal<'text' | 'flow'>('text');
  const uiState = {
    activeView,
    filterMode: signal('all'),
    getLastActiveView: () => null,
    isMobile: () => false,
    isResizing: signal(false),
    isTextColumnCollapsed: signal(false),
    persistActiveView: vi.fn(),
    textColumnRatio: signal(25),
  };

  return {
    destroyRef: { onDestroy: vi.fn() },
    dockEngine: {
      focusChromePhase: signal('idle'),
      focusMode: signal(false),
      focusScrimOn: signal(false),
    },
    flowCommand: {
      centerOnNode: vi.fn(),
      retryDiagram: vi.fn(),
    },
    flowIntentLazyLoadEnabled: true,
    flowStateAwareRestoreEnabled: true,
    handoffCoordinator: {
      result: () => ({ kind: 'full' }),
    },
    injector: { get: vi.fn() },
    logger: { debug: vi.fn() },
    projectState: {
      activeProjectId: () => 'project-1',
      getProject: () => null,
      getProjectsWithCurrentData: () => [],
      getTask: () => null,
      projects: () => [],
      tasks: () => [],
    },
    route: {
      snapshot: { params: {}, firstChild: { params: {} } },
    },
    router: {
      events: new Subject<unknown>(),
      navigate: vi.fn(),
      url: '/projects/project-1/text',
    },
    startupLaunchSnapshot: null,
    syncCoordinator: { isLoadingRemote: () => false },
    tabSync: { notifyProjectOpen: vi.fn() },
    taskOpsAdapter: { addFloatingTask: vi.fn() },
    toast: {
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
    },
    uiState,
    userSession: { switchActiveProject: vi.fn() },
  } as unknown as ProjectShellGraphContext;
}

describe('createProjectShellControllerGraphFromContext', () => {
  it('exposes template state while keeping controller wiring inside the graph', () => {
    const context = createContext();
    const graph = createProjectShellControllerGraphFromContext(context);

    expect(graph.template.uiState).toBe(context.uiState);
    expect(graph.template.projectState).toBe(context.projectState);
    expect(graph.template.dockTakeoverPhase).toBe(
      context.dockEngine.focusChromePhase,
    );
    expect(graph.template.flowIntentActivated()).toBe(false);

    graph.controllers.viewActions.switchToFlow();

    expect(graph.template.flowIntentActivated()).toBe(true);
    expect(context.uiState.activeView()).toBe('flow');
  });

  it('provides the lifecycle and template-facing controllers as one graph', () => {
    const graph = createProjectShellControllerGraphFromContext(createContext());

    expect(graph.controllers.cacheReload).toBeDefined();
    expect(graph.controllers.contentResize).toBeDefined();
    expect(graph.controllers.lifecycle).toBeDefined();
    expect(graph.controllers.newProjectModal).toBeDefined();
    expect(graph.controllers.textViewSwipe).toBeDefined();
    expect(graph.controllers.uiActions).toBeDefined();
    expect(graph.controllers.viewActions).toBeDefined();
  });
});
