import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const context = { injector: {}, warn: vi.fn() };
  const graph = { lifecycle: {}, template: {} };

  return {
    context,
    graph,
    createWorkspaceShellGraphContext: vi.fn(() => context),
    createWorkspaceShellControllerGraphFromContext: vi.fn(() => graph),
  };
});

vi.mock('./workspace-shell-graph-context.factory', () => ({
  createWorkspaceShellGraphContext: mocks.createWorkspaceShellGraphContext,
}));

vi.mock('./workspace-shell-controller-graph-builder.factory', () => ({
  createWorkspaceShellControllerGraphFromContext:
    mocks.createWorkspaceShellControllerGraphFromContext,
}));

describe('createWorkspaceShellControllerGraph', () => {
  it('builds one graph context and feeds it into the controller graph builder', async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const {
      createWorkspaceShellControllerGraph,
    } = await import('./workspace-shell-controller-graph.factory');

    const graph = createWorkspaceShellControllerGraph();

    // 胶水职责：先取一次注入上下文，再交给 builder，且原样返回 builder 结果
    expect(mocks.createWorkspaceShellGraphContext).toHaveBeenCalledTimes(1);
    expect(mocks.createWorkspaceShellControllerGraphFromContext)
      .toHaveBeenCalledExactlyOnceWith(mocks.context);
    expect(graph).toBe(mocks.graph);
  });
});
