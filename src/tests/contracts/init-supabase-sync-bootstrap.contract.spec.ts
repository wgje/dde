import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const initScriptPath = 'scripts/init-supabase.sql';
const dropEntityUuidDefaultsMigrationPath =
  'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql';
const payloadDigestIndexRetirementMigrationPath =
  'supabase/migrations/20260728000700_sync_operation_log_payload_digest_unused_index_retirement.sql';
const entityCreatedIndexRetirementMigrationPath =
  'supabase/migrations/20260728000800_sync_operation_log_entity_created_unused_index_retirement.sql';
const taskChangeAuditArchiveIndexRetirements = [
  { version: '20260728000900', label: 'project', column: 'project_id' },
  { version: '20260728001000', label: 'task', column: 'task_id' },
  { version: '20260728001100', label: 'owner', column: 'owner_id' },
] as const;
type TaskChangeAuditArchiveIndexRetirement = (typeof taskChangeAuditArchiveIndexRetirements)[number];
const migrationDryRunManifestPath = 'scripts/migration-dry-run-manifest.json';

function readInitScript(): string {
  return fs.readFileSync(path.join(process.cwd(), initScriptPath), 'utf8');
}

function readModelDatabaseTypes(): string {
  return [
    'src/models/supabase-types.ts',
    'src/models/supabase-auxiliary-types.ts',
  ]
    .map(relativePath => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8'))
    .join('\n');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

function readDollarQuoteDelimiter(sql: string, cursor: number): string | null {
  if ((sql[cursor] ?? '') !== '$') return null;

  let end = cursor + 1;
  while (end < sql.length) {
    const current = sql[end] ?? '';
    if (current === '$') {
      const tag = sql.slice(cursor + 1, end);
      if (tag.length === 0) return '$$';
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(tag) ? `$${tag}$` : null;
    }

    const valid = end === cursor + 1
      ? /[A-Za-z_]/.test(current)
      : /[A-Za-z0-9_]/.test(current);
    if (!valid) return null;
    end += 1;
  }

  return null;
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
      } else {
        cursor += 1;
      }
      continue;
    }

    if (inSingleQuotedString) {
      if (current === "'" && next === "'") {
        cursor += 2;
        continue;
      }
      if (current === "'") inSingleQuotedString = false;
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
        if (blockCommentDepth === 0) normalized += ' ';
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
    if (current === '"') {
      let end = cursor + 1;
      let identifier = '';
      let terminated = false;
      while (end < sql.length) {
        const identifierCurrent = sql[end] ?? '';
        const identifierNext = sql[end + 1] ?? '';
        if (identifierCurrent === '"' && identifierNext === '"') {
          identifier += '"';
          end += 2;
          continue;
        }
        if (identifierCurrent === '"') {
          terminated = true;
          end += 1;
          break;
        }
        identifier += identifierCurrent;
        end += 1;
      }
      if (!terminated) throw new Error('Malformed SQL: unterminated double-quoted identifier');
      normalized += `"${identifier.replace(/\s+/g, '_')}"`;
      cursor = end;
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

  if (blockCommentDepth > 0) throw new Error('Malformed SQL: unterminated block comment');
  if (inSingleQuotedString) throw new Error('Malformed SQL: unterminated single-quoted string');
  if (dollarQuoteDelimiter !== null) {
    throw new Error('Malformed SQL: unterminated dollar-quoted string');
  }

  return normalized.replace(/\s+/g, ' ').trim().toLowerCase();
}

const retiredPayloadDigestIndexCreatePattern =
  /\bcreate\s+(?:unique\s+)?index(?:\s+concurrently)?(?:\s+if\s+not\s+exists)?\s+(?:(?:"public"|public)\s*\.\s*)?(?:"idx_sync_operation_log_payload_digest"|idx_sync_operation_log_payload_digest)\s+on\b/;

function hasRetiredPayloadDigestIndexCreate(sql: string): boolean {
  return retiredPayloadDigestIndexCreatePattern.test(normalizeSqlStructure(sql));
}

const retiredEntityCreatedIndexCreatePattern =
  /\bcreate\s+(?:unique\s+)?index(?:\s+concurrently)?(?:\s+if\s+not\s+exists)?\s+(?:(?:"public"|public)\s*\.\s*)?(?:"idx_sync_operation_log_entity_created"|idx_sync_operation_log_entity_created)\s+on\b/;

function hasRetiredEntityCreatedIndexCreate(sql: string): boolean {
  return retiredEntityCreatedIndexCreatePattern.test(normalizeSqlStructure(sql));
}

function expectTaskChangeAuditArchiveIndexRetirement(
  sql: string,
  retirement: TaskChangeAuditArchiveIndexRetirement,
): void {
  const normalizedSql = normalize(sql.replace(/--[^\r\n]*/g, '')).toLowerCase();
  const indexName = `task_change_audit_archive_${retirement.column}_changed_at_idx`;
  const identityIndex = normalizedSql.indexOf(`target_index := to_regclass('public.${indexName}')`);
  const malformedIndex = normalizedSql.indexOf(
    `raise exception 'task_change_audit_archive ${retirement.label} legacy index is missing or invalid'`,
  );
  const lockTimeoutIndex = normalizedSql.indexOf("set local lock_timeout = '2s'");
  const dropIndex = normalizedSql.indexOf(`drop index if exists public.${indexName}`);
  const resetTimeoutIndex = normalizedSql.indexOf('set local lock_timeout = default');

  expect(normalizedSql).toContain('if target_index is not null then');
  expect(normalizedSql).toContain("index_row.indrelid = 'public.task_change_audit_archive'::regclass");
  expect(normalizedSql).toContain('index_row.indisvalid');
  expect(normalizedSql).toContain('index_row.indisready');
  expect(normalizedSql).toContain('index_row.indnkeyatts = 2');
  expect(normalizedSql).toContain('index_row.indnatts = 2');
  expect(normalizedSql).toContain('index_row.indexprs is null');
  expect(normalizedSql).toContain('index_row.indpred is null');
  expect(normalizedSql).toContain("access_method.amname = 'btree'");
  expect(normalizedSql).toContain(
    `'create index ${indexName} on public.task_change_audit_archive using btree (${retirement.column}, changed_at desc)'`,
  );
  expect(identityIndex).toBeGreaterThanOrEqual(0);
  expect(malformedIndex).toBeGreaterThan(identityIndex);
  expect(lockTimeoutIndex).toBeGreaterThan(malformedIndex);
  expect(dropIndex).toBeGreaterThan(lockTimeoutIndex);
  expect(resetTimeoutIndex).toBeGreaterThan(dropIndex);
  expect(normalizedSql.match(/\bdrop\s+index\b/g)).toHaveLength(1);
  expect(normalizedSql).not.toMatch(/\b(?:insert|update|delete)\s+(?:into|from|public\.)/);
  expect(normalizedSql).not.toMatch(/\b(?:begin|commit)\s*;/);
  expect(normalizedSql).not.toContain('concurrently');
}

function getTaskChangeAuditArchiveIndexRetirementSection(
  sql: string,
  retirement: TaskChangeAuditArchiveIndexRetirement,
): string {
  const marker = `-- Final convergence: ${retirement.version} task_change_audit_archive ${retirement.label} unused index retirement`;
  const start = sql.indexOf(marker);
  expect(start, `task_change_audit_archive ${retirement.label} retirement marker must exist`).toBeGreaterThanOrEqual(0);
  if (start < 0) return '';

  const retirementIndex = taskChangeAuditArchiveIndexRetirements.indexOf(retirement);
  const nextRetirement = taskChangeAuditArchiveIndexRetirements[retirementIndex + 1];
  const nextMarker = nextRetirement ? `-- Final convergence: ${nextRetirement.version} task_change_audit_archive ${nextRetirement.label} unused index retirement` : '';
  const endMarker = nextMarker !== '' && sql.includes(nextMarker) ? nextMarker : 'ALTER TABLE public.task_change_audit_archive ENABLE ROW LEVEL SECURITY;';
  const end = sql.indexOf(endMarker, start);
  expect(end, `task_change_audit_archive ${retirement.label} retirement section must terminate`).toBeGreaterThan(start);
  return end > start ? sql.slice(start, end) : '';
}

function getFunctionSection(sql: string, functionName: string): string {
  const pattern = new RegExp(
    String.raw`CREATE OR REPLACE FUNCTION public\.${functionName}\([\s\S]*?\n\$\$;`,
  );
  const match = sql.match(pattern);

  expect(match, `function ${functionName} not found in ${initScriptPath}`).not.toBeNull();

  return match?.[0] ?? '';
}

function getLastFunctionSection(sql: string, functionName: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${functionName}(`;
  const start = sql.lastIndexOf(marker);
  expect(start, `function ${functionName} not found in ${initScriptPath}`).toBeGreaterThanOrEqual(0);
  const rest = sql.slice(start);
  const end = rest.indexOf('\n$$;');
  expect(end, `function ${functionName} terminator not found in ${initScriptPath}`).toBeGreaterThanOrEqual(0);
  return rest.slice(0, end + '\n$$;'.length);
}

function getGeneratedInsertBlock(types: string, tableName: string): string {
  const lines = types.split(/\r?\n/);
  const tableStart = lines.findIndex(line => line.trim() === `${tableName}: {`);
  expect(tableStart, `${tableName} table type not found`).toBeGreaterThanOrEqual(0);
  const insertStart = lines.findIndex((line, index) => index > tableStart && line.trim() === 'Insert: {');
  expect(insertStart, `${tableName}.Insert type not found`).toBeGreaterThan(tableStart);
  const insertEnd = lines.findIndex((line, index) => index > insertStart && line.trim() === 'Update: {');
  expect(insertEnd, `${tableName}.Insert terminator not found`).toBeGreaterThan(insertStart);
  return lines.slice(insertStart, insertEnd).join('\n');
}

function getInterfaceBlock(types: string, interfaceName: string): string {
  const marker = `export interface ${interfaceName} {`;
  const start = types.indexOf(marker);
  expect(start, `${interfaceName} not found`).toBeGreaterThanOrEqual(0);
  const rest = types.slice(start);
  const end = rest.indexOf('\n}');
  expect(end, `${interfaceName} terminator not found`).toBeGreaterThanOrEqual(0);
  return rest.slice(0, end + '\n}'.length);
}

describe('init-supabase sync bootstrap final-state contract', () => {
  it('keeps domain entity IDs client-generated by omitting database UUID defaults', () => {
    const sql = readInitScript();
    const normalized = normalize(sql);

    for (const tableName of [
      'projects',
      'tasks',
      'connections',
      'user_preferences',
      'black_box_entries',
      'focus_sessions',
      'routine_tasks',
      'routine_completions',
    ]) {
      const tableStart = normalized.indexOf(`CREATE TABLE IF NOT EXISTS public.${tableName} (`);
      expect(tableStart, `${tableName} table not found`).toBeGreaterThanOrEqual(0);
      const tableEnd = normalized.indexOf(');', tableStart);
      expect(tableEnd, `${tableName} table terminator not found`).toBeGreaterThan(tableStart);
      const tableSection = normalized.slice(tableStart, tableEnd);

      expect(tableSection, `${tableName}.id must not have a database UUID default`).not.toMatch(
        /\bid\s+UUID\b[^,)]*\bDEFAULT\s+(?:extensions\.)?gen_random_uuid\(\)/i,
      );
      expect(tableSection, `${tableName}.id must remain the primary key`).toMatch(/\bid\s+UUID\b[^,)]*PRIMARY KEY/i);
    }
  });

  it('ships a forward migration that drops legacy database UUID defaults on domain entities', () => {
    const migration = fs.readFileSync(path.join(process.cwd(), dropEntityUuidDefaultsMigrationPath), 'utf8');

    for (const tableName of [
      'projects',
      'tasks',
      'connections',
      'user_preferences',
      'focus_sessions',
      'routine_tasks',
      'routine_completions',
      'black_box_entries',
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${tableName} ALTER COLUMN id DROP DEFAULT;`);
    }
  });

  it('fails closed and requires a data export before rewriting user preference identities', () => {
    const migration = fs.readFileSync(path.join(process.cwd(), dropEntityUuidDefaultsMigrationPath), 'utf8');
    const normalized = normalize(migration);
    const preflightIndex = migration.indexOf('DO $user_preferences_identity_preflight$');
    const updateIndex = migration.indexOf('UPDATE public.user_preferences');
    const verificationIndex = migration.indexOf('DO $user_preferences_identity_verify$');
    const dropDefaultIndex = migration.indexOf(
      'ALTER TABLE public.user_preferences ALTER COLUMN id DROP DEFAULT;',
    );

    expect(migration).toContain('BEGIN;');
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(normalized).toContain(
      'LOCK TABLE public.user_preferences IN SHARE ROW EXCLUSIVE MODE',
    );
    expect(migration).toContain('user_preferences identity rewrite has primary-key collisions');
    expect(migration).toContain('user_preferences identity rewrite left mismatched rows');
    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThan(preflightIndex);
    expect(verificationIndex).toBeGreaterThan(updateIndex);
    expect(dropDefaultIndex).toBeGreaterThan(verificationIndex);
    expect(migration).not.toContain('AND NOT EXISTS (');

    const manifest = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), migrationDryRunManifestPath), 'utf8'),
    ) as {
      entries: Array<{
        path: string;
        category: string;
        requiresDataSafetyExport: boolean;
      }>;
    };
    const manifestEntry = manifest.entries.find(entry =>
      entry.path === dropEntityUuidDefaultsMigrationPath
    );
    expect(manifestEntry).toMatchObject({
      category: 'explicit-transaction',
      requiresDataSafetyExport: true,
    });
  });

  it('keeps TypeScript insert types aligned with client-generated entity IDs', () => {
    const generatedTypes = fs.readFileSync(path.join(process.cwd(), 'src/types/supabase.ts'), 'utf8');
    const modelTypes = readModelDatabaseTypes();
    const tableInterfaces: Array<[string, string]> = [
      ['projects', 'ProjectInsert'],
      ['tasks', 'TaskInsert'],
      ['connections', 'ConnectionInsert'],
      ['user_preferences', 'UserPreferencesInsert'],
      ['focus_sessions', 'FocusSessionInsert'],
      ['routine_tasks', 'RoutineTaskInsert'],
      ['routine_completions', 'RoutineCompletionInsert'],
      ['black_box_entries', 'BlackBoxEntryInsert'],
    ];

    for (const [tableName, interfaceName] of tableInterfaces) {
      const generatedInsert = getGeneratedInsertBlock(generatedTypes, tableName);
      expect(generatedInsert, `src/types ${tableName}.Insert.id must be required`).toMatch(/^\s*id: string$/m);
      expect(generatedInsert, `src/types ${tableName}.Insert.id must not be optional`).not.toMatch(/^\s*id\?: string/m);

      const modelInsert = getInterfaceBlock(modelTypes, interfaceName);
      expect(modelInsert, `src/models ${interfaceName}.id must be required`).toMatch(/^\s*id: string;$/m);
      expect(modelInsert, `src/models ${interfaceName}.id must not be optional`).not.toMatch(/^\s*id\?: string;/m);
    }
  });

  it('includes the sync protocol tables, logs, RLS, and final status vocabulary', () => {
    const sql = readInitScript();
    const normalized = normalize(sql);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.sync_operation_log');
    expect(sql).toContain('payload_digest TEXT');
    expect(normalized).toContain(
      "CHECK (status IN ( 'applied', 'idempotent-replay', 'remote-newer', 'deleted-remote-newer', 'client-version-rejected', 'tombstoned', 'unauthorized', 'quarantined' ))",
    );
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_sync_operation_log_user_created');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_sync_operation_log_entity');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_sync_operation_log_status_created');
    expect(sql).toContain('ALTER TABLE public.sync_operation_log ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('CREATE POLICY sync_operation_log_owner_select');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.sync_protocol_state');
    expect(sql).toContain("VALUES ('global', 1, 0, 'initial')");
    expect(sql).toContain('ALTER TABLE public.sync_protocol_state ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('CREATE POLICY sync_protocol_state_authenticated_read');
  });

  it('recognizes only live payload-digest index creation and fails closed on malformed SQL', () => {
    expect(hasRetiredPayloadDigestIndexCreate(`
      CREATE /* split tokens */ INDEX IF NOT EXISTS
        "public"."idx_sync_operation_log_payload_digest"
        ON public.sync_operation_log USING BTREE (payload_digest);
    `)).toBe(true);
    expect(hasRetiredPayloadDigestIndexCreate(`
      -- CREATE INDEX idx_sync_operation_log_payload_digest ON public.sync_operation_log(payload_digest);
      /* CREATE INDEX idx_sync_operation_log_payload_digest ON public.sync_operation_log(payload_digest); */
      SELECT 'CREATE INDEX idx_sync_operation_log_payload_digest ON public.sync_operation_log(payload_digest);';
      SELECT 'escaped '' CREATE INDEX idx_sync_operation_log_payload_digest ON public.sync_operation_log(payload_digest);';
      SELECT "CREATE INDEX idx_sync_operation_log_payload_digest ON public.sync_operation_log(payload_digest);";
      DO $$ BEGIN RAISE NOTICE 'CREATE INDEX idx_sync_operation_log_payload_digest'; END $$;
      DO $diagnostic$ BEGIN RAISE NOTICE 'CREATE INDEX idx_sync_operation_log_payload_digest'; END $diagnostic$;
    `)).toBe(false);
    expect(() => hasRetiredPayloadDigestIndexCreate('/* CREATE INDEX')).toThrow(
      'Malformed SQL: unterminated block comment',
    );
    expect(() => hasRetiredPayloadDigestIndexCreate("SELECT 'CREATE INDEX")).toThrow(
      'Malformed SQL: unterminated single-quoted string',
    );
    expect(() => hasRetiredPayloadDigestIndexCreate('SELECT "CREATE INDEX')).toThrow(
      'Malformed SQL: unterminated double-quoted identifier',
    );
    expect(() => hasRetiredPayloadDigestIndexCreate('DO $audit$ CREATE INDEX')).toThrow(
      'Malformed SQL: unterminated dollar-quoted string',
    );
  });

  it('retires only the exact payload-digest index after fail-closed identity verification', () => {
    const migrationAbsolutePath = path.join(process.cwd(), payloadDigestIndexRetirementMigrationPath);
    expect(
      fs.existsSync(migrationAbsolutePath),
      `${payloadDigestIndexRetirementMigrationPath} must retire the unused payload-digest index`,
    ).toBe(true);
    if (!fs.existsSync(migrationAbsolutePath)) return;

    const migration = fs.readFileSync(migrationAbsolutePath, 'utf8');
    const normalizedMigration = normalize(migration.replace(/--[^\r\n]*/g, '')).toLowerCase();
    const identityIndex = normalizedMigration.indexOf(
      "target_index := to_regclass('public.idx_sync_operation_log_payload_digest')",
    );
    const lockTimeoutIndex = normalizedMigration.indexOf("set local lock_timeout = '2s'");
    const dropIndex = normalizedMigration.indexOf(
      'drop index if exists public.idx_sync_operation_log_payload_digest',
    );
    const resetTimeoutIndex = normalizedMigration.indexOf('set local lock_timeout = default');

    expect(normalizedMigration).toContain("'public.sync_operation_log'::regclass");
    expect(normalizedMigration).toContain('index_row.indisvalid');
    expect(normalizedMigration).toContain('index_row.indisready');
    expect(normalizedMigration).toContain('index_row.indnkeyatts = 1');
    expect(normalizedMigration).toContain('index_row.indnatts = 1');
    expect(normalizedMigration).toContain('index_row.indexprs is null');
    expect(normalizedMigration).toContain('index_row.indpred is not null');
    expect(normalizedMigration).toContain("access_method.amname = 'btree'");
    expect(normalizedMigration).toContain(
      "'create index idx_sync_operation_log_payload_digest on public.sync_operation_log using btree (payload_digest) where (payload_digest is not null)'",
    );
    expect(normalizedMigration).toContain("'(payload_digest is not null)'");
    expect(identityIndex).toBeGreaterThanOrEqual(0);
    expect(lockTimeoutIndex).toBeGreaterThan(identityIndex);
    expect(dropIndex).toBeGreaterThan(lockTimeoutIndex);
    expect(resetTimeoutIndex).toBeGreaterThan(dropIndex);
    expect(normalizedMigration.match(/\bdrop\s+index\b/g)).toHaveLength(1);
    expect(hasRetiredPayloadDigestIndexCreate(migration)).toBe(false);
    expect(normalizedMigration).not.toMatch(/\b(?:insert|update|delete)\s+(?:into|from|public\.)/);
    expect(normalizedMigration).not.toMatch(/\b(?:begin|commit)\s*;/);
    expect(normalizedMigration).not.toContain('concurrently');
  });

  it('recognizes only live entity-created index creation', () => {
    expect(hasRetiredEntityCreatedIndexCreate(`
      CREATE /* split tokens */ INDEX IF NOT EXISTS
        "public"."idx_sync_operation_log_entity_created"
        ON public.sync_operation_log USING BTREE (entity_type, entity_id, created_at DESC);
    `)).toBe(true);
    expect(hasRetiredEntityCreatedIndexCreate(`
      -- CREATE INDEX idx_sync_operation_log_entity_created ON public.sync_operation_log(entity_type, entity_id, created_at DESC);
      /* CREATE INDEX idx_sync_operation_log_entity_created ON public.sync_operation_log(entity_type, entity_id, created_at DESC); */
      SELECT 'CREATE INDEX idx_sync_operation_log_entity_created ON public.sync_operation_log(entity_type, entity_id, created_at DESC);';
      DO $$ BEGIN RAISE NOTICE 'CREATE INDEX idx_sync_operation_log_entity_created'; END $$;
    `)).toBe(false);
  });

  it('retires only the exact entity-created index after fail-closed identity verification', () => {
    const migrationAbsolutePath = path.join(process.cwd(), entityCreatedIndexRetirementMigrationPath);
    expect(
      fs.existsSync(migrationAbsolutePath),
      `${entityCreatedIndexRetirementMigrationPath} must retire the unused entity-created index`,
    ).toBe(true);
    if (!fs.existsSync(migrationAbsolutePath)) return;

    const migration = fs.readFileSync(migrationAbsolutePath, 'utf8');
    const normalizedMigration = normalize(migration.replace(/--[^\r\n]*/g, '')).toLowerCase();
    const identityIndex = normalizedMigration.indexOf(
      "target_index := to_regclass('public.idx_sync_operation_log_entity_created')",
    );
    const lockTimeoutIndex = normalizedMigration.indexOf("set local lock_timeout = '2s'");
    const dropIndex = normalizedMigration.indexOf(
      'drop index if exists public.idx_sync_operation_log_entity_created',
    );
    const resetTimeoutIndex = normalizedMigration.indexOf('set local lock_timeout = default');

    expect(normalizedMigration).toContain("'public.sync_operation_log'::regclass");
    expect(normalizedMigration).toContain('index_row.indisvalid');
    expect(normalizedMigration).toContain('index_row.indisready');
    expect(normalizedMigration).toContain('index_row.indnkeyatts = 3');
    expect(normalizedMigration).toContain('index_row.indnatts = 3');
    expect(normalizedMigration).toContain('index_row.indexprs is null');
    expect(normalizedMigration).toContain('index_row.indpred is null');
    expect(normalizedMigration).toContain("access_method.amname = 'btree'");
    expect(normalizedMigration).toContain(
      "'create index idx_sync_operation_log_entity_created on public.sync_operation_log using btree (entity_type, entity_id, created_at desc)'",
    );
    expect(identityIndex).toBeGreaterThanOrEqual(0);
    expect(lockTimeoutIndex).toBeGreaterThan(identityIndex);
    expect(dropIndex).toBeGreaterThan(lockTimeoutIndex);
    expect(resetTimeoutIndex).toBeGreaterThan(dropIndex);
    expect(normalizedMigration.match(/\bdrop\s+index\b/g)).toHaveLength(1);
    expect(hasRetiredEntityCreatedIndexCreate(migration)).toBe(false);
    expect(normalizedMigration).not.toMatch(/\b(?:insert|update|delete)\s+(?:into|from|public\.)/);
    expect(normalizedMigration).not.toMatch(/\b(?:begin|commit)\s*;/);
    expect(normalizedMigration).not.toContain('concurrently');
  });

  it.each(taskChangeAuditArchiveIndexRetirements)(
    'retires only the exact task audit archive $label index after fail-closed identity verification',
    (retirement) => {
      const migrationPath = `supabase/migrations/${retirement.version}_task_change_audit_archive_${retirement.label}_unused_index_retirement.sql`;
      const migrationAbsolutePath = path.join(process.cwd(), migrationPath);
      expect(
        fs.existsSync(migrationAbsolutePath),
        `${migrationPath} must retire the unused archive ${retirement.label} index`,
      ).toBe(true);
      if (!fs.existsSync(migrationAbsolutePath)) return;
      expectTaskChangeAuditArchiveIndexRetirement(
        fs.readFileSync(migrationAbsolutePath, 'utf8'),
        retirement,
      );
    },
  );

  it.each(taskChangeAuditArchiveIndexRetirements)(
    'converges fresh init for the archive $label index without weakening durability or access boundaries',
    (retirement) => {
      const initSql = readInitScript();
      const normalizedInit = normalize(initSql);

    expect(normalizedInit).toContain(
      'CREATE INDEX IF NOT EXISTS task_change_audit_task_idx ON public.task_change_audit (task_id, changed_at DESC)',
    );
    expect(normalizedInit).toContain(
      'CREATE INDEX IF NOT EXISTS task_change_audit_project_idx ON public.task_change_audit (project_id, changed_at DESC)',
    );
    expect(normalizedInit).toContain(
      'CREATE INDEX IF NOT EXISTS task_change_audit_owner_idx ON public.task_change_audit (owner_id, changed_at DESC)',
    );
    expect(normalizedInit).toContain('CREATE INDEX IF NOT EXISTS task_change_audit_operation_idx');
    expect(normalizedInit).toContain('CREATE INDEX IF NOT EXISTS task_change_audit_suspicious_idx');
    expect(normalizedInit).toContain('CREATE INDEX IF NOT EXISTS idx_task_change_audit_archive_cursor');
    expect(normalizedInit).toContain(
      'CREATE TABLE IF NOT EXISTS public.task_change_audit_archive (LIKE public.task_change_audit INCLUDING ALL)',
    );
    expect(normalizedInit).toContain(
      'INSERT INTO public.task_change_audit_archive OVERRIDING SYSTEM VALUE SELECT * FROM moved ON CONFLICT (id) DO NOTHING',
    );
    expect(normalizedInit).toContain(
      'ALTER TABLE public.task_change_audit_archive FORCE ROW LEVEL SECURITY',
    );
    expect(normalizedInit).toContain(
      'REVOKE ALL ON public.task_change_audit_archive FROM PUBLIC, anon, authenticated',
    );
    expect(normalizedInit).toContain('GRANT ALL ON public.task_change_audit_archive TO service_role');
    expect(normalizedInit).toContain('CREATE POLICY task_change_audit_archive_service_all');
    expect(normalizedInit).toContain(
      'CREATE OR REPLACE FUNCTION public.archive_old_task_change_audit(',
    );

      expectTaskChangeAuditArchiveIndexRetirement(
        getTaskChangeAuditArchiveIndexRetirementSection(initSql, retirement),
        retirement,
      );
    },
  );

  it('keeps fresh init free of the retired index without weakening replay security semantics', () => {
    const initSql = readInitScript();
    const normalizedInit = normalize(initSql);
    const replayResolver = normalize(getLastFunctionSection(initSql, 'sync_resolve_operation_replay'));
    expect(hasRetiredPayloadDigestIndexCreate(initSql)).toBe(false);
    expect(normalizedInit).toContain('payload_digest TEXT');
    expect(normalizedInit).toContain('replay_payload_digest TEXT');
    expect(normalizedInit).toContain('CREATE TRIGGER sync_operation_log_fill_payload_digest');
    expect(normalizedInit).toContain('ALTER TABLE public.sync_operation_log ENABLE ROW LEVEL SECURITY');
    expect(normalizedInit).toContain('CREATE POLICY sync_operation_log_owner_select');
    expect(normalizedInit).toContain('GRANT SELECT ON public.sync_operation_log TO authenticated');
    expect(normalizedInit).toContain('GRANT ALL ON public.sync_operation_log TO service_role');
    expect(normalizedInit).toContain('CONSTRAINT sync_write_quarantine_digest_uniq UNIQUE (payload_digest)');
    expect(replayResolver).toContain('WHERE operation_id = p_operation_id');
    expect(replayResolver).toContain(
      'v_log_existing.replay_payload_digest IS DISTINCT FROM v_replay_payload_digest',
    );
    expect(replayResolver).toContain(
      'v_log_existing.payload_digest IS NOT DISTINCT FROM v_payload_digest',
    );
  });

  it('keeps fresh init free of the entity-created index without weakening operation replay', () => {
    const initSql = readInitScript();
    const normalizedInit = normalize(initSql);
    const replayResolver = normalize(getLastFunctionSection(initSql, 'sync_resolve_operation_replay'));

    expect(hasRetiredEntityCreatedIndexCreate(initSql)).toBe(false);
    expect(normalizedInit).toContain('CREATE INDEX IF NOT EXISTS idx_sync_operation_log_user_created');
    expect(normalizedInit).toContain('CREATE INDEX IF NOT EXISTS idx_sync_operation_log_entity');
    expect(normalizedInit).toContain('CREATE INDEX IF NOT EXISTS idx_sync_operation_log_status_created');
    expect(normalizedInit).toContain('operation_id UUID PRIMARY KEY');
    expect(normalizedInit).toContain('CREATE TRIGGER sync_operation_log_fill_payload_digest');
    expect(normalizedInit).toContain('ALTER TABLE public.sync_operation_log ENABLE ROW LEVEL SECURITY');
    expect(normalizedInit).toContain('CREATE POLICY sync_operation_log_owner_select');
    expect(normalizedInit).toContain('GRANT SELECT ON public.sync_operation_log TO authenticated');
    expect(normalizedInit).toContain('GRANT ALL ON public.sync_operation_log TO service_role');
    expect(replayResolver).toContain('WHERE operation_id = p_operation_id');
  });

  it('includes the disaster-recovery support objects used by sync RPCs on a fresh project', () => {
    const sql = readInitScript();
    const normalized = normalize(sql);

    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS extensions');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.data_safety_flags');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.data_safety_flag_audit');
    expect(sql).toContain("VALUES ('sync_mode', 'normal')");
    expect(sql).toContain('ALTER TABLE public.data_safety_flags FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('REVOKE ALL ON public.data_safety_flags FROM PUBLIC, anon, authenticated');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.sync_trusted_client_deployments');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.sync_write_quarantine');
    expect(sql).toContain('CONSTRAINT sync_write_quarantine_operation_uniq UNIQUE (operation_id)');
    expect(sql).toContain('CONSTRAINT sync_write_quarantine_digest_uniq UNIQUE (payload_digest)');
    expect(normalized).toContain(
      'CREATE OR REPLACE FUNCTION public.record_sync_write_quarantine( p_operation_id UUID, p_user_id UUID, p_entity_type TEXT, p_entity_id UUID, p_client_git_sha TEXT, p_client_origin TEXT, p_reason TEXT, p_payload JSONB ) RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp',
    );

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.task_change_audit');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS operation_id UUID');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.task_change_audit_archive');
    expect(normalized).toContain(
      'CREATE OR REPLACE FUNCTION public.capture_task_change_audit() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp',
    );
    expect(sql).toContain('DROP TRIGGER IF EXISTS trg_task_change_audit_update ON public.tasks');
    expect(sql).toContain('DROP TRIGGER IF EXISTS trg_task_change_audit_delete ON public.tasks');
  });

  it('includes sync RPC functions with locked search_path and authenticated-only execution', () => {
    const sql = readInitScript();

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sync_extract_local_updated(payload JSONB, entity_key TEXT)');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.sync_extract_local_updated(JSONB, TEXT) FROM PUBLIC, anon');

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sync_check_protocol()');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.sync_check_protocol() TO authenticated');

    for (const functionName of [
      'sync_upsert_task',
      'sync_upsert_connection',
      'sync_upsert_blackbox_entry',
      'sync_upsert_project',
      'sync_upsert_user_preferences',
      'sync_upsert_focus_session',
      'sync_upsert_routine_task',
      'sync_increment_routine_completion',
      'sync_delete_project',
      'sync_delete_tasks',
    ]) {
      const section = getFunctionSection(sql, functionName);
      expect(section).toContain('SECURITY DEFINER');
      expect(section).toContain('SET search_path = pg_catalog, pg_temp');
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${functionName}(JSONB) FROM PUBLIC, anon`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${functionName}(JSONB) TO authenticated`);
    }
  });

  it('bootstraps the latest task sync RPC diagnostics and hardening semantics', () => {
    const sql = readInitScript();
    const section = normalize(getFunctionSection(sql, 'sync_upsert_task'));
    const changedFieldsHelper = normalize(getFunctionSection(sql, 'sync_task_changed_fields'));

    expect(section).toContain("v_local_updated TIMESTAMPTZ := public.sync_extract_local_updated(payload, 'task')");
    expect(section).toContain('v_payload_digest TEXT := encode(extensions.digest(payload::TEXT,');
    expect(section).toContain("FROM public.data_safety_flags WHERE key = 'sync_mode'");
    expect(section).toContain('IF v_existing_project_id IS NOT NULL AND v_local_updated IS NULL THEN');
    expect(section).toContain("'reason', 'missing_task_timestamp'");
    expect(section).toContain("IF v_sync_mode = 'read_only' THEN");
    expect(section).toContain("IF v_sync_mode = 'quarantine' THEN");
    expect(section).toContain("'reason', 'stale_task_payload'");
    expect(section).toContain('PERFORM public.batch_upsert_tasks(ARRAY[v_task_for_write], v_project_id)');
    expect(section).toContain('SELECT a.id INTO v_audit_id');
    expect(section).toContain('v_existing_attention_meta JSONB');
    expect(section).toContain('t.attention_meta');
    expect(section).toContain('v_changed_fields := public.sync_task_changed_fields(v_task_id, v_task)');
    expect(changedFieldsHelper).toContain('v_remote.attention_meta');
    expect(changedFieldsHelper).toContain("jsonb_build_array('attention_meta')");
  });

  it('bootstraps the final batch_upsert_tasks safety cap used by latest migrations', () => {
    const section = normalize(getLastFunctionSection(readInitScript(), 'batch_upsert_tasks'));

    expect(section).toContain("IF COALESCE(array_length(p_tasks, 1), 0) > 100 THEN");
    expect(section).toContain("RAISE EXCEPTION 'task batch too large (max 100)'");
    expect(section).toContain('IF v_is_stale THEN');
    expect(section).toContain('CONTINUE');
  });

  it('bootstraps non-task stale guards, tombstone guards, and delete filtering', () => {
    const sql = readInitScript();
    const connectionSection = normalize(getFunctionSection(sql, 'sync_upsert_connection'));
    const blackboxSection = normalize(getFunctionSection(sql, 'sync_upsert_blackbox_entry'));
    const projectSection = normalize(getFunctionSection(sql, 'sync_upsert_project'));
    const userPreferencesSection = normalize(getFunctionSection(sql, 'sync_upsert_user_preferences'));
    const deleteTasksSection = normalize(getFunctionSection(sql, 'sync_delete_tasks'));

    expect(sql).toContain('ALTER TABLE public.connection_tombstones ADD COLUMN IF NOT EXISTS source_id uuid');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS target_id uuid');
    expect(sql).toContain('idx_connection_tombstones_project_source_target_deleted');

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.prevent_soft_deleted_row_resurrection()');
    expect(sql).toContain('CREATE TRIGGER trg_prevent_project_resurrection');
    expect(sql).toContain('CREATE TRIGGER trg_prevent_black_box_resurrection');
    expect(sql).toContain('CREATE TRIGGER trg_prevent_connection_resurrection');
    expect(sql).toContain('EXECUTE FUNCTION public.prevent_soft_deleted_row_resurrection()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.prevent_black_box_content_loss()');
    expect(sql).toContain('CREATE TRIGGER protect_black_box_content_loss');

    expect(connectionSection).toContain('connection_endpoint_not_in_project');
    expect(connectionSection).toContain('connection_tombstone');
    expect(connectionSection).toContain('endpoint_tombstone');
    expect(connectionSection).toContain('legacy_endpointless_tombstone');
    expect(connectionSection).toContain('source_id = CASE WHEN v_is_stale THEN v_existing_source ELSE EXCLUDED.source_id END');
    expect(connectionSection).toContain('target_id = CASE WHEN v_is_stale THEN v_existing_target ELSE EXCLUDED.target_id END');

    expect(blackboxSection).toContain('content_too_large');
    expect(blackboxSection).toContain('focus_meta_too_large');
    expect(blackboxSection).toContain('completed_at = CASE WHEN v_is_stale THEN v_existing_completed_at ELSE EXCLUDED.completed_at END');

    expect(projectSection).toContain('remote_project_tombstone');
    expect(projectSection).toContain("title = CASE WHEN v_is_stale THEN v_existing_title ELSE v_project->>'title' END");

    expect(userPreferencesSection).toContain('INSERT INTO public.user_preferences AS prefs');
    expect(userPreferencesSection).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(userPreferencesSection).toContain("theme = CASE WHEN v_preferences ? 'theme'");
    expect(userPreferencesSection).toContain("focus_preferences = CASE WHEN v_preferences ? 'focus_preferences'");
    expect(userPreferencesSection).not.toContain('dock_snapshot');

    const focusSessionSection = normalize(getFunctionSection(sql, 'sync_upsert_focus_session'));
    const routineTaskSection = normalize(getFunctionSection(sql, 'sync_upsert_routine_task'));
    const routineCompletionSection = normalize(getFunctionSection(sql, 'sync_increment_routine_completion'));
    expect(focusSessionSection).toContain('INSERT INTO public.focus_sessions AS sessions');
    expect(focusSessionSection).toContain('ON CONFLICT (id) DO UPDATE');
    expect(focusSessionSection).toContain('stale_payload');
    expect(routineTaskSection).toContain('INSERT INTO public.routine_tasks AS tasks');
    expect(routineTaskSection).toContain('ON CONFLICT (id) DO UPDATE');
    expect(routineTaskSection).toContain('stale_payload');
    expect(routineCompletionSection).toContain('INSERT INTO public.routine_completion_events');
    expect(routineCompletionSection).toContain('INSERT INTO public.routine_completions');
    expect(routineCompletionSection).toContain('ON CONFLICT (user_id, routine_id, date_key) DO UPDATE');
    expect(routineCompletionSection).toContain("'idempotent-replay'");

    expect(deleteTasksSection).toContain("v_base_map JSONB := payload->'base_updated_at_map'");
    expect(deleteTasksSection).toContain("v_missing_base_map BOOLEAN := v_base_map IS NULL OR jsonb_typeof(v_base_map) <> 'object'");
    expect(deleteTasksSection).toContain("IF v_missing_base_map THEN");
    expect(deleteTasksSection).toContain('v_base_ts IS NULL');
    expect(deleteTasksSection).toContain('v_existing_updated > v_base_ts + v_skew_grace');
    expect(deleteTasksSection).toContain("'skipped_ids', COALESCE(to_jsonb(v_skipped), '[]'::JSONB)");
  });
});
