import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchSnapshot, LaunchSnapshotProject } from '../models/launch-shell';
import { normalizeLaunchSnapshot } from './launch-snapshot-normalization.helpers';

describe('normalizeLaunchSnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('migrates v1 payloads to the v2 launch snapshot shape', () => {
    const normalized = normalizeLaunchSnapshot({
      version: 1,
      savedAt: '',
      activeProjectId: 'project-1',
      lastActiveView: 'flow',
      theme: 'ocean',
      colorMode: 'dark',
      projects: [
        launchProject('project-1', {
          recentTasks: [
            { id: 'task-1', title: 'Valid task', displayId: '1', status: 'active' },
            { id: 'task-2', title: 'Invalid task', displayId: '2', status: 'pending' as unknown as 'active' },
          ],
        }),
        { id: 'broken-project' },
      ],
    });

    expect(normalized).toEqual({
      version: 2,
      savedAt: '2026-03-25T10:00:00.000Z',
      activeProjectId: 'project-1',
      lastActiveView: 'flow',
      preferredView: 'flow',
      resolvedLaunchView: 'flow',
      routeIntent: { kind: 'project', projectId: 'project-1', taskId: null },
      mobileDegraded: false,
      degradeReason: null,
      theme: 'ocean',
      colorMode: 'dark',
      projects: [
        {
          id: 'project-1',
          name: 'Project 1',
          description: '',
          updatedAt: null,
          taskCount: 3,
          openTaskCount: 2,
          recentTasks: [{ id: 'task-1', title: 'Valid task', displayId: '1', status: 'active' }],
        },
      ],
      currentProject: {
        id: 'project-1',
        name: 'Project 1',
        description: '',
        updatedAt: null,
        taskCount: 3,
        openTaskCount: 2,
        recentTasks: [{ id: 'task-1', title: 'Valid task', displayId: '1', status: 'active' }],
      },
    });
  });

  it('normalizes v2 payloads with route and current project fallbacks', () => {
    const normalized = normalizeLaunchSnapshot({
      version: 2,
      savedAt: '2026-03-25T09:00:00.000Z',
      userId: 42,
      activeProjectId: 'project-2',
      lastActiveView: 'text',
      preferredView: 'invalid',
      resolvedLaunchView: 'invalid',
      routeIntent: { kind: 'unknown', projectId: 'bad', taskId: 'bad' },
      mobileDegraded: 'yes',
      degradeReason: 7,
      theme: 'default',
      colorMode: 'system',
      projects: [launchProject('project-2')],
      currentProject: { id: 'broken' },
    });

    expect(normalized).toMatchObject({
      version: 2,
      savedAt: '2026-03-25T09:00:00.000Z',
      userId: null,
      activeProjectId: 'project-2',
      lastActiveView: 'text',
      preferredView: 'text',
      resolvedLaunchView: 'text',
      routeIntent: { kind: 'project', projectId: 'project-2', taskId: null },
      mobileDegraded: false,
      degradeReason: null,
      currentProject: { id: 'project-2' },
    });
  });

  it('rejects unsupported snapshot payloads', () => {
    expect(normalizeLaunchSnapshot(null)).toBeNull();
    expect(normalizeLaunchSnapshot({ version: 3, projects: [] })).toBeNull();
  });
});

function launchProject(
  id: string,
  overrides: Partial<LaunchSnapshotProject> = {},
): LaunchSnapshot['projects'][number] {
  return {
    id,
    name: `Project ${id.split('-').at(-1)}`,
    description: 12 as unknown as string,
    updatedAt: null,
    taskCount: 3,
    openTaskCount: 2,
    recentTasks: [],
    ...overrides,
  };
}
