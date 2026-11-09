import { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  LaunchSnapshotService,
  type LaunchSnapshot,
} from '../../../services/launch-snapshot.service';

type WorkspaceShellLaunchSnapshotSurfaceFactory = (options: {
  injector: Injector;
}) => {
  readonly launchSnapshot: LaunchSnapshotService;
  readonly startupLaunchSnapshot: () => LaunchSnapshot | null;
};

async function loadFactory(): Promise<{
  createWorkspaceShellLaunchSnapshotSurface?: WorkspaceShellLaunchSnapshotSurfaceFactory;
}> {
  const modulePath = './workspace-shell-launch-snapshot-surface.factory';
  const module = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));

  return module as {
    createWorkspaceShellLaunchSnapshotSurface?: WorkspaceShellLaunchSnapshotSurfaceFactory;
  };
}

function createSnapshot(): LaunchSnapshot {
  return {
    version: 2,
    savedAt: '2026-06-18T00:00:00.000Z',
    userId: 'user-1',
    activeProjectId: 'project-1',
    lastActiveView: 'text',
    preferredView: 'text',
    resolvedLaunchView: 'text',
    theme: 'default',
    colorMode: 'system',
    projects: [],
    currentProject: null,
  };
}

describe('createWorkspaceShellLaunchSnapshotSurface', () => {
  it('groups the launch snapshot service with one cached startup snapshot', async () => {
    const { createWorkspaceShellLaunchSnapshotSurface } = await loadFactory();

    expect(createWorkspaceShellLaunchSnapshotSurface).toEqual(expect.any(Function));

    const startupSnapshot = createSnapshot();
    const launchSnapshot = {
      read: vi.fn()
        .mockReturnValueOnce(startupSnapshot)
        .mockReturnValue(null),
    } as unknown as LaunchSnapshotService;
    const injector = {
      get: vi.fn((token: unknown) => {
        if (token === LaunchSnapshotService) return launchSnapshot;
        throw new Error(`Unexpected token: ${String(token)}`);
      }),
    } as unknown as Injector;

    const surface = createWorkspaceShellLaunchSnapshotSurface?.({ injector });

    expect(injector.get).toHaveBeenCalledWith(LaunchSnapshotService);
    expect(launchSnapshot.read).toHaveBeenCalledTimes(1);
    expect(surface?.launchSnapshot).toBe(launchSnapshot);
    expect(surface?.startupLaunchSnapshot()).toBe(startupSnapshot);
    expect(surface?.startupLaunchSnapshot()).toBe(startupSnapshot);
    expect(launchSnapshot.read).toHaveBeenCalledTimes(1);
  });
});
