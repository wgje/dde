import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { clear } from 'idb-keyval';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../../services/auth.service';
import { LoggerService } from '../../../services/logger.service';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { ToastService } from '../../../services/toast.service';
import { ExternalSourceCacheService } from './external-source-cache.service';
import { ExternalSourceLinkService } from './external-source-link.service';

function createLoggerMock() {
  return { category: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) };
}

describe('ExternalSourceLinkService', () => {
  let upsertPayloads: unknown[];
  let authUser = signal('00000000-0000-0000-0000-000000000001');
  let shouldFailUpsert = false;
  let upsertError: { code?: string; status?: number; message: string } | null = null;

  beforeEach(async () => {
    await clear();
    upsertPayloads = [];
    authUser = signal('00000000-0000-0000-0000-000000000001');
    shouldFailUpsert = false;
    upsertError = null;
    const from = vi.fn((table: string) => ({
      select: vi.fn(() => ({ eq: vi.fn(async () => ({ data: [], error: null })) })),
      upsert: vi.fn(async (payload: unknown) => {
        if (upsertError) return { error: upsertError };
        if (shouldFailUpsert) return { error: new Error('offline') };
        upsertPayloads.push({ table, payload });
        return { error: null };
      }),
    }));

    TestBed.configureTestingModule({
      providers: [
        ExternalSourceLinkService,
        { provide: AuthService, useValue: { currentUserId: authUser } },
        { provide: SupabaseClientService, useValue: { clientAsync: vi.fn(async () => ({ from })) } },
        { provide: ToastService, useValue: { success: vi.fn(), info: vi.fn(), error: vi.fn() } },
        { provide: LoggerService, useValue: createLoggerMock() },
      ],
    });
  });

  it('creates a local-first SiYuan pointer with client uuid and standard deep link', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);

    const link = await service.bindSiyuanBlock('task-1', 'siyuan://blocks/20260426123456-abc1234');

    expect(link?.id).toMatch(/[0-9a-f-]{36}/);
    expect(link?.taskId).toBe('task-1');
    expect(link?.targetId).toBe('20260426123456-abc1234');
    expect(link?.uri).toBe('siyuan://blocks/20260426123456-abc1234?focus=1');
    expect(service.firstActiveLinkForTask('task-1')?.id).toBe(link?.id);
  });

  it('sync payload contains pointer metadata but no preview body fields', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);

    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();

    expect(upsertPayloads).toHaveLength(1);
    const payload = upsertPayloads[0] as { table: string; payload: Record<string, unknown> };
    expect(payload.table).toBe('external_source_links');
    expect(payload.payload).toMatchObject({ task_id: 'task-1', target_id: '20260426123456-abc1234' });
    expect(payload.payload).not.toHaveProperty('content');
    expect(payload.payload).not.toHaveProperty('markdown');
    expect(payload.payload).not.toHaveProperty('kramdown');
    expect(payload.payload).not.toHaveProperty('plainText');
  });



  it('keeps failed pushes in a durable pending queue and flushes later', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    shouldFailUpsert = true;

    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();
    expect(upsertPayloads).toHaveLength(0);

    shouldFailUpsert = false;
    await service.flushPendingLinks();

    expect(upsertPayloads).toHaveLength(1);
  });

  it('reloads local links when the current owner changes', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const first = await service.bindSiyuanBlock('task-a', '20260426123456-abc1234');
    expect(service.firstActiveLinkForTask('task-a')?.id).toBe(first?.id);

    authUser.set('00000000-0000-0000-0000-000000000002');
    await service.ensureLoaded();

    expect(service.firstActiveLinkForTask('task-a')).toBeNull();
  });

  it('soft deletes links and hides them from active task anchors', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const link = await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');

    await service.removeLink(link!.id);

    expect(service.firstActiveLinkForTask('task-1')).toBeNull();
  });

  it('drops pending push on unique-violation (23505) instead of looping forever', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);

    upsertError = { code: '23505', message: 'duplicate key value violates unique constraint' };
    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    await service.flushPendingLinks();

    expect(await cache.loadPendingLinks()).toHaveLength(0);
    expect(await cache.loadDeadLetters()).toHaveLength(0);
  });

  it('keeps retry counter so transient failures eventually move to dead letter', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const cache = TestBed.inject(ExternalSourceCacheService);

    shouldFailUpsert = true;
    await service.bindSiyuanBlock('task-1', '20260426123456-abc1234');
    for (let i = 0; i < 6; i++) await service.flushPendingLinks();

    expect(await cache.loadPendingLinks()).toHaveLength(0);
    const deadLetters = await cache.loadDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].retryCount).toBeGreaterThan(5);
  });

  it('dedupes concurrent ensureLoaded calls into a single in-flight promise', async () => {
    const service = TestBed.inject(ExternalSourceLinkService);
    const supabase = TestBed.inject(SupabaseClientService) as unknown as { clientAsync: ReturnType<typeof vi.fn> };
    const before = supabase.clientAsync.mock.calls.length;

    await Promise.all([service.ensureLoaded(), service.ensureLoaded(), service.ensureLoaded()]);
    const after = supabase.clientAsync.mock.calls.length;

    // 3 个 caller 只触发一次远端 pull（getClient 调用）；不再每次都重新 pullRemoteLinks。
    expect(after - before).toBe(1);
  });
});
