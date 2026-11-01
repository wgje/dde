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
  updateParkingMeta: (taskId: string, meta: TaskParkingMeta) => boolean | Promise<boolean>;
  saveFullSnapshot: (taskId: string) => void | Promise<void>;
  currentOwnerUserId: () => string | null;
  saveParkedTasksCache: (
    ownerUserId: string,
    snapshot: ParkedTaskCacheSnapshot,
  ) => Promise<void>;
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
    const ownerUserId = this.options.currentOwnerUserId();
    if (!ownerUserId) return;

    const entries = buildParkedTaskCacheEntries(
      this.options.parkedTasks(),
      (taskId) => this.options.findProjectId(taskId)
    );

    await this.options.saveParkedTasksCache(ownerUserId, {
      entries,
      cursor: this.options.parkedCursor(),
    });
  }

  restoreSnapshotDraftFromLocalStorage(): void {
    const stored = this.readSnapshotDraft();
    if (!stored) return;
    const { draft, raw } = stored;

    const task = this.options.taskById(draft.taskId);
    if (!shouldRestoreParkingSnapshotDraft(task, draft)) {
      this.discardSnapshotDraftIfMatches(raw);
      return;
    }

    const acknowledged = this.options.updateParkingMeta(task.id, {
      ...task.parkingMeta,
      contextSnapshot: mergeParkingSnapshotDraft(task.parkingMeta.contextSnapshot, draft),
    });
    if (typeof acknowledged === 'boolean') {
      if (acknowledged) this.discardSnapshotDraftIfMatches(raw);
      return;
    }
    void acknowledged.then(
      (saved) => { if (saved) this.discardSnapshotDraftIfMatches(raw); },
      () => undefined,
    );
  }

  private discardSnapshotDraftIfMatches(expected: string): void {
    try {
      if (localStorage.getItem(this.options.draftKey) === expected) this.discardSnapshotDraft();
    } catch {
      // Uncertain storage state retains the draft for a later recovery attempt.
    }
  }

  discardSnapshotDraft(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.removeItem(this.options.draftKey);
    } catch {
      // Session teardown must continue even when browser storage is unavailable.
    }
  }

  private readSnapshotDraft() {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(this.options.draftKey);
      const draft = parseParkingSnapshotDraft(raw);
      return draft && raw !== null ? { draft, raw } : null;
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse/localStorage 读取失败时无法恢复草稿，返回 null 表示无可用草稿
      return null;
    }
  }
}
