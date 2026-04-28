import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { clear, get } from 'idb-keyval';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../../services/auth.service';
import { ExternalSourceCacheService } from './external-source-cache.service';
import type { LocalSiyuanPreviewCache } from './external-source.model';

describe('ExternalSourceCacheService', () => {
  const authUser = signal('user-1');
  beforeEach(async () => {
    await clear();
    TestBed.configureTestingModule({
      providers: [
        ExternalSourceCacheService,
        { provide: AuthService, useValue: { currentUserId: authUser } },
      ],
    });
  });

  it('requires both linkId and blockId to hit preview cache', async () => {
    const service = TestBed.inject(ExternalSourceCacheService);
    const cache: LocalSiyuanPreviewCache = {
      linkId: 'link-1',
      blockId: '20260426123456-abc1234',
      fetchedAt: new Date().toISOString(),
      fetchStatus: 'ready',
      truncated: false,
      excerpt: 'preview',
    };

    await service.savePreview(cache);

    expect(await service.getPreview('link-1', '20260426123456-abc1234')).toMatchObject({ excerpt: 'preview' });
    expect(await service.getPreview('link-1', '20260426123456-def5678')).toBeNull();
    expect(await service.getPreview('link-2', '20260426123456-abc1234')).toBeNull();
  });



  it('scopes preview cache keys by current owner', async () => {
    const service = TestBed.inject(ExternalSourceCacheService);
    await service.savePreview({
      linkId: 'link-1',
      blockId: '20260426123456-abc1234',
      fetchedAt: new Date().toISOString(),
      fetchStatus: 'ready',
      truncated: false,
      excerpt: 'owner preview',
    });

    expect(await get(service.previewKey('link-1', '20260426123456-abc1234', 'user-1'))).toBeTruthy();
    expect(await get(service.previewKey('link-1', '20260426123456-abc1234', 'user-2'))).toBeFalsy();
  });

  it('clears preview cache without deleting local config', async () => {
    const service = TestBed.inject(ExternalSourceCacheService);
    await service.saveConfig({ runtimeMode: 'cache-only', baseUrl: 'http://127.0.0.1:6806', previewStrategy: 'excerpt-first', autoRefresh: 'manual' });
    await service.savePreview({
      linkId: 'link-1',
      blockId: '20260426123456-abc1234',
      fetchedAt: new Date().toISOString(),
      fetchStatus: 'ready',
      truncated: false,
    });

    await service.clearPreviewCache();

    expect(await service.getPreview('link-1', '20260426123456-abc1234')).toBeNull();
    expect((await service.loadConfig()).runtimeMode).toBe('cache-only');
  });

  it('upsertPendingLink preserves retryCount across re-enqueue and resets only when requested', async () => {
    const service = TestBed.inject(ExternalSourceCacheService);
    const link = {
      id: 'link-1', taskId: 'task-1', sourceType: 'siyuan-block' as const,
      targetId: '20260426123456-abc1234', uri: 'siyuan://blocks/20260426123456-abc1234?focus=1',
      sortOrder: 0, deletedAt: null,
      createdAt: '2026-04-28T00:00:00.000Z', updatedAt: '2026-04-28T00:00:00.000Z',
    };
    await service.upsertPendingLink(link);
    await service.recordPendingFailure('link-1', 'unknown');
    await service.upsertPendingLink({ ...link, label: 'updated' });
    expect((await service.loadPendingLinks())[0].retryCount).toBe(1);

    await service.upsertPendingLink({ ...link, label: 'reset' }, { resetRetryCount: true });
    expect((await service.loadPendingLinks())[0].retryCount).toBe(0);
  });

  it('moves pending link to dead letter after exceeding retry threshold', async () => {
    const service = TestBed.inject(ExternalSourceCacheService);
    const link = {
      id: 'link-2', taskId: 'task-1', sourceType: 'siyuan-block' as const,
      targetId: '20260426123456-abc1234', uri: 'siyuan://blocks/20260426123456-abc1234?focus=1',
      sortOrder: 0, deletedAt: null,
      createdAt: '2026-04-28T00:00:00.000Z', updatedAt: '2026-04-28T00:00:00.000Z',
    };
    await service.upsertPendingLink(link);
    for (let i = 0; i < 6; i++) await service.recordPendingFailure('link-2', '23514');

    expect(await service.loadPendingLinks()).toHaveLength(0);
    const deadLetters = await service.loadDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].link.id).toBe('link-2');
    expect(deadLetters[0].lastErrorCode).toBe('23514');
  });
});
