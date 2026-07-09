/**
 * 远程项目变更载荷。
 */
export interface RemoteProjectChangePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  projectId: string;
}

/**
 * 远程任务变更载荷。
 *
 * 注：移除了未使用的 data 字段。
 * 增量更新的复杂度（JSON Patch、数组乱序等）远超其带来的带宽节省。
 */
export interface RemoteTaskChangePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  taskId: string;
  projectId: string;
}

export interface RemoteChangeCallbacks {
  onLoadProjects?: () => Promise<void>;
  onRefreshActiveProject?: (reason: string) => Promise<void>;
}

export interface RemoteTaskUpdateContext {
  eventType: RemoteTaskChangePayload['eventType'];
  taskId: string;
  targetProjectId: string;
  requestId: number;
  currentProjectId: string | null;
}
