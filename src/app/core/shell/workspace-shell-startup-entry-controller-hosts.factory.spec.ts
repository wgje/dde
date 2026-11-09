import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellMobileRootStartupNavigationController } from './workspace-shell-mobile-root-startup-navigation.controller';
import { createWorkspaceShellStartupEntryControllers } from './workspace-shell-startup-entry-controllers.factory';
import {
  createWorkspaceShellMobileRootStartupNavigationControllerHost,
  type WorkspaceShellStartupEntryControllersFactoryOptions,
} from './workspace-shell-startup-entry-controller-hosts.factory';

describe('workspace shell startup entry controller hosts', () => {
  it('owns low-level startup controller construction outside the orchestration factory', async () => {
    const modulePath = './workspace-shell-startup-entry-controller-hosts.factory';
    const controllerHostsModule = await import(/* @vite-ignore */ modulePath)
      .catch(() => ({}));

    expect(controllerHostsModule).toHaveProperty(
      'createWorkspaceShellAndroidWidgetLazyLoadControllerHost',
      expect.any(Function),
    );
    expect(controllerHostsModule).toHaveProperty(
      'createWorkspaceShellMobileRootStartupNavigationControllerHost',
      expect.any(Function),
    );
    expect(controllerHostsModule).toHaveProperty(
      'createWorkspaceShellStartupEntryIntentControllerHost',
      expect.any(Function),
    );

    const controllerHostsSource = readFileSync(
      join(__dirname, 'workspace-shell-startup-entry-controller-hosts.factory.ts'),
      'utf8',
    );
    const controllersSource = readFileSync(
      join(__dirname, 'workspace-shell-startup-entry-controllers.factory.ts'),
      'utf8',
    );

    expect(controllerHostsSource).toContain(
      "from './workspace-shell-android-widget-lazy-load.factory'",
    );
    expect(controllerHostsSource).toContain(
      "from './workspace-shell-mobile-root-startup-navigation.controller'",
    );
    expect(controllerHostsSource).toContain(
      "from './workspace-shell-startup-entry-intent.factory'",
    );
    expect(controllersSource).not.toContain(
      "from './workspace-shell-android-widget-lazy-load.factory'",
    );
    expect(controllersSource).not.toContain(
      "from './workspace-shell-mobile-root-startup-navigation.controller'",
    );
    expect(controllersSource).not.toContain(
      'createWorkspaceShellStartupEntryIntentController,',
    );
    expect(controllersSource).not.toContain(
      'WorkspaceShellStartupEntryIntentControllerLike',
    );
  });

  it('constructs and preserves the exact mobile controller through orchestration teardown', () => {
    const order: string[] = [];
    const navigateToTextProject = vi.fn();
    const options = {
      activeProjectId: () => 'project-a',
      isMobile: () => true,
      navigateToTextProject,
      projects: () => [{ id: 'project-a' }],
      routeUrl: () => '/projects',
      startupLaunchSnapshot: () => null,
      warn: vi.fn(),
    } as unknown as WorkspaceShellStartupEntryControllersFactoryOptions;
    const mobileController = createWorkspaceShellMobileRootStartupNavigationControllerHost(
      options,
      () => null,
    );
    const destroy = mobileController.destroy.bind(mobileController);
    vi.spyOn(mobileController, 'destroy').mockImplementation(() => {
      order.push('mobile');
      destroy();
    });
    const startupController = {
      flushWidgetWorkspaceGateRecheck: vi.fn(),
      resetPrimeState: vi.fn(),
      resolveConsumedStartupEntryNavigation: vi.fn(() => []),
      sync: vi.fn(),
      teardown: vi.fn(() => order.push('startup')),
    };

    const controllers = createWorkspaceShellStartupEntryControllers({
      ...options,
      createAndroidWidgetLazyLoadController: () => ({
        persistDeferredStartupEntryIntent: vi.fn(),
      } as never),
      createMobileRootStartupNavigation: () => mobileController,
      createStartupEntryIntentController: () => startupController,
    });

    expect(mobileController).toBeInstanceOf(
      WorkspaceShellMobileRootStartupNavigationController,
    );
    expect(controllers.mobileRootStartupNavigation).toBe(mobileController);
    mobileController.navigateRootStartupToTextProject('project-a');
    expect(navigateToTextProject).toHaveBeenCalledWith('project-a');

    controllers.startupEntryIntentController.teardown();

    expect(order).toEqual(['mobile', 'startup']);
  });
});
