import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const derivedUiState = { showLoginRequired: vi.fn() };
  const handoffControllers = { handoffReadiness: {} };
  const interactionSurface = { interaction: {} };

  return {
    derivedUiState,
    handoffControllers,
    interactionSurface,
    createWorkspaceShellDerivedUiStateController: vi.fn(() => derivedUiState),
    createWorkspaceShellHandoffSurface: vi.fn(() => handoffControllers),
    createWorkspaceShellInteractionBoundarySurface: vi.fn(() => interactionSurface),
  };
});

vi.mock('./workspace-shell-derived-ui-state.factory', () => ({
  createWorkspaceShellDerivedUiStateController:
    mocks.createWorkspaceShellDerivedUiStateController,
}));

vi.mock('./workspace-shell-handoff-controllers.factory', () => ({
  createWorkspaceShellHandoffSurface: mocks.createWorkspaceShellHandoffSurface,
}));

vi.mock('./workspace-shell-interaction-boundary-surface.factory', () => ({
  createWorkspaceShellInteractionBoundarySurface:
    mocks.createWorkspaceShellInteractionBoundarySurface,
}));

describe('createWorkspaceShellInteractionSurfaces', () => {
  it('builds derived ui state and handoff surfaces then wires both into the interaction boundary', async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const {
      createWorkspaceShellInteractionSurfaces,
    } = await import('./workspace-shell-interaction-surfaces.factory');
    const runtime = vi.fn(() => false);
    const authService = { sessionInitialized: vi.fn() };
    const options = {
      runtime,
      authService,
      uiState: { isMobile: vi.fn() },
    };

    const surfaces = createWorkspaceShellInteractionSurfaces(
      options as unknown as Parameters<typeof createWorkspaceShellInteractionSurfaces>[0],
    );

    expect(mocks.createWorkspaceShellDerivedUiStateController).toHaveBeenCalledTimes(1);
    expect(mocks.createWorkspaceShellHandoffSurface).toHaveBeenCalledTimes(1);
    // 交互边界 surface 必须复用同一 derivedUiState，并把 runtime/authService 归一化为
    // destroyed/session 选项，避免组件层重复拼装
    expect(mocks.createWorkspaceShellInteractionBoundarySurface).toHaveBeenCalledWith(
      expect.objectContaining({
        derivedUiState: mocks.derivedUiState,
        destroyed: runtime,
        session: { authService },
      }),
    );
    expect(surfaces).toEqual({
      derivedUiState: mocks.derivedUiState,
      handoffControllers: mocks.handoffControllers,
      interactionSurface: mocks.interactionSurface,
    });
  });
});
