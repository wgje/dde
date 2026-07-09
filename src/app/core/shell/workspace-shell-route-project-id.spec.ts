import { describe, expect, it } from 'vitest';

import {
  readWorkspaceShellRouteProjectId,
  type WorkspaceShellRouteNodeLike,
} from './workspace-shell-route-project-id';

function createRoute(
  params: Record<string, unknown>,
  firstChild: WorkspaceShellRouteNodeLike | null = null,
): WorkspaceShellRouteNodeLike {
  return {
    snapshot: { params },
    firstChild,
  };
}

describe('readWorkspaceShellRouteProjectId', () => {
  it('uses the deepest non-empty projectId from a route tree', () => {
    const route = createRoute(
      { projectId: 'ancestor-project' },
      createRoute(
        { taskId: 'task-1' },
        createRoute({ projectId: 'deep-project' }),
      ),
    );

    expect(readWorkspaceShellRouteProjectId(route)).toBe('deep-project');
  });

  it('falls back to an ancestor projectId when the deepest child has no valid projectId', () => {
    const route = createRoute(
      { projectId: 'ancestor-project' },
      createRoute(
        { projectId: '' },
        createRoute({ projectId: 123 }),
      ),
    );

    expect(readWorkspaceShellRouteProjectId(route)).toBe('ancestor-project');
  });
});
