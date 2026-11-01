import { Injector } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggerService } from '../../../../services/logger.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';
import { ConnectionTombstoneLookupService } from './connection-tombstone-lookup.service';
import { RetryQueueService } from './retry-queue.service';
import { SessionManagerService } from './session-manager.service';
import { TombstoneService } from './tombstone.service';

interface TombstoneRow {
  connection_id: string;
  deleted_at: string;
}

describe('ConnectionTombstoneLookupService', () => {
  beforeEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
    });
  });

  it('uses deleted_at/connection_id keyset pages beyond the PostgREST row cap', async () => {
    const rows = tombstoneRows(2001);
    const filters: string[] = [];
    const limitCalls: number[] = [];
    const orderCalls: Array<[string, { ascending: boolean }]> = [];
    const updateConnectionTombstoneCache = vi.fn();
    const client = createKeysetClient(rows, filters, limitCalls, orderCalls);
    const service = createService(updateConnectionTombstoneCache);

    const ids = await service.getConnectionTombstoneIds(
      '00000000-0000-4000-8000-000000009999',
      () => client,
    );

    expect(ids.size).toBe(2001);
    expect(limitCalls).toEqual([1000, 1000, 1000]);
    expect(filters).toEqual([
      keysetFilter(rows[999]),
      keysetFilter(rows[1999]),
    ]);
    expect(orderCalls).toEqual([
      ['deleted_at', { ascending: true }],
      ['connection_id', { ascending: true }],
      ['deleted_at', { ascending: true }],
      ['connection_id', { ascending: true }],
      ['deleted_at', { ascending: true }],
      ['connection_id', { ascending: true }],
    ]);
    expect(updateConnectionTombstoneCache).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000009999',
      expect.any(Set),
    );
  });
});

function createService(updateConnectionTombstoneCache: ReturnType<typeof vi.fn>): ConnectionTombstoneLookupService {
  return Injector.create({
    providers: [
      ConnectionTombstoneLookupService,
      {
        provide: LoggerService,
        useValue: {
          category: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          }),
        },
      },
      { provide: RetryQueueService, useValue: { recordCircuitFailure: vi.fn() } },
      { provide: SessionManagerService, useValue: {} },
      {
        provide: TombstoneService,
        useValue: {
          getConnectionTombstoneCache: vi.fn(() => null),
          updateConnectionTombstoneCache,
        },
      },
    ],
  }).get(ConnectionTombstoneLookupService);
}

function createKeysetClient(
  rows: TombstoneRow[],
  filters: string[],
  limitCalls: number[],
  orderCalls: Array<[string, { ascending: boolean }]>,
): SupabaseClient {
  return {
    from: vi.fn(() => {
      let cursor: TombstoneRow | null = null;
      const query = {
        select: vi.fn(),
        eq: vi.fn(),
        order: vi.fn((column: string, options: { ascending: boolean }) => {
          orderCalls.push([column, options]);
          return query;
        }),
        or: vi.fn((filter: string) => {
          filters.push(filter);
          cursor = parseKeysetFilter(filter);
          return query;
        }),
        limit: vi.fn(async (count: number) => {
          limitCalls.push(count);
          const visible = cursor
            ? rows.filter(row => row.deleted_at > cursor!.deleted_at
              || (row.deleted_at === cursor!.deleted_at
                && row.connection_id > cursor!.connection_id))
            : rows;
          return { data: visible.slice(0, count), error: null };
        }),
      };
      query.select.mockReturnValue(query);
      query.eq.mockReturnValue(query);
      return query;
    }),
  } as unknown as SupabaseClient;
}

function parseKeysetFilter(filter: string): TombstoneRow {
  const match = /^deleted_at\.gt\.([^,]+),and\(deleted_at\.eq\.([^,]+),connection_id\.gt\.([^)]+)\)$/.exec(filter);
  if (!match) throw new Error(`Unexpected keyset filter: ${filter}`);
  return { deleted_at: match[2], connection_id: match[3] };
}

function keysetFilter(row: TombstoneRow): string {
  return `deleted_at.gt.${row.deleted_at},and(deleted_at.eq.${row.deleted_at},connection_id.gt.${row.connection_id})`;
}

function tombstoneRows(count: number): TombstoneRow[] {
  const deletedAt = '2026-07-15T00:00:00.000Z';
  return Array.from({ length: count }, (_, index) => ({
    connection_id: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
    deleted_at: deletedAt,
  }));
}
