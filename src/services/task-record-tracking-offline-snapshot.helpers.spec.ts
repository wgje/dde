import { describe, expect, it } from 'vitest';

import {
  buildImmediateOfflineSnapshotProjects,
} from './task-record-tracking-offline-snapshot.helpers';
import { createProject } from './task-record-tracking.service.spec-helpers';

describe('buildImmediateOfflineSnapshotProjects', () => {
  it('returns the after project when no current projects are loaded', () => {
    const afterProject = createProject({ id: 'proj-after' });

    expect(buildImmediateOfflineSnapshotProjects({
      currentProjects: [],
      targetProjectId: afterProject.id,
      afterProject,
    })).toEqual([afterProject]);
  });

  it('replaces the matching project while preserving other project references', () => {
    const untouchedProject = createProject({ id: 'proj-other' });
    const beforeProject = createProject({ id: 'proj-target', name: 'Before' });
    const afterProject = createProject({ id: 'proj-target', name: 'After' });

    expect(buildImmediateOfflineSnapshotProjects({
      currentProjects: [untouchedProject, beforeProject],
      targetProjectId: afterProject.id,
      afterProject,
    })).toEqual([untouchedProject, afterProject]);
  });

  it('appends the after project when the target is missing from current data', () => {
    const currentProject = createProject({ id: 'proj-existing' });
    const afterProject = createProject({ id: 'proj-new' });

    expect(buildImmediateOfflineSnapshotProjects({
      currentProjects: [currentProject],
      targetProjectId: afterProject.id,
      afterProject,
    })).toEqual([currentProject, afterProject]);
  });
});
