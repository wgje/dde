import type { Task } from '../models';
import { buildParkingNoteContent } from './parking-note.helpers';

interface ParkingTaskLifecycleControllerOptions {
  taskById: (taskId: string) => Task | undefined;
  findProjectId: (taskId: string) => string | null;
  clearParkingMeta: (taskId: string) => void;
  updateParkingMeta: (taskId: string, meta: NonNullable<Task['parkingMeta']>) => boolean | Promise<boolean>;
  updateTaskContent: (taskId: string, content: string) => boolean | Promise<boolean>;
  setTask: (task: Task, projectId: string) => void;
  previewingTaskId: () => string | null;
  setPreviewingTaskId: (taskId: string | null) => void;
  showInfo: (message: string) => void;
}

export class ParkingTaskLifecycleController {
  constructor(private readonly options: ParkingTaskLifecycleControllerOptions) {}

  handleTaskSoftDelete(taskId: string): void {
    const task = this.options.taskById(taskId);
    if (this.options.previewingTaskId() === taskId) {
      this.options.setPreviewingTaskId(null);
    }
    if (!task?.parkingMeta) return;

    this.options.clearParkingMeta(taskId);
  }

  handleTaskStatusChange(taskId: string, newStatus: string): void {
    if (newStatus !== 'completed' && newStatus !== 'archived') return;

    const task = this.options.taskById(taskId);
    if (task?.parkingMeta) {
      this.options.clearParkingMeta(taskId);
    }
  }

  async addNote(taskId: string, noteContent: string): Promise<boolean> {
    const task = this.options.taskById(taskId);
    if (!task) return false;

    const projectId = this.options.findProjectId(taskId);
    if (!projectId) return false;

    return await this.options.updateTaskContent(
      taskId,
      buildParkingNoteContent(task.content, noteContent),
    );
  }

  async keepParked(taskId: string): Promise<boolean> {
    const task = this.options.taskById(taskId);
    if (!task?.parkingMeta) return false;

    const persisted = await this.options.updateParkingMeta(taskId, {
      ...task.parkingMeta,
      lastVisitedAt: new Date().toISOString(),
    });
    if (!persisted) return false;

    this.options.showInfo('已保留，不会被自动清理');
    return true;
  }
}
