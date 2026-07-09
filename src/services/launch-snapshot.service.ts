import { Injectable } from '@angular/core';
import type { ColorMode, Project, Task, ThemeType } from '../models';
import type { LaunchSnapshot, LaunchSnapshotProject, LaunchSnapshotTask } from '../models/launch-shell';
import {
  LAUNCH_SNAPSHOT_VERSION_V1,
  LAUNCH_SNAPSHOT_VERSION_V2,
  normalizeLaunchSnapshot,
} from './launch-snapshot-normalization.helpers';
import { resolveRouteIntent } from '../utils/route-intent';

export type { LaunchSnapshot, LaunchSnapshotProject, LaunchSnapshotTask } from '../models/launch-shell';

const LAUNCH_SNAPSHOT_STORAGE_KEY_V1 = 'nanoflow.launch-snapshot.v1';
const LAUNCH_SNAPSHOT_STORAGE_KEY_V2 = 'nanoflow.launch-snapshot.v2';
const MAX_PROJECTS = 6;
const MAX_TASKS_PER_PROJECT = 3;
const PERSIST_DEBOUNCE_MS = 400;

type CaptureOptions = {
  userId?: string | null;
  activeProjectId: string | null;
  lastActiveView: 'text' | 'flow' | null;
  routeUrl?: string | null;
  resolvedLaunchView?: 'text' | 'flow';
  mobileDegraded?: boolean;
  degradeReason?: string | null;
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

    const currentProject = options.activeProjectId
      ? trimmedProjects.find((project) => project.id === options.activeProjectId) ?? null
      : null;
    const preferredView = options.lastActiveView;
    const resolvedLaunchView = options.resolvedLaunchView ?? preferredView ?? 'text';

    return {
      version: LAUNCH_SNAPSHOT_VERSION_V2,
      savedAt: new Date().toISOString(),
      userId: options.userId ?? null,
      activeProjectId: options.activeProjectId,
      lastActiveView: options.lastActiveView,
      preferredView,
      resolvedLaunchView,
      routeIntent: resolveRouteIntent(options.routeUrl ?? null, options.activeProjectId),
      mobileDegraded: options.mobileDegraded ?? false,
      degradeReason: options.degradeReason ?? null,
      theme: options.theme,
      colorMode: options.colorMode,
      projects: trimmedProjects,
      currentProject,
    };
  }

  read(): LaunchSnapshot | null {
    const globalSnapshot = this.readGlobalSnapshot();
    if (globalSnapshot) {
      return globalSnapshot;
    }

    if (typeof localStorage === 'undefined') {
      return null;
    }

    for (const storageKey of [LAUNCH_SNAPSHOT_STORAGE_KEY_V2, LAUNCH_SNAPSHOT_STORAGE_KEY_V1]) {
      const raw = localStorage.getItem(storageKey);
      if (!raw) {
        continue;
      }

      try {
        const parsed = JSON.parse(raw) as unknown;
        const normalized = this.normalize(parsed);
        if (!normalized) {
          localStorage.removeItem(storageKey);
          continue;
        }
        return normalized;
      } catch {
        localStorage.removeItem(storageKey);
      }
    }

    return null;
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

  cancelPendingPersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    this.pendingCaptureArgs = null;
    this.pendingSnapshot = null;
  }

  flushPendingPersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    if (!this.pendingSnapshot && this.pendingCaptureArgs) {
      const { projects, options } = this.pendingCaptureArgs;
      this.pendingCaptureArgs = null;
      this.pendingSnapshot = this.capture(projects, options);
    }

    if (!this.pendingSnapshot || typeof localStorage === 'undefined') {
      return;
    }

    try {
      localStorage.setItem(LAUNCH_SNAPSHOT_STORAGE_KEY_V2, JSON.stringify(this.pendingSnapshot));
      localStorage.setItem(
        LAUNCH_SNAPSHOT_STORAGE_KEY_V1,
        JSON.stringify(this.toV1Snapshot(this.pendingSnapshot)),
      );
    } catch {
      // localStorage 写入失败时静默降级，不阻断主流程。
    } finally {
      this.pendingSnapshot = null;
    }
  }

  private normalize(value: unknown): LaunchSnapshot | null {
    return normalizeLaunchSnapshot(value);
  }

  private toV1Snapshot(snapshot: LaunchSnapshot): LaunchSnapshot {
    return {
      version: LAUNCH_SNAPSHOT_VERSION_V1,
      savedAt: snapshot.savedAt,
      userId: snapshot.userId ?? null,
      activeProjectId: snapshot.activeProjectId,
      lastActiveView: snapshot.preferredView ?? snapshot.lastActiveView ?? null,
      theme: snapshot.theme,
      colorMode: snapshot.colorMode,
      projects: snapshot.projects,
    };
  }

  private readGlobalSnapshot(): LaunchSnapshot | null {
    if (typeof window === 'undefined') {
      return null;
    }

    const raw = window.__NANOFLOW_LAUNCH_SNAPSHOT__;
    if (!raw) {
      return null;
    }

    return this.normalize(raw);
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
