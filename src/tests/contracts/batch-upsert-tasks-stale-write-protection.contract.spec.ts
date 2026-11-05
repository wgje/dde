import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P0 待分配块脏数据修复的迁移契约。
 *
 * 该 migration 保证 `batch_upsert_tasks` 不会被 RetryQueue drain 时的陈旧 payload
 * （payload.updated_at 明显早于 existing.updated_at）洗白关键状态字段
 * （stage / parent_id / deleted_at），从而避免"突然新增大量待分配块"的脏数据现象。
 */
const migrationPath =
  'supabase/migrations/20260527110000_batch_upsert_tasks_content_presence_guard.sql';
const hardeningMigrationPath = 'supabase/migrations/20260531120000_database_hardening_dr_controls.sql';
const attentionMetaMigrationPath = 'supabase/migrations/20260605062000_task_attention_meta.sql';
const securitySyncFollowupMigrationPath = 'supabase/migrations/20260606050000_security_sync_followup.sql';
const attachmentPayloadSyncMigrationPath = 'supabase/migrations/20260609010000_task_attachment_payload_sync.sql';
const completedAtUnusedIndexRetirementMigrationPath =
  'supabase/migrations/20260728000300_tasks_completed_at_unused_index_retirement.sql';
const initScriptPath = 'scripts/init-supabase.sql';
const migrationManifestPath = 'scripts/migration-dry-run-manifest.json';

function readMigration(): string {
  return fs.readFileSync(path.join(process.cwd(), migrationPath), 'utf8');
}

function readHardeningMigration(): string {
  return fs.readFileSync(path.join(process.cwd(), hardeningMigrationPath), 'utf8');
}

function readAttentionMetaMigration(): string {
  return fs.readFileSync(path.join(process.cwd(), attentionMetaMigrationPath), 'utf8');
}

function readSecuritySyncFollowupMigration(): string {
  return fs.readFileSync(path.join(process.cwd(), securitySyncFollowupMigrationPath), 'utf8');
}

function readAttachmentPayloadSyncMigration(): string {
  return fs.readFileSync(path.join(process.cwd(), attachmentPayloadSyncMigrationPath), 'utf8');
}

function readInitScript(): string {
  return fs.readFileSync(path.join(process.cwd(), initScriptPath), 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

function getFinalBatchUpsertSection(sql: string): string {
  const startMarker = 'CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(';
  const endMarker = 'COMMENT ON FUNCTION public.batch_upsert_tasks';
  const start = sql.lastIndexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('batch_upsert_tasks stale-write protection migration', () => {
  it('redefines batch_upsert_tasks as SECURITY DEFINER with locked search_path', () => {
    const sql = readMigration();
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain("SET search_path TO 'pg_catalog', 'pg_temp'");
  });

  it('extracts a payload-side updated_at (snake_case with camelCase fallback)', () => {
    const sql = normalize(readMigration());
    expect(sql).toContain(
      "v_payload_updated := NULLIF(v_task->>'updated_at', '')::timestamptz",
    );
    expect(sql).toContain(
      "v_payload_updated := NULLIF(v_task->>'updatedAt', '')::timestamptz",
    );
  });

  it('locks the existing task row before deciding staleness (avoids TOCTOU)', () => {
    const sql = normalize(readMigration());
    // SELECT ... FOR UPDATE on the conflicting task row before INSERT...ON CONFLICT
    expect(sql).toMatch(
      /SELECT TRUE, t\.updated_at, t\.stage, t\.parent_id, t\.deleted_at[\s\S]*?FROM public\.tasks t[\s\S]*?WHERE t\.id = v_task_id[\s\S]*?AND t\.project_id = p_project_id[\s\S]*?FOR UPDATE/,
    );
  });

  it('treats a payload as stale only when payload.updated_at lags existing.updated_at beyond 1s skew', () => {
    const sql = normalize(readMigration());
    // Definition of v_is_stale must require all three guards plus NULL-safe coercion.
    expect(sql).toContain(
      "v_skew_grace constant interval := interval '1 second'",
    );
    expect(sql).toMatch(
      /v_is_stale := COALESCE\(\s*v_existing_exists\s+AND v_payload_updated IS NOT NULL\s+AND v_existing_updated IS NOT NULL\s+AND v_existing_updated > v_payload_updated \+ v_skew_grace,\s+FALSE\s*\)/,
    );
  });

  it('preserves existing stage / parent_id / deleted_at when the write is stale', () => {
    const sql = normalize(readMigration());
    expect(sql).toContain(
      'stage = CASE WHEN v_is_stale THEN v_existing_stage ELSE EXCLUDED.stage END',
    );
    expect(sql).toContain(
      'parent_id = CASE WHEN v_is_stale THEN v_existing_parent ELSE EXCLUDED.parent_id END',
    );
    expect(sql).toContain(
      'deleted_at = CASE WHEN v_is_stale THEN v_existing_deleted ELSE EXCLUDED.deleted_at END',
    );
  });

  it('preserves existing content when the payload omits the content key', () => {
    const sql = normalize(readMigration());
    expect(sql).toContain("v_has_content := v_task ? 'content'");
    expect(sql).toContain("CASE WHEN v_has_content THEN v_content ELSE '' END");
    expect(sql).toContain(
      'content = CASE WHEN v_has_content THEN EXCLUDED.content ELSE existing.content END',
    );
  });

  it('final batch_upsert_tasks skips existing-row writes that omit updated_at', () => {
    for (const sql of [readAttachmentPayloadSyncMigration(), readInitScript()]) {
      const normalized = normalize(getFinalBatchUpsertSection(sql));

      expect(normalized).toContain('IF v_existing_exists AND v_payload_updated IS NULL THEN CONTINUE; END IF');
      expect(normalized).toMatch(
        /SELECT TRUE, t\.updated_at, t\.stage, t\.parent_id, t\.deleted_at[\s\S]*?INTO v_existing_exists, v_existing_updated, v_existing_stage, v_existing_parent, v_existing_deleted/,
      );
      expect(normalized).toContain('IF v_is_stale THEN CONTINUE; END IF');
    }
  });

  it('adds forensics indexes on sync_operation_log for dirty-data triage', () => {
    const sql = readMigration();
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_sync_operation_log_entity_created',
    );
    expect(sql).toContain(
      'ON public.sync_operation_log (entity_type, entity_id, created_at DESC)',
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_sync_operation_log_status_created',
    );
    expect(sql).toContain(
      'ON public.sync_operation_log (entity_type, status, created_at DESC)',
    );
  });

  it('keeps owner-only authorization guards intact', () => {
    const sql = normalize(readMigration());
    expect(sql).toContain("RAISE EXCEPTION 'Unauthorized: not authenticated'");
    expect(sql).toContain("RAISE EXCEPTION 'Unauthorized: not project owner'");
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO service_role');
  });

  it('hardening migration blocks direct batch writes while sync is frozen', () => {
    const sql = normalize(readHardeningMigration());

    expect(sql).toContain("SELECT value INTO v_sync_mode FROM public.data_safety_flags WHERE key = 'sync_mode'");
    expect(sql).toContain("IF v_sync_mode IN ('read_only', 'quarantine') THEN");
    expect(sql).toContain("RAISE EXCEPTION 'sync_write_blocked: %', v_sync_mode");
  });

  it('hardening migration preserves structure fields for task_text_update intents', () => {
    const sql = normalize(readHardeningMigration());

    expect(sql).toContain("v_write_intent NOT IN ('task_full_upsert', 'task_text_update', 'task_structure_update', 'task_soft_delete')");
    expect(sql).toContain("stage = CASE WHEN v_is_stale OR v_write_intent IN ('task_text_update', 'task_soft_delete') THEN v_existing_stage ELSE EXCLUDED.stage END");
    expect(sql).toContain("parent_id = CASE WHEN v_is_stale OR v_write_intent IN ('task_text_update', 'task_soft_delete') THEN v_existing_parent ELSE EXCLUDED.parent_id END");
    expect(sql).toContain("\"order\" = CASE WHEN v_write_intent = 'task_text_update' THEN existing.\"order\" ELSE EXCLUDED.\"order\" END");
  });

  it('hardening migration preserves text fields for task_structure_update intents', () => {
    const sql = normalize(readHardeningMigration());

    expect(sql).toContain("title = CASE WHEN v_write_intent IN ('task_structure_update', 'task_soft_delete') THEN existing.title ELSE EXCLUDED.title END");
    expect(sql).toContain("WHEN v_write_intent IN ('task_structure_update', 'task_soft_delete') THEN existing.content");
    expect(sql).toContain("status = CASE WHEN v_write_intent = 'task_structure_update' THEN existing.status ELSE EXCLUDED.status END");
  });

  it('attention_meta migration keeps hardening guards while adding task sidecar persistence', () => {
    const sql = normalize(readAttentionMetaMigration());

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS attention_meta jsonb');
    expect(sql).toContain("WHERE key = 'sync_mode'");
    expect(sql).toContain("IF v_sync_mode IN ('read_only', 'quarantine') THEN");
    expect(sql).toContain("v_write_intent NOT IN ('task_full_upsert', 'task_text_update', 'task_structure_update', 'task_soft_delete')");
    expect(sql).toContain('attachments, expected_minutes, cognitive_load, wait_minutes, parking_meta, attention_meta');
    expect(sql).toContain("COALESCE(v_task->'attentionMeta', v_task->'attention_meta')");
    expect(sql).toContain('attention_meta = CASE');
    expect(sql).toContain('WHEN NOT v_has_attention_meta THEN existing.attention_meta');
    expect(sql).toContain("WHEN v_write_intent IN ('task_structure_update', 'task_soft_delete') THEN existing.attention_meta");
  });

  it('attention_meta migration preserves unset cognitive_load as NULL instead of defaulting to low', () => {
    const sql = normalize(readAttentionMetaMigration());

    expect(sql).toContain('ALTER TABLE public.tasks ALTER COLUMN cognitive_load DROP DEFAULT');
    expect(sql).not.toContain("COALESCE(v_cognitive, 'low')");
    expect(sql).toMatch(/v_expected,\s*v_cognitive,\s*v_wait/);
  });

  it('attention_meta migration refreshes full project reads and active task view', () => {
    const sql = normalize(readAttentionMetaMigration());

    expect(sql).toContain('CREATE OR REPLACE VIEW public.active_tasks WITH (security_invoker = true) AS');
    expect(sql).toContain('t.expected_minutes');
    expect(sql).toContain('t.cognitive_load');
    expect(sql).toContain('t.wait_minutes');
    expect(sql).toContain('t.completed_at');
    expect(sql).toContain('t.attention_meta');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.get_full_project_data(p_project_id uuid)');
    expect(sql).toContain('attention_meta FROM public.tasks WHERE project_id = p_project_id');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.get_full_project_data(uuid) FROM PUBLIC, anon');
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.active_tasks FROM authenticated');
    expect(sql).toContain('GRANT SELECT ON TABLE public.active_tasks TO authenticated');
    expect(sql).not.toContain('GRANT ALL ON TABLE public.active_tasks TO authenticated');
  });

  it('init script keeps the task attention sidecar final-state overlay', () => {
    const sql = normalize(readInitScript());

    expect(sql).toContain('Task attention sidecar overlay (2026-06-05)');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS attention_meta jsonb');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS completed_at timestamptz');
    expect(sql).toContain('CREATE OR REPLACE VIEW public.active_tasks WITH (security_invoker = true) AS');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.get_full_project_data(p_project_id uuid)');
    expect(sql).toContain('attention_meta = CASE');
    expect(sql).toContain('WHEN NOT v_has_attention_meta THEN existing.attention_meta');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC');
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.active_tasks FROM authenticated');
    expect(sql).toContain('GRANT SELECT ON TABLE public.active_tasks TO authenticated');
    expect(sql).not.toContain('GRANT ALL ON TABLE public.active_tasks TO authenticated');
  });

  it('init script preserves unset cognitive_load as NULL instead of defaulting to low', () => {
    const sql = normalize(readInitScript());

    expect(sql).toContain('ALTER TABLE public.tasks ALTER COLUMN cognitive_load DROP DEFAULT');
    expect(sql).not.toContain("cognitive_load TEXT DEFAULT 'low'");
    expect(sql).not.toContain("ALTER TABLE public.tasks ALTER COLUMN cognitive_load SET DEFAULT 'low'");
    expect(sql).not.toContain("SET cognitive_load = 'low' WHERE cognitive_load IS NULL");
    expect(sql).not.toContain("COALESCE(v_cognitive, 'low')");
    expect(sql).toMatch(/v_expected,\s*v_cognitive,\s*v_wait/);
  });

  it('latest stale-skip function reports only rows actually applied', () => {
    for (const sql of [readSecuritySyncFollowupMigration(), readInitScript()]) {
      const normalized = normalize(sql);

      expect(normalized).toContain('IF v_is_stale THEN CONTINUE; END IF');
      expect(normalized).not.toContain('IF v_is_stale THEN v_count := v_count + 1; CONTINUE; END IF');
    }
  });

  it('final batch_upsert_tasks persists complete payload sidecar fields for full task upserts', () => {
    for (const sql of [readAttachmentPayloadSyncMigration(), readInitScript()]) {
      const normalized = normalize(getFinalBatchUpsertSection(sql));

      expect(normalized).toContain("v_has_attachments := v_task ? 'attachments'");
      expect(normalized).toContain("v_has_tags := v_task ? 'tags'");
      expect(normalized).toContain("'task_attachment_update'");
      expect(normalized).toContain("CASE WHEN v_has_attachments THEN COALESCE(v_task->'attachments', '[]'::jsonb) ELSE '[]'::jsonb END");
      expect(normalized).toContain("CASE WHEN v_has_tags THEN COALESCE(v_task->'tags', '[]'::jsonb) ELSE '[]'::jsonb END");
      expect(normalized).toContain("NULLIF(v_task->>'priority', '')");
      expect(normalized).toContain("NULLIF(COALESCE(v_task->>'dueDate', v_task->>'due_date'), '')::timestamptz");
      expect(normalized).toContain("NULLIF(COALESCE(v_task->>'completedAt', v_task->>'completed_at'), '')::timestamptz");
      expect(normalized).toContain('tags, priority, due_date, completed_at');
      expect(normalized).toContain("WHEN NOT v_has_attachments THEN existing.attachments");
      expect(normalized).toContain("WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_soft_delete') THEN existing.attachments");
      expect(normalized).toContain("WHEN NOT v_has_tags THEN existing.tags");
      expect(normalized).toContain("WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_soft_delete', 'task_attachment_update') THEN existing.tags");
      expect(normalized).toContain("attachments = CASE WHEN NOT v_has_attachments THEN existing.attachments WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_soft_delete') THEN existing.attachments ELSE EXCLUDED.attachments END");
      expect(normalized).toContain("title = CASE WHEN v_write_intent IN ('task_structure_update', 'task_soft_delete', 'task_attachment_update') THEN existing.title ELSE EXCLUDED.title END");
      expect(normalized).toContain("priority = CASE WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_attachment_update') THEN existing.priority ELSE EXCLUDED.priority END");
      expect(normalized).toContain("due_date = CASE WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_attachment_update') THEN existing.due_date ELSE EXCLUDED.due_date END");
      expect(normalized).toContain("completed_at = CASE WHEN v_write_intent IN ('task_text_update', 'task_structure_update', 'task_attachment_update') THEN existing.completed_at ELSE EXCLUDED.completed_at END");
      expect(normalized).toContain('ELSE EXCLUDED.attachments');
      expect(normalized).not.toContain("attachments = COALESCE(existing.attachments, '[]'::jsonb)");
    }
  });

  it('latest batch_upsert_tasks RPC migration reloads the PostgREST schema cache', () => {
    const sql = readAttachmentPayloadSyncMigration();

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(');
    expect(sql).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('init final batch_upsert_tasks matches the latest stale skip shape rather than preserving dead stale CASE branches', () => {
    const normalized = normalize(getFinalBatchUpsertSection(readInitScript()));

    expect(normalized).toContain('IF v_is_stale THEN CONTINUE; END IF');
    expect(normalized).toContain(
      "stage = CASE WHEN v_write_intent IN ('task_text_update', 'task_soft_delete', 'task_attachment_update') THEN existing.stage ELSE EXCLUDED.stage END",
    );
    expect(normalized).toContain(
      "parent_id = CASE WHEN v_write_intent IN ('task_text_update', 'task_soft_delete', 'task_attachment_update') THEN existing.parent_id ELSE EXCLUDED.parent_id END",
    );
    expect(normalized).not.toContain(
      "stage = CASE WHEN v_is_stale OR v_write_intent IN ('task_text_update', 'task_soft_delete', 'task_attachment_update') THEN v_existing_stage ELSE EXCLUDED.stage END",
    );
    expect(normalized).not.toContain(
      "parent_id = CASE WHEN v_is_stale OR v_write_intent IN ('task_text_update', 'task_soft_delete', 'task_attachment_update') THEN v_existing_parent ELSE EXCLUDED.parent_id END",
    );
    expect(normalized).not.toContain('WHEN v_is_stale THEN v_existing_deleted');
  });

  it('retires the unused completed_at project index only after a fail-closed identity check and keeps fresh-init aligned', () => {
    const matchingMigrationFiles = fs
      .readdirSync(path.join(process.cwd(), 'supabase', 'migrations'))
      .filter(name => name.endsWith('_tasks_completed_at_unused_index_retirement.sql'));
    const migrationAbsolutePath = path.join(
      process.cwd(),
      completedAtUnusedIndexRetirementMigrationPath,
    );
    const migration = normalize(
      fs.existsSync(migrationAbsolutePath) ? fs.readFileSync(migrationAbsolutePath, 'utf8') : '',
    ).toLowerCase();
    const init = normalize(readInitScript()).toLowerCase();
    const manifest = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), migrationManifestPath), 'utf8'),
    ) as {
      entries: Array<{
        path: string;
      }>;
    };

    expect(matchingMigrationFiles).toEqual([
      '20260728000300_tasks_completed_at_unused_index_retirement.sql',
    ]);
    expect(
      fs.existsSync(migrationAbsolutePath),
      `${completedAtUnusedIndexRetirementMigrationPath} should exist`,
    ).toBe(true);

    for (const sql of [migration, init]) {
      expect(sql).toContain("to_regclass('public.idx_tasks_project_completed_at')");
      expect(sql).toContain("index_row.indrelid = 'public.tasks'::regclass");
      expect(sql).toContain('pg_get_indexdef(index_row.indexrelid)');
      expect(sql).toContain('pg_get_expr(index_row.indpred, index_row.indrelid)');
      expect(sql).toContain('project_id, completed_at desc');
      expect(sql).toContain('completed_at is not null');
      expect(sql).toContain('deleted_at is null');
      expect(sql).toContain("set local lock_timeout = '2s';");
      expect(sql).toContain('drop index if exists public.idx_tasks_project_completed_at;');
      expect(sql).toContain('set local lock_timeout = default;');
      expect(sql).not.toContain('drop index concurrently');
      expect(sql).not.toContain('begin;');
      expect(sql).not.toContain('commit;');
    }

    expect(init).toContain(
      '-- final convergence: 20260728000300 tasks completed_at unused index retirement',
    );
    expect(init).not.toContain('create index if not exists idx_tasks_project_completed_at');
    expect(
      manifest.entries.find(item => item.path === completedAtUnusedIndexRetirementMigrationPath),
    ).toBeUndefined();
  });
});
