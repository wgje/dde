import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../models';
import { markTaskContentMissingFromSource } from '../utils/task-content-guard';
import type { UserSessionServiceSpecContext } from './user-session.service.spec-context';

export function registerUserSessionMergeSingleProjectContentSpecs(
  getContext: () => UserSessionServiceSpecContext,
): void {
  let context: UserSessionServiceSpecContext;

  beforeEach(() => {
    context = getContext();
  });

  describe('mergeSingleProject content guard', () => {
    it('远端任务缺少 content 时应在直接覆盖分支保留本地正文', async () => {
      vi.clearAllMocks();

      const localTask = context.createTask({
        id: 'task-1',
        title: 'Keep Content',
        content: 'local content should survive',
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const localProject = context.createProject({
        id: 'proj-content-guard',
        tasks: [localTask],
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const shellProject = context.createProject({
        id: 'proj-content-guard',
        tasks: [],
        connections: [],
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const remoteTask = markTaskContentMissingFromSource(context.createTask({
        id: 'task-1',
        title: 'Keep Content',
        content: '',
        updatedAt: '2026-05-27T08:00:00.000Z',
      }));
      const remoteProject = context.createProject({
        id: 'proj-content-guard',
        tasks: [remoteTask],
        updatedAt: '2026-05-27T08:00:00.000Z',
      });

      (context.mockProjectState['setProjects'] as (projects: Project[]) => void)([shellProject]);
      (context.mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
      (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);

      await (
        context.service as unknown as {
          mergeSingleProject: (cloudProject: Project, userId: string) => Promise<void>;
        }
      ).mergeSingleProject(remoteProject, 'user-1');

      const mergedProject = (context.mockProjectState['projects'] as () => Project[])()
        .find((project) => project.id === 'proj-content-guard');

      expect(mergedProject?.tasks[0]?.content).toBe('local content should survive');
      expect(mergedProject?.tasks[0]?.updatedAt).toBe('2026-05-27T08:00:00.000Z');
      expect(context.mockLoggerCategory.warn).toHaveBeenCalledWith(
        'mergeSingleProject: 远端任务缺少 content，已保留本地正文',
        expect.objectContaining({
          projectId: 'proj-content-guard',
          restoredTaskCount: 1,
        }),
      );
    });

    it('远端显式提交空 content 时不应误用本地正文覆盖', async () => {
      vi.clearAllMocks();

      const localTask = context.createTask({
        id: 'task-2',
        title: 'Allow Empty',
        content: 'old content',
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const localProject = context.createProject({
        id: 'proj-explicit-empty',
        tasks: [localTask],
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const shellProject = context.createProject({
        id: 'proj-explicit-empty',
        tasks: [],
        connections: [],
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const remoteTask = context.createTask({
        id: 'task-2',
        title: 'Allow Empty',
        content: '',
        updatedAt: '2026-05-27T08:00:00.000Z',
      });
      const remoteProject = context.createProject({
        id: 'proj-explicit-empty',
        tasks: [remoteTask],
        updatedAt: '2026-05-27T08:00:00.000Z',
      });

      (context.mockProjectState['setProjects'] as (projects: Project[]) => void)([shellProject]);
      (context.mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
      (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(false);

      await (
        context.service as unknown as {
          mergeSingleProject: (cloudProject: Project, userId: string) => Promise<void>;
        }
      ).mergeSingleProject(remoteProject, 'user-1');

      const mergedProject = (context.mockProjectState['projects'] as () => Project[])()
        .find((project) => project.id === 'proj-explicit-empty');

      expect(mergedProject?.tasks[0]?.content).toBe('');
      expect(context.mockLoggerCategory.warn).not.toHaveBeenCalledWith(
        'mergeSingleProject: 远端任务缺少 content，已保留本地正文',
        expect.anything(),
      );
    });

    it('存在本地待同步修改时也应在 LWW 分支保留缺字段远端正文', async () => {
      vi.clearAllMocks();

      const localTask = context.createTask({
        id: 'task-3',
        title: 'Pending Merge',
        content: 'pending local content',
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const localProject = context.createProject({
        id: 'proj-pending-merge',
        tasks: [localTask],
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const shellProject = context.createProject({
        id: 'proj-pending-merge',
        tasks: [],
        connections: [],
        updatedAt: '2026-05-26T08:00:00.000Z',
      });
      const remoteTask = markTaskContentMissingFromSource(context.createTask({
        id: 'task-3',
        title: 'Pending Merge',
        content: '',
        updatedAt: '2026-05-27T08:00:00.000Z',
        order: 9,
      }));
      const remoteProject = context.createProject({
        id: 'proj-pending-merge',
        tasks: [remoteTask],
        updatedAt: '2026-05-27T08:00:00.000Z',
      });

      (context.mockProjectState['setProjects'] as (projects: Project[]) => void)([shellProject]);
      (context.mockProjectState['getProjectsWithCurrentData'] as ReturnType<typeof vi.fn>).mockReturnValue([localProject]);
      (context.mockSyncCoordinator['hasPendingChangesForProject'] as ReturnType<typeof vi.fn>).mockReturnValue(true);

      await (
        context.service as unknown as {
          mergeSingleProject: (cloudProject: Project, userId: string) => Promise<void>;
        }
      ).mergeSingleProject(remoteProject, 'user-1');

      const mergedProject = (context.mockProjectState['projects'] as () => Project[])()
        .find((project) => project.id === 'proj-pending-merge');

      expect(mergedProject?.tasks[0]?.content).toBe('pending local content');
      expect(mergedProject?.tasks[0]?.order).toBe(9);
      expect(mergedProject?.tasks[0]?.updatedAt).toBe('2026-05-27T08:00:00.000Z');
    });
  });
}
