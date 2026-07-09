import { describe, expect, it } from 'vitest';
import type { Project, Task } from '../models';
import type { ExternalSourceLink } from '../app/core/external-sources/external-source.model';
import {
  buildExportData,
  collectExportStats,
  createExportBlobResult,
  EXPORT_CONFIG,
  generateExportFilename,
  sanitizeProjectForExport,
} from './export-build.utils';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  const { id, ...rest } = overrides;

  return {
    id,
    title: rest.title ?? id,
    content: rest.content ?? '',
    stage: rest.stage ?? 1,
    parentId: rest.parentId ?? null,
    order: rest.order ?? 0,
    rank: rest.rank ?? 10000,
    status: rest.status ?? 'active',
    x: rest.x ?? 0,
    y: rest.y ?? 0,
    displayId: rest.displayId ?? id,
    createdDate: rest.createdDate ?? '2026-06-08T00:00:00.000Z',
    ...rest,
  };
}

function makeProject(overrides: Partial<Project> & { id: string }): Project {
  const { id, ...rest } = overrides;

  return {
    id,
    name: rest.name ?? id,
    description: rest.description ?? '',
    createdDate: rest.createdDate ?? '2026-06-08T00:00:00.000Z',
    tasks: rest.tasks ?? [],
    connections: rest.connections ?? [],
    ...rest,
  };
}

describe('export build utils', () => {
  it('counts tasks, connections, and task attachments across projects', () => {
    const projects = [
      makeProject({
        id: 'p1',
        tasks: [
          makeTask({
            id: 't1',
            attachments: [
              {
                id: 'a1',
                type: 'file',
                name: 'a.pdf',
                url: 'https://example.com/a.pdf',
                createdAt: '2026-06-08T00:00:00.000Z',
              },
            ],
          }),
        ],
        connections: [{ id: 'c1', source: 't1', target: 't2' }],
      }),
      makeProject({ id: 'p2', tasks: [makeTask({ id: 't2' })] }),
    ];

    expect(collectExportStats(projects)).toEqual({
      taskCount: 2,
      connectionCount: 1,
      attachmentCount: 1,
    });
  });

  it('sanitizes projects while preserving backup-critical metadata', () => {
    const link: ExternalSourceLink = {
      id: 'link-1',
      taskId: 'task-1',
      sourceType: 'siyuan-block',
      targetId: '20260608000000-test',
      uri: 'siyuan://blocks/20260608000000-test',
      label: 'Spec',
      role: 'spec',
      sortOrder: 0,
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
    };
    const project = makeProject({
      id: 'project-1',
      tasks: [
        makeTask({
          id: 'task-1',
          parkingMeta: {
            state: 'parked',
            parkedAt: '2026-06-08T00:00:00.000Z',
            lastVisitedAt: null,
            contextSnapshot: {
              savedAt: '2026-06-08T00:00:00.000Z',
              contentHash: 'hash',
              viewMode: 'text',
              cursorPosition: null,
              scrollAnchor: null,
              structuralAnchor: null,
              flowViewport: null,
            },
            reminder: null,
            pinned: false,
          },
          attachments: [
            {
              id: 'active-att',
              type: 'file',
              name: 'active.pdf',
              url: 'https://example.com/active.pdf',
              createdAt: '2026-06-08T00:00:00.000Z',
            },
            {
              id: 'deleted-att',
              type: 'file',
              name: 'deleted.pdf',
              url: 'https://example.com/deleted.pdf',
              createdAt: '2026-06-08T00:00:00.000Z',
              deletedAt: '2026-06-09T00:00:00.000Z',
            },
          ],
        }),
      ],
    });

    const exportProject = sanitizeProjectForExport(project, taskId => [link]);

    expect(exportProject.tasks[0].parkingMeta?.contextSnapshot).toBeNull();
    expect(exportProject.tasks[0].attachments?.map(attachment => attachment.id)).toEqual(['active-att']);
    expect(exportProject.tasks[0].externalSourceLinks).toEqual([{
      id: link.id,
      sourceType: link.sourceType,
      targetId: link.targetId,
      uri: link.uri,
      label: link.label,
      role: link.role,
      sortOrder: link.sortOrder,
      deletedAt: link.deletedAt,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
    }]);
  });

  it('preserves connection sync timestamps for LWW restore', () => {
    const project = makeProject({
      id: 'project-1',
      connections: [{
        id: 'connection-1',
        source: 'task-1',
        target: 'task-2',
        updatedAt: '2026-06-08T01:23:45.000Z',
        deletedAt: null,
      }],
    });

    const exportProject = sanitizeProjectForExport(project, () => []);

    expect(exportProject.connections[0]).toEqual(expect.objectContaining({
      id: 'connection-1',
      updatedAt: '2026-06-08T01:23:45.000Z',
      deletedAt: null,
    }));
  });

  it('builds export metadata and blob results from prepared projects', async () => {
    const projects = [makeProject({ id: 'project-1', tasks: [makeTask({ id: 'task-1' })] })];
    const stats = collectExportStats(projects);
    const exportProjects = projects.map(project => sanitizeProjectForExport(project, () => []));
    const exportData = buildExportData(projects.length, exportProjects, stats, 'full', '2026-06-08T01:02:03.000Z');

    exportData.metadata.checksum = 'checksum';
    const result = createExportBlobResult(exportData, 'nanoflow-backup-20260608-010203.json', 1000, 1250);

    expect(exportData.metadata).toMatchObject({
      exportedAt: '2026-06-08T01:02:03.000Z',
      version: EXPORT_CONFIG.FORMAT_VERSION,
      projectCount: 1,
      taskCount: 1,
      exportType: 'full',
    });
    expect(result.durationMs).toBe(250);
    expect(result.blob?.type).toBe(EXPORT_CONFIG.MIME_TYPE);
    await expect(result.blob?.text()).resolves.toContain('"checksum": "checksum"');
  });

  it('generates stable export filenames with type suffixes', () => {
    expect(generateExportFilename('single-project', new Date('2026-06-08T01:02:03.000Z')))
      .toBe('nanoflow-backup-project-20260608-010203.json');
    expect(generateExportFilename('selected', new Date('2026-06-08T01:02:03.000Z')))
      .toBe('nanoflow-backup-selected-20260608-010203.json');
    expect(generateExportFilename('full', new Date('2026-06-08T01:02:03.000Z')))
      .toBe('nanoflow-backup-20260608-010203.json');
  });
});
