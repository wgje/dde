import { describe, expect, it, vi } from 'vitest';
import { AUTH_CONFIG } from '../config/auth.config';
import { createProject, createProjectOperationServiceSpecContext } from './project-operation.test-harness';

describe('project-operation test harness', () => {
  it('creates a reset service context with project operation dependencies', () => {
    const context = createProjectOperationServiceSpecContext();

    expect(context.service).toBeTruthy();
    expect(context.projectConflict).toBeTruthy();
    expect(context.mockProjectState.projects()).toEqual([]);
    expect(context.mockUserSession.currentUserId()).toBe(AUTH_CONFIG.LOCAL_MODE_USER_ID);
    expect(context.mockSyncCoordinator.resolveConflict).toHaveBeenCalledTimes(0);

    context.mockProjectState.projects.mockReturnValue([createProject({ id: 'stale-project' })]);
    context.mockSyncCoordinator.resolveConflict.mockResolvedValueOnce({
      ok: true,
      value: createProject({ id: 'stale-project' }),
    });
    vi.clearAllMocks();

    const nextContext = createProjectOperationServiceSpecContext();

    expect(nextContext.mockProjectState.projects()).toEqual([]);
    expect(nextContext.mockSyncCoordinator.resolveConflict).toHaveBeenCalledTimes(0);
  });
});
