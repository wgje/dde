import type { ColorMode, TaskStatus, ThemeType } from './index';

export interface LaunchSnapshotTask {
  id: string;
  title: string;
  displayId: string;
  status: TaskStatus;
}

export interface LaunchSnapshotProject {
  id: string;
  name: string;
  description: string;
  updatedAt: string | null;
  taskCount: number;
  openTaskCount: number;
  recentTasks: LaunchSnapshotTask[];
}

export interface LaunchSnapshot {
  version: 1;
  savedAt: string;
  activeProjectId: string | null;
  lastActiveView: 'text' | 'flow' | null;
  theme: ThemeType;
  colorMode: ColorMode;
  projects: LaunchSnapshotProject[];
}
