import { describe, expect, it } from 'vitest';
import type { Project } from '../models';
import {
  captureConflictFingerprint,
  doesActiveConflictMatchSnapshot,
  doesStoredConflictMatchFingerprint,
} from './project-operation-conflict-fingerprint';

function project(id: string, version: number): Project {
  return {
    id,
    version,
    name: id,
    description: '',
    createdDate: '2026-01-01T00:00:00.000Z',
    tasks: [],
    connections: [],
  };
}

describe('project-operation-conflict-fingerprint', () => {
  it('prefers the newer stored conflict fingerprint over the active conflict', () => {
    const fingerprint = captureConflictFingerprint(
      {
        projectId: 'project-1',
        ownerUserId: 'stored-owner',
        conflictedAt: '2026-01-02T00:00:00.000Z',
        localVersion: 4,
        remoteVersion: 5,
        pendingTaskDeleteIds: ['b', 'a'],
      },
      {
        projectId: 'project-1',
        conflictedAt: '2026-01-01T00:00:00.000Z',
        local: project('project-1', 2),
        remote: project('project-1', 3),
        pendingTaskDeleteIds: ['c'],
      },
      'active-owner',
    );

    expect(fingerprint).toEqual({
      projectId: 'project-1',
      ownerUserId: 'stored-owner',
      conflictedAt: '2026-01-02T00:00:00.000Z',
      localVersion: 4,
      remoteVersion: 5,
      pendingTaskDeleteIds: ['b', 'a'],
      pendingTaskDeleteBaseUpdatedAtMap: {},
      operationConflictFingerprints: [],
    });
  });

  it('falls back to owner context when stored conflict has no owner', () => {
    const fingerprint = captureConflictFingerprint(
      {
        projectId: 'project-1',
        conflictedAt: '2026-01-02T00:00:00.000Z',
        localVersion: 4,
        pendingTaskDeleteIds: [],
      },
      null,
      'owner-1',
    );

    expect(fingerprint.ownerUserId).toBe('owner-1');
    expect(fingerprint.remoteVersion).toBeUndefined();
  });

  it('matches stored conflict fingerprints with order-insensitive pending deletes', () => {
    expect(doesStoredConflictMatchFingerprint(
      {
        projectId: 'project-1',
        ownerUserId: 'owner-1',
        conflictedAt: '2026-01-02T00:00:00.000Z',
        localVersion: 4,
        remoteVersion: 0,
        pendingTaskDeleteIds: ['b', 'a'],
        pendingTaskDeleteBaseUpdatedAtMap: {
          a: null,
          b: '2026-01-02T00:00:00.000Z',
        },
      },
      {
        projectId: 'project-1',
        ownerUserId: 'owner-1',
        conflictedAt: '2026-01-02T00:00:00.000Z',
        localVersion: 4,
        pendingTaskDeleteIds: ['a', 'b'],
        pendingTaskDeleteBaseUpdatedAtMap: {
          b: '2026-01-02T00:00:00.000Z',
          a: null,
        },
      },
    )).toBe(true);
  });

  it('does not match stored conflict fingerprints when delete CAS baselines differ', () => {
    expect(doesStoredConflictMatchFingerprint(
      {
        projectId: 'project-1',
        ownerUserId: 'owner-1',
        conflictedAt: '2026-01-02T00:00:00.000Z',
        localVersion: 4,
        remoteVersion: 0,
        pendingTaskDeleteIds: ['a'],
        pendingTaskDeleteBaseUpdatedAtMap: {
          a: '2026-01-02T00:00:00.000Z',
        },
      },
      {
        projectId: 'project-1',
        ownerUserId: 'owner-1',
        conflictedAt: '2026-01-02T00:00:00.000Z',
        localVersion: 4,
        pendingTaskDeleteIds: ['a'],
        pendingTaskDeleteBaseUpdatedAtMap: {
          a: '2026-01-03T00:00:00.000Z',
        },
      },
    )).toBe(false);
  });

  it('matches active conflict snapshots by versions, timestamp, and pending deletes', () => {
    expect(doesActiveConflictMatchSnapshot(
      {
        projectId: 'project-1',
        conflictedAt: '2026-01-02T00:00:00.000Z',
        localProject: project('project-1', 4),
        remoteProject: project('project-1', 5),
        pendingTaskDeleteIds: ['b', 'a'],
        pendingTaskDeleteBaseUpdatedAtMap: {
          a: null,
          b: '2026-01-02T00:00:00.000Z',
        },
      },
      {
        projectId: 'project-1',
        conflictedAt: '2026-01-02T00:00:00.000Z',
        local: project('project-1', 4),
        remote: project('project-1', 5),
        pendingTaskDeleteIds: ['a', 'b'],
        pendingTaskDeleteBaseUpdatedAtMap: {
          b: '2026-01-02T00:00:00.000Z',
          a: null,
        },
      },
    )).toBe(true);
  });

  it('does not match active conflict snapshots when delete CAS baselines differ', () => {
    expect(doesActiveConflictMatchSnapshot(
      {
        projectId: 'project-1',
        conflictedAt: '2026-01-02T00:00:00.000Z',
        localProject: project('project-1', 4),
        remoteProject: project('project-1', 5),
        pendingTaskDeleteIds: ['a'],
        pendingTaskDeleteBaseUpdatedAtMap: {
          a: '2026-01-02T00:00:00.000Z',
        },
      },
      {
        projectId: 'project-1',
        conflictedAt: '2026-01-02T00:00:00.000Z',
        local: project('project-1', 4),
        remote: project('project-1', 5),
        pendingTaskDeleteIds: ['a'],
        pendingTaskDeleteBaseUpdatedAtMap: {
          a: '2026-01-03T00:00:00.000Z',
        },
      },
    )).toBe(false);
  });
});
