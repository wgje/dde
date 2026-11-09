import { expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';

import type { FocusSessionRecord, RoutineCompletionMutation, RoutineTask } from '../models/parking-dock';
import type { Connection, Project, Task, UserPreferences } from '../models';
import { buildLastWriteExplain } from './data-safety-package';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import { SyncRpcClientService } from './sync-rpc-client.service';
import {
  buildService,
  syncRpcEnv,
} from './sync-rpc-client.service.spec-context';

const TEST_OPERATION_ID = '00000000-0000-4000-8000-000000000101';

function buildServiceWithClientAsync(clientAsync: () => Promise<unknown>): SyncRpcClientService {
  const injector = Injector.create({
    providers: [
      { provide: SupabaseClientService, useValue: { clientAsync } },
      {
        provide: LoggerService,
        useValue: {
          category: () => ({
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          }),
        },
      },
    ],
  });
  return runInInjectionContext(injector, () => new SyncRpcClientService());
}

function createRpcProject(): Project {
  return {
    id: 'project-rpc',
    name: 'RPC project',
    description: '',
    createdDate: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:01:00.000Z',
    tasks: [],
    connections: [],
  };
}

function createRpcConnection(): Connection {
  return {
    id: 'connection-rpc',
    source: 'task-source',
    target: 'task-target',
    updatedAt: '2026-07-29T00:01:00.000Z',
  };
}

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

    let current = true;
    let resolveClient: ((client: unknown) => void) | undefined;
    const rpcAfterAcquisitionDrift = vi.fn(async () => ({
      data: { status: 'applied' },
      error: null,
    }));
    const deferredClientAsync = vi.fn(() => new Promise<unknown>(resolve => {
      resolveClient = resolve;
    }));
    const deferredService = buildServiceWithClientAsync(deferredClientAsync);
    const deferredWrite = deferredService.upsertUserPreferences({
      operationId: TEST_OPERATION_ID,
      userId: 'user-pref',
      baseUpdatedAt: null,
      preferences: { theme: 'ocean' },
      isCurrent: () => current,
    });

    expect(deferredClientAsync).toHaveBeenCalledOnce();
    current = false;
    resolveClient?.({ rpc: rpcAfterAcquisitionDrift });

    await expect(deferredWrite).resolves.toEqual({
      status: 'unauthorized',
      reason: 'replay_fence_stale',
      raw: null,
    });
    expect(rpcAfterAcquisitionDrift).not.toHaveBeenCalled();

    const rpcBeforeCallDrift = vi.fn(async () => ({
      data: { status: 'applied' },
      error: null,
    }));
    const isCurrent = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const preRpcService = buildServiceWithClientAsync(
      vi.fn(async () => ({ rpc: rpcBeforeCallDrift })),
    );

    await expect(preRpcService.upsertUserPreferences({
      operationId: TEST_OPERATION_ID,
      userId: 'user-pref',
      baseUpdatedAt: null,
      preferences: { theme: 'ocean' },
      isCurrent,
    })).resolves.toEqual({
      status: 'unauthorized',
      reason: 'replay_fence_stale',
      raw: null,
    });
    expect(isCurrent).toHaveBeenCalledTimes(3);
    expect(rpcBeforeCallDrift).not.toHaveBeenCalled();
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

  it.each([
    ['focus session', (service: SyncRpcClientService, signal: AbortSignal, isCurrent: () => boolean) =>
      (service.upsertFocusSession as unknown as (params: Record<string, unknown>) => Promise<unknown>)({
        operationId: TEST_OPERATION_ID, record: { id: 'focus-fence', userId: 'user-rpc' },
        abortSignal: signal, isCurrent,
      })],
    ['routine task', (service: SyncRpcClientService, signal: AbortSignal, isCurrent: () => boolean) =>
      (service.upsertRoutineTask as unknown as (params: Record<string, unknown>) => Promise<unknown>)({
        operationId: TEST_OPERATION_ID, userId: 'user-rpc', task: { routineId: 'routine-fence' },
        abortSignal: signal, isCurrent,
      })],
    ['routine completion', (service: SyncRpcClientService, signal: AbortSignal, isCurrent: () => boolean) =>
      (service.incrementRoutineCompletion as unknown as (params: Record<string, unknown>) => Promise<unknown>)({
        operationId: TEST_OPERATION_ID,
        mutation: { completionId: 'completion-fence', userId: 'user-rpc' },
        abortSignal: signal, isCurrent,
      })],
  ])('%s: suppresses RPC when the replay fence drifts during client acquisition', async (_label, invoke) => {
    let current = true;
    let resolveClient: ((client: unknown) => void) | undefined;
    const rpc = vi.fn(async () => ({ data: { status: 'applied' }, error: null }));
    const clientAsync = vi.fn(() => new Promise<unknown>(resolve => { resolveClient = resolve; }));
    const service = buildServiceWithClientAsync(clientAsync);

    const write = invoke(service, new AbortController().signal, () => current);
    expect(clientAsync).toHaveBeenCalledOnce();
    current = false;
    resolveClient?.({ rpc });

    await expect(write).resolves.toEqual({
      status: 'unauthorized', reason: 'replay_fence_stale', raw: null,
    });
    expect(rpc).not.toHaveBeenCalled();
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

  it.each([
    ['project upsert', (service: ReturnType<typeof buildService>, signal: AbortSignal) => service.upsertProject({
      operationId: TEST_OPERATION_ID,
      project: createRpcProject(),
      ownerId: 'user-rpc',
      baseUpdatedAt: null,
      abortSignal: signal,
    })],
    ['connection upsert', (service: ReturnType<typeof buildService>, signal: AbortSignal) => service.upsertConnection({
      operationId: TEST_OPERATION_ID,
      connection: createRpcConnection(),
      projectId: 'project-rpc',
      baseUpdatedAt: null,
      abortSignal: signal,
    })],
    ['task delete', (service: ReturnType<typeof buildService>, signal: AbortSignal) => service.deleteTasks({
      operationId: TEST_OPERATION_ID,
      projectId: 'project-rpc',
      taskIds: ['task-source'],
      baseUpdatedAt: null,
      abortSignal: signal,
    })],
    ['preference upsert', (service: ReturnType<typeof buildService>, signal: AbortSignal) => service.upsertUserPreferences({
      operationId: TEST_OPERATION_ID,
      userId: 'user-rpc',
      baseUpdatedAt: null,
      preferences: { theme: 'ocean' },
      abortSignal: signal,
    })],
    ['focus session upsert', (service: ReturnType<typeof buildService>, signal: AbortSignal) => service.upsertFocusSession({
      operationId: TEST_OPERATION_ID,
      record: { id: 'focus-rpc', userId: 'user-rpc' } as FocusSessionRecord,
      abortSignal: signal,
    })],
    ['routine task upsert', (service: ReturnType<typeof buildService>, signal: AbortSignal) => service.upsertRoutineTask({
      operationId: TEST_OPERATION_ID,
      userId: 'user-rpc',
      task: { routineId: 'routine-rpc' } as RoutineTask,
      abortSignal: signal,
    })],
    ['routine completion', (service: ReturnType<typeof buildService>, signal: AbortSignal) => service.incrementRoutineCompletion({
      operationId: TEST_OPERATION_ID,
      mutation: { completionId: 'completion-rpc', userId: 'user-rpc' } as RoutineCompletionMutation,
      abortSignal: signal,
    })],
  ])('%s: forwards AbortSignal through the RPC builder', async (_label, invoke) => {
    const response = Promise.resolve({ data: { status: 'applied' }, error: null });
    const abortSignal = vi.fn(() => response);
    Object.assign(response, { abortSignal });
    const service = buildService(vi.fn(() => response) as never);
    const controller = new AbortController();

    await expect(invoke(service, controller.signal)).resolves.toMatchObject({ status: 'applied' });
    expect(abortSignal).toHaveBeenCalledOnce();
    expect(abortSignal).toHaveBeenCalledWith(controller.signal);
  });

  it('fails closed without awaiting when a signaled RPC builder lacks abortSignal', async () => {
    const then = vi.fn();
    const service = buildService(vi.fn(() => ({ then })) as never);

    await expect(service.upsertProject({
      operationId: TEST_OPERATION_ID,
      project: createRpcProject(),
      ownerId: 'user-rpc',
      baseUpdatedAt: null,
      abortSignal: new AbortController().signal,
    })).rejects.toThrow('sync_upsert_project RPC builder does not support abortSignal');
    expect(then).not.toHaveBeenCalled();
  });

  it('keeps awaiting an RPC builder without abortSignal when no signal was requested', async () => {
    const service = buildService(vi.fn(async () => ({
      data: { status: 'applied', project_id: 'project-rpc' },
      error: null,
    })));

    await expect(service.upsertProject({
      operationId: TEST_OPERATION_ID,
      project: createRpcProject(),
      ownerId: 'user-rpc',
      baseUpdatedAt: null,
    })).resolves.toMatchObject({ status: 'applied', entityId: 'project-rpc' });
  });

  it('upsertTask: 应结构化保留服务端 forensic 字段供 last-write explain 使用', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;
    const task: Task = {
      id: '00000000-0000-4000-8000-000000000202',
      title: 'Forensic task',
      content: 'Forensic task content',
      stage: null,
      parentId: null,
      order: 0,
      rank: 100,
      status: 'active',
      x: 10,
      y: 20,
      createdDate: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:01:00.000Z',
      displayId: 'T-FORENSIC',
    };
    const rpc = vi.fn(async () => ({
      data: {
        status: 'quarantined',
        reason: 'suspicious_stage_null_transition',
        task_id: task.id,
        decision: 'quarantined',
        operation_id: TEST_OPERATION_ID,
        changed_fields: ['stage', 'parent_id', null, 42],
        quarantine_id: '00000000-0000-4000-8000-000000000303',
        audit_id: null,
        origin_unverified: true,
        payload_digest: 'payload-digest-new',
        existing_payload_digest: 'payload-digest-existing',
        replay_payload_digest: 'payload-digest-replay',
      },
      error: null,
    }));
    const service = buildService(rpc as never);

    const result = await service.upsertTask({
      operationId: TEST_OPERATION_ID,
      task,
      projectId: 'project-1',
      baseUpdatedAt: task.updatedAt ?? null,
      writeIntent: 'task_structure_update',
    });

    expect(result).toMatchObject({
      decision: 'quarantined',
      operationId: TEST_OPERATION_ID,
      changedFields: ['stage', 'parent_id'],
      quarantineId: '00000000-0000-4000-8000-000000000303',
      auditId: null,
      originUnverified: true,
      payloadDigest: 'payload-digest-new',
      existingPayloadDigest: 'payload-digest-existing',
      replayPayloadDigest: 'payload-digest-replay',
    });
    const explain = buildLastWriteExplain({
      operationId: TEST_OPERATION_ID,
      sourceUserId: 'user-1',
      entityType: 'task',
      entityId: task.id,
      operation: 'upsert',
      writeIntent: 'task_structure_update',
      localTimestamp: Date.parse('2026-07-27T00:02:00.000Z'),
      updatedAtBaseline: task.updatedAt,
      beforeVersion: task.updatedAt,
      rpcResult: result,
      enteredRetryQueue: false,
      retryCount: 0,
      lastSyncTimeBefore: null,
      lastSyncTimeAfter: null,
    });
    expect(explain.rpcResult).toMatchObject({
      operationId: TEST_OPERATION_ID,
      changedFields: ['stage', 'parent_id'],
      quarantineId: '00000000-0000-4000-8000-000000000303',
      originUnverified: true,
      payloadDigest: 'payload-digest-new',
    });
  });

  it('upsertTask: client acquisition 后 fence 失效时不得发起 RPC', async () => {
    let current = true;
    const rpc = vi.fn();
    const service = buildServiceWithClientAsync(async () => {
      current = false;
      return { rpc };
    });

    const result = await service.upsertTask({
      operationId: TEST_OPERATION_ID,
      task: createTaskForFence('task-client-fence'),
      projectId: 'project-1',
      baseUpdatedAt: null,
      isCurrent: () => current,
    });

    expect(result).toMatchObject({ status: 'unauthorized', reason: 'replay_fence_stale' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('upsertTask: RPC await 后 fence 失效时丢弃服务端结果', async () => {
    let current = true;
    const rpc = vi.fn(async () => {
      current = false;
      return { data: { status: 'applied', task_id: 'task-rpc-fence' }, error: null };
    });
    const service = buildServiceWithClientAsync(async () => ({ rpc }));

    const result = await service.upsertTask({
      operationId: TEST_OPERATION_ID,
      task: createTaskForFence('task-rpc-fence'),
      projectId: 'project-1',
      baseUpdatedAt: null,
      isCurrent: () => current,
    });

    expect(result).toMatchObject({ status: 'unauthorized', reason: 'replay_fence_stale' });
    expect(rpc).toHaveBeenCalledOnce();
  });
}

function createTaskForFence(id: string): Task {
  return {
    id, title: id, content: '', stage: null, parentId: null, order: 0, rank: 0,
    status: 'active', x: 0, y: 0, displayId: id,
    createdDate: '2026-08-03T00:00:00.000Z', updatedAt: '2026-08-03T00:00:00.000Z',
  };
}
