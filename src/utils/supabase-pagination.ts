import { isValidUUID } from './validation';

export const SUPABASE_REST_PAGE_SIZE = 1000;

export interface SupabasePageResult<Row, ErrorType = unknown> {
  data: Row[] | null;
  error: ErrorType | null;
}

interface SupabaseQueryResult<ErrorType = unknown> {
  data: unknown[] | null;
  error: ErrorType | null;
}

interface SupabaseRangeQueryResult<ErrorType = unknown> extends SupabaseQueryResult<ErrorType> {}

export interface SupabaseRangeQuery<ErrorType = unknown> {
  range(
    from: number,
    to: number,
  ): PromiseLike<SupabaseRangeQueryResult<ErrorType>> | SupabaseRangeQueryResult<ErrorType>;
}

export interface FetchAllSupabasePagesOptions {
  pageSize?: number;
}

export interface SupabasePaginationOptions {
  pageSize?: number;
}

export interface SupabaseKeysetCursor {
  updatedAt: string;
  id: string;
}

export interface SupabaseLimitQuery<ErrorType = unknown> {
  limit(
    count: number,
  ): PromiseLike<SupabaseQueryResult<ErrorType>> | SupabaseQueryResult<ErrorType>;
}

export interface FetchAllSupabaseKeysetPagesByCursorOptions<Row, Cursor>
  extends SupabasePaginationOptions {
  readCursor: (row: Row) => Cursor | null;
  cursorKey: (cursor: Cursor) => string | null;
  isCursorAfter: (previous: Cursor, next: Cursor) => boolean;
}

/** PostgREST (updated_at, id) keyset 过滤器（与黑匣子增量拉取同一范式）。 */
export function buildSupabaseKeysetOrFilter(cursor: SupabaseKeysetCursor): string {
  return `updated_at.gt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.gt.${cursor.id})`;
}

export function supabaseKeysetCursorKey(cursor: SupabaseKeysetCursor): string {
  return `${cursor.updatedAt}:${cursor.id}`;
}

export function isSupabaseKeysetCursorAfter(previous: SupabaseKeysetCursor, next: SupabaseKeysetCursor): boolean {
  if (next.updatedAt !== previous.updatedAt) return next.updatedAt > previous.updatedAt;
  return next.id > previous.id;
}

/** 保留旧调用方使用的 offset 分页 API；增量同步路径使用 keyset 分页。 */
export async function fetchAllSupabasePages<Row, ErrorType = unknown>(
  buildQuery: () => SupabaseRangeQuery<ErrorType>,
  options: FetchAllSupabasePagesOptions = {},
): Promise<SupabasePageResult<Row, ErrorType>> {
  const pageSize = normalizePageSize(options.pageSize);
  const rows: Row[] = [];

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await buildQuery().range(from, to);
    if (error) return { data: null, error };

    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < pageSize) return { data: rows, error: null };
  }
}

/**
 * (updated_at, id) keyset 翻页。
 *
 * offset 分页在翻页期间有并发写入同一排序窗口时，
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
  options: SupabasePaginationOptions = {},
): Promise<SupabasePageResult<Row, ErrorType>> {
  return await fetchAllSupabaseKeysetPagesByCursor<Row, SupabaseKeysetCursor, ErrorType>(
    buildQuery,
    {
      ...options,
      readCursor: readSupabaseKeysetCursor,
      cursorKey: supabaseKeysetCursorKey,
      isCursorAfter: isSupabaseKeysetCursorAfter,
    },
  );
}

/** 使用调用方定义的稳定游标进行 keyset 翻页。 */
export async function fetchAllSupabaseKeysetPagesByCursor<
  Row,
  Cursor,
  ErrorType = unknown,
>(
  buildQuery: (cursor: Cursor | null) => SupabaseLimitQuery<ErrorType>,
  options: FetchAllSupabaseKeysetPagesByCursorOptions<Row, Cursor>,
): Promise<SupabasePageResult<Row, ErrorType>> {
  const pageSize = normalizePageSize(options.pageSize);
  const rows: Row[] = [];
  let cursor: Cursor | null = null;

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

   const nextCursor = options.readCursor(page[page.length - 1]);
   if (!nextCursor) {
     throw new Error('Supabase keyset page ended without a valid cursor');
   }
   const nextKey = options.cursorKey(nextCursor);
   if (nextKey === null || (cursor !== null && (nextKey === options.cursorKey(cursor) || !options.isCursorAfter(cursor, nextCursor)))) {
     throw new Error('Supabase keyset cursor did not advance');
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
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > SUPABASE_REST_PAGE_SIZE) {
    throw new Error('Supabase page size must be a positive integer');
  }
  return pageSize;
}
