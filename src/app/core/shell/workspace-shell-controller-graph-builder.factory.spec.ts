import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createWorkspaceShellControllerGraphFromContext,
} from './workspace-shell-controller-graph-builder.factory';

describe('createWorkspaceShellControllerGraphFromContext', () => {
  it('exposes the context-based shell graph builder as its own boundary', () => {
    expect(createWorkspaceShellControllerGraphFromContext).toEqual(expect.any(Function));
  });

  it('owns the ordered shell surface composition', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-controller-graph-builder.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellStartupEntryRegistry');
    expect(source).toContain('createWorkspaceShellBaseSurfaces');
    expect(source).toContain('createWorkspaceShellSessionRoutingSurface');
    expect(source).toContain('createWorkspaceShellInteractionSurfaces');
    expect(source).toContain('createWorkspaceShellStartupTemplateSurfaces');
    expect(source).toContain('createWorkspaceShellLifecycleGraph');
  });
});
