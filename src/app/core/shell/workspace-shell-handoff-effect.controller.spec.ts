import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellHandoffEffectController,
  type WorkspaceShellHandoffEffectControllerOptions,
} from './workspace-shell-handoff-effect.controller';
import type { HandoffResult } from '../../../services/handoff-coordinator.service';

type StartupSnapshot = NonNullable<WorkspaceShellHandoffEffectControllerOptions['startupLaunchSnapshot'] extends () => infer T ? T : never>;
type StartupSnapshotProject = StartupSnapshot['projects'][number];

function createSnapshotProject(id: string): StartupSnapshotProject {
  return {
    id,
    name: id,
    description: '',
    updatedAt: null,
    taskCount: 0,
    openTaskCount: 0,
    recentTasks: [],
  };
}

function createStartupSnapshot(projectId: string): StartupSnapshot {
  const project = createSnapshotProject(projectId);
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

function createController(overrides: Partial<WorkspaceShellHandoffEffectControllerOptions> = {}) {
  const resolveHandoff = vi.fn<() => HandoffResult>(() => ({ kind: 'full', degradeReason: null }));
  const switchActiveProject = vi.fn();
  let snapshotHandoffEnabled = true;
  let routeUrl = '/projects/project-1/flow';
  let isMobile = true;
  let projects: Array<{ id: string }> = [{ id: 'project-1' }];
  let activeProjectId: string | null = null;
  let startupProjectCatalogStage: 'unresolved' | 'partial' | 'resolved' = 'resolved';
  let trustedPrehydratedSnapshotVisible = false;
  let startupLaunchSnapshot: StartupSnapshot | null = null;

  const controller = new WorkspaceShellHandoffEffectController({
    isSnapshotHandoffEnabled: () => snapshotHandoffEnabled,
    routeUrl: () => routeUrl,
    isMobile: () => isMobile,
    projects: () => projects,
    activeProjectId: () => activeProjectId,
    startupProjectCatalogStage: () => startupProjectCatalogStage,
    trustedPrehydratedSnapshotVisible: () => trustedPrehydratedSnapshotVisible,
    startupLaunchSnapshot: () => startupLaunchSnapshot,
    authConfigured: () => true,
    authRuntimeState: () => 'ready',
    isCheckingSession: () => false,
    showLoginRequired: () => false,
    bootstrapFailed: () => false,
    resolveHandoff,
    switchActiveProject,
    ...overrides,
  });

  return {
    controller,
    resolveHandoff,
    setActiveProjectId: (projectId: string | null) => {
      activeProjectId = projectId;
    },
    setProjects: (nextProjects: Array<{ id: string }>) => {
      projects = nextProjects;
    },
    setSnapshotHandoffEnabled: (enabled: boolean) => {
      snapshotHandoffEnabled = enabled;
    },
    setStartupLaunchSnapshot: (snapshot: StartupSnapshot | null) => {
      startupLaunchSnapshot = snapshot;
    },
    setStartupProjectCatalogStage: (stage: 'unresolved' | 'partial' | 'resolved') => {
      startupProjectCatalogStage = stage;
    },
    setTrustedPrehydratedSnapshotVisible: (visible: boolean) => {
      trustedPrehydratedSnapshotVisible = visible;
    },
    switchActiveProject,
  };
}

describe('WorkspaceShellHandoffEffectController', () => {
  it('does not resolve handoff while snapshot handoff is disabled', () => {
    const { controller, resolveHandoff, setSnapshotHandoffEnabled } = createController();
    setSnapshotHandoffEnabled(false);

    controller.sync();

    expect(resolveHandoff).not.toHaveBeenCalled();
  });

  it('passes a trusted partial startup snapshot into handoff resolution', () => {
    const {
      controller,
      resolveHandoff,
      setStartupLaunchSnapshot,
      setStartupProjectCatalogStage,
      setTrustedPrehydratedSnapshotVisible,
    } = createController();
    const snapshot = createStartupSnapshot('snapshot-project');
    setStartupLaunchSnapshot(snapshot);
    setStartupProjectCatalogStage('partial');
    setTrustedPrehydratedSnapshotVisible(true);

    controller.sync();

    expect(resolveHandoff).toHaveBeenCalledWith(expect.objectContaining({
      snapshot,
      snapshotProjectsTrusted: true,
    }));
  });

  it('ignores startup snapshot when it is not both visible and partial', () => {
    const {
      controller,
      resolveHandoff,
      setStartupLaunchSnapshot,
      setStartupProjectCatalogStage,
      setTrustedPrehydratedSnapshotVisible,
    } = createController();
    setStartupLaunchSnapshot(createStartupSnapshot('snapshot-project'));
    setStartupProjectCatalogStage('resolved');
    setTrustedPrehydratedSnapshotVisible(true);

    controller.sync();

    expect(resolveHandoff).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: null,
      snapshotProjectsTrusted: false,
    }));
  });

  it('switches to the trusted snapshot project after degraded-to-project when no project is active', () => {
    const {
      controller,
      resolveHandoff,
      setProjects,
      setStartupLaunchSnapshot,
      setStartupProjectCatalogStage,
      setTrustedPrehydratedSnapshotVisible,
      switchActiveProject,
    } = createController();
    setProjects([{ id: 'project-1' }, { id: 'project-2' }]);
    setStartupLaunchSnapshot(createStartupSnapshot('project-2'));
    setStartupProjectCatalogStage('partial');
    setTrustedPrehydratedSnapshotVisible(true);
    resolveHandoff.mockReturnValue({ kind: 'degraded-to-project', degradeReason: 'project-unavailable' });

    controller.sync();

    expect(switchActiveProject).toHaveBeenCalledWith('project-2');
  });

  it('falls back to the first project when the trusted snapshot project is unavailable', () => {
    const {
      controller,
      resolveHandoff,
      setProjects,
      setStartupLaunchSnapshot,
      setStartupProjectCatalogStage,
      setTrustedPrehydratedSnapshotVisible,
      switchActiveProject,
    } = createController();
    setProjects([{ id: 'project-1' }]);
    setStartupLaunchSnapshot(createStartupSnapshot('missing-project'));
    setStartupProjectCatalogStage('partial');
    setTrustedPrehydratedSnapshotVisible(true);
    resolveHandoff.mockReturnValue({ kind: 'degraded-to-project', degradeReason: 'project-unavailable' });

    controller.sync();

    expect(switchActiveProject).toHaveBeenCalledWith('project-1');
  });
});
