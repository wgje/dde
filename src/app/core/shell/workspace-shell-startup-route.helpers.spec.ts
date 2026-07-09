import { describe, expect, it } from 'vitest';

import {
  resolveConsumedStartupEntryNavigation,
  resolveStartupProjectFallbackId,
  shouldNavigateRootStartupToTextProject,
} from './workspace-shell-startup-route.helpers';

describe('workspace shell startup route helpers', () => {
  it('resolves startup project fallback from snapshot before first project', () => {
    const projects = [{ id: 'project-1' }, { id: 'project-2' }];

    expect(resolveStartupProjectFallbackId({
      projects,
      startupLaunchSnapshot: {
        activeProjectId: 'project-1',
        currentProject: { id: 'project-2' },
      },
    })).toBe('project-2');

    expect(resolveStartupProjectFallbackId({
      projects,
      startupLaunchSnapshot: {
        activeProjectId: 'missing-project',
        currentProject: null,
      },
    })).toBe('project-1');
  });

  it('only navigates mobile root startup to text once and only for workspace intents', () => {
    expect(shouldNavigateRootStartupToTextProject({
      routeUrl: '/projects',
      isMobile: true,
      rootStartupTextNavigationApplied: false,
      startupEntryIntent: null,
    })).toBe(true);

    expect(shouldNavigateRootStartupToTextProject({
      routeUrl: '/projects?entry=widget&intent=open-workspace',
      isMobile: true,
      rootStartupTextNavigationApplied: false,
      startupEntryIntent: { intent: 'open-workspace' },
    })).toBe(true);

    expect(shouldNavigateRootStartupToTextProject({
      routeUrl: '/projects?entry=shortcut&intent=open-focus-tools',
      isMobile: true,
      rootStartupTextNavigationApplied: false,
      startupEntryIntent: { intent: 'open-focus-tools' },
    })).toBe(false);

    expect(shouldNavigateRootStartupToTextProject({
      routeUrl: '/projects/project-1/flow',
      isMobile: true,
      rootStartupTextNavigationApplied: false,
      startupEntryIntent: null,
    })).toBe(false);
  });

  it('preserves deep-link route targets when consuming startup query params', () => {
    expect(resolveConsumedStartupEntryNavigation({
      routeUrl: '/projects/project-1/task/task-1?entry=widget&intent=open-workspace',
      mobileRootProjectId: null,
    })).toEqual(['/projects', 'project-1', 'task', 'task-1']);

    expect(resolveConsumedStartupEntryNavigation({
      routeUrl: '/projects/project-1/flow?entry=widget&intent=open-workspace',
      mobileRootProjectId: null,
    })).toEqual(['/projects', 'project-1', 'flow']);

    expect(resolveConsumedStartupEntryNavigation({
      routeUrl: '/projects?entry=widget&intent=open-workspace',
      mobileRootProjectId: () => 'project-2',
    })).toEqual(['/projects', 'project-2', 'text']);
  });
});
