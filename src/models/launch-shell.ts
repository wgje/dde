import type { ColorMode, TaskStatus, ThemeType } from './index';

export type LaunchRouteIntentKind = 'projects' | 'project' | 'text' | 'flow' | 'task';

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

export interface LaunchRouteIntent {
  kind: LaunchRouteIntentKind;
  projectId: string | null;
  taskId: string | null;
}

export interface LaunchSnapshot {
  version: 1 | 2;
  savedAt: string;
  activeProjectId: string | null;
  lastActiveView: 'text' | 'flow' | null;
  preferredView?: 'text' | 'flow' | null;
  resolvedLaunchView?: 'text' | 'flow';
  routeIntent?: LaunchRouteIntent;
  mobileDegraded?: boolean;
  degradeReason?: string | null;
  theme: ThemeType;
  colorMode: ColorMode;
  projects: LaunchSnapshotProject[];
  currentProject?: LaunchSnapshotProject | null;
}
