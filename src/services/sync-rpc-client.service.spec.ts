import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';

import { SyncRpcClientService } from './sync-rpc-client.service';
import { SupabaseClientService } from './supabase-client.service';
import { LoggerService } from './logger.service';
import { environment } from '../environments/environment';
import type { Task, Connection, BlackBoxEntry } from '../models';

const mockLoggerCategory = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockLogger = {
  category: () => mockLoggerCategory,
} as unknown as LoggerService;

interface MutableEnv {
  syncRpcEnabled?: boolean;
  syncProtocolVersion?: number;
  sentryRelease?: string;
  canonicalOrigin?: string;
}

function buildService(rpcImpl: (name: string, payload: unknown) => Promise<{ data: unknown; error: { message: string } | null }>): SyncRpcClientService {
  const mockSupabase = {
    clientAsync: vi.fn(async () => ({
      rpc: vi.fn(async (name: string, args: { payload: unknown }) => rpcImpl(name, args?.payload)),
    })),
  } as unknown as SupabaseClientService;

  const injector = Injector.create({
    providers: [
      { provide: SupabaseClientService, useValue: mockSupabase },
      { provide: LoggerService, useValue: mockLogger },
    ],
  });
  return runInInjectionContext(injector, () => new SyncRpcClientService());
}

describe('SyncRpcClientService', () => {
  let originalEnv: MutableEnv;

  beforeEach(() => {
    mockLoggerCategory.info.mockReset();
    mockLoggerCategory.warn.mockReset();
    const env = environment as unknown as MutableEnv;
    originalEnv = {
      syncRpcEnabled: env.syncRpcEnabled,
      syncProtocolVersion: env.syncProtocolVersion,
      sentryRelease: env.sentryRelease,
      canonicalOrigin: env.canonicalOrigin,
    };
  });

  afterEach(() => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = originalEnv.syncRpcEnabled;
    env.syncProtocolVersion = originalEnv.syncProtocolVersion;
    env.sentryRelease = originalEnv.sentryRelease;
    env.canonicalOrigin = originalEnv.canonicalOrigin;
  });

  it('checkProtocol 在 feature 关闭时直接返回 null（不发起 RPC）', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = false;

    const rpc = vi.fn(async () => ({ data: { minProtocolVersion: 2 }, error: null }));
    const service = buildService(rpc as never);
    const result = await service.checkProtocol();
    expect(result).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('checkProtocol 解析 minProtocolVersion + deploymentEpoch', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const rpc = vi.fn(async () => ({ data: { minProtocolVersion: 2, deploymentEpoch: 7 }, error: null }));
    const service = buildService(rpc as never);
    const result = await service.checkProtocol();
    expect(result).toEqual({ minProtocolVersion: 2, deploymentEpoch: 7 });
    expect(service.isClientRejected()).toBe(true);
  });

  it('checkProtocol RPC 错误返回 null（向后兼容）', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;

    const rpc = vi.fn(async () => ({ data: null, error: { message: 'pgrst-503' } }));
    const service = buildService(rpc as never);
    const result = await service.checkProtocol();
    expect(result).toBeNull();
    expect(mockLoggerCategory.warn).toHaveBeenCalled();
  });

  it('upsertTask: applied 状态解析 entityId / status', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const rpc = vi.fn(async (_name, _payload) => ({
      data: { status: 'applied', operation_id: 'op-1', task_id: 'task-9' },
      error: null,
    }));

    const service = buildService(rpc as never);
    const result = await service.upsertTask({
      operationId: 'op-1',
      task: { id: 'task-9', projectId: 'p-1', content: 'hi' } as Task,
      baseUpdatedAt: null,
    });

    expect(result.status).toBe('applied');
    expect(result.entityId).toBe('task-9');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('upsertTask: remote-newer 状态解析 remoteUpdatedAt', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const rpc = vi.fn(async () => ({
      data: { status: 'remote-newer', remote_updated_at: '2026-04-29T01:00:00Z' },
      error: null,
    }));

    const service = buildService(rpc as never);
    const result = await service.upsertTask({
      operationId: 'op-1',
      task: { id: 'task-9', projectId: 'p-1', content: 'hi' } as Task,
      baseUpdatedAt: '2026-04-28T20:00:00Z',
    });

    expect(result.status).toBe('remote-newer');
    expect(result.remoteUpdatedAt).toBe('2026-04-29T01:00:00Z');
  });

  it('upsertTask: client-version-rejected 状态解析 minProtocolVersion', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 1;

    const rpc = vi.fn(async () => ({
      data: { status: 'client-version-rejected', minProtocolVersion: 3 },
      error: null,
    }));

    const service = buildService(rpc as never);
    const result = await service.upsertTask({
      operationId: 'op-1',
      task: { id: 'task-9', projectId: 'p-1', content: 'hi' } as Task,
      baseUpdatedAt: null,
    });

    expect(result.status).toBe('client-version-rejected');
    expect(result.minProtocolVersion).toBe(3);
  });

  it('upsertConnection: 序列化 source_id/target_id（兼容 from/to 别名）', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;

    let captured: unknown = null;
    const rpc = vi.fn(async (_name, payload) => {
      captured = payload;
      return { data: { status: 'applied', connection_id: 'c-1' }, error: null };
    });

    const service = buildService(rpc as never);
    await service.upsertConnection({
      operationId: 'op-1',
      connection: { id: 'c-1', from: 't-1', to: 't-2', projectId: 'p-1' } as unknown as Connection,
      baseUpdatedAt: null,
    });

    const cap = captured as { connection: { source_id: string; target_id: string } };
    expect(cap.connection.source_id).toBe('t-1');
    expect(cap.connection.target_id).toBe('t-2');
  });

  it('upsertBlackboxEntry: 序列化 content + created_at', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;

    let captured: unknown = null;
    const rpc = vi.fn(async (_name, payload) => {
      captured = payload;
      return { data: { status: 'applied', entry_id: 'b-1' }, error: null };
    });

    const service = buildService(rpc as never);
    await service.upsertBlackboxEntry({
      operationId: 'op-1',
      entry: { id: 'b-1', content: 'hello', createdAt: '2026-04-29T00:00:00Z' } as unknown as BlackBoxEntry,
      baseUpdatedAt: null,
    });

    const cap = captured as { entry: { content: string; created_at: string } };
    expect(cap.entry.content).toBe('hello');
    expect(cap.entry.created_at).toBe('2026-04-29T00:00:00Z');
  });

  it('upsert RPC 网络错误时向上抛（调用方走 RetryQueue 路径）', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;

    const rpc = vi.fn(async () => ({ data: null, error: { message: 'network down' } }));
    const service = buildService(rpc as never);

    await expect(
      service.upsertTask({
        operationId: 'op-1',
        task: { id: 't', projectId: 'p', content: 'x' } as Task,
        baseUpdatedAt: null,
      })
    ).rejects.toMatchObject({ message: 'network down' });
  });

  it('isClientRejected: 服务端 minProtocolVersion <= 客户端时 false', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;
    env.syncProtocolVersion = 5;

    const rpc = vi.fn(async () => ({ data: { minProtocolVersion: 2, deploymentEpoch: 0 }, error: null }));
    const service = buildService(rpc as never);
    await service.checkProtocol();
    expect(service.isClientRejected()).toBe(false);
  });

  it('未知 status 默认归类为 unauthorized', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncRpcEnabled = true;

    const rpc = vi.fn(async () => ({ data: { status: 'totally-bogus' }, error: null }));
    const service = buildService(rpc as never);
    const result = await service.upsertTask({
      operationId: 'op-1',
      task: { id: 't', projectId: 'p', content: 'x' } as Task,
      baseUpdatedAt: null,
    });
    expect(result.status).toBe('unauthorized');
  });
});
