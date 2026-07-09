import { describe, expect, it } from 'vitest';

import type {
  WorkspaceShellStartupEntryControllers,
} from './workspace-shell-startup-entry-controllers.factory';
import {
  createWorkspaceShellStartupEntryRegistry,
} from './workspace-shell-startup-entry-registry.factory';

describe('createWorkspaceShellStartupEntryRegistry', () => {
  it('throws before startup entry controllers are registered', () => {
    const registry = createWorkspaceShellStartupEntryRegistry();

    expect(() => registry.startupEntryControllers()).toThrow(
      'Workspace shell startup entry controllers are not initialized',
    );
  });

  it('returns the registered startup entry controllers', () => {
    const registry = createWorkspaceShellStartupEntryRegistry();
    const controllers = {
      androidWidgetLazyLoad: {},
    } as WorkspaceShellStartupEntryControllers;

    registry.registerStartupEntryControllers(controllers);

    expect(registry.startupEntryControllers()).toBe(controllers);
  });
});
