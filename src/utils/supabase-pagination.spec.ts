import { describe, expect, it, vi } from 'vitest';
import {
  buildSupabaseKeysetOrFilter,
  fetchAllSupabaseKeysetPages,
  fetchAllSupabasePages,
  type SupabaseKeysetCursor,
} from './supabase-pagination';

interface Row {
  id: string;
}

interface KeysetRow {
  id: string;
  updated_at: string;
}

describe('fetchAllSupabasePages', () => {
  it('fetches every range until the final short page', async () => {
    const ranges: Array<[number, number]> = [];
    const buildQuery = vi.fn(() => ({
      range: vi.fn(async (from: number, to: number) => {
        ranges.push([from, to]);
        if (from === 0) {
          return { data: rows('a', 'b'), error: null };
        }
        if (from === 2) {
          return { data: rows('c', 'd'), error: null };
        }
        return { data: rows('e'), error: null };
      }),
    }));

    const result = await fetchAllSupabasePages<Row>(buildQuery, { pageSize: 2 });

    expect(result).toEqual({
      data: rows('a', 'b', 'c', 'd', 'e'),
      error: null,
    });
    expect(ranges).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
    expect(buildQuery).toHaveBeenCalledTimes(3);
  });

  it('stops after the first page when it is shorter than page size', async () => {
    const range = vi.fn(async () => ({ data: rows('a'), error: null }));

    const result = await fetchAllSupabasePages<Row>(
      () => ({ range }),
      { pageSize: 2 },
    );

    expect(result.data).toEqual(rows('a'));
    expect(range).toHaveBeenCalledTimes(1);
  });

  it('returns the first error without dropping already fetched row shape', async () => {
    const error = { message: 'network failed' };
    const range = vi.fn(async () => ({ data: null, error }));

    const result = await fetchAllSupabasePages<Row>(
      () => ({ range }),
      { pageSize: 2 },
    );

    expect(result).toEqual({ data: null, error });
    expect(range).toHaveBeenCalledWith(0, 1);
  });
});

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

  it('末行缺少合法 keyset 字段时停止翻页而不是冒跳行风险', async () => {
    const limit = vi.fn(async () => ({
      data: [
        keysetRow(1, '2026-06-09T00:00:01.000Z'),
        { id: 'not-a-uuid', updated_at: '2026-06-09T00:00:02.000Z' },
      ],
      error: null,
    }));

    const result = await fetchAllSupabaseKeysetPages<KeysetRow>(
      () => ({ limit }),
      { pageSize: 2 },
    );

    expect(result.data).toHaveLength(2);
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
});

function rows(...ids: string[]): Row[] {
  return ids.map((id) => ({ id }));
}

function keysetRow(index: number, updatedAt: string): KeysetRow {
  return {
    id: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    updated_at: updatedAt,
  };
}
