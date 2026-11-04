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
  const navigateToTextProject = vi.fn<(projectId: string) => Promise<unknown> | unknown>();
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

async function flushNavigationSettled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function appliedNavigationState(
  controller: WorkspaceShellMobileRootStartupNavigationController,
): boolean {
  return Reflect.get(controller, 'rootStartupTextNavigationApplied') as boolean;
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

  it('coalesces duplicate requests for the current root mobile startup project', () => {
    const { controller, navigateToTextProject } = createController();

    controller.navigateRootStartupToTextProject('project-active');
    controller.navigateRootStartupToTextProject('project-active');

    expect(navigateToTextProject).toHaveBeenCalledTimes(1);
    expect(navigateToTextProject).toHaveBeenCalledWith('project-active');
  });

  it.each([undefined, true] as const)(
    'treats settled result %p as a confirmed root startup navigation',
    async (navigationResult) => {
      const { controller, navigateToTextProject } = createController();
      navigateToTextProject.mockResolvedValueOnce(navigationResult);

      controller.navigateRootStartupToTextProject('project-active');

      await flushNavigationSettled();

      expect(controller.shouldNavigateRootStartupToTextProject()).toBe(false);
      controller.navigateRootStartupToTextProject('project-active');
      expect(navigateToTextProject).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, null] as const)(
    'keeps root startup navigation retryable when settled result %p is not confirmed',
    async (navigationResult) => {
      const { controller, navigateToTextProject } = createController();
      navigateToTextProject
        .mockResolvedValueOnce(navigationResult)
        .mockResolvedValueOnce(undefined);

      controller.navigateRootStartupToTextProject('project-active');

      await flushNavigationSettled();

      expect(controller.shouldNavigateRootStartupToTextProject()).toBe(true);
      controller.navigateRootStartupToTextProject('project-active');
      await vi.waitFor(() => expect(navigateToTextProject).toHaveBeenCalledTimes(2));
      await flushNavigationSettled();
      controller.navigateRootStartupToTextProject('project-active');
      expect(navigateToTextProject).toHaveBeenCalledTimes(2);
    },
  );

  it.each([undefined, true, false, null] as const)(
    'drains queued B after stale A settles with %p without applying A',
    async (firstResult) => {
      const { controller, navigateToTextProject } = createController();
      const firstNavigation = createDeferred<unknown>();
      const secondNavigation = createDeferred<unknown>();
      navigateToTextProject
        .mockReturnValueOnce(firstNavigation.promise)
        .mockReturnValueOnce(secondNavigation.promise);

      controller.navigateRootStartupToTextProject('project-a');
      controller.navigateRootStartupToTextProject('project-b');
      firstNavigation.resolve(firstResult);

      await vi.waitFor(() => expect(navigateToTextProject).toHaveBeenCalledTimes(2));

      expect(navigateToTextProject).toHaveBeenNthCalledWith(1, 'project-a');
      expect(navigateToTextProject).toHaveBeenNthCalledWith(2, 'project-b');
      expect(controller.shouldNavigateRootStartupToTextProject()).toBe(true);
    },
  );

  it('drains queued B after stale A rejects without letting a throwing warning sink block it', async () => {
    const { controller, navigateToTextProject, warn } = createController();
    const firstNavigation = createDeferred<unknown>();
    const secondNavigation = createDeferred<unknown>();
    const navigationError = new Error('root startup navigation failed');
    warn.mockImplementationOnce(() => {
      throw new Error('warning sink failed');
    });
    navigateToTextProject
      .mockReturnValueOnce(firstNavigation.promise)
      .mockReturnValueOnce(secondNavigation.promise);

    controller.navigateRootStartupToTextProject('project-a');
    controller.navigateRootStartupToTextProject('project-b');
    firstNavigation.reject(navigationError);

    await vi.waitFor(() => expect(navigateToTextProject).toHaveBeenCalledTimes(2));

    expect(warn).toHaveBeenCalledWith('Mobile root startup navigation failed', navigationError);
    expect(navigateToTextProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      'project-a',
      'project-b',
    ]);
    expect(controller.shouldNavigateRootStartupToTextProject()).toBe(true);
  });

  it('drains re-entrant queued B after A throws synchronously', () => {
    const { controller, navigateToTextProject, warn } = createController();
    const secondNavigation = createDeferred<unknown>();
    const navigationError = new Error('root startup navigation failed');
    navigateToTextProject
      .mockImplementationOnce(() => {
        controller.navigateRootStartupToTextProject('project-b');
        throw navigationError;
      })
      .mockReturnValueOnce(secondNavigation.promise);

    expect(() => controller.navigateRootStartupToTextProject('project-a')).not.toThrow();

    expect(warn).toHaveBeenCalledWith('Mobile root startup navigation failed', navigationError);
    expect(navigateToTextProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      'project-a',
      'project-b',
    ]);
    expect(controller.shouldNavigateRootStartupToTextProject()).toBe(true);
  });

  it('drains the latest queued generation and coalesces duplicate intermediate requests', async () => {
    const { controller, navigateToTextProject } = createController();
    const firstNavigation = createDeferred<unknown>();
    const latestNavigation = createDeferred<unknown>();
    navigateToTextProject
      .mockReturnValueOnce(firstNavigation.promise)
      .mockReturnValueOnce(latestNavigation.promise);

    controller.navigateRootStartupToTextProject('project-a');
    controller.navigateRootStartupToTextProject('project-b');
    controller.navigateRootStartupToTextProject('project-b');
    controller.navigateRootStartupToTextProject('project-c');
    firstNavigation.resolve(true);

    await vi.waitFor(() => expect(navigateToTextProject).toHaveBeenCalledTimes(2));

    expect(navigateToTextProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      'project-a',
      'project-c',
    ]);
    expect(controller.shouldNavigateRootStartupToTextProject()).toBe(true);
  });

  it('coalesces A-B-A back to the in-flight A without starting A or B again', async () => {
    const { controller, navigateToTextProject } = createController();
    const firstNavigation = createDeferred<unknown>();
    navigateToTextProject.mockReturnValueOnce(firstNavigation.promise);

    controller.navigateRootStartupToTextProject('project-a');
    controller.navigateRootStartupToTextProject('project-b');
    controller.navigateRootStartupToTextProject('project-a');

    expect(navigateToTextProject).toHaveBeenCalledTimes(1);
    expect(navigateToTextProject).toHaveBeenCalledWith('project-a');

    firstNavigation.resolve(true);
    await flushNavigationSettled();

    expect(navigateToTextProject).toHaveBeenCalledTimes(1);
    expect(controller.shouldNavigateRootStartupToTextProject()).toBe(false);

    controller.navigateRootStartupToTextProject('project-a');
    expect(navigateToTextProject).toHaveBeenCalledTimes(1);
  });

  it('keeps A-B-A retryable when the coalesced in-flight A settles false without looping', async () => {
    const { controller, navigateToTextProject } = createController();
    const firstNavigation = createDeferred<unknown>();
    const latestNavigation = createDeferred<unknown>();
    navigateToTextProject
      .mockReturnValueOnce(firstNavigation.promise)
      .mockReturnValueOnce(latestNavigation.promise);

    controller.navigateRootStartupToTextProject('project-a');
    controller.navigateRootStartupToTextProject('project-b');
    controller.navigateRootStartupToTextProject('project-a');
    firstNavigation.resolve(false);

    await vi.waitFor(() => expect(navigateToTextProject).toHaveBeenCalledTimes(2));

    expect(navigateToTextProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      'project-a',
      'project-a',
    ]);
    expect(controller.shouldNavigateRootStartupToTextProject()).toBe(true);

    latestNavigation.resolve(false);
    await flushNavigationSettled();

    expect(navigateToTextProject).toHaveBeenCalledTimes(2);
    expect(controller.shouldNavigateRootStartupToTextProject()).toBe(true);

    controller.navigateRootStartupToTextProject('project-a');
    await flushNavigationSettled();
    expect(navigateToTextProject).toHaveBeenCalledTimes(3);
  });

  it('keeps A-B-A retryable when the coalesced in-flight A rejects without looping', async () => {
    const { controller, navigateToTextProject, warn } = createController();
    const firstNavigation = createDeferred<unknown>();
    const latestNavigation = createDeferred<unknown>();
    const navigationError = new Error('root startup navigation failed');
    navigateToTextProject
      .mockReturnValueOnce(firstNavigation.promise)
      .mockReturnValueOnce(latestNavigation.promise);

    controller.navigateRootStartupToTextProject('project-a');
    controller.navigateRootStartupToTextProject('project-b');
    controller.navigateRootStartupToTextProject('project-a');
    firstNavigation.reject(navigationError);

    await vi.waitFor(() => expect(navigateToTextProject).toHaveBeenCalledTimes(2));

    expect(warn).toHaveBeenCalledWith('Mobile root startup navigation failed', navigationError);
    expect(navigateToTextProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      'project-a',
      'project-a',
    ]);
    expect(controller.shouldNavigateRootStartupToTextProject()).toBe(true);

    latestNavigation.resolve(true);
    await flushNavigationSettled();

    expect(navigateToTextProject).toHaveBeenCalledTimes(2);
    expect(controller.shouldNavigateRootStartupToTextProject()).toBe(false);
  });
  it('does not publish applied after startup eligibility changes during current A', async () => {
    const {
      controller,
      navigateToTextProject,
      setMobile,
      setRouteUrl,
      setStartupEntryIntent,
    } = createController();
    const firstNavigation = createDeferred<unknown>();
    navigateToTextProject.mockReturnValueOnce(firstNavigation.promise);

    controller.navigateRootStartupToTextProject('project-a');
    setRouteUrl('/projects/project-a/flow');
    setMobile(false);
    setStartupEntryIntent({ intent: 'open-focus-tools' });
    firstNavigation.resolve(true);

    await flushNavigationSettled();

    expect(navigateToTextProject).toHaveBeenCalledTimes(1);
    expect(appliedNavigationState(controller)).toBe(false);
  });

  it('retires queued B when startup eligibility changes before A settles', async () => {
    const {
      controller,
      navigateToTextProject,
      setMobile,
      setRouteUrl,
      setStartupEntryIntent,
    } = createController();
    const firstNavigation = createDeferred<unknown>();
    navigateToTextProject.mockReturnValueOnce(firstNavigation.promise);

    controller.navigateRootStartupToTextProject('project-a');
    controller.navigateRootStartupToTextProject('project-b');
    setRouteUrl('/projects/project-a/flow');
    setMobile(false);
    setStartupEntryIntent({ intent: 'open-focus-tools' });
    firstNavigation.resolve(true);

    await flushNavigationSettled();

    expect(navigateToTextProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      'project-a',
    ]);
    expect(appliedNavigationState(controller)).toBe(false);
  });

  it('keeps re-entrant C latest when initial A eligibility reenters', async () => {
    let controller!: WorkspaceShellMobileRootStartupNavigationController;
    let shouldReenter = true;
    const routeUrl = vi.fn(() => {
      if (shouldReenter) {
        shouldReenter = false;
        controller.navigateRootStartupToTextProject('project-c');
      }
      return '/projects';
    });
    const created = createController({ routeUrl });
    controller = created.controller;
    const latestNavigation = createDeferred<unknown>();
    created.navigateToTextProject.mockReturnValueOnce(latestNavigation.promise);

    controller.navigateRootStartupToTextProject('project-a');

    expect(created.navigateToTextProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      'project-c',
    ]);
    expect(appliedNavigationState(controller)).toBe(false);

    latestNavigation.resolve(true);
    await flushNavigationSettled();

    expect(created.navigateToTextProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      'project-c',
    ]);
    expect(appliedNavigationState(controller)).toBe(true);
  });

  it('keeps re-entrant C coherent when eligibility reenters before A publishes applied', async () => {
    let controller!: WorkspaceShellMobileRootStartupNavigationController;
    let reentrantProjectId: string | null = null;
    const routeUrl = vi.fn(() => {
      const projectId = reentrantProjectId;
      reentrantProjectId = null;
      if (projectId !== null) {
        controller.navigateRootStartupToTextProject(projectId);
      }
      return '/projects';
    });
    const created = createController({ routeUrl });
    controller = created.controller;
    const firstNavigation = createDeferred<unknown>();
    const latestNavigation = createDeferred<unknown>();
    created.navigateToTextProject
      .mockReturnValueOnce(firstNavigation.promise)
      .mockReturnValueOnce(latestNavigation.promise);

    controller.navigateRootStartupToTextProject('project-a');
    reentrantProjectId = 'project-c';
    firstNavigation.resolve(true);

    await flushNavigationSettled();

    expect(created.navigateToTextProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      'project-a',
      'project-c',
    ]);
    expect(appliedNavigationState(controller)).toBe(false);

    latestNavigation.resolve(true);
    await flushNavigationSettled();

    expect(created.navigateToTextProject).toHaveBeenCalledTimes(2);
    expect(appliedNavigationState(controller)).toBe(true);
  });

  it('does not start stale B when drain eligibility reenters with latest C', async () => {
    let controller!: WorkspaceShellMobileRootStartupNavigationController;
    let reentrantProjectId: string | null = null;
    const routeUrl = vi.fn(() => {
      const projectId = reentrantProjectId;
      reentrantProjectId = null;
      if (projectId !== null) {
        controller.navigateRootStartupToTextProject(projectId);
      }
      return '/projects';
    });
    const created = createController({ routeUrl });
    controller = created.controller;
    const firstNavigation = createDeferred<unknown>();
    const latestNavigation = createDeferred<unknown>();
    created.navigateToTextProject
      .mockReturnValueOnce(firstNavigation.promise)
      .mockReturnValueOnce(latestNavigation.promise);

    controller.navigateRootStartupToTextProject('project-a');
    controller.navigateRootStartupToTextProject('project-b');
    reentrantProjectId = 'project-c';
    firstNavigation.resolve(true);

    await flushNavigationSettled();

    expect(created.navigateToTextProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      'project-a',
      'project-c',
    ]);
    expect(appliedNavigationState(controller)).toBe(false);

    latestNavigation.resolve(true);
    await flushNavigationSettled();

    expect(created.navigateToTextProject).toHaveBeenCalledTimes(2);
    expect(appliedNavigationState(controller)).toBe(true);
  });

  it.each([undefined, true] as const)(
    'marks current drained B result %p as applied',
    async (secondResult) => {
      const { controller, navigateToTextProject } = createController();
      const firstNavigation = createDeferred<unknown>();
      navigateToTextProject
        .mockReturnValueOnce(firstNavigation.promise)
        .mockResolvedValueOnce(secondResult);

      controller.navigateRootStartupToTextProject('project-a');
      controller.navigateRootStartupToTextProject('project-b');
      firstNavigation.resolve(true);

      await vi.waitFor(() => expect(navigateToTextProject).toHaveBeenCalledTimes(2));
      await flushNavigationSettled();

      expect(controller.shouldNavigateRootStartupToTextProject()).toBe(false);
    },
  );

  it.each([false, null] as const)(
    'does not make a third call when current drained B settles with %p',
    async (secondResult) => {
      const { controller, navigateToTextProject } = createController();
      const firstNavigation = createDeferred<unknown>();
      navigateToTextProject
        .mockReturnValueOnce(firstNavigation.promise)
        .mockResolvedValueOnce(secondResult);

      controller.navigateRootStartupToTextProject('project-a');
      controller.navigateRootStartupToTextProject('project-b');
      firstNavigation.resolve(true);

      await vi.waitFor(() => expect(navigateToTextProject).toHaveBeenCalledTimes(2));
      await flushNavigationSettled();

      expect(navigateToTextProject).toHaveBeenCalledTimes(2);
      expect(controller.shouldNavigateRootStartupToTextProject()).toBe(true);
    },
  );

  it('does not make a third call when current drained B rejects', async () => {
    const { controller, navigateToTextProject, warn } = createController();
    const firstNavigation = createDeferred<unknown>();
    const navigationError = new Error('root startup navigation failed');
    navigateToTextProject
      .mockReturnValueOnce(firstNavigation.promise)
      .mockRejectedValueOnce(navigationError);

    controller.navigateRootStartupToTextProject('project-a');
    controller.navigateRootStartupToTextProject('project-b');
    firstNavigation.resolve(true);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Mobile root startup navigation failed',
      navigationError,
    ));
    await flushNavigationSettled();

    expect(navigateToTextProject).toHaveBeenCalledTimes(2);
    expect(controller.shouldNavigateRootStartupToTextProject()).toBe(true);
    controller.navigateRootStartupToTextProject('project-b');
    await flushNavigationSettled();
    controller.navigateRootStartupToTextProject('project-b');
    expect(navigateToTextProject).toHaveBeenCalledTimes(3);
  });

  it('does not make a third call when current drained B throws synchronously', async () => {
    const { controller, navigateToTextProject, warn } = createController();
    const firstNavigation = createDeferred<unknown>();
    const navigationError = new Error('root startup navigation failed');
    navigateToTextProject
      .mockReturnValueOnce(firstNavigation.promise)
      .mockImplementationOnce(() => {
        throw navigationError;
      });

    controller.navigateRootStartupToTextProject('project-a');
    controller.navigateRootStartupToTextProject('project-b');
    firstNavigation.resolve(true);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Mobile root startup navigation failed',
      navigationError,
    ));

    expect(navigateToTextProject).toHaveBeenCalledTimes(2);
    expect(controller.shouldNavigateRootStartupToTextProject()).toBe(true);
    controller.navigateRootStartupToTextProject('project-b');
    await flushNavigationSettled();
    controller.navigateRootStartupToTextProject('project-b');
    expect(navigateToTextProject).toHaveBeenCalledTimes(3);
  });

  it('retires queued navigation when pending A resolves after destroy', async () => {
    const { controller, navigateToTextProject } = createController();
    const firstNavigation = createDeferred<unknown>();
    navigateToTextProject.mockReturnValueOnce(firstNavigation.promise);

    controller.navigateRootStartupToTextProject('project-a');
    controller.navigateRootStartupToTextProject('project-b');
    controller.destroy();
    firstNavigation.resolve(true);

    await flushNavigationSettled();
    controller.navigateRootStartupToTextProject('project-c');

    expect(navigateToTextProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      'project-a',
    ]);
    expect(appliedNavigationState(controller)).toBe(false);
    expect(controller.shouldNavigateRootStartupToTextProject()).toBe(false);
  });

  it('retires queued navigation without warning when pending A rejects after destroy', async () => {
    const { controller, navigateToTextProject, warn } = createController();
    const firstNavigation = createDeferred<unknown>();
    navigateToTextProject.mockReturnValueOnce(firstNavigation.promise);

    controller.navigateRootStartupToTextProject('project-a');
    controller.navigateRootStartupToTextProject('project-b');
    controller.destroy();
    firstNavigation.reject(new Error('late navigation failure'));

    await flushNavigationSettled();

    expect(navigateToTextProject).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('retires a re-entrant queued request before synchronous A failure settles', () => {
    const { controller, navigateToTextProject, warn } = createController();
    navigateToTextProject.mockImplementationOnce(() => {
      controller.navigateRootStartupToTextProject('project-b');
      controller.destroy();
      throw new Error('late synchronous navigation failure');
    });

    expect(() => controller.navigateRootStartupToTextProject('project-a')).not.toThrow();

    expect(navigateToTextProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      'project-a',
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not let warning-sink re-entry resume navigation during retirement', async () => {
    const { controller, navigateToTextProject, warn } = createController();
    const firstNavigation = createDeferred<unknown>();
    navigateToTextProject.mockReturnValueOnce(firstNavigation.promise);
    warn.mockImplementationOnce(() => {
      controller.destroy();
      controller.navigateRootStartupToTextProject('project-c');
      throw new Error('warning sink failed');
    });

    controller.navigateRootStartupToTextProject('project-a');
    controller.navigateRootStartupToTextProject('project-b');
    firstNavigation.reject(new Error('navigation failed'));

    await flushNavigationSettled();

    expect(warn).toHaveBeenCalledOnce();
    expect(navigateToTextProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      'project-a',
    ]);
  });

  it('makes repeated destroy calls idempotent', () => {
    const { controller, navigateToTextProject } = createController();

    controller.destroy();
    controller.destroy();
    controller.navigateRootStartupToTextProject('project-a');

    expect(navigateToTextProject).not.toHaveBeenCalled();
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
