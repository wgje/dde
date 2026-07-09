import { expect, it, vi } from 'vitest';

import type { FocusSessionRecord, RoutineCompletionMutation, RoutineTask } from '../models/parking-dock';
import type { UserPreferences } from '../models';
import {
  buildService,
  syncRpcEnv,
} from './sync-rpc-client.service.spec-context';

const TEST_OPERATION_ID = '00000000-0000-4000-8000-000000000101';

export function registerSyncRpcClientMutationRpcSpecs(): void {
  it('upsertUserPreferences: 通过 operationId 序列化用户偏好幂等写入', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 5;
    env.deploymentEpoch = 13;
    env.deploymentTarget = 'cloudflare-pages';
    env.sentryRelease = 'sha-pref';
    env.canonicalOrigin = 'https://nanoflow.pages.dev';

    let rpcName = '';
    let captured: unknown = null;
    const rpc = vi.fn(async (name, payload) => {
      rpcName = name;
      captured = payload;
      return {
        data: {
          status: 'applied',
          user_id: 'user-pref',
          updated_at: '2026-06-15T00:00:00.000Z',
        },
        error: null,
      };
    });

    const service = buildService(rpc as never);
    const result = await service.upsertUserPreferences({
      operationId: TEST_OPERATION_ID,
      userId: 'user-pref',
      baseUpdatedAt: '2026-06-15T00:00:00.000Z',
      preferences: {
        theme: 'ocean',
        colorMode: 'dark',
        autoResolveConflicts: false,
        focusPreferences: {
          gateEnabled: true,
          strataEnabled: true,
          blackBoxEnabled: false,
          maxSnoozePerDay: 2,
          routineResetHourLocal: 4,
          restReminderHighLoadMinutes: 90,
          restReminderLowLoadMinutes: 15,
          updatedAt: '2026-06-15T00:00:00.000Z',
        },
      } as Partial<UserPreferences>,
    });

    expect(rpcName).toBe('sync_upsert_user_preferences');
    expect(result.status).toBe('applied');
    expect(result.entityId).toBe('user-pref');
    expect(result.serverUpdatedAt).toBe('2026-06-15T00:00:00.000Z');
    expect(captured).toMatchObject({
      operation_id: TEST_OPERATION_ID,
      protocol_version: 5,
      base_updated_at: '2026-06-15T00:00:00.000Z',
      user_id: 'user-pref',
      client_git_sha: 'sha-pref',
      client_origin: 'https://nanoflow.pages.dev',
      deployment_epoch: 13,
      deployment_target: 'cloudflare-pages',
      preferences: {
        theme: 'ocean',
        color_mode: 'dark',
        auto_resolve_conflicts: false,
        focus_preferences: expect.objectContaining({
          blackBoxEnabled: false,
          updatedAt: '2026-06-15T00:00:00.000Z',
        }),
      },
    });
  });

  it('upsertFocusSession: 通过 operationId 序列化专注会话幂等写入', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 5;
    env.deploymentEpoch = 13;
    env.deploymentTarget = 'cloudflare-pages';
    env.sentryRelease = 'sha-focus';
    env.canonicalOrigin = 'https://nanoflow.pages.dev';

    let rpcName = '';
    let captured: unknown = null;
    const rpc = vi.fn(async (name, payload) => {
      rpcName = name;
      captured = payload;
      return {
        data: {
          status: 'applied',
          focus_session_id: 'session-focus',
          updated_at: '2026-06-15T00:00:01.000Z',
        },
        error: null,
      };
    });

    const service = buildService(rpc as never);
    const result = await service.upsertFocusSession({
      operationId: TEST_OPERATION_ID,
      record: {
        id: 'session-focus',
        userId: 'user-focus',
        startedAt: '2026-06-15T00:00:00.000Z',
        endedAt: null,
        updatedAt: '2026-06-15T00:00:01.000Z',
        snapshot: {
          version: 6,
          savedAt: '2026-06-15T00:00:01.000Z',
        },
      } as unknown as FocusSessionRecord,
    });

    expect(rpcName).toBe('sync_upsert_focus_session');
    expect(result.status).toBe('applied');
    expect(result.entityId).toBe('session-focus');
    expect(result.serverUpdatedAt).toBe('2026-06-15T00:00:01.000Z');
    expect(captured).toMatchObject({
      operation_id: TEST_OPERATION_ID,
      protocol_version: 5,
      client_git_sha: 'sha-focus',
      client_origin: 'https://nanoflow.pages.dev',
      deployment_epoch: 13,
      deployment_target: 'cloudflare-pages',
      focus_session: {
        id: 'session-focus',
        user_id: 'user-focus',
        started_at: '2026-06-15T00:00:00.000Z',
        ended_at: null,
        updated_at: '2026-06-15T00:00:01.000Z',
        session_state: expect.objectContaining({
          version: 6,
          savedAt: '2026-06-15T00:00:01.000Z',
        }),
      },
    });
  });

  it('upsertRoutineTask: 通过 operationId 序列化日常任务幂等写入', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 5;
    env.deploymentEpoch = 13;
    env.deploymentTarget = 'cloudflare-pages';
    env.sentryRelease = 'sha-routine';
    env.canonicalOrigin = 'https://nanoflow.pages.dev';

    let rpcName = '';
    let captured: unknown = null;
    const rpc = vi.fn(async (name, payload) => {
      rpcName = name;
      captured = payload;
      return {
        data: {
          status: 'applied',
          routine_task_id: 'routine-1',
          updated_at: '2026-06-15T00:00:02.000Z',
        },
        error: null,
      };
    });

    const service = buildService(rpc as never);
    const result = await service.upsertRoutineTask({
      operationId: TEST_OPERATION_ID,
      userId: 'user-routine',
      task: {
        routineId: 'routine-1',
        title: 'Standup',
        triggerCondition: 'any-blank-period',
        maxTimesPerDay: 2,
        isEnabled: true,
        updatedAt: '2026-06-15T00:00:02.000Z',
      } satisfies RoutineTask,
    });

    expect(rpcName).toBe('sync_upsert_routine_task');
    expect(result.status).toBe('applied');
    expect(result.entityId).toBe('routine-1');
    expect(result.serverUpdatedAt).toBe('2026-06-15T00:00:02.000Z');
    expect(captured).toMatchObject({
      operation_id: TEST_OPERATION_ID,
      protocol_version: 5,
      user_id: 'user-routine',
      client_git_sha: 'sha-routine',
      client_origin: 'https://nanoflow.pages.dev',
      deployment_epoch: 13,
      deployment_target: 'cloudflare-pages',
      routine_task: {
        id: 'routine-1',
        title: 'Standup',
        max_times_per_day: 2,
        is_enabled: true,
        updated_at: '2026-06-15T00:00:02.000Z',
      },
    });
  });

  it('incrementRoutineCompletion: 通过 operationId 序列化日常完成计数幂等写入', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 5;
    env.deploymentEpoch = 13;
    env.deploymentTarget = 'cloudflare-pages';
    env.sentryRelease = 'sha-routine-completion';
    env.canonicalOrigin = 'https://nanoflow.pages.dev';

    let rpcName = '';
    let captured: unknown = null;
    const rpc = vi.fn(async (name, payload) => {
      rpcName = name;
      captured = payload;
      return {
        data: {
          status: 'applied',
          routine_completion_id: 'completion-1',
          updated_at: '2026-06-15T00:00:03.000Z',
        },
        error: null,
      };
    });

    const service = buildService(rpc as never);
    const result = await service.incrementRoutineCompletion({
      operationId: TEST_OPERATION_ID,
      mutation: {
        completionId: 'completion-1',
        userId: 'user-routine',
        routineId: 'routine-1',
        dateKey: '2026-06-15',
      } satisfies RoutineCompletionMutation,
    });

    expect(rpcName).toBe('sync_increment_routine_completion');
    expect(result.status).toBe('applied');
    expect(result.entityId).toBe('completion-1');
    expect(result.serverUpdatedAt).toBe('2026-06-15T00:00:03.000Z');
    expect(captured).toMatchObject({
      operation_id: TEST_OPERATION_ID,
      protocol_version: 5,
      user_id: 'user-routine',
      routine_completion: {
        id: 'completion-1',
        routine_id: 'routine-1',
        date_key: '2026-06-15',
      },
      client_git_sha: 'sha-routine-completion',
      client_origin: 'https://nanoflow.pages.dev',
      deployment_epoch: 13,
      deployment_target: 'cloudflare-pages',
    });
  });

  it('deleteProject: 发出受 protocol/epoch 保护的删除 RPC', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;

    let rpcName = '';
    let captured: unknown = null;
    const rpc = vi.fn(async (name, payload) => {
      rpcName = name;
      captured = payload;
      return {
        data: {
          status: 'applied',
          project_id: 'project-delete',
          updated_at: '2026-04-30T03:00:00.000Z',
        },
        error: null,
      };
    });

    const service = buildService(rpc as never);
    const result = await service.deleteProject({
      operationId: TEST_OPERATION_ID,
      projectId: 'project-delete',
      baseUpdatedAt: null,
    });

    expect(rpcName).toBe('sync_delete_project');
    expect(result.entityId).toBe('project-delete');
    expect((captured as Record<string, unknown>)['project_id']).toBe('project-delete');
  });

  it('deleteTasks: 解析批量删除数量与附件路径', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;

    let rpcName = '';
    const rpc = vi.fn(async (name) => {
      rpcName = name;
      return {
        data: {
          status: 'applied',
          project_id: 'project-1',
          deleted_count: 2,
          attachment_paths: ['u/p/t/a.png'],
          updated_at: '2026-04-30T04:00:00.000Z',
        },
        error: null,
      };
    });

    const service = buildService(rpc as never);
    const result = await service.deleteTasks({
      operationId: TEST_OPERATION_ID,
      projectId: 'project-1',
      taskIds: ['task-1', 'task-2'],
      baseUpdatedAt: null,
    });

    expect(rpcName).toBe('sync_delete_tasks');
    expect(result.status).toBe('applied');
    expect(result.affectedCount).toBe(2);
    expect(result.attachmentPaths).toEqual(['u/p/t/a.png']);
  });

  it('deleteTasks: 携带 baseUpdatedAtMap 时应灌入 payload 并解析 skipped_ids 供调用方重排队', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;

    let capturedPayload: Record<string, unknown> | null = null;
    const rpc = vi.fn(async (_name, payload) => {
      capturedPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
      return {
        data: {
          status: 'applied',
          project_id: 'project-1',
          deleted_count: 1,
          attachment_paths: [],
          skipped_ids: ['task-2'],
          updated_at: '2026-05-15T10:00:00.000Z',
        },
        error: null,
      };
    });

    const service = buildService(rpc as never);
    const result = await service.deleteTasks({
      operationId: TEST_OPERATION_ID,
      projectId: 'project-1',
      taskIds: ['task-1', 'task-2'],
      baseUpdatedAt: null,
      deleteMode: 'soft',
      baseUpdatedAtMap: {
        'task-1': '2026-05-15T09:00:00.000Z',
        'task-2': '2026-05-15T09:30:00.000Z',
      },
    });

    expect(capturedPayload).not.toBeNull();
    if (!capturedPayload) {
      throw new Error('Expected deleteTasks RPC payload to be captured');
    }
    expect(capturedPayload['base_updated_at_map']).toEqual({
      'task-1': '2026-05-15T09:00:00.000Z',
      'task-2': '2026-05-15T09:30:00.000Z',
    });
    expect(result.status).toBe('applied');
    expect(result.skippedIds).toEqual(['task-2']);
  });

  it('deleteTasks: baseUpdatedAtMap 中 null 基线应显式上送供服务端跳过删除', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;

    let capturedPayload: Record<string, unknown> | null = null;
    const rpc = vi.fn(async (_name, payload) => {
      capturedPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
      return {
        data: { status: 'applied', deleted_count: 0, attachment_paths: [] },
        error: null,
      };
    });

    const service = buildService(rpc as never);
    await service.deleteTasks({
      operationId: TEST_OPERATION_ID,
      projectId: 'project-1',
      taskIds: ['task-1'],
      baseUpdatedAt: null,
      baseUpdatedAtMap: { 'task-1': null, 'task-other': '2026-05-15T09:00:00.000Z' },
    });

    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload!['base_updated_at_map']).toEqual({ 'task-1': null });
  });
}
