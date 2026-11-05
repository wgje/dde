import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const indexMigrationPath =
  'supabase/migrations/20260716001500_dr_maintenance_cleanup_indexes.sql';
const functionMigrationPath =
  'supabase/migrations/20260716001600_dr_maintenance_batched_cleanup.sql';
const quarantineUserReasonUnusedIndexRetirementMigrationPath =
  'supabase/migrations/20260728000400_sync_write_quarantine_user_reason_unused_index_retirement.sql';
const initPath = 'scripts/init-supabase.sql';
const manifestPath = 'scripts/migration-dry-run-manifest.json';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
}

function normalize(sql: string): string {
  return sql.replace(/--[^\r\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeSqlStructure(sql: string): string {
  let normalized = '';
  let cursor = 0;
  let inLineComment = false;
  let blockCommentDepth = 0;
  let inSingleQuotedString = false;

  while (cursor < sql.length) {
    const current = sql[cursor] ?? '';
    const next = sql[cursor + 1] ?? '';

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

    normalized += current;
    cursor += 1;
  }

  if (blockCommentDepth > 0) {
    throw new Error('Malformed SQL: unterminated block comment');
  }
  if (inSingleQuotedString) {
    throw new Error('Malformed SQL: unterminated single-quoted string');
  }

  return normalized.replace(/\s+/g, ' ').trim().toLowerCase();
}

function functionDefinition(sql: string, signature: string): string {
  const start = sql.lastIndexOf(signature);
  expect(start, `${signature} should exist`).toBeGreaterThanOrEqual(0);
  if (start < 0) return '';
  const end = sql.indexOf('$$;', start);
  expect(end, `${signature} should terminate`).toBeGreaterThan(start);
  return end > start ? sql.slice(start, end + 3) : '';
}

const retiredQuarantineUserReasonIndexCreatePattern =
  /\bcreate\s+(?:unique\s+)?index(?:\s+concurrently)?(?:\s+if\s+not\s+exists)?\s+(?:"sync_write_quarantine_user_reason_idx"|sync_write_quarantine_user_reason_idx)\s+on\b/;

function hasRetiredQuarantineUserReasonIndexCreate(sql: string): boolean {
  return retiredQuarantineUserReasonIndexCreatePattern.test(normalizeSqlStructure(sql));
}

function expectBoundedFunctions(sql: string): void {
  const normalized = normalize(sql);

  expect(normalized).toContain(
    "create or replace function public.purge_expired_sync_write_quarantine() returns integer language plpgsql security definer set search_path = ''",
  );
  expect(normalized).toContain(
    'select quarantine.id from public.sync_write_quarantine as quarantine where quarantine.expires_at < now() and quarantine.reviewed_at is null order by quarantine.expires_at asc, quarantine.id asc limit v_batch_size for update of quarantine skip locked',
  );
  expect(normalized).toContain(
    'delete from public.sync_write_quarantine as quarantine using candidates where quarantine.id = candidates.id returning 1',
  );

  expect(normalized).toContain(
    "create or replace function public.archive_old_task_change_audit( p_retention interval default interval '180 days' ) returns integer language plpgsql security definer set search_path = ''",
  );
  expect(normalized).toContain(
    "if p_retention is null or p_retention <= interval '0' then raise exception 'p_retention must be a positive interval' using errcode = '22023'; end if;",
  );
  expect(normalized).toContain(
    'select audit.id from public.task_change_audit as audit where audit.changed_at < now() - p_retention order by audit.changed_at asc, audit.id asc limit v_batch_size for update of audit skip locked',
  );
  expect(normalized).toContain(
    'delete from public.task_change_audit as audit using candidates where audit.id = candidates.id returning audit.*',
  );
  expect(normalized).toContain(
    'insert into public.task_change_audit_archive overriding system value select * from moved on conflict (id) do nothing;',
  );
  expect(functionDefinition(
    normalized,
    'create or replace function public.purge_expired_sync_write_quarantine()',
  )).toContain('v_batch_size constant integer := 5000;');
  expect(functionDefinition(
    normalized,
    'create or replace function public.archive_old_task_change_audit(',
  )).toContain('v_batch_size constant integer := 5000;');

  expect(normalized).toContain(
    'revoke all on function public.purge_expired_sync_write_quarantine() from public, anon, authenticated, service_role;',
  );
  expect(normalized).toContain(
    'grant execute on function public.purge_expired_sync_write_quarantine() to service_role;',
  );
  expect(normalized).toContain(
    'revoke all on function public.archive_old_task_change_audit(interval) from public, anon, authenticated, service_role;',
  );
  expect(normalized).toContain(
    'grant execute on function public.archive_old_task_change_audit(interval) to service_role;',
  );
}

describe('DR maintenance bounded cleanup and index performance', () => {
  it('creates cursor indexes inside the reset transaction and defers the obsolete drop to a short-lock migration', () => {
    const migration = normalize(read(indexMigrationPath));
    expect(migration).toContain(
      'create index if not exists idx_sync_write_quarantine_expired_cursor on public.sync_write_quarantine (expires_at, id) where reviewed_at is null;',
    );
    expect(migration).toContain(
      'create index if not exists idx_task_change_audit_archive_cursor on public.task_change_audit (changed_at, id);',
    );
    expect(migration).not.toContain('concurrently');
    expect(migration).toContain("set local lock_timeout = '2s';");
    expect(migration).toContain("set local statement_timeout = '30s';");
    expect(migration).toContain('set local lock_timeout = default;');
    expect(migration).toContain('set local statement_timeout = default;');
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');

    const cleanupMigration = normalize(read(functionMigrationPath));
    expect(cleanupMigration).toContain("set local lock_timeout = '5s';");
    expect(cleanupMigration).toContain(
      'drop index if exists public.sync_write_quarantine_expires_idx;',
    );
  });

  it('bounds both scheduled maintenance functions and keeps fresh-init aligned', () => {
    expectBoundedFunctions(read(functionMigrationPath));
    expectBoundedFunctions(read(initPath));

    const init = normalize(read(initPath));
    expect(init).toContain(
      'create index if not exists idx_sync_write_quarantine_expired_cursor on public.sync_write_quarantine (expires_at, id) where reviewed_at is null;',
    );
    expect(init).toContain(
      'create index if not exists idx_task_change_audit_archive_cursor on public.task_change_audit (changed_at, id);',
    );
    expect(init).not.toContain(
      'create index if not exists sync_write_quarantine_expires_idx on public.sync_write_quarantine (expires_at)',
    );
  });

  it('does not register the transaction-safe index migration in the dry-run manifest', () => {
    const manifest = JSON.parse(read(manifestPath)) as {
      entries: Array<{
        path: string;
        category: string;
        rollbackStrategy: string;
        requiresDataSafetyExport: boolean;
      }>;
    };
    expect(
      manifest.entries.find(item => item.path === indexMigrationPath),
    ).toBeUndefined();
  });

  it('treats any real legacy quarantine user/reason CREATE INDEX variant as forbidden while ignoring comments', () => {
    const legacyCreateVariants = [
      'CREATE INDEX IF NOT EXISTS sync_write_quarantine_user_reason_idx ON public.sync_write_quarantine (user_id, reason, created_at DESC);',
      'CREATE INDEX sync_write_quarantine_user_reason_idx ON public.sync_write_quarantine USING BTREE (user_id, reason, created_at DESC);',
      'CREATE /* owner-only legacy comment */ INDEX sync_write_quarantine_user_reason_idx ON public.sync_write_quarantine USING BTREE (user_id, reason, created_at DESC);',
      `CREATE
         INDEX
         IF NOT EXISTS
         sync_write_quarantine_user_reason_idx
         ON public.sync_write_quarantine
         USING BTREE
         (user_id, reason, created_at DESC);`,
      'CrEaTe InDeX sync_write_quarantine_user_reason_idx ON public.sync_write_quarantine (user_id, reason, created_at DESC);',
    ];

    for (const sql of legacyCreateVariants) {
      expect(hasRetiredQuarantineUserReasonIndexCreate(sql)).toBe(true);
    }

    expect(hasRetiredQuarantineUserReasonIndexCreate(`
      -- CREATE INDEX sync_write_quarantine_user_reason_idx
      --   ON public.sync_write_quarantine USING BTREE (user_id, reason, created_at DESC);
    `)).toBe(false);
    expect(hasRetiredQuarantineUserReasonIndexCreate(`
      /* CREATE INDEX sync_write_quarantine_user_reason_idx
         ON public.sync_write_quarantine USING BTREE (user_id, reason, created_at DESC); */
    `)).toBe(false);
    expect(hasRetiredQuarantineUserReasonIndexCreate(`
      RAISE EXCEPTION 'create index sync_write_quarantine_user_reason_idx on public.sync_write_quarantine using btree (user_id, reason, created_at desc)';
    `)).toBe(false);
  });

  it('fails closed on malformed SQL while preserving doubled single quotes inside strings', () => {
    expect(hasRetiredQuarantineUserReasonIndexCreate(`
      SELECT 'owner''s diagnostic';
      CREATE INDEX sync_write_quarantine_user_reason_idx
        ON public.sync_write_quarantine USING BTREE (user_id, reason, created_at DESC);
    `)).toBe(true);

    expect(() => normalizeSqlStructure(`
      /* CREATE INDEX sync_write_quarantine_user_reason_idx
         ON public.sync_write_quarantine USING BTREE (user_id, reason, created_at DESC);
    `)).toThrow('Malformed SQL: unterminated block comment');
    expect(() => hasRetiredQuarantineUserReasonIndexCreate(`
      /* CREATE INDEX sync_write_quarantine_user_reason_idx
         ON public.sync_write_quarantine USING BTREE (user_id, reason, created_at DESC);
    `)).toThrow('Malformed SQL: unterminated block comment');

    expect(() => normalizeSqlStructure(`
      SELECT 'unterminated owner''s diagnostic
      CREATE INDEX sync_write_quarantine_user_reason_idx
        ON public.sync_write_quarantine USING BTREE (user_id, reason, created_at DESC);
    `)).toThrow('Malformed SQL: unterminated single-quoted string');
    expect(() => hasRetiredQuarantineUserReasonIndexCreate(`
      SELECT 'unterminated owner''s diagnostic
      CREATE INDEX sync_write_quarantine_user_reason_idx
        ON public.sync_write_quarantine USING BTREE (user_id, reason, created_at DESC);
    `)).toThrow('Malformed SQL: unterminated single-quoted string');
  });

  it('retires the unused sync_write_quarantine user/reason index only after verifying its exact legacy shape', () => {
    const migrationAbsolutePath = path.join(
      process.cwd(),
      quarantineUserReasonUnusedIndexRetirementMigrationPath,
    );
    expect(
      fs.existsSync(migrationAbsolutePath),
      `${quarantineUserReasonUnusedIndexRetirementMigrationPath} should exist`,
    ).toBe(true);

    const migration = normalize(read(quarantineUserReasonUnusedIndexRetirementMigrationPath));
    const initSource = read(initPath);
    const init = normalize(initSource);
    const manifest = JSON.parse(read(manifestPath)) as {
      entries: Array<{
        path: string;
      }>;
    };
    const matchingMigrationFiles = fs.readdirSync(path.join(process.cwd(), 'supabase/migrations'))
      .filter(name => name.includes('sync_write_quarantine_user_reason_unused_index_retirement'));

    expect(matchingMigrationFiles).toEqual([
      '20260728000400_sync_write_quarantine_user_reason_unused_index_retirement.sql',
    ]);

    for (const sql of [migration, init]) {
      expect(sql).toContain("to_regclass('public.sync_write_quarantine_user_reason_idx')");
      expect(sql).toContain("index_row.indrelid = 'public.sync_write_quarantine'::regclass");
      expect(sql).toContain('pg_get_indexdef(index_row.indexrelid)');
      expect(sql).toContain('pg_get_expr(index_row.indpred, index_row.indrelid)');
      expect(sql).toContain('user_id, reason, created_at desc');
      expect(sql).toContain("index_row.indnkeyatts = 3");
      expect(sql).toContain("index_row.indnatts = 3");
      expect(sql).toContain('index_row.indexprs is null');
      expect(sql).toContain('index_row.indpred is null');
      expect(sql).toContain("set local lock_timeout = '2s';");
      expect(sql).toContain('drop index if exists public.sync_write_quarantine_user_reason_idx;');
      expect(sql).toContain('set local lock_timeout = default;');
      expect(sql).not.toContain('drop index concurrently');
      expect(sql).not.toContain('begin;');
      expect(sql).not.toContain('commit;');
    }

    expect(initSource.toLowerCase()).toContain(
      '-- final convergence: 20260728000400 sync_write_quarantine user reason unused index retirement',
    );
    expect(init).toContain(
      'create index if not exists idx_sync_write_quarantine_expired_cursor on public.sync_write_quarantine (expires_at, id) where reviewed_at is null;',
    );
    expect(hasRetiredQuarantineUserReasonIndexCreate(initSource)).toBe(false);
    expect(
      manifest.entries.find(
        item => item.path === quarantineUserReasonUnusedIndexRetirementMigrationPath,
      ),
    ).toBeUndefined();
  });
});
