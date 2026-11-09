import { describe, expect, it } from 'vitest';

import {
  readWorkspaceShellBaseSurfacesSource,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

describe('WorkspaceShell startup launch snapshot wiring', () => {
  it('keeps startup launch snapshot storage out of WorkspaceShellComponent wrapper fields', () => {
    const componentSource = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const baseSurfacesSource = readWorkspaceShellBaseSurfacesSource();

    expect(componentSource).not.toContain('createWorkspaceShellStartupRuntimeContext');
    expect(graphSource).toContain('createWorkspaceShellBaseSurfaces');
    expect(graphSource).not.toContain('createWorkspaceShellLaunchSnapshotSurface');
    expect(baseSurfacesSource)
      .toContain('createWorkspaceShellLaunchSnapshotSurface');
    expect(componentSource).not.toContain('inject(LaunchSnapshotService)');
    expect(componentSource).not.toContain('this.launchSnapshot.read()');
    expect(baseSurfacesSource).toContain('launchSnapshotSurface');
    expect(componentSource).not.toContain(
      'startupLaunchSnapshot: this.launchSnapshotSurface.startupLaunchSnapshot',
    );
  });
});
