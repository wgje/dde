import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  normalizeSql,
  registerSupabaseFreshInitRepositorySpecs,
  type RpcFunctionCoverageModule,
  type SchemaCoverageModule,
} from './supabase-fresh-init-table-coverage-repository.spec-helpers';

const projectRoot = process.cwd();
const require = createRequire(import.meta.url);
const coverage = require('../../../scripts/lib/supabase-schema-coverage.cjs') as SchemaCoverageModule;
const rpcCoverage = require('../../../scripts/lib/supabase-rpc-function-coverage.cjs') as RpcFunctionCoverageModule;

describe('Supabase fresh-init table coverage', () => {
  it('extracts public table keys from generated Database types with the TypeScript AST', () => {
    const source = `
      export type Database = {
        auth: { Tables: { users: { Row: {} } } };
        public: {
          Tables: {
            tasks: { Row: {} };
            'audit_log': { Row: {} };
          };
          Views: {};
        };
      };
    `;

    expect(coverage.extractGeneratedPublicTables(source)).toEqual(['audit_log', 'tasks']);
  });

  it('extracts public view keys from generated Database types with the TypeScript AST', () => {
    expect(coverage.extractGeneratedPublicViews).toBeTypeOf('function');
    if (!coverage.extractGeneratedPublicViews) return;

    const source = `
      export type Database = {
        public: {
          Tables: { tasks: { Row: {} } };
          Views: {
            active_tasks: { Row: {} };
            'project_structure_audit': { Row: {} };
          };
        };
      };
    `;

    expect(coverage.extractGeneratedPublicViews(source)).toEqual([
      'active_tasks',
      'project_structure_audit',
    ]);
  });

  it('extracts generated public Row columns without mixing Insert or Update shapes', () => {
    expect(coverage.extractGeneratedPublicTableColumns).toBeTypeOf('function');
    if (!coverage.extractGeneratedPublicTableColumns) return;

    const source = `
      export type Database = {
        public: {
          Tables: {
            tasks: {
              Row: { id: string; title: string; deleted_at: string | null };
              Insert: { id: string; title: string; client_only?: boolean };
              Update: { title?: string; client_only?: boolean };
              Relationships: [];
            };
            'audit_log': {
              Row: { id: number; payload: Json };
              Insert: {};
              Update: {};
              Relationships: [];
            };
          };
          Views: {};
        };
      };
    `;

    expect(coverage.extractGeneratedPublicTableColumns(source)).toEqual({
      audit_log: ['id', 'payload'],
      tasks: ['deleted_at', 'id', 'title'],
    });
  });

  it('derives generated public NOT NULL columns from Row null unions', () => {
    expect(coverage.extractGeneratedPublicNotNullColumns).toBeTypeOf('function');
    if (!coverage.extractGeneratedPublicNotNullColumns) return;

    const source = `
      export type Database = {
        public: {
          Tables: {
            tasks: {
              Row: {
                id: string;
                title: string;
                deleted_at: string | null;
                optional_projection?: string;
              };
              Insert: {};
              Update: {};
              Relationships: [];
            };
          };
          Views: {};
        };
      };
    `;

    expect(coverage.extractGeneratedPublicNotNullColumns(source)).toEqual({
      tasks: ['id', 'title'],
    });
  });

  it('derives generated required Insert columns from non-optional properties', () => {
    expect(coverage.extractGeneratedPublicRequiredInsertColumns).toBeTypeOf('function');
    if (!coverage.extractGeneratedPublicRequiredInsertColumns) return;

    const source = `
      export type Database = {
        public: {
          Tables: {
            tasks: {
              Row: { id: string; title: string; created_at: string; deleted_at: string | null };
              Insert: {
                id: string;
                title: string;
                created_at?: string;
                deleted_at?: string | null;
                generated_id?: never;
              };
              Update: {};
              Relationships: [];
            };
          };
          Views: {};
        };
      };
    `;

    expect(coverage.extractGeneratedPublicRequiredInsertColumns(source)).toEqual({
      tasks: ['id', 'title'],
    });
  });

  it('collects database table literals while excluding Storage and non-public schema calls', () => {
    const source = `
      client.from('tasks');
      client.schema('public').from('projects');
      client.storage.from('attachments');
      client.schema('storage').from('objects');
      Array.from('not-a-table');
    `;

    expect(coverage.extractDatabaseTableReferences(source)).toEqual(['projects', 'tasks']);
  });

  it('tracks table lifecycle inside dollar-quoted blocks and multi-table drops', () => {
    const source = `
      -- CREATE TABLE public.comment_only (id uuid);
      DO $bootstrap$
      BEGIN
        CREATE TABLE IF NOT EXISTS public.app_config (key text PRIMARY KEY);
      END
      $bootstrap$;
      CREATE TABLE "public"."tasks" (id uuid PRIMARY KEY);
      CREATE TABLE public.legacy (id uuid);
      CREATE TABLE public.extra (id uuid);
      DROP TABLE IF EXISTS public.legacy, public.extra CASCADE;
      CREATE TABLE public.old_name (id uuid);
      ALTER TABLE public.old_name RENAME TO current_name;
      SELECT 'CREATE TABLE public.string_only (id uuid)';
    `;

    const events = coverage.extractPublicTableEvents(source);

    expect(coverage.applyPublicTableEvents(events)).toEqual([
      'app_config',
      'current_name',
      'tasks',
    ]);
  });

  it('tracks public table columns while resolving LIKE and ignoring table constraints', () => {
    expect(coverage.extractPublicTableColumns).toBeTypeOf('function');
    if (!coverage.extractPublicTableColumns) return;

    const source = `
      CREATE TABLE public.template_rows (
        id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL,
        CHECK (created_at <= now())
      );
      CREATE TABLE public.child_rows (
        LIKE public.template_rows INCLUDING ALL,
        payload text,
        CONSTRAINT child_rows_payload_check CHECK (length(payload) > 0),
        UNIQUE (payload)
      );
      ALTER TABLE public.child_rows
        ADD COLUMN IF NOT EXISTS extra_value integer,
        RENAME COLUMN payload TO body;
      ALTER TABLE public.child_rows DROP COLUMN created_at;
      CREATE TABLE public.dropped_rows (id uuid, marker text);
      DROP TABLE public.dropped_rows;
    `;

    expect(coverage.extractPublicTableColumns(source)).toEqual({
      child_rows: ['body', 'extra_value', 'id'],
      template_rows: ['created_at', 'id'],
    });
  });

  it('tracks public NOT NULL state across primary keys, LIKE, and ALTER COLUMN', () => {
    expect(coverage.extractPublicNotNullColumns).toBeTypeOf('function');
    if (!coverage.extractPublicNotNullColumns) return;

    const source = `
      CREATE TABLE public.template_rows (
        id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL,
        optional_value text
      );
      CREATE TABLE public.child_rows (
        LIKE public.template_rows INCLUDING ALL,
        payload text,
        tenant_id uuid,
        sequence_id uuid,
        PRIMARY KEY (tenant_id, sequence_id)
      );
      ALTER TABLE public.child_rows
        ADD COLUMN extra_value integer NOT NULL,
        ALTER COLUMN payload SET NOT NULL;
      ALTER TABLE public.child_rows ALTER COLUMN payload DROP NOT NULL;
      ALTER TABLE public.child_rows RENAME COLUMN extra_value TO required_value;
      ALTER TABLE public.child_rows DROP COLUMN created_at;
    `;

    expect(coverage.extractPublicNotNullColumns(source)).toEqual({
      child_rows: ['id', 'required_value', 'sequence_id', 'tenant_id'],
      template_rows: ['created_at', 'id'],
    });
  });

  it('derives SQL required Insert columns from NOT NULL columns without server values', () => {
    expect(coverage.extractPublicRequiredInsertColumns).toBeTypeOf('function');
    if (!coverage.extractPublicRequiredInsertColumns) return;

    const source = `
      CREATE TABLE public.template_rows (
        id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        serial_id bigserial NOT NULL,
        computed_value integer GENERATED ALWAYS AS (1) STORED,
        label text NOT NULL
      );
      CREATE TABLE public.child_rows (
        LIKE public.template_rows INCLUDING ALL,
        tenant_id uuid NOT NULL
      );
      ALTER TABLE public.child_rows
        ALTER COLUMN label SET DEFAULT 'temporary',
        ALTER COLUMN label DROP DEFAULT,
        ALTER COLUMN tenant_id SET DEFAULT gen_random_uuid();
      ALTER TABLE public.child_rows RENAME COLUMN label TO required_label;
      ALTER TABLE public.child_rows DROP COLUMN computed_value;
    `;

    expect(coverage.extractPublicRequiredInsertColumns(source)).toEqual({
      child_rows: ['id', 'required_label'],
      template_rows: ['id', 'label'],
    });
  });

  it('keeps the recognized started_at_v2 cutover conditional and exposes pre-convergence started_at drift', () => {
    const source = `
      CREATE TABLE public.focus_sessions (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz,
        session_state jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'focus_sessions'
            AND column_name = 'started_at_v2'
        ) THEN
          ALTER TABLE public.focus_sessions DROP COLUMN IF EXISTS started_at;
          ALTER TABLE public.focus_sessions RENAME COLUMN started_at_v2 TO started_at;
          ALTER TABLE public.focus_sessions ALTER COLUMN started_at SET NOT NULL;
          ALTER TABLE public.focus_sessions ALTER COLUMN started_at SET DEFAULT now();
        END IF;
      END $$;
    `;

    expect(coverage.extractPublicTableColumns(source)).toEqual({
      focus_sessions: ['ended_at', 'id', 'session_state', 'started_at', 'updated_at', 'user_id'],
    });
    expect(coverage.extractPublicRequiredInsertColumns(source)).toEqual({
      focus_sessions: ['id', 'user_id'],
    });
  });

  it('tracks public view lifecycle and security_invoker state', () => {
    expect(coverage.extractPublicViewState).toBeTypeOf('function');
    if (!coverage.extractPublicViewState) return;

    const source = `
      CREATE VIEW public.safe_view WITH (security_invoker = true) AS SELECT 1 AS id;
      CREATE OR REPLACE VIEW "public"."quoted_safe_view"
        WITH ("security_invoker"='true') AS SELECT 1 AS id;
      CREATE VIEW public.altered_view AS SELECT 1 AS id;
      ALTER VIEW public.altered_view SET (security_invoker = true);
      CREATE VIEW public.unsafe_view AS SELECT 1 AS id;
      CREATE VIEW public.dropped_view AS SELECT 1 AS id;
      DROP VIEW public.dropped_view;
      CREATE VIEW public.old_name AS SELECT 1 AS id;
      ALTER VIEW public.old_name RENAME TO renamed_view;
      ALTER VIEW public.renamed_view SET (security_invoker = true);
    `;

    expect(coverage.extractPublicViewState(source)).toEqual([
      { view: 'altered_view', securityInvoker: true },
      { view: 'quoted_safe_view', securityInvoker: true },
      { view: 'renamed_view', securityInvoker: true },
      { view: 'safe_view', securityInvoker: true },
      { view: 'unsafe_view', securityInvoker: false },
    ]);
  });

  it('tracks effective public view privileges across grants, revokes, renames, and drops', () => {
    expect(coverage.extractPublicViewPrivilegeState).toBeTypeOf('function');
    if (!coverage.extractPublicViewPrivilegeState) return;

    const source = `
      CREATE VIEW public.safe_view WITH (security_invoker = true) AS SELECT 1 AS id;
      GRANT ALL ON TABLE public.safe_view TO PUBLIC, anon, authenticated;
      REVOKE ALL ON TABLE public.safe_view FROM PUBLIC, anon, authenticated;
      GRANT SELECT ON public.safe_view TO authenticated;

      CREATE VIEW public.partial_revoke_view AS SELECT 1 AS id;
      GRANT SELECT, UPDATE ON TABLE public.partial_revoke_view TO authenticated;
      REVOKE UPDATE ON TABLE public.partial_revoke_view FROM authenticated;

      CREATE VIEW public.unsafe_anon_view AS SELECT 1 AS id;
      GRANT SELECT ON public.unsafe_anon_view TO anon;

      CREATE VIEW public.unsafe_write_view AS SELECT 1 AS id;
      GRANT SELECT, INSERT, UPDATE ON public.unsafe_write_view TO authenticated;

      CREATE VIEW public.old_name AS SELECT 1 AS id;
      GRANT SELECT ON public.old_name TO authenticated;
      ALTER VIEW public.old_name RENAME TO renamed_view;

      CREATE VIEW public.dropped_view AS SELECT 1 AS id;
      GRANT SELECT ON public.dropped_view TO anon;
      DROP VIEW public.dropped_view;
    `;

    expect(coverage.extractPublicViewPrivilegeState(source)).toEqual([
      {
        view: 'partial_revoke_view',
        public: [],
        anon: [],
        authenticated: ['select'],
      },
      {
        view: 'renamed_view',
        public: [],
        anon: [],
        authenticated: ['select'],
      },
      {
        view: 'safe_view',
        public: [],
        anon: [],
        authenticated: ['select'],
      },
      {
        view: 'unsafe_anon_view',
        public: [],
        anon: ['select'],
        authenticated: [],
      },
      {
        view: 'unsafe_write_view',
        public: [],
        anon: [],
        authenticated: ['insert', 'select', 'update'],
      },
    ]);
  });

  it('converges diagnostic views from legacy broad grants to authenticated SELECT only', () => {
    const migrationsDirectory = path.join(projectRoot, 'supabase', 'migrations');
    const matchingMigrations = readdirSync(migrationsDirectory)
      .filter(name => name.endsWith('_diagnostic_view_privilege_convergence.sql'))
      .map(name => path.join('supabase', 'migrations', name));

    expect(matchingMigrations).toHaveLength(1);
    if (matchingMigrations.length !== 1) return;

    const migrationSource = readFileSync(path.join(projectRoot, matchingMigrations[0]), 'utf8');
    const normalizedMigration = normalizeSql(migrationSource);
    const targetViews = 'public.project_structure_audit, public.stage_null_recovery_diagnostics';
    expect(normalizedMigration).toContain("set local lock_timeout = '2s';");
    expect(normalizedMigration).toContain(
      `revoke all on table ${targetViews} from public, anon, authenticated;`,
    );
    expect(normalizedMigration).toContain(
      `grant select on table ${targetViews} to authenticated;`,
    );
    expect(normalizedMigration).toContain('set local lock_timeout = default;');

    const hostileLegacyState = `
      CREATE VIEW public.project_structure_audit AS SELECT 1 AS id;
      CREATE VIEW public.stage_null_recovery_diagnostics AS SELECT 1 AS id;
      GRANT ALL ON TABLE ${targetViews} TO PUBLIC, anon, authenticated;
    `;
    expect(
      coverage.extractPublicViewPrivilegeState(`${hostileLegacyState}\n${migrationSource}`),
    ).toEqual([
      {
        view: 'project_structure_audit',
        public: [],
        anon: [],
        authenticated: ['select'],
      },
      {
        view: 'stage_null_recovery_diagnostics',
        public: [],
        anon: [],
        authenticated: ['select'],
      },
    ]);

    const init = normalizeSql(readFileSync(path.join(projectRoot, 'scripts', 'init-supabase.sql'), 'utf8'));
    expect(init).toContain(
      `revoke all on table ${targetViews} from public, anon, authenticated;`,
    );
    expect(init).toContain(
      `grant select on table ${targetViews} to authenticated;`,
    );
  });

  it('converges black-box status defaults to enforced NOT NULL columns', () => {
    const migrationsDirectory = path.join(projectRoot, 'supabase', 'migrations');
    const matchingMigrations = readdirSync(migrationsDirectory)
      .filter(name => name.endsWith('_black_box_status_not_null_convergence.sql'))
      .map(name => path.join('supabase', 'migrations', name));

    expect(matchingMigrations).toHaveLength(1);
    if (matchingMigrations.length !== 1) return;

    const migrationSource = readFileSync(path.join(projectRoot, matchingMigrations[0]), 'utf8');
    const migration = normalizeSql(migrationSource);
    expect(migration).toContain("set local lock_timeout = '2s';");
    expect(migration).toContain("set local statement_timeout = '30s';");
    expect(migration).toContain('if null_row_count > 10000 then');
    expect(migration).toContain('is_read = coalesce(is_read, false)');
    expect(migration).toContain('is_completed = coalesce(is_completed, false)');
    expect(migration).toContain('is_archived = coalesce(is_archived, false)');
    expect(migration).toContain('snooze_count = coalesce(snooze_count, 0)');
    expect(migration).toContain(
      'add constraint black_box_entries_status_fields_not_null check',
    );
    expect(migration).toContain('not valid;');
    expect(migration).toContain(
      'validate constraint black_box_entries_status_fields_not_null;',
    );
    for (const column of ['is_read', 'is_completed', 'is_archived', 'snooze_count']) {
      expect(migration).toContain(`alter column ${column} set not null`);
    }
    expect(migration).toContain(
      'drop constraint black_box_entries_status_fields_not_null;',
    );
    expect(migration).toContain('set local statement_timeout = default;');
    expect(migration).toContain('set local lock_timeout = default;');

    const legacySchema = `
      CREATE TABLE public.black_box_entries (
        id uuid PRIMARY KEY,
        is_read boolean DEFAULT false,
        is_completed boolean DEFAULT false,
        is_archived boolean DEFAULT false,
        snooze_count integer DEFAULT 0
      );
    `;
    expect(
      coverage.extractPublicNotNullColumns(`${legacySchema}\n${migrationSource}`)
        .black_box_entries,
    ).toEqual(['id', 'is_archived', 'is_completed', 'is_read', 'snooze_count']);

    const init = normalizeSql(readFileSync(path.join(projectRoot, 'scripts', 'init-supabase.sql'), 'utf8'));
    expect(init).toContain('is_read boolean not null default false');
    expect(init).toContain('is_completed boolean not null default false');
    expect(init).toContain('is_archived boolean not null default false');
    expect(init).toContain('snooze_count integer not null default 0');
  });

  it('requires callers to provide focus session state instead of defaulting to an empty snapshot', () => {
    const migrationsDirectory = path.join(projectRoot, 'supabase', 'migrations');
    const matchingMigrations = readdirSync(migrationsDirectory)
      .filter(name => name.endsWith('_focus_session_state_required_insert_convergence.sql'))
      .map(name => path.join('supabase', 'migrations', name));

    expect(matchingMigrations).toHaveLength(1);
    if (matchingMigrations.length !== 1) return;

    const migrationSource = readFileSync(path.join(projectRoot, matchingMigrations[0]), 'utf8');
    const migration = normalizeSql(migrationSource);
    expect(migration).toContain("set local lock_timeout = '2s';");
    expect(migration).toContain(
      'alter table public.focus_sessions alter column session_state drop default;',
    );
    expect(migration).toContain('set local lock_timeout = default;');
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');

    const legacySchema = `
      CREATE TABLE public.focus_sessions (
        session_state jsonb NOT NULL DEFAULT '{}'::jsonb
      );
    `;
    expect(
      coverage.extractPublicRequiredInsertColumns(`${legacySchema}\n${migrationSource}`),
    ).toEqual({
      focus_sessions: ['session_state'],
    });

    const init = normalizeSql(readFileSync(path.join(projectRoot, 'scripts', 'init-supabase.sql'), 'utf8'));
    const migrationVersion = path.basename(matchingMigrations[0]).slice(0, 14);
    expect(init).toContain(
      `-- final convergence: ${migrationVersion} focus session state required insert convergence`,
    );
    expect(init).toContain(
      'alter table public.focus_sessions alter column session_state drop default;',
    );

    const migrationManifest = JSON.parse(readFileSync(
      path.join(projectRoot, 'scripts', 'migration-dry-run-manifest.json'),
      'utf8',
    )) as { entries: Array<{ path: string }> };
    expect(
      migrationManifest.entries.find(entry => entry.path.endsWith(
        '_focus_session_state_required_insert_convergence.sql',
      )),
    ).toBeUndefined();
  });

  it('requires callers to provide focus session started_at instead of defaulting to now()', () => {
    const migrationsDirectory = path.join(projectRoot, 'supabase', 'migrations');
    const matchingMigrations = readdirSync(migrationsDirectory)
      .filter(name => name.endsWith('_focus_sessions_started_at_required_insert_convergence.sql'))
      .map(name => path.join('supabase', 'migrations', name));

    expect(matchingMigrations).toHaveLength(1);
    if (matchingMigrations.length !== 1) return;

    const migrationSource = readFileSync(path.join(projectRoot, matchingMigrations[0]), 'utf8');
    const migration = normalizeSql(migrationSource);
    expect(migration).toContain("set local lock_timeout = '2s';");
    expect(migration).toContain(
      'alter table public.focus_sessions alter column started_at drop default;',
    );
    expect(migration).toContain('set local lock_timeout = default;');
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');

    const legacySchema = `
      CREATE TABLE public.focus_sessions (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        session_state jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `;
    expect(
      coverage.extractPublicRequiredInsertColumns(`${legacySchema}\n${migrationSource}`),
    ).toEqual({
      focus_sessions: ['id', 'started_at', 'user_id'],
    });

    const init = normalizeSql(readFileSync(path.join(projectRoot, 'scripts', 'init-supabase.sql'), 'utf8'));
    const migrationVersion = path.basename(matchingMigrations[0]).slice(0, 14);
    expect(init).toContain(
      `-- final convergence: ${migrationVersion} focus sessions started_at required insert convergence`,
    );
    expect(init).toContain(
      'alter table public.focus_sessions alter column started_at drop default;',
    );

    const migrationManifest = JSON.parse(readFileSync(
      path.join(projectRoot, 'scripts', 'migration-dry-run-manifest.json'),
      'utf8',
    )) as { entries: Array<{ path: string }> };
    expect(
      migrationManifest.entries.find(entry => entry.path.endsWith(
        '_focus_sessions_started_at_required_insert_convergence.sql',
      )),
    ).toBeUndefined();
  });

  it('detects foreign keys without a covering index prefix using index lifecycle state', () => {
    expect(coverage.extractUnindexedPublicForeignKeys).toBeTypeOf('function');
    if (!coverage.extractUnindexedPublicForeignKeys) return;

    const source = `
      CREATE TABLE public.parent_rows (id uuid PRIMARY KEY);
      CREATE TABLE public.child_rows (
        id uuid PRIMARY KEY,
        owner_id uuid REFERENCES auth.users(id),
        parent_id uuid REFERENCES public.parent_rows(id),
        unique_parent_id uuid UNIQUE REFERENCES public.parent_rows(id),
        dropped_index_parent_id uuid REFERENCES public.parent_rows(id),
        tenant_id uuid NOT NULL,
        pair_id uuid NOT NULL,
        CONSTRAINT child_rows_pair_fkey
          FOREIGN KEY (tenant_id, pair_id)
          REFERENCES public.parent_rows(id, id)
      );

      CREATE INDEX child_rows_owner_parent_idx
        ON public.child_rows (owner_id, parent_id);
      CREATE INDEX child_rows_pair_idx
        ON public.child_rows (tenant_id, pair_id);
      CREATE INDEX child_rows_dropped_idx
        ON public.child_rows (dropped_index_parent_id)
        WHERE dropped_index_parent_id IS NOT NULL;
      DROP INDEX public.child_rows_dropped_idx;
    `;

    expect(coverage.extractUnindexedPublicForeignKeys(source)).toEqual([
      'child_rows.dropped_index_parent_id',
      'child_rows.parent_id',
    ]);
  });

  it('detects exact duplicate indexes without collapsing distinct predicates or sort keys', () => {
    expect(coverage.extractRedundantPublicIndexes).toBeTypeOf('function');
    if (!coverage.extractRedundantPublicIndexes) return;

    const source = `
      CREATE TABLE public.items (
        id uuid,
        deleted_at timestamptz,
        status text,
        CONSTRAINT items_pkey PRIMARY KEY (id)
      );

      CREATE INDEX items_id_lookup ON public.items (id);
      CREATE INDEX items_deleted_a
        ON public.items (deleted_at)
        WHERE deleted_at IS NOT NULL;
      CREATE INDEX "items_deleted_b"
        ON "public"."items" USING "btree" ("deleted_at")
        WHERE ("deleted_at" IS NOT NULL);
      CREATE INDEX items_active
        ON public.items (deleted_at)
        WHERE status = 'active';
      CREATE INDEX items_inactive
        ON public.items (deleted_at)
        WHERE status = 'inactive';
      CREATE INDEX items_deleted_desc ON public.items (deleted_at DESC);
      CREATE INDEX items_dropped_duplicate ON public.items (id);
      DROP INDEX public.items_dropped_duplicate;
    `;

    expect(coverage.extractRedundantPublicIndexes(source)).toEqual([
      {
        table: 'items',
        indexes: ['items_deleted_a', 'items_deleted_b'],
      },
      {
        table: 'items',
        indexes: ['items_id_lookup', 'items_pkey'],
      },
    ]);
  });

  registerSupabaseFreshInitRepositorySpecs({ coverage, rpcCoverage });
});
