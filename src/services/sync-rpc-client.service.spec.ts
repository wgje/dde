import { describe, expect, it, vi } from 'vitest';

import type { Task, Connection, BlackBoxEntry, Project } from '../models';
import {
  buildService,
  installSyncRpcClientSpecEnv,
  mockLoggerCategory,
  syncRpcEnv,
} from './sync-rpc-client.service.spec-context';
import { registerSyncRpcClientMutationRpcSpecs } from './sync-rpc-client-mutation-rpc.spec-helpers';

const TEST_OPERATION_ID = '00000000-0000-4000-8000-000000000001';

describe('SyncRpcClientService', () => {
  installSyncRpcClientSpecEnv();

  it('checkProtocol 在 feature 关闭但服务端支持时应自动开启 RPC', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = false;

    const rpc = vi.fn(async () => ({ data: { minProtocolVersion: 1 }, error: null }));
    const service = buildService(rpc as never);
    const result = await service.checkProtocol();
    expect(result).toEqual({ minProtocolVersion: 1, deploymentEpoch: 0 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(service.isFeatureEnabled()).toBe(true);
  });

  it('checkProtocol 在 feature 关闭且探测失败时保持关闭', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = false;

    const rpc = vi.fn(async () => ({ data: null, error: { message: 'pgrst-404' } }));
    const service = buildService(rpc as never);
    const result = await service.checkProtocol();
    expect(result).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(service.isFeatureEnabled()).toBe(false);
  });

  it('checkProtocol 在 deploymentEpoch 落后时不应自动开启 RPC', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = false;
    env.syncProtocolVersion = 1;
    env.deploymentEpoch = 0;

    const rpc = vi.fn(async () => ({ data: { minProtocolVersion: 1, deploymentEpoch: 3 }, error: null }));
    const service = buildService(rpc as never);
    const result = await service.checkProtocol();

    expect(result).toEqual({ minProtocolVersion: 1, deploymentEpoch: 3 });
    expect(service.isFeatureEnabled()).toBe(false);
    expect(service.isClientRejected()).toBe(true);
  });

  it('checkProtocol 对失败探测结果应做缓存，避免重复阻塞写入路径', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = false;

    const rpc = vi.fn(async () => ({ data: null, error: { message: 'pgrst-404' } }));
    const service = buildService(rpc as never);

    await expect(service.checkProtocol()).resolves.toBeNull();
    await expect(service.checkProtocol()).resolves.toBeNull();

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('checkProtocol 瞬时网络失败不得缓存整个会话，冷却窗过后应重新探测并自动开启', async () => {
    // P0 回归：捕获门户/断流下一次探针失败被缓存 null 后整个会话不再重探，
    // task 写入路径永远 blocked-by-sync-rpc。瞬时失败只允许短冷却，之后必须重探。
    vi.useFakeTimers();
    try {
      const env = syncRpcEnv();
      env.syncRpcEnabled = false;

      let attempts = 0;
      const rpc = vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new TypeError('Failed to fetch');
        }
        return { data: { minProtocolVersion: 1 }, error: null };
      });
      const service = buildService(rpc as never);

      await expect(service.checkProtocol()).resolves.toBeNull();
      // 冷却窗内不重复探测（保护写入路径不被每写一探拖慢）
      await expect(service.checkProtocol()).resolves.toBeNull();
      expect(rpc).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_001);

      await expect(service.checkProtocol()).resolves.toEqual({ minProtocolVersion: 1, deploymentEpoch: 0 });
      expect(rpc).toHaveBeenCalledTimes(2);
      expect(service.isFeatureEnabled()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkProtocol 对函数缺失类确定性失败应整会话缓存，冷却窗过后也不重探', async () => {
    vi.useFakeTimers();
    try {
      const env = syncRpcEnv();
      env.syncRpcEnabled = false;

      const rpc = vi.fn(async () => ({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function sync_check_protocol' },
      }));
      const service = buildService(rpc as never);

      await expect(service.checkProtocol()).resolves.toBeNull();
      vi.advanceTimersByTime(120_000);
      await expect(service.checkProtocol()).resolves.toBeNull();

      expect(rpc).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkProtocol 解析 minProtocolVersion + deploymentEpoch', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const rpc = vi.fn(async () => ({ data: { minProtocolVersion: 2, deploymentEpoch: 7 }, error: null }));
    const service = buildService(rpc as never);
    const result = await service.checkProtocol();
    expect(result).toEqual({ minProtocolVersion: 2, deploymentEpoch: 7 });
    expect(service.isClientRejected()).toBe(true);
  });

  it('checkProtocol RPC 错误返回 null（向后兼容）', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;

    const rpc = vi.fn(async () => ({ data: null, error: { message: 'pgrst-503' } }));
    const service = buildService(rpc as never);
    const result = await service.checkProtocol();
    expect(result).toBeNull();
    expect(mockLoggerCategory.warn).toHaveBeenCalled();
  });

  it('upsertTask: applied 状态解析 entityId / status', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const rpc = vi.fn(async (_name, _payload) => ({
      data: { status: 'applied', operation_id: TEST_OPERATION_ID, task_id: 'task-9', updated_at: '2026-04-30T00:00:01.000Z' },
      error: null,
    }));

    const service = buildService(rpc as never);
    const result = await service.upsertTask({
      operationId: TEST_OPERATION_ID,
      task: { id: 'task-9', projectId: 'p-1', content: 'hi' } as unknown as Task,
      baseUpdatedAt: null,
    });

    expect(result.status).toBe('applied');
    expect(result.entityId).toBe('task-9');
    expect(result.serverUpdatedAt).toBe('2026-04-30T00:00:01.000Z');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('upsertTask: throttle abort 信号应透传到 Supabase RPC builder，超时可终止幽灵写入', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const abortSignalSpy = vi.fn();
    const rpcBuilder = {
      abortSignal(signal: AbortSignal) {
        abortSignalSpy(signal);
        return rpcBuilder;
      },
      then(resolve: (value: { data: unknown; error: null }) => unknown) {
        return Promise.resolve({
          data: { status: 'applied', task_id: 'task-abort' },
          error: null,
        }).then(resolve);
      },
    };
    const rpc = vi.fn(() => rpcBuilder);
    const service = buildService(rpc as never);

    const controller = new AbortController();
    const result = await service.upsertTask({
      operationId: TEST_OPERATION_ID,
      task: { id: 'task-abort', projectId: 'p-1', content: 'hi' } as unknown as Task,
      baseUpdatedAt: null,
      abortSignal: controller.signal,
    });

    expect(abortSignalSpy).toHaveBeenCalledTimes(1);
    expect(abortSignalSpy).toHaveBeenCalledWith(controller.signal);
    expect(result.status).toBe('applied');
    expect(result.entityId).toBe('task-abort');
  });

  it('upsertTask: 未传 abort 信号时不得调用 builder.abortSignal，兼容旧调用方', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const abortSignalSpy = vi.fn();
    const rpcBuilder = {
      abortSignal(signal: AbortSignal) {
        abortSignalSpy(signal);
        return rpcBuilder;
      },
      then(resolve: (value: { data: unknown; error: null }) => unknown) {
        return Promise.resolve({
          data: { status: 'applied', task_id: 'task-no-abort' },
          error: null,
        }).then(resolve);
      },
    };
    const rpc = vi.fn(() => rpcBuilder);
    const service = buildService(rpc as never);

    const result = await service.upsertTask({
      operationId: TEST_OPERATION_ID,
      task: { id: 'task-no-abort', projectId: 'p-1', content: 'hi' } as unknown as Task,
      baseUpdatedAt: null,
    });

    expect(abortSignalSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('applied');
  });

  it('upsertTask: operationId 非 UUID 时应在本地拒绝且不能触达 Supabase RPC', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;

    const rpc = vi.fn(async () => ({ data: { status: 'applied', task_id: 'task-9' }, error: null }));
    const service = buildService(rpc as never);

    await expect(service.upsertTask({
      operationId: 'not-a-uuid',
      task: { id: 'task-9', projectId: 'p-1', content: 'hi' } as unknown as Task,
      baseUpdatedAt: null,
    })).rejects.toThrow('Invalid sync operationId');

    expect(rpc).not.toHaveBeenCalled();
  });

  it('upsertBlackboxEntry: 应解析服务端 stale_payload 标记', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const rpc = vi.fn(async () => ({
      data: {
        status: 'applied',
        entry_id: 'entry-9',
        updated_at: '2026-05-16T00:00:01.000Z',
        stale_payload: true,
      },
      error: null,
    }));

    const service = buildService(rpc as never);
    const result = await service.upsertBlackboxEntry({
      operationId: TEST_OPERATION_ID,
      entry: { id: 'entry-9', projectId: null, content: 'hi' } as unknown as BlackBoxEntry,
      baseUpdatedAt: '2026-05-16T00:00:00.000Z',
    });

    expect(result.status).toBe('applied');
    expect(result.entityId).toBe('entry-9');
    expect(result.serverUpdatedAt).toBe('2026-05-16T00:00:01.000Z');
    expect(result.stalePayload).toBe(true);
  });

  it('upsertTask: 序列化完整同步字段供 batch_upsert_tasks 使用', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 4;
    env.deploymentEpoch = 12;
    env.deploymentTarget = 'cloudflare-pages';
    env.sentryRelease = 'git-sha';
    env.canonicalOrigin = 'https://nanoflow.pages.dev';

    let captured: unknown = null;
    const rpc = vi.fn(async (_name, payload) => {
      captured = payload;
      return { data: { status: 'applied', task_id: 'task-full' }, error: null };
    });

    const service = buildService(rpc as never);
    await service.upsertTask({
      operationId: TEST_OPERATION_ID,
      task: {
        id: 'task-full',
        projectId: 'project-1',
        title: 'Full title',
        content: 'Full content',
        stage: 2,
        parentId: 'parent-1',
        order: 3,
        rank: 4000,
        status: 'completed',
        x: 10,
        y: 20,
        shortId: 'S-1',
        priority: 'high',
        dueDate: '2026-05-01',
        expected_minutes: 25,
        cognitive_load: 'high',
        wait_minutes: 5,
        tags: ['sync'],
        completedAt: '2026-04-30T01:00:00.000Z',
        updatedAt: '2026-04-30T00:05:00.000Z',
        deletedAt: null,
        attachments: [{ id: 'att-1' }],
        parkingMeta: { state: 'parked' },
        attentionMeta: {
          items: [
            {
              id: 'attention-1',
              text: 'RPC 需保留僚机字段',
              level: 'warning',
              done: false,
              createdAt: '2026-06-05T00:00:00.000Z',
              updatedAt: '2026-06-05T00:00:00.000Z',
            },
          ],
          pinned: false,
          updatedAt: '2026-06-05T00:00:00.000Z',
        },
      } as unknown as Task,
      baseUpdatedAt: '2026-04-30T00:00:00.000Z',
    });

    const cap = captured as { task: Record<string, unknown> };
    expect(cap).toMatchObject({
      operation_id: TEST_OPERATION_ID,
      protocol_version: 4,
      base_updated_at: '2026-04-30T00:00:00.000Z',
      client_git_sha: 'git-sha',
      client_origin: 'https://nanoflow.pages.dev',
      deployment_epoch: 12,
      deployment_target: 'cloudflare-pages',
    });
    expect(cap.task).toMatchObject({
      id: 'task-full',
      project_id: 'project-1',
      title: 'Full title',
      content: 'Full content',
      stage: 2,
      parent_id: 'parent-1',
      order: 3,
      rank: 4000,
      status: 'completed',
      x: 10,
      y: 20,
      short_id: 'S-1',
      priority: 'high',
      due_date: '2026-05-01',
      expected_minutes: 25,
      cognitive_load: 'high',
      wait_minutes: 5,
      tags: ['sync'],
      completed_at: '2026-04-30T01:00:00.000Z',
      updated_at: '2026-04-30T00:05:00.000Z',
      deleted_at: null,
      attachments: [{ id: 'att-1' }],
      parking_meta: { state: 'parked' },
      attention_meta: {
        items: [
          {
            id: 'attention-1',
            text: 'RPC 需保留僚机字段',
            level: 'warning',
            done: false,
            createdAt: '2026-06-05T00:00:00.000Z',
            updatedAt: '2026-06-05T00:00:00.000Z',
          },
        ],
        pinned: false,
        updatedAt: '2026-06-05T00:00:00.000Z',
      },
      attentionMeta: {
        items: [
          {
            id: 'attention-1',
            text: 'RPC 需保留僚机字段',
            level: 'warning',
            done: false,
            createdAt: '2026-06-05T00:00:00.000Z',
            updatedAt: '2026-06-05T00:00:00.000Z',
          },
        ],
        pinned: false,
        updatedAt: '2026-06-05T00:00:00.000Z',
      },
    });
  });

  it('upsertTask: 序列化写入意图，避免部分更新覆盖附件等旁路字段', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;

    let captured: unknown = null;
    const rpc = vi.fn(async (_name, payload) => {
      captured = payload;
      return { data: { status: 'applied', task_id: 'task-intent' }, error: null };
    });

    const service = buildService(rpc as never);
    await service.upsertTask({
      operationId: TEST_OPERATION_ID,
      task: {
        id: 'task-intent',
        projectId: 'project-1',
        title: 'Title changed',
        content: 'Content changed',
        updatedAt: '2026-06-09T00:00:00.000Z',
        attachments: [{ id: 'local-old-att' }],
      } as unknown as Task,
      baseUpdatedAt: '2026-06-08T00:00:00.000Z',
      writeIntent: 'task_text_update',
    });

    const cap = captured as { task: Record<string, unknown> };
    expect(cap.task['write_intent']).toBe('task_text_update');
    expect(cap.task['writeIntent']).toBe('task_text_update');
  });

  it('upsertTask: remote-newer 状态解析 remoteUpdatedAt', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const rpc = vi.fn(async () => ({
      data: { status: 'remote-newer', remote_updated_at: '2026-04-29T01:00:00Z' },
      error: null,
    }));

    const service = buildService(rpc as never);
    const result = await service.upsertTask({
      operationId: TEST_OPERATION_ID,
      task: { id: 'task-9', projectId: 'p-1', content: 'hi' } as unknown as Task,
      baseUpdatedAt: '2026-04-28T20:00:00Z',
    });

    expect(result.status).toBe('remote-newer');
    expect(result.remoteUpdatedAt).toBe('2026-04-29T01:00:00Z');
  });

  it('upsertTask: client-version-rejected 状态解析 minProtocolVersion', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const rpc = vi.fn(async () => ({
      data: { status: 'client-version-rejected', minProtocolVersion: 3 },
      error: null,
    }));

    const service = buildService(rpc as never);
    const result = await service.upsertTask({
      operationId: TEST_OPERATION_ID,
      task: { id: 'task-9', projectId: 'p-1', content: 'hi' } as unknown as Task,
      baseUpdatedAt: null,
    });

    expect(result.status).toBe('client-version-rejected');
    expect(result.minProtocolVersion).toBe(3);
  });

  it('upsertTask: quarantined 状态应按服务端合法状态解析', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const rpc = vi.fn(async () => ({
      data: { status: 'quarantined', reason: 'sync_quarantine' },
      error: null,
    }));

    const service = buildService(rpc as never);
    const result = await service.upsertTask({
      operationId: TEST_OPERATION_ID,
      task: { id: 'task-quarantine', projectId: 'p-1', content: 'hi' } as unknown as Task,
      baseUpdatedAt: '2026-06-01T00:00:00.000Z',
    });

    expect(result.status).toBe('quarantined');
    expect(result.reason).toBe('sync_quarantine');
  });

  it('upsertConnection: 序列化 source_id/target_id（兼容标准 source/target 与 from/to 别名）', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;

    let captured: unknown = null;
    const rpc = vi.fn(async (_name, payload) => {
      captured = payload;
      return { data: { status: 'applied', connection_id: 'c-1' }, error: null };
    });

    const service = buildService(rpc as never);
    await service.upsertConnection({
      operationId: TEST_OPERATION_ID,
      connection: {
        id: 'c-1',
        source: 't-1',
        target: 't-2',
        title: 'Link',
        description: 'Link detail',
        updatedAt: '2026-04-30T02:00:00.000Z',
        deletedAt: null,
        projectId: 'p-1',
      } as unknown as Connection,
      baseUpdatedAt: null,
    });

    const cap = captured as { connection: Record<string, unknown> };
    expect(cap.connection.source_id).toBe('t-1');
    expect(cap.connection.target_id).toBe('t-2');
    expect(cap.connection.title).toBe('Link');
    expect(cap.connection.description).toBe('Link detail');
    expect(cap.connection.updated_at).toBe('2026-04-30T02:00:00.000Z');
    expect(cap.connection.deleted_at).toBeNull();
  });

  it('upsertBlackboxEntry: 序列化完整黑匣子同步字段', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;

    let captured: unknown = null;
    const rpc = vi.fn(async (_name, payload) => {
      captured = payload;
      return { data: { status: 'applied', entry_id: 'b-1' }, error: null };
    });

    const service = buildService(rpc as never);
    await service.upsertBlackboxEntry({
      operationId: TEST_OPERATION_ID,
      entry: {
        id: 'b-1',
        projectId: 'project-1',
        userId: 'user-1',
        content: 'hello',
        date: '2026-04-29',
        createdAt: '2026-04-29T00:00:00Z',
        updatedAt: '2026-04-29T00:01:00Z',
        completedAt: '2026-06-03T09:15:00Z',
        isRead: true,
        isCompleted: true,
        isArchived: false,
        snoozeUntil: '2026-04-30',
        snoozeCount: 1,
        deletedAt: null,
        focusMeta: { source: 'focus-console-inline' },
      } as unknown as BlackBoxEntry,
      baseUpdatedAt: null,
    });

    const cap = captured as { entry: Record<string, unknown> };
    expect(cap.entry.content).toBe('hello');
    expect(cap.entry.created_at).toBe('2026-04-29T00:00:00Z');
    expect(cap.entry.project_id).toBe('project-1');
    expect(cap.entry.user_id).toBe('user-1');
    expect(cap.entry.date).toBe('2026-04-29');
    expect(cap.entry.updated_at).toBe('2026-04-29T00:01:00Z');
    expect(cap.entry.completed_at).toBe('2026-06-03T09:15:00Z');
    expect(cap.entry.is_read).toBe(true);
    expect(cap.entry.is_completed).toBe(true);
    expect(cap.entry.is_archived).toBe(false);
    expect(cap.entry.snooze_until).toBe('2026-04-30');
    expect(cap.entry.snooze_count).toBe(1);
    expect(cap.entry.focus_meta).toEqual({ source: 'focus-console-inline' });
  });

  it('upsertBlackboxEntry: 拒绝缺失 content 的黑匣子 payload，不能序列化为空字符串', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;

    const rpc = vi.fn(async () => ({ data: { status: 'applied', entry_id: 'b-1' }, error: null }));
    const service = buildService(rpc as never);

    await expect(service.upsertBlackboxEntry({
      operationId: TEST_OPERATION_ID,
      entry: {
        id: 'b-1',
        projectId: null,
        userId: 'user-1',
        content: undefined,
        date: '2026-04-29',
        createdAt: '2026-04-29T00:00:00Z',
        updatedAt: '2026-04-29T00:01:00Z',
        isRead: false,
        isCompleted: false,
        isArchived: false,
        deletedAt: null,
        focusMeta: null,
      } as unknown as BlackBoxEntry,
      baseUpdatedAt: null,
    })).rejects.toThrow('BlackBox entry content is missing');

    expect(rpc).not.toHaveBeenCalled();
  });

  it('upsertProject: 序列化项目元数据和部署审计字段', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 5;
    env.deploymentEpoch = 13;
    env.deploymentTarget = 'cloudflare-pages';
    env.sentryRelease = 'sha-project';
    env.canonicalOrigin = 'https://nanoflow.pages.dev';

    let captured: unknown = null;
    const rpc = vi.fn(async (_name, payload) => {
      captured = payload;
      return { data: { status: 'applied', project_id: 'project-rpc', updated_at: '2026-04-30T02:00:00.000Z' }, error: null };
    });

    const service = buildService(rpc as never);
    const result = await service.upsertProject({
      operationId: TEST_OPERATION_ID,
      project: {
        id: 'project-rpc',
        name: 'RPC Project',
        description: 'Project metadata',
        version: 7,
        updatedAt: '2026-04-30T01:30:00.000Z',
        deletedAt: null,
      } as unknown as Project,
      ownerId: 'user-1',
      baseUpdatedAt: '2026-04-30T01:00:00.000Z',
    });

    expect(result.status).toBe('applied');
    expect(result.entityId).toBe('project-rpc');
    const cap = captured as { project: Record<string, unknown> };
    expect(cap).toMatchObject({
      operation_id: TEST_OPERATION_ID,
      protocol_version: 5,
      base_updated_at: '2026-04-30T01:00:00.000Z',
      client_git_sha: 'sha-project',
      client_origin: 'https://nanoflow.pages.dev',
      deployment_epoch: 13,
      deployment_target: 'cloudflare-pages',
    });
    expect(cap.project).toMatchObject({
      id: 'project-rpc',
      owner_id: 'user-1',
      title: 'RPC Project',
      description: 'Project metadata',
      version: 7,
      migrated_to_v2: true,
      updated_at: '2026-04-30T01:30:00.000Z',
      deleted_at: null,
    });
  });

  registerSyncRpcClientMutationRpcSpecs();

  it('deleted-remote-newer 状态按服务端 tombstone 冲突解析', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;

    const rpc = vi.fn(async () => ({
      data: {
        status: 'deleted-remote-newer',
        remote_updated_at: '2026-04-30T05:00:00.000Z',
        reason: 'remote_tombstone_newer',
      },
      error: null,
    }));

    const service = buildService(rpc as never);
    const result = await service.upsertTask({
      operationId: TEST_OPERATION_ID,
      task: { id: 'task-9', projectId: 'p-1', content: 'hi' } as unknown as Task,
      baseUpdatedAt: '2026-04-30T04:00:00.000Z',
    });

    expect(result.status).toBe('deleted-remote-newer');
    expect(result.remoteUpdatedAt).toBe('2026-04-30T05:00:00.000Z');
  });

  it('deleteProject: tombstoned 状态应保留为服务端合法删除结果', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;

    const rpc = vi.fn(async () => ({
      data: {
        status: 'tombstoned',
        project_id: 'project-tombstoned',
        deleted_count: 1,
        reason: 'already_tombstoned',
      },
      error: null,
    }));

    const service = buildService(rpc as never);
    const result = await service.deleteProject({
      operationId: TEST_OPERATION_ID,
      projectId: 'project-tombstoned',
      baseUpdatedAt: '2026-06-01T00:00:00.000Z',
    });

    expect(result.status).toBe('tombstoned');
    expect(result.entityId).toBe('project-tombstoned');
    expect(result.affectedCount).toBe(1);
    expect(result.reason).toBe('already_tombstoned');
  });

  it('upsert RPC 网络错误时向上抛（调用方走 RetryQueue 路径）', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;

    const rpc = vi.fn(async () => ({ data: null, error: { message: 'network down' } }));
    const service = buildService(rpc as never);

    await expect(
      service.upsertTask({
        operationId: TEST_OPERATION_ID,
        task: { id: 't', projectId: 'p', content: 'x' } as unknown as Task,
        baseUpdatedAt: null,
      })
    ).rejects.toMatchObject({ message: 'network down' });
  });

  it('isClientRejected: 服务端 minProtocolVersion <= 客户端时 false', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 5;

    const rpc = vi.fn(async () => ({ data: { minProtocolVersion: 2, deploymentEpoch: 0 }, error: null }));
    const service = buildService(rpc as never);
    await service.checkProtocol();
    expect(service.isClientRejected()).toBe(false);
  });

  it('未知 status 默认归类为 unauthorized', async () => {
    const env = syncRpcEnv();
    env.syncRpcEnabled = true;

    const rpc = vi.fn(async () => ({ data: { status: 'totally-bogus' }, error: null }));
    const service = buildService(rpc as never);
    const result = await service.upsertTask({
      operationId: TEST_OPERATION_ID,
      task: { id: 't', projectId: 'p', content: 'x' } as unknown as Task,
      baseUpdatedAt: null,
    });
    expect(result.status).toBe('unauthorized');
  });
});
