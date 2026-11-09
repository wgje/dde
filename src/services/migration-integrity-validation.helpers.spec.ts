import { describe, expect, it } from 'vitest';
import type { Project } from '../models';
import { validateMigrationProjectIntegrity } from './migration-integrity-validation.helpers';

describe('validateMigrationProjectIntegrity', () => {
  it('counts valid projects, tasks, and connections', () => {
    const result = validateMigrationProjectIntegrity([
      project({
        tasks: [task({ id: 'task-1' }), task({ id: 'task-2' })],
        connections: [{ id: 'conn-1', source: 'task-1', target: 'task-2' }],
      }),
    ]);

    expect(result).toEqual({
      valid: true,
      issues: [],
      projectCount: 1,
      taskCount: 2,
      connectionCount: 1,
    });
  });

  it('collects project, task, parent, field, and connection issues', () => {
    const result = validateMigrationProjectIntegrity([
      project({ id: '', name: '' }),
      project({
        id: 'project-1',
        name: 'Project 1',
        tasks: [
          task({ id: 'dup', stage: 'bad' as unknown as number }),
          task({ id: 'dup', title: 'Duplicate' }),
          task({ id: 'child', parentId: 'missing-parent' }),
          task({ id: '', title: '' }),
        ],
        connections: [
          { id: '', source: 'dup', target: 'child' },
          { id: 'broken', source: 'missing-source', target: 'missing-target' },
        ],
      }),
      project({ id: 'project-1', name: 'Duplicate Project' }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.taskCount).toBe(4);
    expect(result.connectionCount).toBe(2);
    expect(result.issues.map((issue) => [issue.type, issue.entityType, issue.entityId ?? null])).toEqual([
      ['missing-id', 'project', null],
      ['invalid-field', 'task', 'dup'],
      ['duplicate-id', 'task', 'dup'],
      ['missing-id', 'task', null],
      ['orphan-task', 'task', 'child'],
      ['missing-id', 'connection', null],
      ['broken-connection', 'connection', 'broken'],
      ['broken-connection', 'connection', 'broken'],
      ['duplicate-id', 'project', 'project-1'],
    ]);
  });
});

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project',
    description: '',
    createdDate: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    tasks: [],
    connections: [],
    ...overrides,
  };
}

function task(overrides: Partial<Project['tasks'][number]> = {}): Project['tasks'][number] {
  return {
    id: 'task-1',
    title: 'Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    displayId: '1',
    attachments: [],
    ...overrides,
  };
}
