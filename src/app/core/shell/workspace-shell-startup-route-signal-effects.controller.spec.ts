import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellStartupRouteSignalEffectsController } from './workspace-shell-startup-route-signal-effects.controller';
import type { WorkspaceShellSignalEffectRegistrarController } from './workspace-shell-signal-effect-registrar.controller';

function createController() {
  const effects = new Map<string, () => void>();
  const register = vi.fn((effectName: string, callback: () => void) => {
    effects.set(effectName, callback);
  });
  const effectRegistrar = { register } as unknown as WorkspaceShellSignalEffectRegistrarController;
  const launchSnapshotController = { sync: vi.fn() };
  const routeUrl = vi.fn(() => '/projects/project-1');
  const projects = vi.fn(() => [{ id: 'project-1' }]);
  const activeProjectId = vi.fn(() => 'project-1');
  const syncStateFromRoute = vi.fn();
  const startupEntryIntentController = { sync: vi.fn() };
  const controller = new WorkspaceShellStartupRouteSignalEffectsController({
    effectRegistrar,
    launchSnapshotController,
    routeUrl,
    projects,
    activeProjectId,
    syncStateFromRoute,
    startupEntryIntentController,
  });

  return {
    activeProjectId,
    controller,
    effects,
    launchSnapshotController,
    projects,
    register,
    routeUrl,
    startupEntryIntentController,
    syncStateFromRoute,
  };
}

describe('WorkspaceShellStartupRouteSignalEffectsController', () => {
  it('registers launch and route effects before startup entry intent', () => {
    const { controller, register } = createController();

    controller.setupLaunchAndRoute();
    controller.setupStartupEntryIntent();

    expect(register.mock.calls.map(([effectName]) => effectName)).toEqual([
      'launch-snapshot',
      'route-project-selection',
      'startup-entry-intent',
    ]);
  });

  it('forwards launch snapshot synchronization', () => {
    const { controller, effects, launchSnapshotController } = createController();

    controller.setupLaunchAndRoute();
    effects.get('launch-snapshot')?.();

    expect(launchSnapshotController.sync).toHaveBeenCalledTimes(1);
  });

  it('captures route dependencies before synchronizing route state', () => {
    const {
      activeProjectId,
      controller,
      effects,
      projects,
      routeUrl,
      syncStateFromRoute,
    } = createController();
    const order: string[] = [];
    routeUrl.mockImplementation(() => {
      order.push('routeUrl');
      return '/projects/project-1';
    });
    projects.mockImplementation(() => {
      order.push('projects');
      return [{ id: 'project-1' }];
    });
    activeProjectId.mockImplementation(() => {
      order.push('activeProjectId');
      return 'project-1';
    });
    syncStateFromRoute.mockImplementation(() => {
      order.push('syncStateFromRoute');
    });

    controller.setupLaunchAndRoute();
    effects.get('route-project-selection')?.();

    expect(order).toEqual([
      'routeUrl',
      'projects',
      'activeProjectId',
      'syncStateFromRoute',
    ]);
  });

  it('forwards startup entry intent synchronization', () => {
    const { controller, effects, startupEntryIntentController } = createController();

    controller.setupStartupEntryIntent();
    effects.get('startup-entry-intent')?.();

    expect(startupEntryIntentController.sync).toHaveBeenCalledTimes(1);
  });
});
