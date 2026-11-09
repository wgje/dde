import { describe, expect, it, vi } from 'vitest';

import { createEntry } from './black-box-sync.spec-helpers';
import { writeBlackBoxEntryByPreflightState } from './black-box-sync-push-write.helpers';
import { type BlackBoxSupabaseClient } from './black-box-sync.types';

describe('writeBlackBoxEntryByPreflightState', () => {
  it('updates an existing remote row with CAS when preflight has updatedAt', async () => {
    const entry = createEntry({ id: crypto.randomUUID() });
    const preflightServerEntry = createEntry({
      id: entry.id,
      updatedAt: '2026-03-04T00:00:00.000Z',
    });
    const savedRow = { id: entry.id, updated_at: '2026-03-04T00:00:01.000Z' };
    const maybeSingle = vi.fn(async () => ({ data: savedRow, error: null }));
    const updateQuery = {
      eq: vi.fn(),
      select: vi.fn(),
    };
    updateQuery.eq.mockReturnValue(updateQuery);
    updateQuery.select.mockReturnValue({ maybeSingle });
    const update = vi.fn(() => updateQuery);
    const client = { from: vi.fn(() => ({ update })) } as unknown as BlackBoxSupabaseClient;

    const result = await writeBlackBoxEntryByPreflightState({
      client,
      entry,
      sessionUserId: 'user-1',
      preflightServerEntry,
      logger: { warn: vi.fn() },
      buildUpdatePayload: () => ({ content: 'payload' }),
      buildInsertPayload: () => ({ id: entry.id, user_id: 'user-1', content: 'payload' }),
    });

    expect(result).toEqual({ savedRow, error: null });
    expect(update).toHaveBeenCalledWith({ content: 'payload' });
    expect(updateQuery.eq).toHaveBeenCalledWith('id', entry.id);
    expect(updateQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(updateQuery.eq).toHaveBeenCalledWith('updated_at', preflightServerEntry.updatedAt);
    expect(maybeSingle).toHaveBeenCalledOnce();
  });

  it('defers when preflight found a row without updatedAt', async () => {
    const entry = createEntry({ id: crypto.randomUUID() });
    const logger = { warn: vi.fn() };

    const result = await writeBlackBoxEntryByPreflightState({
      client: { from: vi.fn() } as unknown as BlackBoxSupabaseClient,
      entry,
      sessionUserId: 'user-1',
      preflightServerEntry: { ...entry, updatedAt: undefined as unknown as string },
      logger,
      buildUpdatePayload: () => ({ content: 'payload' }),
      buildInsertPayload: () => ({ id: entry.id, user_id: 'user-1', content: 'payload' }),
    });

    expect(result).toEqual({ savedRow: null, error: null, deferred: true });
    expect(logger.warn).toHaveBeenCalledWith(
      '黑匣子预检命中缺失 updated_at 的远端行，放弃本轮写入避免覆盖未对账状态',
      { entryId: entry.id },
    );
  });

  it('defers duplicate insert conflicts without surfacing an error', async () => {
    const entry = createEntry({ id: crypto.randomUUID() });
    const logger = { warn: vi.fn() };
    const single = vi.fn(async () => ({ data: null, error: { code: '23505' } }));
    const insert = vi.fn(() => ({
      select: vi.fn(() => ({ single })),
    }));
    const client = { from: vi.fn(() => ({ insert })) } as unknown as BlackBoxSupabaseClient;

    const result = await writeBlackBoxEntryByPreflightState({
      client,
      entry,
      sessionUserId: 'user-1',
      preflightServerEntry: null,
      logger,
      buildUpdatePayload: () => ({ content: 'payload' }),
      buildInsertPayload: () => ({ id: entry.id, user_id: 'user-1', content: 'payload' }),
    });

    expect(result).toEqual({ savedRow: null, error: null, deferred: true });
    expect(insert).toHaveBeenCalledWith({ id: entry.id, user_id: 'user-1', content: 'payload' });
    expect(logger.warn).toHaveBeenCalledWith(
      '黑匣子 insert 命中并发主键冲突，延后到下一轮重试',
      { entryId: entry.id },
    );
  });
});
