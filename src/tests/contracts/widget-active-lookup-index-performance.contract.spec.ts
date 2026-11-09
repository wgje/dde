import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const notifyFunctionPath = 'supabase/functions/widget-notify/index.ts';
const createMigrationPath =
  'supabase/migrations/20260715018400_widget_active_lookup_indexes.sql';
const cleanupMigrationPath =
  'supabase/migrations/20260715018500_widget_active_lookup_index_cleanup.sql';
const boundedFanoutMigrationPath =
  'supabase/migrations/20260716001000_widget_notify_bounded_fanout_rpc.sql';
const expiresAtRetirementMigrationPath =
  'supabase/migrations/20260728000600_widget_devices_expires_at_unused_index_retirement.sql';
const registerFunctionPath = 'supabase/functions/widget-register/index.ts';
const summaryFunctionPath = 'supabase/functions/widget-summary/index.ts';
const focusActionFunctionPath = 'supabase/functions/widget-focus-action/index.ts';
const blackBoxActionFunctionPath = 'supabase/functions/widget-black-box-action/index.ts';
const migrationManifestPath = 'scripts/migration-dry-run-manifest.json';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function stripSqlLineComments(value: string): string {
  return value.replace(/^--.*$/gm, '');
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

const retiredWidgetDevicesExpiresAtIndexCreatePattern =
  /\bcreate\s+(?:unique\s+)?index(?:\s+concurrently)?(?:\s+if\s+not\s+exists)?\s+(?:"idx_widget_devices_expires_at"|idx_widget_devices_expires_at)\s+on\b/;

function hasRetiredWidgetDevicesExpiresAtIndexCreate(sql: string): boolean {
  return retiredWidgetDevicesExpiresAtIndexCreatePattern.test(normalizeSqlStructure(sql));
}

describe('widget active lookup index performance contract', () => {
  it('keeps active device lookups aligned with owner/platform/activity semantics instead of expires_at-leading access', () => {
    const notifyFunction = normalize(read(notifyFunctionPath));
    const registerFunction = normalize(read(registerFunctionPath));
    const summaryFunction = normalize(read(summaryFunctionPath));
    const focusActionFunction = normalize(read(focusActionFunctionPath));
    const blackBoxActionFunction = normalize(read(blackBoxActionFunctionPath));
    const boundedFanoutMigration = normalize(read(boundedFanoutMigrationPath));
    const initSource = read(initPath);
    const init = normalize(initSource);

    expect(notifyFunction).toContain(".rpc<widgetdevicerow[]>('list_widget_notify_devices'");
    for (const sql of [boundedFanoutMigration, init]) {
      expect(sql).toContain('device.user_id = p_user_id');
      expect(sql).toContain("device.platform = 'android-widget'");
      expect(sql).toContain('device.revoked_at is null');
      expect(sql).toContain('instance.user_id = p_user_id');
      expect(sql).toContain("instance.platform = 'android-widget'");
      expect(sql).toContain('instance.uninstalled_at is null');
      expect(sql).toContain('order by device.last_seen_at desc, device.id asc');
      expect(sql).not.toContain('order by device.expires_at');
    }

    expect(init).toContain(
      'create index if not exists idx_widget_devices_active_owner_platform on public.widget_devices (user_id, platform) where revoked_at is null;',
    );
    expect(init).toContain(
      'create index if not exists idx_widget_instances_active_owner_platform on public.widget_instances (user_id, platform) include (device_id, binding_generation) where uninstalled_at is null;',
    );
    expect(init).toContain('unique (device_id, host_instance_id)');
    expect(hasRetiredWidgetDevicesExpiresAtIndexCreate(initSource)).toBe(false);
    expect(init).not.toContain('idx_widget_devices_user_platform_active');
    expect(init).not.toContain('idx_widget_instances_device_active');
    expect(init).not.toContain('idx_widget_instances_user_platform');

    expect(registerFunction).toContain(".eq('installation_id', installationid)");
    expect(registerFunction).toContain(".eq('id', deviceid)");
    expect(summaryFunction).toContain(".eq('token_hash', tokenhash)");
    expect(summaryFunction).toContain(".eq('id', deviceid)");
    expect(focusActionFunction).toContain(".eq('token_hash', tokenhash)");
    expect(focusActionFunction).toContain(".eq('id', parsed.deviceid)");
    expect(blackBoxActionFunction).toContain(".eq('token_hash', tokenhash)");
    expect(blackBoxActionFunction).toContain(".eq('id', parsed.deviceid)");

    for (const content of [
      notifyFunction,
      registerFunction,
      summaryFunction,
      focusActionFunction,
      blackBoxActionFunction,
    ]) {
      expect(content).not.toContain(".order('expires_at'");
      expect(content).not.toContain(".gt('expires_at'");
      expect(content).not.toContain(".gte('expires_at'");
      expect(content).not.toContain(".lt('expires_at'");
      expect(content).not.toContain(".lte('expires_at'");
    }
  });

  it('builds replacement indexes concurrently before cleanup', () => {
    const migration = normalize(read(createMigrationPath));

    expect(migration).toContain(
      'create index if not exists idx_widget_devices_active_owner_platform on public.widget_devices (user_id, platform) where revoked_at is null;',
    );
    expect(migration).toContain(
      'create index if not exists idx_widget_instances_active_owner_platform on public.widget_instances (user_id, platform) include (device_id, binding_generation) where uninstalled_at is null;',
    );
    expect(migration).not.toContain('create index concurrently');
    expect(migration).not.toContain('drop index concurrently');
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
  });

  it('validates replacements and the device uniqueness cover before fail-fast cleanup', () => {
    const migration = normalize(read(cleanupMigrationPath));

    expect(migration).toContain("to_regclass('public.idx_widget_devices_active_owner_platform')");
    expect(migration).toContain("to_regclass('public.idx_widget_instances_active_owner_platform')");
    expect(migration).toContain('index_row.indisvalid');
    expect(migration).toContain('index_row.indisready');
    expect(migration).toContain('index_row.indnkeyatts = 2');
    expect(migration).toContain('index_row.indnatts = 4');
    expect(migration).toContain("pg_get_expr(index_row.indpred, index_row.indrelid) ilike '%uninstalled_at is null%'");
    expect(migration).toContain("constraint_row.contype = 'u'");
    expect(migration).toContain("attribute_row.attname = 'device_id'");
    expect(migration).toContain("attribute_row.attname = 'host_instance_id'");
    expect(migration).toContain("set local lock_timeout = '2s';");
    expect(migration).toContain('drop index if exists public.idx_widget_devices_user_platform_active;');
    expect(migration).toContain('drop index if exists public.idx_widget_instances_device_active;');
    expect(migration).toContain('drop index if exists public.idx_widget_instances_user_platform;');
    expect(migration).toContain('set local lock_timeout = default;');
    expect(migration).not.toContain('drop index concurrently');
  });

  it('keeps pipeline-safe migrations out of the dry-run manifest and records rollback SQL', () => {
    const cleanupMigration = normalize(read(cleanupMigrationPath));
    const createMigration = normalize(read(createMigrationPath));
    const manifest = JSON.parse(read(migrationManifestPath)) as {
      entries: Array<{
        path: string;
        category: string;
        reason: string;
        rollbackStrategy: string;
        requiresDataSafetyExport: boolean;
      }>;
    };
    const createEntry = manifest.entries.find(item => item.path === createMigrationPath);
    const cleanupEntry = manifest.entries.find(item => item.path === cleanupMigrationPath);

    expect(createEntry).toBeUndefined();
    expect(cleanupEntry).toBeUndefined();
    expect(createMigration).not.toContain('concurrently');
    expect(cleanupMigration).toContain(
      'rollback: create index concurrently idx_widget_devices_user_platform_active on public.widget_devices(user_id, platform, updated_at desc) where revoked_at is null;',
    );
    expect(cleanupMigration).toContain(
      'rollback: create index concurrently idx_widget_instances_device_active on public.widget_instances(device_id, updated_at desc) where uninstalled_at is null;',
    );
    expect(cleanupMigration).toContain(
      'rollback: create index concurrently idx_widget_instances_user_platform on public.widget_instances(user_id, platform, updated_at desc);',
    );
  });

  it('retires the legacy widget device expiry index only after exact identity verification', () => {
    const migration = normalize(stripSqlLineComments(read(expiresAtRetirementMigrationPath)));

    expect(migration).toContain("to_regclass('public.idx_widget_devices_expires_at')");
    expect(migration).toContain("and index_row.indrelid = 'public.widget_devices'::regclass");
    expect(migration).toContain('and index_row.indisvalid');
    expect(migration).toContain('and index_row.indisready');
    expect(migration).toContain('and index_row.indnkeyatts = 1');
    expect(migration).toContain('and index_row.indnatts = 1');
    expect(migration).toContain('and index_row.indexprs is null');
    expect(migration).toContain('and index_row.indpred is null');
    expect(migration).toContain("and access_method.amname = 'btree'");
    expect(migration).toContain(
      "'create index idx_widget_devices_expires_at on public.widget_devices using btree (expires_at)'",
    );
    expect(migration).toContain('or normalized_predicate is not null');
    expect(migration).toContain("set local lock_timeout = '2s';");
    expect(migration).toContain('drop index if exists public.idx_widget_devices_expires_at;');
    expect(migration).toContain('set local lock_timeout = default;');
    expect(migration).not.toContain('drop index concurrently');
    expect(migration).not.toContain('insert into public.widget_devices');
    expect(migration).not.toContain('update public.widget_devices');
    expect(migration).not.toContain('delete from public.widget_devices');
  });

  it('keeps the expiry-index retirement out of the dry-run manifest and records rollback-only recovery', () => {
    const migrationWithComments = normalize(read(expiresAtRetirementMigrationPath));
    const manifest = JSON.parse(read(migrationManifestPath)) as {
      entries: Array<{ path: string }>;
    };

    expect(manifest.entries.find(item => item.path === expiresAtRetirementMigrationPath)).toBeUndefined();
    expect(migrationWithComments).toContain(
      'rollback: create index concurrently if not exists idx_widget_devices_expires_at on public.widget_devices(expires_at);',
    );
  });
});
