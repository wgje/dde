import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellLifecycleAfterViewInitOptions,
} from './workspace-shell-lifecycle-after-view-init-options.factory';
import {
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellLifecycleGraphSource,
  readWorkspaceShellLifecycleSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

describe('workspace shell lifecycle after-view-init options', () => {
  it('builds after-view-init options from shell dependencies', () => {
    const handoffReadiness = {
      signalWorkspaceHandoffReady: vi.fn(),
    };
    const handoffControllers = {
      readiness: handoffReadiness,
    };

    expect(createWorkspaceShellLifecycleAfterViewInitOptions({
      handoffControllers,
    })).toEqual({
      handoffReadiness,
    });
  });

  it('keeps after-view-init option wiring outside WorkspaceShellComponent', () => {
    const componentSource = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const lifecycleGraphSource = readWorkspaceShellLifecycleGraphSource();
    const surfaceSource = readWorkspaceShellLifecycleSurfaceSource();

    expect(graphSource).toContain('createWorkspaceShellLifecycleGraph');
    expect(lifecycleGraphSource).toContain('createWorkspaceShellLifecycleSurface');
    expect(componentSource).not.toContain(
      'createWorkspaceShellLifecycleAfterViewInitOptions',
    );
    expect(componentSource).not.toContain(
      'afterViewInit: this.lifecycleAfterViewInitOptions',
    );
    expect(surfaceSource).toContain(
      'afterViewInit: createWorkspaceShellLifecycleAfterViewInitOptions(options)',
    );
    expect(componentSource).not.toContain(
      'private readonly handoffReadiness = this.handoffControllers.readiness',
    );
    expect(componentSource).not.toContain('handoffReadiness: this.handoffReadiness');
    expect(componentSource).not.toMatch(
      /afterViewInit:\s*{\s*handoffReadiness:\s*this\.handoffReadiness,\s*}/s,
    );
  });
});
