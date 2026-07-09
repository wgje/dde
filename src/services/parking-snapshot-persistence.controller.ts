import type { Task, TaskParkingMeta } from '../models';
import {
  buildParkingSnapshotDraft,
  mergeParkingSnapshotDraft,
  parseParkingSnapshotDraft,
  shouldRestoreParkingSnapshotDraft,
} from './parking-snapshot-draft.helpers';
import { buildParkedTaskCacheEntries } from './parking-task-cache.helpers';

interface ParkedTaskCacheSnapshot {
  entries: Array<{ task: Task; projectId: string }>;
  cursor: string | null;
}

export interface ParkingSnapshotPersistenceControllerOptions {
  draftKey: string;
  focusedTask: () => Task | null;
  parkedTasks: () => Task[];
  taskById: (taskId: string) => Task | undefined;
  findProjectId: (taskId: string) => string | null;
  updateParkingMeta: (taskId: string, meta: TaskParkingMeta) => void;
  saveFullSnapshot: (taskId: string) => void | Promise<void>;
  saveParkedTasksCache: (snapshot: ParkedTaskCacheSnapshot) => Promise<void>;
  parkedCursor: () => string | null;
}

export class ParkingSnapshotPersistenceController {
  constructor(private readonly options: ParkingSnapshotPersistenceControllerOptions) {}

  saveSnapshotToLocalStorage(): void {
    const focused = this.options.focusedTask();
    if (!focused) return;

    try {
      const draft = buildParkingSnapshotDraft(focused);
      if (!draft) return;
      localStorage.setItem(this.options.draftKey, JSON.stringify(draft));
    } catch {
      // localStorage 写入失败（容量不足/隐私模式），静默忽略
    }
  }

  async saveSnapshotToIndexedDB(): Promise<void> {
    const focused = this.options.focusedTask();
    if (focused) {
      void this.options.saveFullSnapshot(focused.id);
    }
    await this.persistParkedTasksToIndexedDB();
  }

  async persistParkedTasksToIndexedDB(): Promise<void> {
    const entries = buildParkedTaskCacheEntries(
      this.options.parkedTasks(),
      (taskId) => this.options.findProjectId(taskId)
    );

    await this.options.saveParkedTasksCache({
      entries,
      cursor: this.options.parkedCursor(),
    });
  }

  restoreSnapshotDraftFromLocalStorage(): void {
    const draft = this.readSnapshotDraft();
    if (!draft) return;

    try {
      const task = this.options.taskById(draft.taskId);
      if (!shouldRestoreParkingSnapshotDraft(task, draft)) return;

      this.options.updateParkingMeta(task.id, {
        ...task.parkingMeta,
        contextSnapshot: mergeParkingSnapshotDraft(task.parkingMeta.contextSnapshot, draft),
      });
    } finally {
      try {
        localStorage.removeItem(this.options.draftKey);
      } catch {
        // 忽略 localStorage 清理失败
      }
    }
  }

  private readSnapshotDraft() {
    if (typeof localStorage === 'undefined') return null;
    try {
      return parseParkingSnapshotDraft(localStorage.getItem(this.options.draftKey));
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse/localStorage 读取失败时无法恢复草稿，返回 null 表示无可用草稿
      return null;
    }
  }
}
