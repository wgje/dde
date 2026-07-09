import { describe, expect, it } from 'vitest';

import { AUTH_CONFIG } from '../config/auth.config';
import type { Project } from '../models';
import {
  getNonEmptyTaskDeleteBaseUpdatedAtMap,
  getPendingOwnerHandoffProjectIds,
  hasProtectedOfflineProjects,
  shouldRetainOwnerHandoffSnapshot,
} from './sync-coordinator-owner-handoff.helpers';

function createProject(overrides: Partial<Project>): Project {
  return {
    id: 'project-1',
    name: 'Project',
    description: '',
    createdDate: '2026-01-01T00:00:00.000Z',
    tasks: [],
    connections: [],
    ...overrides,
  };
}

describe('sync coordinator owner handoff helpers', () => {
  it('combines changed project ids with the active project only when local changes are pending', () => {
    expect(getPendingOwnerHandoffProjectIds({
      changedProjectIds: ['project-a', 'project-b'],
      activeProjectId: 'active-project',
      hasPendingLocalChanges: true,
    })).toEqual(new Set(['project-a', 'project-b', 'active-project']));

    expect(getPendingOwnerHandoffProjectIds({
      changedProjectIds: ['project-a'],
      activeProjectId: 'active-project',
      hasPendingLocalChanges: false,
    })).toEqual(new Set(['project-a']));

    expect(getPendingOwnerHandoffProjectIds({
      changedProjectIds: [],
      activeProjectId: null,
      hasPendingLocalChanges: true,
    })).toEqual(new Set());
  });

  it('detects protected offline projects while honoring handed-off exclusions', () => {
    const projects = [
      createProject({ id: 'synced-project', syncSource: 'synced', pendingSync: false }),
      createProject({ id: 'pending-project', syncSource: 'synced', pendingSync: true }),
      createProject({ id: 'local-project', syncSource: 'local-only', pendingSync: false }),
    ];

    expect(hasProtectedOfflineProjects(projects)).toBe(true);
    expect(hasProtectedOfflineProjects(projects, new Set(['pending-project']))).toBe(true);
    expect(hasProtectedOfflineProjects(projects, new Set(['pending-project', 'local-project']))).toBe(false);
  });

  it('retains owner handoff snapshots when ownership cannot be safely transferred', () => {
    expect(shouldRetainOwnerHandoffSnapshot(createProject({ syncSource: 'synced' }), null)).toBe(true);
    expect(shouldRetainOwnerHandoffSnapshot(
      createProject({ syncSource: 'synced' }),
      AUTH_CONFIG.LOCAL_MODE_USER_ID,
    )).toBe(true);
    expect(shouldRetainOwnerHandoffSnapshot(
      createProject({ syncSource: 'local-only' }),
      'owner-user',
    )).toBe(true);
    expect(shouldRetainOwnerHandoffSnapshot(
      createProject({ syncSource: 'synced' }),
      'owner-user',
    )).toBe(false);
  });

  it('normalizes empty task delete base maps out of owner handoff payloads', () => {
    expect(getNonEmptyTaskDeleteBaseUpdatedAtMap(undefined)).toBeUndefined();
    expect(getNonEmptyTaskDeleteBaseUpdatedAtMap({})).toBeUndefined();

    const map = { 'task-1': '2026-01-01T00:00:00.000Z', 'task-2': null };
    expect(getNonEmptyTaskDeleteBaseUpdatedAtMap(map)).toBe(map);
  });
});
