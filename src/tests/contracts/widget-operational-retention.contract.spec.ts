import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CURRENT_SUPABASE_INIT_VERSION,
  isSupabaseInitVersionAtLeast,
} from './supabase-init-version.spec-helpers';

const initPath = 'scripts/init-supabase.sql';
const migrationSuffix = '_widget_operational_retention.sql';
const retiredBlockedUntilIndexMigrationPath =
  'supabase/migrations/20260728000500_widget_request_rate_limits_blocked_until_unused_index_retirement.sql';
const manifestPath = 'scripts/migration-dry-run-manifest.json';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
}

function normalize(source: string): string {
  return source.replace(/--[^\r\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeSqlStructure(sql: string): string {
  let normalized = '';
  let cursor = 0;
  let inLineComment = false;
  let blockCommentDepth = 0;
  let inSingleQuotedString = false;
  let dollarQuoteDelimiter: string | null = null;

  while (cursor < sql.length) {
    const current = sql[cursor] ?? '';
    const next = sql[cursor + 1] ?? '';

    if (dollarQuoteDelimiter !== null) {
      if (sql.startsWith(dollarQuoteDelimiter, cursor)) {
        cursor += dollarQuoteDelimiter.length;
        dollarQuoteDelimiter = null;
        continue;
      }
      cursor += 1;
      continue;
    }

    if (inSingleQuotedString) {
      if (current === "'" && next === "'") {
        cursor += 2;
        continue;
      }
      if (current === "'") {
        inSingleQuotedString = false;
      }
      cursor += 1;
      continue;
    }

    if (inLineComment) {
      if (current === '\r' || current === '\n') {
        inLineComment = false;
        normalized += ' ';
      }
      cursor += 1;
      continue;
    }

    if (blockCommentDepth > 0) {
      if (current === '/' && next === '*') {
        blockCommentDepth += 1;
        cursor += 2;
        continue;
      }
      if (current === '*' && next === '/') {
        blockCommentDepth -= 1;
        cursor += 2;
        if (blockCommentDepth === 0) {
          normalized += ' ';
        }
        continue;
      }
      cursor += 1;
      continue;
    }

    if (current === '-' && next === '-') {
      inLineComment = true;
      cursor += 2;
      continue;
    }

    if (current === '/' && next === '*') {
      blockCommentDepth = 1;
      cursor += 2;
      continue;
    }

    if (current === "'") {
      inSingleQuotedString = true;
      normalized += "''";
      cursor += 1;
      continue;
    }

    const nextDollarQuoteDelimiter = readDollarQuoteDelimiter(sql, cursor);
    if (nextDollarQuoteDelimiter !== null) {
      dollarQuoteDelimiter = nextDollarQuoteDelimiter;
      normalized += "''";
      cursor += nextDollarQuoteDelimiter.length;
      continue;
    }

    normalized += current;
    cursor += 1;
  }

  if (blockCommentDepth > 0) {
    throw new Error('Malformed SQL: unterminated block comment');
  }
  if (inSingleQuotedString) {
    throw new Error('Malformed SQL: unterminated single-quoted string');
  }
  if (dollarQuoteDelimiter !== null) {
    throw new Error('Malformed SQL: unterminated dollar-quoted string');
  }

  return normalized.replace(/\s+/g, ' ').trim().toLowerCase();
}

function readDollarQuoteDelimiter(sql: string, cursor: number): string | null {
  if ((sql[cursor] ?? '') !== '$') {
    return null;
  }

  let end = cursor + 1;
  while (end < sql.length) {
    const current = sql[end] ?? '';
    if (current === '$') {
      const tag = sql.slice(cursor + 1, end);
      if (tag.length === 0) {
        return '$$';
      }
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(tag) ? `$${tag}$` : null;
    }

    const isValidTagCharacter = end === cursor + 1
      ? /[A-Za-z_]/.test(current)
      : /[A-Za-z0-9_]/.test(current);
    if (!isValidTagCharacter) {
      return null;
    }
    end += 1;
  }

  return null;
}

const retiredBlockedUntilIndexCreatePattern =
  /\bcreate\s+(?:unique\s+)?index(?:\s+concurrently)?(?:\s+if\s+not\s+exists)?\s+(?:"idx_widget_request_rate_limits_blocked_until"|idx_widget_request_rate_limits_blocked_until)\s+on\b/;

function hasRetiredBlockedUntilIndexCreate(sql: string): boolean {
  return retiredBlockedUntilIndexCreatePattern.test(normalizeSqlStructure(sql));
}

function findMigration(): string | null {
  const migrationsDirectory = path.join(process.cwd(), 'supabase', 'migrations');
  const matches = fs.readdirSync(migrationsDirectory)
    .filter(name => name.endsWith(migrationSuffix))
    .sort();
  expect(matches).toHaveLength(1);
  return matches.length === 1 ? path.join('supabase', 'migrations', matches[0]) : null;
}

function collectRuntimeTypeScript(relativeDir: string): string[] {
  const absoluteDir = path.join(process.cwd(), relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];

  return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap(entry => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) return collectRuntimeTypeScript(relativePath);
    const normalizedPath = relativePath.replaceAll('\\', '/');
    if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
    if (
      normalizedPath.includes('/tests/')
      || normalizedPath.includes('.spec.')
      || normalizedPath.includes('.test.')
      || normalizedPath.includes('spec-helpers')
      || normalizedPath.endsWith('/types/supabase.ts')
      || normalizedPath.endsWith('/models/supabase-types.ts')
    ) {
      return [];
    }
    return [relativePath];
  });
}

describe('Widget operational retention', () => {
  it('adds bounded retention indexes and an atomic owner-only cleanup function', () => {
    const migrationPath = findMigration();
    if (!migrationPath) return;
    const sql = normalize(read(migrationPath));

    expect(sql).toContain("set local lock_timeout = '2s';");
    expect(sql).toContain("set local statement_timeout = '30s';");
    expect(sql).toContain(
      'create index if not exists idx_widget_notify_events_retention on public.widget_notify_events (processed_at, webhook_id);',
    );
    expect(sql).toContain(
      'create index if not exists idx_widget_request_rate_limits_retention on public.widget_request_rate_limits (updated_at, scope_type, scope_key);',
    );
    expect(sql).toContain('create or replace function public.cleanup_widget_operational_state(');
    expect(sql).toContain("p_retention interval default interval '30 days'");
    expect(sql).toContain('p_batch_size integer default 5000');
    expect(sql).toContain('returns jsonb');
    expect(sql).toContain('security definer');
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain("using errcode = '22023'");
    expect(sql).toContain("p_retention < interval '1 day'");
    expect(sql).toContain("p_retention > interval '365 days'");
    expect(sql).toContain('p_batch_size < 1');
    expect(sql).toContain('p_batch_size > 10000');
    expect(sql).toContain('events.processed_at < v_now - p_retention');
    expect(sql).toContain('order by events.processed_at, events.webhook_id');
    expect(sql).toContain('for update of events skip locked');
    expect(sql).toContain('limit p_batch_size');
    expect(sql).toContain('limits.updated_at < v_now - p_retention');
    expect(sql).toContain(
      '(limits.blocked_until is null or limits.blocked_until <= v_now)',
    );
    expect(sql).toContain('order by limits.updated_at, limits.scope_type, limits.scope_key');
    expect(sql).toContain('for update of limits skip locked');
    expect(sql).toContain("'widget_operational_retention'");
    expect(sql).toContain("'widget_notify_events_deleted'");
    expect(sql).toContain("'widget_request_rate_limits_deleted'");
    expect(sql).toContain('set local statement_timeout = default;');
    expect(sql).toContain('set local lock_timeout = default;');
    expect(sql).not.toContain('create index concurrently');
    expect(sql).not.toContain('begin;');
    expect(sql).not.toContain('commit;');
  });

  it('keeps cleanup owner-only and conditionally schedules the canonical daily job', () => {
    const migrationPath = findMigration();
    if (!migrationPath) return;
    const sql = normalize(read(migrationPath));

    expect(sql).toContain(
      'revoke all on function public.cleanup_widget_operational_state(interval, integer) from public, anon, authenticated, service_role;',
    );
    expect(sql).not.toContain(
      'grant execute on function public.cleanup_widget_operational_state(interval, integer) to service_role;',
    );
    expect(sql).toContain("to_regclass('cron.job') is null");
    expect(sql).toContain(
      "to_regprocedure('public.cleanup_widget_operational_state(interval,integer)') is null",
    );
    expect(sql).toContain("where jobname = 'nanoflow-widget-operational-retention'");
    expect(sql).toContain('perform cron.unschedule(v_job.jobid)');
    expect(sql).toContain(
      "perform cron.schedule( 'nanoflow-widget-operational-retention', '40 3 * * *', $job$select public.cleanup_widget_operational_state();$job$ )",
    );
  });

  it('keeps fresh-init and migration replay converged at or after version 7.51.0', () => {
    expect(isSupabaseInitVersionAtLeast(CURRENT_SUPABASE_INIT_VERSION, '7.51.0')).toBe(true);
    const initSource = read(initPath);
    expect(initSource).toContain(`-- 版本: ${CURRENT_SUPABASE_INIT_VERSION}`);

    const migrationPath = findMigration();
    if (!migrationPath) return;
    const migrationVersion = path.basename(migrationPath).slice(0, 14);
    const marker = `-- FINAL CONVERGENCE: ${migrationVersion} widget operational retention`;
    const markerIndex = initSource.lastIndexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const finalInit = normalize(markerIndex >= 0 ? initSource.slice(markerIndex) : '');

    expect(finalInit).toContain(
      'create or replace function public.cleanup_widget_operational_state(',
    );
    expect(finalInit).toContain("'nanoflow-widget-operational-retention'");
    expect(finalInit).toContain("'40 3 * * *'");
  });

  it('keeps the cron-only function outside runtime RPCs and the special migration manifest', () => {
    const runtimeSources = [
      ...collectRuntimeTypeScript('src'),
      ...collectRuntimeTypeScript('supabase/functions'),
    ].map(relativePath => ({ relativePath, source: read(relativePath) }));
    const callers = runtimeSources
      .filter(({ source }) => /\.rpc\(\s*['"]cleanup_widget_operational_state['"]/.test(source))
      .map(({ relativePath }) => relativePath);
    expect(callers).toEqual([]);

    const manifest = JSON.parse(read('scripts/migration-dry-run-manifest.json')) as {
      entries: Array<{ path: string }>;
    };
    expect(
      manifest.entries.find(entry => entry.path.endsWith(migrationSuffix)),
    ).toBeUndefined();
  }, 30_000);

  it('treats any real blocked_until CREATE INDEX variant as forbidden while ignoring comments', () => {
    const legacyCreateVariants = [
      'CREATE INDEX IF NOT EXISTS idx_widget_request_rate_limits_blocked_until ON public.widget_request_rate_limits (blocked_until) WHERE blocked_until IS NOT NULL;',
      'CREATE INDEX idx_widget_request_rate_limits_blocked_until ON public.widget_request_rate_limits USING BTREE (blocked_until) WHERE blocked_until IS NOT NULL;',
      'CREATE /* widget legacy comment */ INDEX idx_widget_request_rate_limits_blocked_until ON public.widget_request_rate_limits USING BTREE (blocked_until) WHERE blocked_until IS NOT NULL;',
      `CREATE
         INDEX
         IF NOT EXISTS
         idx_widget_request_rate_limits_blocked_until
         ON public.widget_request_rate_limits
         USING BTREE
         (blocked_until)
         WHERE blocked_until IS NOT NULL;`,
      'CrEaTe InDeX idx_widget_request_rate_limits_blocked_until ON public.widget_request_rate_limits (blocked_until) WHERE blocked_until IS NOT NULL;',
    ];

    for (const sql of legacyCreateVariants) {
      expect(hasRetiredBlockedUntilIndexCreate(sql)).toBe(true);
    }

    expect(hasRetiredBlockedUntilIndexCreate(`
      -- CREATE INDEX idx_widget_request_rate_limits_blocked_until
      --   ON public.widget_request_rate_limits USING BTREE (blocked_until)
      --   WHERE blocked_until IS NOT NULL;
    `)).toBe(false);
    expect(hasRetiredBlockedUntilIndexCreate(`
      /* CREATE INDEX idx_widget_request_rate_limits_blocked_until
         ON public.widget_request_rate_limits USING BTREE (blocked_until)
         WHERE blocked_until IS NOT NULL; */
    `)).toBe(false);
    expect(hasRetiredBlockedUntilIndexCreate(`
      DO $$
      BEGIN
        RAISE NOTICE 'create index idx_widget_request_rate_limits_blocked_until on public.widget_request_rate_limits using btree (blocked_until) where blocked_until is not null';
      END
      $$;
    `)).toBe(false);
  });

  it('fails closed on malformed SQL while preserving doubled single quotes inside strings', () => {
    expect(hasRetiredBlockedUntilIndexCreate(`
      SELECT 'owner''s diagnostic';
      CREATE INDEX idx_widget_request_rate_limits_blocked_until
        ON public.widget_request_rate_limits USING BTREE (blocked_until)
        WHERE blocked_until IS NOT NULL;
    `)).toBe(true);

    expect(() => normalizeSqlStructure(`
      /* CREATE INDEX idx_widget_request_rate_limits_blocked_until
         ON public.widget_request_rate_limits USING BTREE (blocked_until)
         WHERE blocked_until IS NOT NULL;
    `)).toThrow('Malformed SQL: unterminated block comment');
    expect(() => hasRetiredBlockedUntilIndexCreate(`
      /* CREATE INDEX idx_widget_request_rate_limits_blocked_until
         ON public.widget_request_rate_limits USING BTREE (blocked_until)
         WHERE blocked_until IS NOT NULL;
    `)).toThrow('Malformed SQL: unterminated block comment');

    expect(() => normalizeSqlStructure(`
      SELECT 'unterminated owner''s diagnostic
      CREATE INDEX idx_widget_request_rate_limits_blocked_until
        ON public.widget_request_rate_limits USING BTREE (blocked_until)
        WHERE blocked_until IS NOT NULL;
    `)).toThrow('Malformed SQL: unterminated single-quoted string');
    expect(() => hasRetiredBlockedUntilIndexCreate(`
      SELECT 'unterminated owner''s diagnostic
      CREATE INDEX idx_widget_request_rate_limits_blocked_until
        ON public.widget_request_rate_limits USING BTREE (blocked_until)
        WHERE blocked_until IS NOT NULL;
    `)).toThrow('Malformed SQL: unterminated single-quoted string');
  });

  it('ignores benign dollar-quoted payloads but still detects a real CREATE INDEX after closure', () => {
    expect(hasRetiredBlockedUntilIndexCreate(`
      DO $$
      BEGIN
        CREATE INDEX idx_widget_request_rate_limits_blocked_until
          ON public.widget_request_rate_limits USING BTREE (blocked_until)
          WHERE blocked_until IS NOT NULL;
      END
      $$;
    `)).toBe(false);

    expect(hasRetiredBlockedUntilIndexCreate(`
      SELECT $widget$
        CREATE INDEX idx_widget_request_rate_limits_blocked_until
          ON public.widget_request_rate_limits USING BTREE (blocked_until)
          WHERE blocked_until IS NOT NULL;
      $widget$;
    `)).toBe(false);

    expect(hasRetiredBlockedUntilIndexCreate(`
      SELECT $widget$
        benign payload with CREATE INDEX idx_widget_request_rate_limits_blocked_until
      $widget$;

      CREATE INDEX idx_widget_request_rate_limits_blocked_until
        ON public.widget_request_rate_limits USING BTREE (blocked_until)
        WHERE blocked_until IS NOT NULL;
    `)).toBe(true);
  });

  it('fails closed on mismatched or unterminated dollar-quoted strings', () => {
    expect(() => normalizeSqlStructure(`
      SELECT $widget$
        CREATE INDEX idx_widget_request_rate_limits_blocked_until
          ON public.widget_request_rate_limits USING BTREE (blocked_until)
          WHERE blocked_until IS NOT NULL;
      $other$;
    `)).toThrow('Malformed SQL: unterminated dollar-quoted string');
    expect(() => hasRetiredBlockedUntilIndexCreate(`
      SELECT $widget$
        CREATE INDEX idx_widget_request_rate_limits_blocked_until
          ON public.widget_request_rate_limits USING BTREE (blocked_until)
          WHERE blocked_until IS NOT NULL;
      $other$;
    `)).toThrow('Malformed SQL: unterminated dollar-quoted string');

    expect(() => normalizeSqlStructure(`
      SELECT $widget$
        CREATE INDEX idx_widget_request_rate_limits_blocked_until
          ON public.widget_request_rate_limits USING BTREE (blocked_until)
          WHERE blocked_until IS NOT NULL;
    `)).toThrow('Malformed SQL: unterminated dollar-quoted string');
    expect(() => hasRetiredBlockedUntilIndexCreate(`
      SELECT $widget$
        CREATE INDEX idx_widget_request_rate_limits_blocked_until
          ON public.widget_request_rate_limits USING BTREE (blocked_until)
          WHERE blocked_until IS NOT NULL;
    `)).toThrow('Malformed SQL: unterminated dollar-quoted string');
  });

  it('retires the unused blocked_until rate-limit index only after verifying its exact legacy shape', () => {
    const migrationAbsolutePath = path.join(
      process.cwd(),
      retiredBlockedUntilIndexMigrationPath,
    );
    expect(
      fs.existsSync(migrationAbsolutePath),
      `${retiredBlockedUntilIndexMigrationPath} should exist`,
    ).toBe(true);

    const migration = normalize(read(retiredBlockedUntilIndexMigrationPath));
    const initSource = read(initPath);
    const init = normalize(initSource);
    const manifest = JSON.parse(read(manifestPath)) as {
      entries: Array<{
        path: string;
      }>;
    };
    const matchingMigrationFiles = fs.readdirSync(path.join(process.cwd(), 'supabase/migrations'))
      .filter(name => name.includes('widget_request_rate_limits_blocked_until_unused_index_retirement'));

    expect(matchingMigrationFiles).toEqual([
      '20260728000500_widget_request_rate_limits_blocked_until_unused_index_retirement.sql',
    ]);

    for (const sql of [migration, init]) {
      expect(sql).toContain("to_regclass('public.idx_widget_request_rate_limits_blocked_until')");
      expect(sql).toContain("index_row.indrelid = 'public.widget_request_rate_limits'::regclass");
      expect(sql).toContain("access_method.amname = 'btree'");
      expect(sql).toContain('pg_get_indexdef(index_row.indexrelid)');
      expect(sql).toContain('pg_get_expr(index_row.indpred, index_row.indrelid)');
      expect(sql).toContain('idx_widget_request_rate_limits_blocked_until');
      expect(sql).toContain('widget_request_rate_limits');
      expect(sql).toContain("index_row.indnkeyatts = 1");
      expect(sql).toContain("index_row.indnatts = 1");
      expect(sql).toContain('index_row.indexprs is null');
      expect(sql).toContain('index_row.indpred is not null');
      expect(sql).toContain(
        "'create index idx_widget_request_rate_limits_blocked_until on public.widget_request_rate_limits using btree (blocked_until) where (blocked_until is not null)'",
      );
      expect(sql).toContain("'(blocked_until is not null)'");
      expect(sql).toContain("set local lock_timeout = '2s';");
      expect(sql).toContain('drop index if exists public.idx_widget_request_rate_limits_blocked_until;');
      expect(sql).toContain('set local lock_timeout = default;');
      expect(sql).not.toContain('drop index concurrently');
      expect(sql).not.toContain('begin;');
      expect(sql).not.toContain('commit;');
    }

    expect(init).toContain('primary key (scope_type, scope_key)');
    expect(init).toContain(
      'create index if not exists idx_widget_request_rate_limits_retention on public.widget_request_rate_limits (updated_at, scope_type, scope_key);',
    );
    expect(initSource.toLowerCase()).toContain(
      '-- final convergence: 20260728000500 widget request rate limits blocked until unused index retirement',
    );
    expect(hasRetiredBlockedUntilIndexCreate(initSource)).toBe(false);
    expect(
      manifest.entries.find(
        entry => entry.path === retiredBlockedUntilIndexMigrationPath,
      ),
    ).toBeUndefined();
  });
});
