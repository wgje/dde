import type { RealtimeSubscribeState } from './realtime-status.controller';

/**
 * 远程变更回调
 */
export type RemoteChangeCallback = (payload: { eventType?: string; projectId?: string } | undefined) => Promise<void>;

/**
 * 用户偏好变更回调
 */
export type UserPreferencesChangeCallback = (payload: { eventType: string; userId: string }) => void;

/**
 * 任务级变更回调
 */
export type TaskChangeCallback = (payload: { eventType: string; taskId: string; projectId: string }) => void;

export interface RealtimePayload {
  eventType: string;
  new?: unknown;
  old?: unknown;
}

export interface RealtimePayloadDispatchRuntime {
  isStateCurrent: (state: RealtimeSubscribeState) => boolean;
  isPaused: () => boolean;
  getRemoteChangeCallback: () => RemoteChangeCallback | null;
  getUserPreferencesChangeCallback: () => UserPreferencesChangeCallback | null;
  getTaskChangeCallback: () => TaskChangeCallback | null;
}

interface RealtimePayloadDispatchLogger {
  debug: (message: string, data?: unknown) => void;
}

export class RealtimePayloadDispatchController {
  constructor(private readonly logger: RealtimePayloadDispatchLogger) {}

  handleTaskRealtimePayload(
    payload: RealtimePayload,
    state: RealtimeSubscribeState,
    runtime: RealtimePayloadDispatchRuntime,
  ): void {
    if (!runtime.isStateCurrent(state)) return;

    const taskData = readRealtimePayloadRecord(payload);
    if (isForeignProjectPayload(taskData, state.projectId)) return;

    this.logger.debug('收到任务变更', { event: payload.eventType });
    if (runtime.isPaused()) return;

    const taskId = readStringField(taskData, 'id');
    const taskChangeCallback = runtime.getTaskChangeCallback();
    if (taskId && taskChangeCallback) {
      taskChangeCallback({
        eventType: payload.eventType,
        taskId,
        projectId: state.projectId
      });
    }

    this.triggerRealtimeProjectChange(payload.eventType, state.projectId, '任务级事件触发项目增量拉取失败', runtime);
  }

  handleConnectionRealtimePayload(
    payload: RealtimePayload,
    state: RealtimeSubscribeState,
    runtime: RealtimePayloadDispatchRuntime,
  ): void {
    if (!runtime.isStateCurrent(state)) return;

    const connectionData = readRealtimePayloadRecord(payload);
    if (isForeignProjectPayload(connectionData, state.projectId)) return;

    this.logger.debug('收到连接变更', { event: payload.eventType });
    this.triggerRealtimeProjectChange(payload.eventType, state.projectId, '连接级事件触发项目增量拉取失败', runtime);
  }

  handleUserPreferencesRealtimePayload(
    payload: RealtimePayload,
    state: RealtimeSubscribeState,
    runtime: RealtimePayloadDispatchRuntime,
  ): void {
    if (!runtime.isStateCurrent(state)) return;

    this.logger.debug('收到用户偏好变更', { event: payload.eventType });
    const userPreferencesChangeCallback = runtime.getUserPreferencesChangeCallback();
    if (userPreferencesChangeCallback && !runtime.isPaused()) {
      userPreferencesChangeCallback({
        eventType: payload.eventType,
        userId: state.userId
      });
    }
  }

  private triggerRealtimeProjectChange(
    eventType: string,
    projectId: string,
    failureLog: string,
    runtime: RealtimePayloadDispatchRuntime,
  ): void {
    const remoteChangeCallback = runtime.getRemoteChangeCallback();
    if (!remoteChangeCallback || runtime.isPaused()) return;

    remoteChangeCallback({
      eventType,
      projectId
    }).catch(e => {
      this.logger.debug(failureLog, e);
    });
  }
}

function readRealtimePayloadRecord(payload: RealtimePayload): Record<string, unknown> | undefined {
  return toRecord(payload.new) ?? toRecord(payload.old);
}

function isForeignProjectPayload(record: Record<string, unknown> | undefined, projectId: string): boolean {
  const recordProjectId = readStringField(record, 'project_id');
  return recordProjectId !== undefined && recordProjectId !== projectId;
}

function readStringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === 'string' ? value : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}
