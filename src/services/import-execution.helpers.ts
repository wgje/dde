import type { Project } from '../models';
import type { ExportProject } from './export.service';
import type {
  ImportExecutionResult,
  ImportOptions,
  ImportProjectResult,
} from './import.service';

export type ImportProjectPlan =
  | { kind: 'skip'; result: ImportProjectResult }
  | {
      kind: 'merge';
      exportProject: ExportProject;
      existingProject: Project;
    }
  | {
      kind: 'import';
      exportProject: ExportProject;
      generateNewIds: boolean;
      action: 'imported' | 'overwritten';
    };

export function buildConcurrentImportRejection(): ImportExecutionResult {
  return {
    success: false,
    error: '导入正在进行中',
    importedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    details: [],
    durationMs: 0,
  };
}

export function summarizeImportExecution(
  details: ImportProjectResult[],
  durationMs: number
): ImportExecutionResult {
  const importedCount = details.filter(isImportedAction).length;
  const skippedCount = details.filter(detail => detail.action === 'skipped').length;
  const failedCount = details.filter(detail => detail.action === 'failed').length;

  return {
    success: failedCount === 0,
    importedCount,
    skippedCount,
    failedCount,
    details,
    durationMs,
  };
}

export function resolveImportProjectPlan(
  exportProject: ExportProject,
  existingProject: Project | undefined,
  options: ImportOptions
): ImportProjectPlan {
  if (!existingProject) {
    return {
      kind: 'import',
      exportProject,
      generateNewIds: options.generateNewIds ?? false,
      action: 'imported',
    };
  }

  switch (options.conflictStrategy) {
    case 'skip':
      return {
        kind: 'skip',
        result: buildSkippedProjectResult(exportProject),
      };

    case 'overwrite':
      return {
        kind: 'import',
        exportProject,
        generateNewIds: options.generateNewIds ?? false,
        action: 'overwritten',
      };

    case 'merge':
      return { kind: 'merge', exportProject, existingProject };

    case 'rename':
      return {
        kind: 'import',
        exportProject: {
          ...exportProject,
          name: `${exportProject.name} (导入)`,
        },
        generateNewIds: true,
        action: 'imported',
      };
  }
}

export function buildImportedProjectResult(
  project: Project,
  action: 'imported' | 'overwritten'
): ImportProjectResult {
  return {
    projectId: project.id,
    projectName: project.name,
    success: true,
    action,
    taskCount: project.tasks.length,
    connectionCount: project.connections.length,
  };
}

function isImportedAction(detail: ImportProjectResult): boolean {
  return (
    detail.action === 'imported' ||
    detail.action === 'merged' ||
    detail.action === 'overwritten'
  );
}

function buildSkippedProjectResult(exportProject: ExportProject): ImportProjectResult {
  return {
    projectId: exportProject.id,
    projectName: exportProject.name,
    success: true,
    action: 'skipped',
  };
}
