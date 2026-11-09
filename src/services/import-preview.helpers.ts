import type { Project } from '../models';
import type { ExportProject } from './export.service';
import type { ImportConflict, ImportProjectPreview } from './import.service';

export interface ImportProjectPreviewBuildResult {
  projects: ImportProjectPreview[];
  conflicts: ImportConflict[];
  hasAttachments: boolean;
}

export function buildImportProjectPreviews(
  projects: ExportProject[],
  existingProjects: Project[]
): ImportProjectPreviewBuildResult {
  const existingById = new Map(existingProjects.map(project => [project.id, project]));
  const existingByName = new Map(
    existingProjects.map(project => [project.name.toLowerCase(), project])
  );
  const conflicts: ImportConflict[] = [];
  let hasAttachments = false;

  const previews = projects.map(project => {
    const attachmentCount = countProjectAttachments(project);
    if (attachmentCount > 0) {
      hasAttachments = true;
    }

    appendProjectConflicts(project, existingById, existingByName, conflicts);

    return {
      id: project.id,
      name: project.name,
      taskCount: project.tasks?.length ?? 0,
      connectionCount: project.connections?.length ?? 0,
      attachmentCount,
      hasConflict: existingById.has(project.id),
    };
  });

  return {
    projects: previews,
    conflicts,
    hasAttachments,
  };
}

function countProjectAttachments(project: ExportProject): number {
  return (project.tasks ?? []).reduce(
    (sum, task) => sum + (task.attachments?.length ?? 0),
    0
  );
}

function appendProjectConflicts(
  project: ExportProject,
  existingById: ReadonlyMap<string, Project>,
  existingByName: ReadonlyMap<string, Project>,
  conflicts: ImportConflict[]
): void {
  const idConflict = existingById.get(project.id);
  if (idConflict) {
    conflicts.push({
      projectId: project.id,
      projectName: project.name,
      existingProjectId: idConflict.id,
      existingProjectName: idConflict.name,
      type: 'id',
    });
  }

  const nameConflict = existingByName.get(project.name.toLowerCase());
  if (nameConflict && nameConflict.id !== project.id) {
    conflicts.push({
      projectId: project.id,
      projectName: project.name,
      existingProjectId: nameConflict.id,
      existingProjectName: nameConflict.name,
      type: 'name',
    });
  }
}
