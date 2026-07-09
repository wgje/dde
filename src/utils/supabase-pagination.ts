import { isValidUUID } from './validation';

export const SUPABASE_REST_PAGE_SIZE = 1000;

export interface SupabasePageResult<Row, ErrorType = unknown> {
  data: Row[] | null;
  error: ErrorType | null;
}

interface SupabaseRangeQueryResult<ErrorType = unknown> {
  data: unknown[] | null;
  error: ErrorType | null;
}

export interface SupabaseRangeQuery<ErrorType = unknown> {
  range(
    from: number,
    to: number,
  ): PromiseLike<SupabaseRangeQueryResult<ErrorType>> | SupabaseRangeQueryResult<ErrorType>;
}

export interface FetchAllSupabasePagesOptions {
  pageSize?: number;
}

export interface SupabaseKeysetCursor {
  updatedAt: string;
  id: string;
}

export interface SupabaseLimitQuery<ErrorType = unknown> {
  limit(
    count: number,
  ): PromiseLike<SupabaseRangeQueryResult<ErrorType>> | SupabaseRangeQueryResult<ErrorType>;
}

/** PostgREST (updated_at, id) keyset 过滤器（与黑匣子增量拉取同一范式）。 */
export function buildSupabaseKeysetOrFilter(cursor: SupabaseKeysetCursor): string {
  return `updated_at.gt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.gt.${cursor.id})`;
}

export async function fetchAllSupabasePages<Row, ErrorType = unknown>(
  buildQuery: () => SupabaseRangeQuery<ErrorType>,
  options: FetchAllSupabasePagesOptions = {},
): Promise<SupabasePageResult<Row, ErrorType>> {
  const pageSize = normalizePageSize(options.pageSize);
  const rows: Row[] = [];

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await buildQuery().range(from, to);
    if (error) {
      return { data: null, error };
    }

    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < pageSize) {
      return { data: rows, error: null };
    }
  }
}

/**
 * (updated_at, id) keyset 翻页。
 *
 * offset 分页（fetchAllSupabasePages）在翻页期间有并发写入同一排序窗口时，
 * 已取回区间内的行被 UPDATE 会移到序列尾部、后续行整体左移一位，页边界处
 * 会静默跳过一行；被跳过的行随后被增量游标封口成永久缺口。keyset 以最后
 * 一行 (updated_at, id) 为锚点续页，行移动只会让它在后续页或下一轮增量
 * 重新出现，绝不丢行——增量 delta 拉取必须使用本函数。
 *
 * 调用方约定：builder 负责基础过滤 +（cursor 为 null 时的）下界条件 +
 * `(updated_at asc, id asc)` 排序；cursor 非 null 时改用
 * `buildSupabaseKeysetOrFilter(cursor)` 作为下界。
 */
export async function fetchAllSupabaseKeysetPages<Row, ErrorType = unknown>(
  buildQuery: (cursor: SupabaseKeysetCursor | null) => SupabaseLimitQuery<ErrorType>,
  options: FetchAllSupabasePagesOptions = {},
): Promise<SupabasePageResult<Row, ErrorType>> {
  const pageSize = normalizePageSize(options.pageSize);
  const rows: Row[] = [];
  let cursor: SupabaseKeysetCursor | null = null;

  for (;;) {
    const { data, error } = await buildQuery(cursor).limit(pageSize);
    if (error) {
      return { data: null, error };
    }

    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < pageSize) {
      return { data: rows, error: null };
    }

    const nextCursor = readSupabaseKeysetCursor(page[page.length - 1]);
    if (!nextCursor) {
      // 末行缺少可用 keyset 字段时停止本轮翻页：
      // 宁可下一轮增量按旧游标重拉，也不冒 offset 式跳行风险
      return { data: rows, error: null };
    }
    cursor = nextCursor;
  }
}

function readSupabaseKeysetCursor(row: unknown): SupabaseKeysetCursor | null {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const candidate = row as { updated_at?: unknown; id?: unknown };
  if (
    typeof candidate.updated_at !== 'string'
    || !Number.isFinite(Date.parse(candidate.updated_at))
    || typeof candidate.id !== 'string'
    || !isValidUUID(candidate.id)
  ) {
    return null;
  }
  return { updatedAt: candidate.updated_at, id: candidate.id };
}

function normalizePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return SUPABASE_REST_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error('Supabase page size must be a positive integer');
  }
  return pageSize;
}
