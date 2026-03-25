import { Injectable } from '@angular/core';
import type { ColorMode, Project, Task, ThemeType } from '../models';
import type { LaunchSnapshot, LaunchSnapshotProject, LaunchSnapshotTask } from '../models/launch-shell';

export type { LaunchSnapshot, LaunchSnapshotProject, LaunchSnapshotTask } from '../models/launch-shell';

const LAUNCH_SNAPSHOT_STORAGE_KEY = 'nanoflow.launch-snapshot.v1';
const LAUNCH_SNAPSHOT_VERSION = 1 as const;
const MAX_PROJECTS = 6;
const MAX_TASKS_PER_PROJECT = 3;
const PERSIST_DEBOUNCE_MS = 400;

type CaptureOptions = {
  activeProjectId: string | null;
  lastActiveView: 'text' | 'flow' | null;
  theme: ThemeType;
  colorMode: ColorMode;
};

@Injectable({
  providedIn: 'root',
})
export class LaunchSnapshotService {
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSnapshot: LaunchSnapshot | null = null;
  private pendingCaptureArgs: { projects: Project[]; options: CaptureOptions } | null = null;
  private readonly pagehideListener = () => this.flushPendingPersist();
  private readonly visibilityChangeListener = () => {
    if (document.hidden) {
      this.flushPendingPersist();
    }
  };

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.pagehideListener, { passive: true });
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityChangeListener, { passive: true });
    }
  }

  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.pagehideListener);
    }

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityChangeListener);
    }
  }

  capture(projects: Project[], options: CaptureOptions): LaunchSnapshot {
    const trimmedProjects = [...projects]
      .sort((left, right) => this.sortProjectsForLaunchPreview(left, right, options.activeProjectId))
      .slice(0, MAX_PROJECTS)
      .map((project) => this.toLaunchProject(project));

    return {
      version: LAUNCH_SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      activeProjectId: options.activeProjectId,
      lastActiveView: options.lastActiveView,
      theme: options.theme,
      colorMode: options.colorMode,
      projects: trimmedProjects,
    };
  }

  read(): LaunchSnapshot | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }

    const raw = localStorage.getItem(LAUNCH_SNAPSHOT_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      const normalized = this.normalize(parsed);
      if (!normalized) {
        localStorage.removeItem(LAUNCH_SNAPSHOT_STORAGE_KEY);
      }
      return normalized;
    } catch {
      localStorage.removeItem(LAUNCH_SNAPSHOT_STORAGE_KEY);
      return null;
    }
  }

  schedulePersist(snapshot: LaunchSnapshot | null): void {
    if (!snapshot) {
      return;
    }

    this.pendingSnapshot = snapshot;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }

    this.persistTimer = setTimeout(() => {
      this.flushPendingPersist();
    }, PERSIST_DEBOUNCE_MS);
  }

  /**
   * 延迟快照持久化：先缓存原始参数，防抖后才执行 capture + 写入。
   * 避免在每次信号变化时都做 sort/slice/map（capture 开销）。
   */
  schedulePersistDeferred(projects: Project[], options: CaptureOptions): void {
    this.pendingCaptureArgs = { projects, options };
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }

    this.persistTimer = setTimeout(() => {
      if (this.pendingCaptureArgs) {
        const { projects: p, options: o } = this.pendingCaptureArgs;
        this.pendingCaptureArgs = null;
        this.pendingSnapshot = this.capture(p, o);
      }
      this.flushPendingPersist();
    }, PERSIST_DEBOUNCE_MS);
  }

  flushPendingPersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    if (!this.pendingSnapshot || typeof localStorage === 'undefined') {
      return;
    }

    try {
      localStorage.setItem(LAUNCH_SNAPSHOT_STORAGE_KEY, JSON.stringify(this.pendingSnapshot));
    } catch {
      // localStorage 写入失败时静默降级，不阻断主流程。
    } finally {
      this.pendingSnapshot = null;
    }
  }

  private normalize(value: unknown): LaunchSnapshot | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const source = value as Partial<LaunchSnapshot>;
    if (source.version !== LAUNCH_SNAPSHOT_VERSION) {
      return null;
    }

    const projects = Array.isArray(source.projects)
      ? source.projects.map((project) => this.normalizeProject(project)).filter((project): project is LaunchSnapshotProject => !!project)
      : [];

    return {
      version: LAUNCH_SNAPSHOT_VERSION,
      savedAt: typeof source.savedAt === 'string' && source.savedAt ? source.savedAt : new Date().toISOString(),
      activeProjectId: typeof source.activeProjectId === 'string' ? source.activeProjectId : null,
      lastActiveView: source.lastActiveView === 'flow' || source.lastActiveView === 'text' ? source.lastActiveView : null,
      theme: source.theme ?? 'default',
      colorMode: source.colorMode ?? 'system',
      projects,
    };
  }

  private normalizeProject(value: unknown): LaunchSnapshotProject | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const source = value as Partial<LaunchSnapshotProject>;
    if (typeof source.id !== 'string' || typeof source.name !== 'string') {
      return null;
    }

    const recentTasks = Array.isArray(source.recentTasks)
      ? source.recentTasks.map((task) => this.normalizeTask(task)).filter((task): task is LaunchSnapshotTask => !!task)
      : [];

    return {
      id: source.id,
      name: source.name,
      description: typeof source.description === 'string' ? source.description : '',
      updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
      taskCount: Number.isFinite(source.taskCount) ? Number(source.taskCount) : 0,
      openTaskCount: Number.isFinite(source.openTaskCount) ? Number(source.openTaskCount) : 0,
      recentTasks,
    };
  }

  private normalizeTask(value: unknown): LaunchSnapshotTask | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const source = value as Partial<LaunchSnapshotTask>;
    if (
      typeof source.id !== 'string' ||
      typeof source.title !== 'string' ||
      typeof source.displayId !== 'string' ||
      (source.status !== 'active' && source.status !== 'completed' && source.status !== 'archived')
    ) {
      return null;
    }

    return {
      id: source.id,
      title: source.title,
      displayId: source.displayId,
      status: source.status,
    };
  }

  private toLaunchProject(project: Project): LaunchSnapshotProject {
    const activeTasks = project.tasks.filter((task) => !task.deletedAt);
    const recentTasks = activeTasks
      .sort((left, right) => this.sortTasksForLaunchPreview(left, right))
      .slice(0, MAX_TASKS_PER_PROJECT)
      .map((task) => this.toLaunchTask(task));

    return {
      id: project.id,
      name: project.name,
      description: project.description,
      updatedAt: project.updatedAt ?? null,
      taskCount: activeTasks.length,
      openTaskCount: activeTasks.filter((task) => task.status !== 'completed').length,
      recentTasks,
    };
  }

  private toLaunchTask(task: Task): LaunchSnapshotTask {
    return {
      id: task.id,
      title: task.title,
      displayId: task.displayId,
      status: task.status,
    };
  }

  private sortProjectsForLaunchPreview(left: Project, right: Project, activeProjectId: string | null): number {
    if (left.id === activeProjectId && right.id !== activeProjectId) return -1;
    if (right.id === activeProjectId && left.id !== activeProjectId) return 1;

    const leftUpdatedAt = Date.parse(left.updatedAt ?? left.createdDate);
    const rightUpdatedAt = Date.parse(right.updatedAt ?? right.createdDate);
    return rightUpdatedAt - leftUpdatedAt;
  }

  private sortTasksForLaunchPreview(left: Task, right: Task): number {
    if (left.status !== right.status) {
      return left.status === 'completed' ? 1 : -1;
    }

    const leftUpdatedAt = Date.parse(left.updatedAt ?? left.createdDate);
    const rightUpdatedAt = Date.parse(right.updatedAt ?? right.createdDate);
    return rightUpdatedAt - leftUpdatedAt;
  }
}
