import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellMobileRootStartupNavigationController,
  type WorkspaceShellMobileRootStartupNavigationControllerOptions,
} from './workspace-shell-mobile-root-startup-navigation.controller';
import type { Project } from '../../../models';
import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';

function createProject(id: string): Pick<Project, 'id'> {
  return { id };
}

function createController(
  overrides: Partial<WorkspaceShellMobileRootStartupNavigationControllerOptions> = {},
) {
  type StartupLaunchSnapshot = ReturnType<WorkspaceShellMobileRootStartupNavigationControllerOptions['startupLaunchSnapshot']>;
  let mobile = true;
  let activeProjectId: string | null = 'project-active';
  let routeUrl = '/projects';
  let startupEntryIntent: Pick<StartupEntryIntent, 'intent'> | null = null;
  const projects: Pick<Project, 'id'>[] = [
    createProject('project-1'),
    createProject('project-2'),
  ];
  let startupLaunchSnapshot: StartupLaunchSnapshot = null;
  const navigateToTextProject = vi.fn<(projectId: string) => Promise<void> | void>();
  const warn = vi.fn();
  const controller = new WorkspaceShellMobileRootStartupNavigationController({
    isMobile: () => mobile,
    activeProjectId: () => activeProjectId,
    projects: () => projects,
    startupLaunchSnapshot: () => startupLaunchSnapshot,
    routeUrl: () => routeUrl,
    startupEntryIntent: () => startupEntryIntent,
    navigateToTextProject,
    warn,
    ...overrides,
  });

  return {
    controller,
    navigateToTextProject,
    projects,
    setActiveProjectId: (projectId: string | null) => {
      activeProjectId = projectId;
    },
    setMobile: (value: boolean) => {
      mobile = value;
    },
    setRouteUrl: (value: string) => {
      routeUrl = value;
    },
    setStartupEntryIntent: (value: Pick<StartupEntryIntent, 'intent'> | null) => {
      startupEntryIntent = value;
    },
    setStartupLaunchSnapshot: (value: StartupLaunchSnapshot) => {
      startupLaunchSnapshot = value;
    },
    warn,
  };
}

describe('WorkspaceShellMobileRootStartupNavigationController', () => {
  it('resolves the active project as the mobile root startup project', () => {
    const { controller } = createController();

    expect(controller.resolveMobileRootStartupProjectId()).toBe('project-active');
  });

  it('resolves the startup project fallback independent of viewport mode', () => {
    const { controller, setMobile, setStartupLaunchSnapshot } = createController();
    setMobile(false);
    setStartupLaunchSnapshot({
      activeProjectId: 'project-2',
      currentProject: null,
    });

    expect(controller.resolveStartupProjectFallbackId()).toBe('project-2');
  });

  it('falls back to the startup snapshot project when no active project exists', () => {
    const { controller, setActiveProjectId, setStartupLaunchSnapshot } = createController();
    setActiveProjectId(null);
    setStartupLaunchSnapshot({
      activeProjectId: null,
      currentProject: { id: 'project-2' },
    });

    expect(controller.resolveMobileRootStartupProjectId()).toBe('project-2');
  });

  it('does not resolve a mobile root startup project on desktop', () => {
    const { controller, setMobile } = createController();
    setMobile(false);

    expect(controller.resolveMobileRootStartupProjectId()).toBeNull();
  });

  it('navigates the root mobile startup route to text once', () => {
    const { controller, navigateToTextProject } = createController();

    controller.navigateRootStartupToTextProject('project-active');
    controller.navigateRootStartupToTextProject('project-active');

    expect(navigateToTextProject).toHaveBeenCalledTimes(1);
    expect(navigateToTextProject).toHaveBeenCalledWith('project-active');
  });

  it('retries root mobile startup navigation after a failed navigation settles', async () => {
    const { controller, navigateToTextProject, warn } = createController();
    const navigationError = new Error('root startup navigation failed');
    navigateToTextProject
      .mockRejectedValueOnce(navigationError)
      .mockResolvedValueOnce(undefined);

    controller.navigateRootStartupToTextProject('project-active');
    controller.navigateRootStartupToTextProject('project-active');

    expect(navigateToTextProject).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Mobile root startup navigation failed',
      navigationError,
    ));

    controller.navigateRootStartupToTextProject('project-active');

    await vi.waitFor(() => expect(navigateToTextProject).toHaveBeenCalledTimes(2));
  });

  it('retries when warning a synchronous root startup navigation failure also fails', () => {
    const { controller, navigateToTextProject, warn } = createController();
    const navigationError = new Error('root startup navigation failed');
    const warningError = new Error('warning sink failed');
    navigateToTextProject
      .mockImplementationOnce(() => {
        throw navigationError;
      })
      .mockResolvedValueOnce(undefined);
    warn.mockImplementationOnce(() => {
      throw warningError;
    });

    expect(() => controller.navigateRootStartupToTextProject('project-active')).not.toThrow();
    expect(navigateToTextProject).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Mobile root startup navigation failed', navigationError);

    controller.navigateRootStartupToTextProject('project-active');

    expect(navigateToTextProject).toHaveBeenCalledTimes(2);
  });

  it('exposes the current root startup text navigation decision', () => {
    const { controller, setRouteUrl } = createController();

    expect(controller.shouldNavigateRootStartupToTextProject()).toBe(true);
    setRouteUrl('/projects/project-1/flow');
    expect(controller.shouldNavigateRootStartupToTextProject()).toBe(false);
  });

  it('does not navigate non-root, desktop, or explicit non-workspace startup routes', () => {
    const {
      controller,
      navigateToTextProject,
      setMobile,
      setRouteUrl,
      setStartupEntryIntent,
    } = createController();

    setRouteUrl('/projects/project-1/flow');
    controller.navigateRootStartupToTextProject('project-1');
    setRouteUrl('/projects');
    setMobile(false);
    controller.navigateRootStartupToTextProject('project-1');
    setMobile(true);
    setStartupEntryIntent({ intent: 'open-focus-tools' });
    controller.navigateRootStartupToTextProject('project-1');

    expect(navigateToTextProject).not.toHaveBeenCalled();
  });
});
