import { describe, expect, it } from 'vitest';
import {
  buildImportedProjectResult,
  buildConcurrentImportRejection,
  resolveImportProjectPlan,
  summarizeImportExecution,
} from './import-execution.helpers';
import type { ImportOptions, ImportProjectResult } from './import.service';
import type { ExportProject } from './export.service';
import type { Project } from '../models';

describe('import execution helpers', () => {
  const exportProject: ExportProject = {
    id: 'project-1',
    name: 'Imported Project',
    description: '',
    createdAt: '2026-06-09T00:00:00.000Z',
    updatedAt: '2026-06-09T00:00:00.000Z',
    tasks: [],
    connections: [],
  };

  const existingProject: Project = {
    id: 'project-1',
    name: 'Existing Project',
    description: '',
    createdDate: '2026-06-09T00:00:00.000Z',
    tasks: [],
    connections: [],
  };

  it('builds a stable rejection result while another import is active', () => {
    expect(buildConcurrentImportRejection()).toEqual({
      success: false,
      error: '导入正在进行中',
      importedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      details: [],
      durationMs: 0,
    });
  });

  it('summarizes imported, skipped, and failed project details', () => {
    const details: ImportProjectResult[] = [
      {
        projectId: 'imported',
        projectName: 'Imported',
        success: true,
        action: 'imported',
      },
      {
        projectId: 'merged',
        projectName: 'Merged',
        success: true,
        action: 'merged',
      },
      {
        projectId: 'skipped',
        projectName: 'Skipped',
        success: true,
        action: 'skipped',
      },
      {
        projectId: 'failed',
        projectName: 'Failed',
        success: false,
        action: 'failed',
      },
    ];

    expect(summarizeImportExecution(details, 125)).toEqual({
      success: false,
      importedCount: 2,
      skippedCount: 1,
      failedCount: 1,
      details,
      durationMs: 125,
    });
  });

  it('resolves skip conflicts without requiring service side effects', () => {
    const options: ImportOptions = { conflictStrategy: 'skip' };

    expect(resolveImportProjectPlan(exportProject, existingProject, options)).toEqual({
      kind: 'skip',
      result: {
        projectId: 'project-1',
        projectName: 'Imported Project',
        success: true,
        action: 'skipped',
      },
    });
  });

  it('resolves rename conflicts as new project imports with regenerated ids', () => {
    const options: ImportOptions = { conflictStrategy: 'rename' };

    expect(resolveImportProjectPlan(exportProject, existingProject, options)).toEqual({
      kind: 'import',
      exportProject: {
        ...exportProject,
        name: 'Imported Project (导入)',
      },
      generateNewIds: true,
      action: 'imported',
    });
  });

  it('builds successful project import results from the saved project shape', () => {
    const project: Project = {
      ...existingProject,
      tasks: [{ id: 'task-1' } as Project['tasks'][number]],
      connections: [{ id: 'connection-1' } as Project['connections'][number]],
    };

    expect(buildImportedProjectResult(project, 'overwritten')).toEqual({
      projectId: 'project-1',
      projectName: 'Existing Project',
      success: true,
      action: 'overwritten',
      taskCount: 1,
      connectionCount: 1,
    });
  });
});
