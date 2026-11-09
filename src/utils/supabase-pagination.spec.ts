import { describe, expect, it, vi } from 'vitest';
import {
  buildSupabaseKeysetOrFilter,
  fetchAllSupabaseKeysetPages,
  fetchAllSupabaseKeysetPagesByCursor,
  type SupabaseKeysetCursor,
} from './supabase-pagination';

interface KeysetRow {
  id: string;
  updated_at: string;
}

describe('fetchAllSupabaseKeysetPages', () => {
  it('翻页期间行被并发更新左移时不得像 offset 分页那样跳行', async () => {
    // 数据库快照：4 行按 (updated_at, id) 升序；页大小 2。
    // 第 1 页取回 [r1, r2] 后，r1 被并发 UPDATE 移到序列尾部（updated_at 变大）。
    // offset 分页第 2 页 range(2,3) 会因整体左移跳过 r3；keyset 以 r2 为锚点续页，
    // r3/r4 与被移动的 r1 全部保留。
    const r1 = keysetRow(1, '2026-06-09T00:00:01.000Z');
    const r2 = keysetRow(2, '2026-06-09T00:00:02.000Z');
    const r3 = keysetRow(3, '2026-06-09T00:00:03.000Z');
    const r4 = keysetRow(4, '2026-06-09T00:00:04.000Z');
    let snapshot: KeysetRow[] = [r1, r2, r3, r4];

    const buildQuery = vi.fn((cursor: SupabaseKeysetCursor | null) => ({
      limit: vi.fn(async (count: number) => {
        const visible = cursor
          ? snapshot.filter(row =>
            row.updated_at > cursor.updatedAt
            || (row.updated_at === cursor.updatedAt && row.id > cursor.id))
          : snapshot;
        const page = visible.slice(0, count);
        // 模拟页间并发写入：r1 被更新移动到序列尾部
        snapshot = [r2, r3, r4, { ...r1, updated_at: '2026-06-09T00:00:05.000Z' }];
        return { data: page, error: null };
      }),
    }));

    const result = await fetchAllSupabaseKeysetPages<KeysetRow>(buildQuery, { pageSize: 2 });

    expect(result.error).toBeNull();
    const ids = (result.data ?? []).map(row => row.id);
    // r3 绝不能丢（offset 分页在此场景会静默跳过 r3）
    expect(ids).toContain(r3.id);
    expect(ids).toContain(r4.id);
    // 被移动的 r1 以新时间戳重新出现，由上层 LWW 合并幂等吸收
    expect(buildQuery).toHaveBeenNthCalledWith(1, null);
    expect(buildQuery).toHaveBeenNthCalledWith(2, { updatedAt: r2.updated_at, id: r2.id });
  });

  it('末行缺少合法 keyset 字段时必须失败关闭，不能返回可推进游标的部分结果', async () => {
    const limit = vi.fn(async () => ({
      data: [
        keysetRow(1, '2026-06-09T00:00:01.000Z'),
        { id: 'not-a-uuid', updated_at: '2026-06-09T00:00:02.000Z' },
      ],
      error: null,
    }));

    await expect(fetchAllSupabaseKeysetPages<KeysetRow>(
      () => ({ limit }),
      { pageSize: 2 },
    )).rejects.toThrow('Supabase keyset page ended without a valid cursor');

    expect(limit).toHaveBeenCalledTimes(1);
  });

  it('返回首个错误并终止翻页', async () => {
    const error = { message: 'network failed' };
    const limit = vi.fn(async () => ({ data: null, error }));

    const result = await fetchAllSupabaseKeysetPages<KeysetRow>(
      () => ({ limit }),
      { pageSize: 2 },
    );

    expect(result).toEqual({ data: null, error });
  });

  it('buildSupabaseKeysetOrFilter 输出与黑匣子增量相同的 PostgREST 过滤形态', () => {
    expect(buildSupabaseKeysetOrFilter({
      updatedAt: '2026-06-09T00:00:02.000Z',
      id: '00000000-0000-4000-8000-000000000002',
    })).toBe('updated_at.gt.2026-06-09T00:00:02.000Z,and(updated_at.eq.2026-06-09T00:00:02.000Z,id.gt.00000000-0000-4000-8000-000000000002)');
  });

  it('支持调用方定义非 updated_at/id 的稳定游标', async () => {
    const cursors: Array<{ sequence: number } | null> = [];
    const pages = [
      [{ sequence: 1 }, { sequence: 2 }],
      [{ sequence: 3 }],
    ];

    const result = await fetchAllSupabaseKeysetPagesByCursor<
      { sequence: number },
      { sequence: number }
    >(
      (cursor) => ({
        limit: vi.fn(async () => {
          cursors.push(cursor);
          return { data: pages[cursors.length - 1] ?? [], error: null };
        }),
      }),
      {
       pageSize: 2,
      readCursor: row => ({ sequence: row.sequence }),
      cursorKey: cursor => String(cursor.sequence),
      isCursorAfter: (previous, next) => next.sequence > previous.sequence,
    },
  );

    expect(result).toEqual({
      data: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }],
      error: null,
    });
    expect(cursors).toEqual([null, { sequence: 2 }]);
  });

  it.each([1001, 1.5, 0])('rejects invalid pageSize %s before buildQuery/limit', async (pageSize) => {
    const buildQuery = vi.fn(() => ({ limit: vi.fn() }));

    await expect(fetchAllSupabaseKeysetPages(buildQuery, { pageSize })).rejects.toThrow('Supabase page size must be a positive integer');
    expect(buildQuery).not.toHaveBeenCalled();
  });

  it('accepts pageSize 1 and 1000', async () => {
    const responses1 = [
      [keysetRow(1, '2026-06-09T00:00:01.000Z')],
      [],
    ];
    let calls1 = 0;
    const limit1 = vi.fn(async () => {
      const page = responses1[calls1++] ?? [];
      return { data: page, error: null };
    });
    const result1 = await fetchAllSupabaseKeysetPages(() => ({ limit: limit1 }), { pageSize: 1 });
    expect(result1.error).toBeNull();
    expect(limit1).toHaveBeenCalledWith(1);

    const limit1000 = vi.fn(async () => ({ data: [], error: null }));
    const result1000 = await fetchAllSupabaseKeysetPages(() => ({ limit: limit1000 }), { pageSize: 1000 });
    expect(result1000.error).toBeNull();
    expect(limit1000).toHaveBeenCalledWith(1000);
  });

  it('default pageSize remains SUPABASE_REST_PAGE_SIZE=1000', async () => {
    const limit = vi.fn(async () => ({ data: [], error: null }));
    await fetchAllSupabaseKeysetPages(() => ({ limit }));
    expect(limit).toHaveBeenCalledWith(1000);
  });

  it('exact 1000-row page continues to fresh next builder instead of stopping', async () => {
    const first = Array.from({ length: 1000 }, (_, index) => keysetRow(index + 1, `2026-06-09T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`));
    const next = [keysetRow(1001, '2026-06-09T01:00:00.000Z')];
    const responses = [first, next];
    let buildCount = 0;
    const buildQuery = vi.fn((cursor: SupabaseKeysetCursor | null) => {
      buildCount += 1;
      if (buildCount > 2) throw new Error('keyset builder exceeded finite response sequence');
      const page = responses[buildCount - 1];
      return {
        limit: vi.fn(async () => ({ data: page, error: null })),
      };
    });

    const result = await fetchAllSupabaseKeysetPages(buildQuery, { pageSize: 1000 });
    expect(result.error).toBeNull();
    expect((result.data ?? []).length).toBe(1001);
    expect(buildQuery).toHaveBeenCalledTimes(2);
  });

  it('same primitive cursor returned on repeated full pages fails closed before sentinel', async () => {
    const page = [keysetRow(1, '2026-06-09T00:00:01.000Z'), keysetRow(2, '2026-06-09T00:00:02.000Z')];
    let calls = 0;
    const buildQuery = vi.fn(() => {
      calls += 1;
      if (calls > 2) throw new Error('sentinel reached: helper did not fail closed');
      return { limit: vi.fn(async () => ({ data: page, error: null })) };
    });

   let rejection: unknown;
   try {
     await fetchAllSupabaseKeysetPagesByCursor<KeysetRow, number>(buildQuery, {
     pageSize: 2,
     readCursor: () => 1,
    cursorKey: (cursor) => String(cursor),
    isCursorAfter: (previous, next) => next > previous,
   });
   } catch (error) {
     rejection = error;
   }
   expect(rejection instanceof Error ? rejection.message : undefined).not.toBe('sentinel reached: helper did not fail closed');
    expect(calls).toBeLessThan(3);
  });

  it('exact same cursor object reference repeated fails closed before sentinel', async () => {
    const page = [keysetRow(1, '2026-06-09T00:00:01.000Z'), keysetRow(2, '2026-06-09T00:00:02.000Z')];
    const cursor = { sequence: 1 };
    let calls = 0;
    const buildQuery = vi.fn(() => {
      calls += 1;
      if (calls > 2) throw new Error('sentinel reached: helper did not fail closed');
      return { limit: vi.fn(async () => ({ data: page, error: null })) };
    });

    let rejection: unknown;
    try {
      await fetchAllSupabaseKeysetPagesByCursor<KeysetRow, { sequence: number }>(buildQuery, {
        pageSize: 2,
        readCursor: () => cursor,
        cursorKey: (cursor) => String(cursor.sequence),
        isCursorAfter: (previous, next) => next.sequence > previous.sequence,
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection instanceof Error ? rejection.message : undefined).not.toBe('sentinel reached: helper did not fail closed');
    expect(calls).toBeLessThan(3);
  });

  it('fresh cursor instances with same semantic fields fail closed before sentinel', async () => {
    const page = [keysetRow(1, '2026-06-09T00:00:01.000Z'), keysetRow(2, '2026-06-09T00:00:02.000Z')];
    const cursor = { sequence: 1 };
    let calls = 0;
    const buildQuery = vi.fn(() => {
      calls += 1;
      if (calls > 2) throw new Error('sentinel reached: helper did not fail closed');
      return { limit: vi.fn(async () => ({ data: page, error: null })) };
    });

    let rejection: unknown;
    try {
      await fetchAllSupabaseKeysetPagesByCursor<KeysetRow, { sequence: number }>(buildQuery, {
        pageSize: 2,
        readCursor: () => ({ sequence: cursor.sequence }),
        cursorKey: (cursor) => String(cursor.sequence),
        isCursorAfter: (previous, next) => next.sequence > previous.sequence,
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection instanceof Error ? rejection.message : undefined).not.toBe('sentinel reached: helper did not fail closed');
    expect(calls).toBeLessThan(3);
  });

  it('legal advancing cursor plus final short page still succeeds', async () => {
    const page1 = [keysetRow(1, '2026-06-09T00:00:01.000Z'), keysetRow(2, '2026-06-09T00:00:02.000Z')];
    const page2 = [keysetRow(3, '2026-06-09T00:00:03.000Z')];
    const responses = [page1, page2];
    let calls = 0;
    const buildQuery = vi.fn(() => {
      calls += 1;
      if (calls > 2) throw new Error('sentinel reached');
      return { limit: vi.fn(async () => ({ data: responses[calls - 1], error: null })) };
    });

   const result = await fetchAllSupabaseKeysetPages<KeysetRow>(buildQuery, { pageSize: 2 });
   expect(result.error).toBeNull();
   expect((result.data ?? []).map(row => row.id)).toEqual([
     '00000000-0000-4000-8000-000000000001',
     '00000000-0000-4000-8000-000000000002',
     '00000000-0000-4000-8000-000000000003',
   ]);
    expect(calls).toBe(2);
  });
});

function keysetRow(index: number, updatedAt: string): KeysetRow {
  return {
    id: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    updated_at: updatedAt,
  };
}
