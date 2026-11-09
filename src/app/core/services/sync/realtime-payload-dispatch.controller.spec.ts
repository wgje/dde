import { describe, expect, it, vi } from 'vitest';
import {
  RealtimePayloadDispatchController,
  type RealtimePayloadDispatchRuntime,
  type RealtimePayload,
} from './realtime-payload-dispatch.controller';
import type { RealtimeSubscribeState } from './realtime-status.controller';

const logger = {
  debug: vi.fn(),
};

function createController(): RealtimePayloadDispatchController {
  logger.debug.mockClear();
  return new RealtimePayloadDispatchController(logger);
}

function createState(overrides: Partial<RealtimeSubscribeState> = {}): RealtimeSubscribeState {
  return {
    projectId: 'project-1',
    userId: 'user-1',
    transportGeneration: 1,
    channelName: 'project:project-1:user-1',
    channel: {} as RealtimeSubscribeState['channel'],
    previousStatus: null,
    consecutiveErrors: 0,
    ...overrides,
  };
}

function createRuntime(overrides: Partial<{
  paused: boolean;
  stateCurrent: boolean;
  remoteChangeCallback: RealtimePayloadDispatchRuntime['getRemoteChangeCallback'] extends () => infer T ? T : never;
  userPreferencesChangeCallback: RealtimePayloadDispatchRuntime['getUserPreferencesChangeCallback'] extends () => infer T ? T : never;
  taskChangeCallback: RealtimePayloadDispatchRuntime['getTaskChangeCallback'] extends () => infer T ? T : never;
}> = {}): RealtimePayloadDispatchRuntime {
  return {
    isStateCurrent: () => overrides.stateCurrent ?? true,
    isPaused: () => overrides.paused ?? false,
    getRemoteChangeCallback: () => overrides.remoteChangeCallback ?? null,
    getUserPreferencesChangeCallback: () => overrides.userPreferencesChangeCallback ?? null,
    getTaskChangeCallback: () => overrides.taskChangeCallback ?? null,
  };
}

describe('RealtimePayloadDispatchController', () => {
  it('dispatches matching task payloads to task and project callbacks', () => {
    const controller = createController();
    const remoteChangeCallback = vi.fn().mockResolvedValue(undefined);
    const taskChangeCallback = vi.fn();
    const runtime = createRuntime({ remoteChangeCallback, taskChangeCallback });

    controller.handleTaskRealtimePayload({
      eventType: 'UPDATE',
      new: { id: 'task-1', project_id: 'project-1' },
    }, createState(), runtime);

    expect(taskChangeCallback).toHaveBeenCalledWith({
      eventType: 'UPDATE',
      taskId: 'task-1',
      projectId: 'project-1',
    });
    expect(remoteChangeCallback).toHaveBeenCalledWith({
      eventType: 'UPDATE',
      projectId: 'project-1',
    });
  });

  it('ignores stale state and payloads from another project', () => {
    const controller = createController();
    const remoteChangeCallback = vi.fn().mockResolvedValue(undefined);
    const taskChangeCallback = vi.fn();

    controller.handleTaskRealtimePayload(
      { eventType: 'UPDATE', new: { id: 'task-1', project_id: 'project-1' } },
      createState(),
      createRuntime({ stateCurrent: false, remoteChangeCallback, taskChangeCallback }),
    );
    controller.handleTaskRealtimePayload(
      { eventType: 'UPDATE', new: { id: 'task-2', project_id: 'project-2' } },
      createState(),
      createRuntime({ remoteChangeCallback, taskChangeCallback }),
    );

    expect(taskChangeCallback).not.toHaveBeenCalled();
    expect(remoteChangeCallback).not.toHaveBeenCalled();
  });

  it('does not dispatch task callbacks while realtime updates are paused', () => {
    const controller = createController();
    const remoteChangeCallback = vi.fn().mockResolvedValue(undefined);
    const taskChangeCallback = vi.fn();

    controller.handleTaskRealtimePayload(
      { eventType: 'UPDATE', new: { id: 'task-1', project_id: 'project-1' } },
      createState(),
      createRuntime({ paused: true, remoteChangeCallback, taskChangeCallback }),
    );

    expect(taskChangeCallback).not.toHaveBeenCalled();
    expect(remoteChangeCallback).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith('收到任务变更', { event: 'UPDATE' });
  });

  it('logs rejected project sync callbacks for connection payloads', async () => {
    const controller = createController();
    const error = new Error('sync failed');
    const remoteChangeCallback = vi.fn().mockRejectedValue(error);

    controller.handleConnectionRealtimePayload(
      { eventType: 'INSERT', old: { project_id: 'project-1' } },
      createState(),
      createRuntime({ remoteChangeCallback }),
    );
    await Promise.resolve();

    expect(remoteChangeCallback).toHaveBeenCalledWith({
      eventType: 'INSERT',
      projectId: 'project-1',
    });
    expect(logger.debug).toHaveBeenCalledWith('连接级事件触发项目增量拉取失败', error);
  });

  it('dispatches user preference payloads only when current and unpaused', () => {
    const controller = createController();
    const userPreferencesChangeCallback = vi.fn();

    controller.handleUserPreferencesRealtimePayload(
      { eventType: 'UPDATE' },
      createState({ userId: 'user-2' }),
      createRuntime({ userPreferencesChangeCallback }),
    );
    controller.handleUserPreferencesRealtimePayload(
      { eventType: 'UPDATE' },
      createState({ userId: 'user-2' }),
      createRuntime({ paused: true, userPreferencesChangeCallback }),
    );

    expect(userPreferencesChangeCallback).toHaveBeenCalledTimes(1);
    expect(userPreferencesChangeCallback).toHaveBeenCalledWith({
      eventType: 'UPDATE',
      userId: 'user-2',
    });
  });
});
