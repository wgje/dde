import { expect, it, vi } from 'vitest';

import type { Project } from '../models';
import type { UserSessionServiceSpecContext } from './user-session.service.spec-context';

export interface UserSessionMetadataLocalProjectRetentionSpecContext {
  getContext: () => UserSessionServiceSpecContext;
  setupSupabaseQuery: (serverProjects: Array<Record<string, unknown>>) => unknown;
}

export function registerUserSessionMetadataLocalProjectRetentionSpecs(
  specContext: UserSessionMetadataLocalProjectRetentionSpecContext,
): void {
  it('expired guest draft 标记不应阻止 local-only 影子项目被裁剪', async () => {
    const context = specContext.getContext();
    const remoteProject = context.createProject({ id: 'proj-a', name: 'A', syncSource: 'synced' });
    const shadowProject = context.createProject({
      id: 'proj-expired-shadow',
      name: 'Expired Shadow',
      syncSource: 'local-only',
      pendingSync: true,
    });
    localStorage.setItem('nanoflow.guest-data', JSON.stringify({
      projects: [shadowProject],
      version: 2,
      savedAt: '2026-02-01T00:00:00.000Z',
      expiresAt: '2026-02-02T00:00:00.000Z',
    }));
    (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
      remoteProject,
      shadowProject,
    ]);
    (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>)
      .mockReturnValue(false);

    specContext.setupSupabaseQuery([{
      id: 'proj-a',
      title: 'A',
      description: '',
      created_date: remoteProject.createdDate,
      updated_at: remoteProject.updatedAt,
      version: 1,
    }]);

    await (
      context.service as unknown as {
        syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
      }
    ).syncProjectListMetadata('user-1');

    const setProjectsCall = (
      context.mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0] as Project[] | undefined;
    expect(setProjectsCall?.map((project: Project) => project.id)).toEqual(['proj-a']);
  });

  it('无 guest draft 标记且无真实本地改动的 local-only 影子项目应被裁剪', async () => {
    const context = specContext.getContext();
    const remoteProject = context.createProject({ id: 'proj-a', name: 'A', syncSource: 'synced' });
    const shadowProject = context.createProject({
      id: 'proj-shadow-only',
      name: 'Shadow',
      syncSource: 'local-only',
      pendingSync: true,
    });
    (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
      remoteProject,
      shadowProject,
    ]);
    (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>)
      .mockReturnValue(false);

    specContext.setupSupabaseQuery([{
      id: 'proj-a',
      title: 'A',
      description: '',
      created_date: remoteProject.createdDate,
      updated_at: remoteProject.updatedAt,
      version: 1,
    }]);

    await (
      context.service as unknown as {
        syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
      }
    ).syncProjectListMetadata('user-1');

    const setProjectsCall = (
      context.mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0] as Project[] | undefined;
    expect(setProjectsCall?.map((project: Project) => project.id)).toEqual(['proj-a']);
  });

  it('存在 ChangeTracker 本地改动时，应继续保留 remote 缺席的 local-only 项目', async () => {
    const context = specContext.getContext();
    const remoteProject = context.createProject({ id: 'proj-a', name: 'A', syncSource: 'synced' });
    const localOnlyProject = context.createProject({
      id: 'proj-local-change',
      name: 'Local Change',
      syncSource: 'local-only',
      pendingSync: true,
    });
    (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([
      remoteProject,
      localOnlyProject,
    ]);
    (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>)
      .mockImplementation((projectId: string) => projectId === 'proj-a');
    (context.mockChangeTracker['hasProjectChanges'] as ReturnType<typeof vi.fn>)
      .mockImplementation((projectId: string) => projectId === 'proj-local-change');

    specContext.setupSupabaseQuery([{
      id: 'proj-a',
      title: 'A',
      description: '',
      created_date: remoteProject.createdDate,
      updated_at: remoteProject.updatedAt,
      version: 1,
    }]);

    await (
      context.service as unknown as {
        syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
      }
    ).syncProjectListMetadata('user-1');

    const setProjectsCall = (
      context.mockProjectState['setProjectsMetadataOnly'] as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0] as Project[] | undefined;
    expect(setProjectsCall?.map((project: Project) => project.id)).toEqual([
      'proj-a',
      'proj-local-change',
    ]);
  });

  it('裁剪后清理不可访问的 activeProjectId 时应弹提示', async () => {
    const context = specContext.getContext();
    const staleProject = context.createProject({ id: 'proj-stale', name: 'Stale' });
    (context.mockProjectState['projects'] as ReturnType<typeof vi.fn>).mockReturnValue([staleProject]);
    (context.mockProjectState['activeProjectId'] as ReturnType<typeof vi.fn>)
      .mockReturnValue('proj-gone');
    (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>)
      .mockReturnValue(false);

    specContext.setupSupabaseQuery([]);

    await (
      context.service as unknown as {
        syncProjectListMetadata: (userId: string) => Promise<Set<string>>;
      }
    ).syncProjectListMetadata('user-1');

    expect(context.mockProjectState['setProjectsMetadataOnly']).toHaveBeenCalledWith([]);
    expect(context.mockProjectState['setActiveProjectId']).toHaveBeenCalledWith(null);
    expect(context.mockToastService['info'])
      .toHaveBeenCalledWith('当前项目不可访问，已自动切换');
  });
}
