import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellLifecycleStartupOptions,
} from './workspace-shell-lifecycle-startup-options.factory';
import {
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellLifecycleGraphSource,
  readWorkspaceShellLifecycleSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

describe('workspace shell lifecycle startup options', () => {
  it('builds shared startup lazy lifecycle options from the shell runtime context', () => {
    const injector = { get: vi.fn() };
    const destroyed = vi.fn(() => false);
    const warn = vi.fn();

    const options = createWorkspaceShellLifecycleStartupOptions({
      injector,
      destroyed,
      warn,
    });

    expect(options.flowPrewarm).toEqual({
      isDestroyed: destroyed,
      warn,
    });
    expect(options.lazyLifecycles).toEqual({
      injector,
      runtime: { destroyed },
      warn,
    });
    expect(options.startupLazyServices).toEqual({
      injector,
      warn,
    });
  });

  it('keeps startup lazy lifecycle option wiring outside WorkspaceShellComponent', () => {
    const componentSource = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const lifecycleGraphSource = readWorkspaceShellLifecycleGraphSource();
    const surfaceSource = readWorkspaceShellLifecycleSurfaceSource();

    expect(graphSource).toContain('createWorkspaceShellLifecycleGraph');
    expect(lifecycleGraphSource).toContain('createWorkspaceShellLifecycleSurface');
    expect(componentSource).not.toContain('createWorkspaceShellLifecycleStartupOptions');
    expect(componentSource).not.toContain('...this.lifecycleStartupOptions');
    expect(surfaceSource).toContain(
      '...createWorkspaceShellLifecycleStartupOptions(options)',
    );
    expect(componentSource).not.toMatch(
      /lazyLifecycles:\s*{\s*injector:\s*this\.injector,\s*destroyed:\s*\(\)\s*=>\s*this\.destroyed,\s*warn:\s*this\.warn,\s*}/s,
    );
    expect(componentSource).not.toMatch(
      /startupLazyServices:\s*{\s*injector:\s*this\.injector,\s*warn:\s*this\.warn,\s*}/s,
    );
    expect(componentSource).not.toContain('createWorkspaceShellFlowPrewarmLazyLoadController');
  });
});
