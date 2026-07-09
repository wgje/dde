import { describe, expect, it, vi } from 'vitest';

import type { HandoffResult } from '../../../services/handoff-coordinator.service';
import type { LaunchSnapshot } from '../../../services/launch-snapshot.service';
import {
  createWorkspaceShellHandoffControllers,
  createWorkspaceShellHandoffSurface,
} from './workspace-shell-handoff-controllers.factory';
import {
  readWorkspaceShellControllerGraphCallOptions,
  readWorkspaceShellInteractionSurfacesCallOptions,
} from './workspace-shell-source.spec-helpers';

function createLaunchSnapshot(projectId: string): LaunchSnapshot {
  const project = {
    id: projectId,
    name: projectId,
    description: '',
    updatedAt: null,
    taskCount: 0,
    openTaskCount: 0,
    recentTasks: [],
  };

  return {
    version: 2,
    savedAt: '2026-06-10T00:00:00.000Z',
    userId: 'user-1',
    activeProjectId: projectId,
    lastActiveView: 'text',
    preferredView: 'text',
    resolvedLaunchView: 'text',
    routeIntent: { kind: 'projects', projectId: null, taskId: null },
    mobileDegraded: false,
    degradeReason: null,
    theme: 'default',
    colorMode: 'system',
    projects: [project],
    currentProject: project,
  };
}

function createFactoryOptions() {
  let startupLaunchSnapshot: LaunchSnapshot | null = null;
  let trustedPrehydratedSnapshotVisible = false;
  let startupProjectCatalogStage: 'unresolved' | 'partial' | 'resolved' = 'resolved';
  let workspaceHandoffReady = false;

  const resolve = vi.fn<() => HandoffResult>(() => ({ kind: 'full', degradeReason: null }));
  const switchActiveProject = vi.fn();
  const bootStage = {
    isWorkspaceHandoffReady: vi.fn(() => workspaceHandoffReady),
    markWorkspaceHandoffReady: vi.fn(),
    noteLoaderHidden: vi.fn(),
    markApplicationReady: vi.fn(),
  };
  const handoffCoordinator = {
    markLayoutStable: vi.fn(),
    resolve,
  };
  const startupTier = {
    markHandoffReady: vi.fn(),
  };
  const startupEntryIntentController = {
    flushWidgetWorkspaceGateRecheck: vi.fn(),
  };
  const startupEntryControllers = {
    startupEntryIntentController,
  };

  const options = {
    bootStage,
    handoffCoordinator,
    startupTier,
    startupEntryControllers: () => startupEntryControllers,
    routeUrl: () => '/projects/project-1/flow',
    isMobile: () => true,
    projects: () => [{ id: 'project-1' }, { id: 'project-2' }],
    activeProjectId: () => null,
    startupLaunchSnapshot: () => startupLaunchSnapshot,
    userSession: {
      startupProjectCatalogStage: () => startupProjectCatalogStage,
      switchActiveProject,
      trustedPrehydratedSnapshotVisible: () => trustedPrehydratedSnapshotVisible,
    },
    authService: {
      isConfigured: true,
      runtimeState: () => 'ready' as const,
    },
    authCoord: {
      isCheckingSession: () => false,
      showLoginRequired: () => false,
      bootstrapFailed: () => false,
    },
    switchActiveProject,
  };

  return {
    bootStage,
    handoffCoordinator,
    options,
    startupEntryIntentController,
    setStartupLaunchSnapshot: (value: LaunchSnapshot | null) => {
      startupLaunchSnapshot = value;
    },
    setStartupProjectCatalogStage: (value: 'unresolved' | 'partial' | 'resolved') => {
      startupProjectCatalogStage = value;
    },
    setTrustedPrehydratedSnapshotVisible: (value: boolean) => {
      trustedPrehydratedSnapshotVisible = value;
    },
    setWorkspaceHandoffReady: (value: boolean) => {
      workspaceHandoffReady = value;
    },
    startupTier,
    switchActiveProject,
  };
}

describe('createWorkspaceShellHandoffControllers', () => {
  it('keeps handoff runtime signal adaptation behind the shell handoff surface', () => {
    const interactionSurfacesBlock = readWorkspaceShellControllerGraphCallOptions(
      'createWorkspaceShellInteractionSurfaces',
    );
    const handoffControllersBlock = readWorkspaceShellInteractionSurfacesCallOptions(
      'createWorkspaceShellHandoffSurface',
    );

    expect(interactionSurfacesBlock).toContain(
      '...context',
    );
    expect(interactionSurfacesBlock).toContain('...base');
    expect(interactionSurfacesBlock).toContain('...sessionRouting');
    expect(handoffControllersBlock).toContain('...options');
    expect(handoffControllersBlock).not.toContain(
      'routeUrl: this.routing.routeUrl',
    );
    expect(handoffControllersBlock).not.toContain(
      'isMobile: () => this.uiState.isMobile()',
    );
    expect(handoffControllersBlock).not.toContain(
      'projects: () => this.projectState.projects()',
    );
    expect(handoffControllersBlock).not.toContain(
      'activeProjectId: () => this.projectState.activeProjectId()',
    );
    expect(handoffControllersBlock).not.toContain(
      'startupLaunchSnapshot: this.launchSnapshotSurface.startupLaunchSnapshot',
    );
  });

  it('adapts shell surfaces into handoff controller runtime signals', () => {
    const context = createFactoryOptions();
    const controllers = createWorkspaceShellHandoffSurface({
      bootStage: context.options.bootStage,
      handoffCoordinator: context.options.handoffCoordinator,
      startupTier: context.options.startupTier,
      startupEntryControllers: context.options.startupEntryControllers,
      routing: {
        routeUrl: () => '/projects/project-surface/flow',
      },
      uiState: {
        isMobile: () => false,
      },
      projectState: {
        projects: () => [{ id: 'project-surface' }],
        activeProjectId: () => 'project-surface',
      },
      launchSnapshotSurface: {
        startupLaunchSnapshot: () => null,
      },
      userSession: context.options.userSession,
      authService: context.options.authService,
      authCoord: context.options.authCoord,
    });

    controllers.effect.sync();

    expect(context.handoffCoordinator.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        routeUrl: '/projects/project-surface/flow',
        isMobile: false,
        hasProjects: true,
        activeProjectId: 'project-surface',
        snapshot: null,
      }),
    );
  });

  it('keeps route and user session handoff wiring grouped at the component boundary', () => {
    const interactionSurfacesBlock = readWorkspaceShellControllerGraphCallOptions(
      'createWorkspaceShellInteractionSurfaces',
    );
    const handoffControllersBlock = readWorkspaceShellInteractionSurfacesCallOptions(
      'createWorkspaceShellHandoffSurface',
    );

    expect(interactionSurfacesBlock).toContain(
      '...sessionRouting',
    );
    expect(handoffControllersBlock).toContain('...options');
    expect(handoffControllersBlock).not.toContain(
      'routeState: { routeUrl: this.routing.routeUrl }',
    );
    expect(interactionSurfacesBlock).toContain(
      'startupEntryControllers: startupEntryRegistry.startupEntryControllers',
    );
    expect(handoffControllersBlock).not.toContain(
      'routeUrl: () => this.routing.routeUrl()',
    );
    expect(handoffControllersBlock).not.toContain('flushWidgetWorkspaceGateRecheck');
    expect(handoffControllersBlock).not.toContain(
      'this.startupEntryControllers.startupEntryIntentController',
    );
    expect(handoffControllersBlock).not.toContain(
      'startupProjectCatalogStage: () =>',
    );
    expect(handoffControllersBlock).not.toContain(
      'trustedPrehydratedSnapshotVisible: () =>',
    );
    expect(handoffControllersBlock).not.toContain('switchActiveProject: (projectId) =>');
  });

  it('wires readiness lifecycle side effects through one shell delegate', () => {
    const context = createFactoryOptions();
    const controllers = createWorkspaceShellHandoffControllers(context.options);

    controllers.readiness.signalWorkspaceHandoffReady();
    context.setWorkspaceHandoffReady(true);
    controllers.readiness.commitWorkspaceHandoffIfReady();

    expect(context.handoffCoordinator.markLayoutStable).toHaveBeenCalledTimes(1);
    expect(context.bootStage.noteLoaderHidden).toHaveBeenCalledTimes(1);
    expect(context.startupTier.markHandoffReady).toHaveBeenCalledTimes(1);
    expect(context.startupEntryIntentController.flushWidgetWorkspaceGateRecheck)
      .toHaveBeenCalledTimes(1);
  });

  it('wires trusted partial snapshot data into the handoff effect', () => {
    const context = createFactoryOptions();
    const snapshot = createLaunchSnapshot('project-2');
    context.setStartupLaunchSnapshot(snapshot);
    context.setStartupProjectCatalogStage('partial');
    context.setTrustedPrehydratedSnapshotVisible(true);
    const controllers = createWorkspaceShellHandoffControllers(context.options);

    controllers.effect.sync();

    expect(context.handoffCoordinator.resolve).toHaveBeenCalledWith(expect.objectContaining({
      snapshot,
      snapshotProjectsTrusted: true,
    }));
  });

  it('keeps degraded project fallback switching behind the factory boundary', () => {
    const context = createFactoryOptions();
    context.handoffCoordinator.resolve.mockReturnValue({
      kind: 'degraded-to-project',
      degradeReason: 'project-unavailable',
    });
    context.setStartupLaunchSnapshot(createLaunchSnapshot('project-2'));
    context.setStartupProjectCatalogStage('partial');
    context.setTrustedPrehydratedSnapshotVisible(true);
    const controllers = createWorkspaceShellHandoffControllers(context.options);

    controllers.effect.sync();

    expect(context.switchActiveProject).toHaveBeenCalledWith('project-2');
  });
});
