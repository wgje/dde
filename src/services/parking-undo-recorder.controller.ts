import type { Project } from '../models';
import {
  collectParkUndoProjectIds,
  hasProjectSnapshotChanged,
} from './parking-undo.helpers';

interface ParkingUndoRecorderControllerOptions {
  findProjectId: (taskId: string) => string | null;
  getProject: (projectId: string) => Project | undefined;
  createProjectSnapshot: (project: Project) => Partial<Project>;
  recordAction: (action: ParkingUndoActionInput) => void;
}

interface ParkingUndoActionInput {
  type: 'task-park';
  projectId: string;
  data: {
    before: Partial<Project>;
    after: Partial<Project>;
  };
}

export class ParkingUndoRecorderController {
  constructor(private readonly options: ParkingUndoRecorderControllerOptions) {}

  captureSnapshots(taskIds: Array<string | null>): Map<string, Partial<Project>> {
    const snapshots = new Map<string, Partial<Project>>();
    const projectIds = collectParkUndoProjectIds(taskIds, this.options.findProjectId);

    for (const projectId of projectIds) {
      const project = this.options.getProject(projectId);
      if (!project) continue;
      snapshots.set(projectId, this.options.createProjectSnapshot(project));
    }

    return snapshots;
  }

  recordAction(beforeSnapshots: Map<string, Partial<Project>>): void {
    for (const [projectId, before] of beforeSnapshots.entries()) {
      const project = this.options.getProject(projectId);
      if (!project) continue;

      const after = this.options.createProjectSnapshot(project);
      if (!hasProjectSnapshotChanged(before, after)) continue;

      this.options.recordAction({
        type: 'task-park',
        projectId,
        data: { before, after },
      });
    }
  }
}
