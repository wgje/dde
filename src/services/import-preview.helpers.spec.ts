import { describe, expect, it } from 'vitest';
import type { Project } from '../models';
import type { ExportProject } from './export.service';
import { buildImportProjectPreviews } from './import-preview.helpers';

describe('buildImportProjectPreviews', () => {
  const existingProjects: Project[] = [
    {
      id: 'existing-id',
      name: 'Existing Project',
      description: '',
      createdDate: '2026-06-09T00:00:00.000Z',
      tasks: [],
      connections: [],
    },
    {
      id: 'different-id',
      name: 'Same Name',
      description: '',
      createdDate: '2026-06-09T00:00:00.000Z',
      tasks: [],
      connections: [],
    },
  ];

  it('builds project previews and records id/name conflicts in one pass', () => {
    const projects: ExportProject[] = [
      {
        id: 'existing-id',
        name: 'Imported Existing',
        description: '',
        createdAt: '2026-06-09T00:00:00.000Z',
        updatedAt: '2026-06-09T00:00:00.000Z',
        tasks: [
          {
            id: 'task-1',
            title: 'Task 1',
            content: '',
            stage: null,
            parentId: null,
            order: 0,
            rank: 0,
            status: 'active',
            x: 0,
            y: 0,
            displayId: '1',
            createdAt: '2026-06-09T00:00:00.000Z',
            attachments: [
              {
                id: 'attachment-1',
                name: 'file.pdf',
                size: 100,
                mimeType: 'application/pdf',
              },
            ],
          },
        ],
        connections: [{ id: 'conn-1', source: 'task-1', target: 'task-2' }],
      },
      {
        id: 'new-id',
        name: 'same name',
        description: '',
        createdAt: '2026-06-09T00:00:00.000Z',
        updatedAt: '2026-06-09T00:00:00.000Z',
        tasks: [],
        connections: [],
      },
    ];

    const result = buildImportProjectPreviews(projects, existingProjects);

    expect(result.projects).toEqual([
      {
        id: 'existing-id',
        name: 'Imported Existing',
        taskCount: 1,
        connectionCount: 1,
        attachmentCount: 1,
        hasConflict: true,
      },
      {
        id: 'new-id',
        name: 'same name',
        taskCount: 0,
        connectionCount: 0,
        attachmentCount: 0,
        hasConflict: false,
      },
    ]);
    expect(result.conflicts).toEqual([
      {
        projectId: 'existing-id',
        projectName: 'Imported Existing',
        existingProjectId: 'existing-id',
        existingProjectName: 'Existing Project',
        type: 'id',
      },
      {
        projectId: 'new-id',
        projectName: 'same name',
        existingProjectId: 'different-id',
        existingProjectName: 'Same Name',
        type: 'name',
      },
    ]);
    expect(result.hasAttachments).toBe(true);
  });
});
