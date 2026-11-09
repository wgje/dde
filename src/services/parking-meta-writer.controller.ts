import type { Task, TaskParkingMeta } from '../models';

export interface ParkingMetaWriterControllerOptions {
  taskById: (taskId: string) => Task | undefined;
  findProjectId: (taskId: string) => string | null;
  setTask: (task: Task, projectId: string) => boolean | Promise<boolean> | void;
  nowIso?: () => string;
}

export class ParkingMetaWriterController {
  private readonly nowIso: () => string;

  constructor(private readonly options: ParkingMetaWriterControllerOptions) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  update(taskId: string, meta: TaskParkingMeta): boolean | Promise<boolean> {
    return this.write(taskId, meta);
  }

  clear(taskId: string): boolean | Promise<boolean> {
    return this.write(taskId, undefined);
  }

  restore(taskId: string, meta: TaskParkingMeta): boolean | Promise<boolean> {
    return this.write(taskId, meta);
  }

  private write(taskId: string, parkingMeta: TaskParkingMeta | undefined): boolean | Promise<boolean> {
    const task = this.options.taskById(taskId);
    if (!task) return false;

    const projectId = this.options.findProjectId(taskId);
    if (!projectId) return false;

    const result = this.options.setTask(
      { ...task, parkingMeta, updatedAt: this.nowIso() },
      projectId
    );
    return result instanceof Promise
      ? result.then(value => value !== false)
      : result !== false;
  }
}
