import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20260714033000_attachment_scan_rescan_lifecycle_hardening.sql';
const userOwnershipMigrationPath =
  'supabase/migrations/20260714041000_user_owned_auxiliary_rows_hardening.sql';
const initPath = 'scripts/init-supabase.sql';
const legacyInitDryRunPath =
  'scripts/contracts/init-supabase-legacy-attachment-scans-dry-run.sql';
const auxiliaryTypesPath = 'src/models/supabase-auxiliary-types.ts';
const edgeFunctionsDocPath = 'docs/context7/03-api-reference/edge-functions.md';
const cronSetupPath = 'scripts/virus-rescan-cron-setup.sql';
const supabaseConfigPath = 'supabase/config.toml';
const virusScanFunctionPath = 'supabase/functions/virus-scan/index.ts';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function interfaceBlock(source: string, interfaceName: string): string {
  const start = source.indexOf(`export interface ${interfaceName} {`);
  expect(start, `${interfaceName} should exist`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}', start);
  expect(end, `${interfaceName} should terminate`).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

describe('virus scan rescan lifecycle hardening contract', () => {
  it('backfills unique scan ownership, discards unresolved legacy rows, and enforces owner uniqueness', () => {
    const sql = normalize(read(migrationPath));

    expect(sql).toContain("jsonb_array_elements(coalesce(t.attachments, '[]'::jsonb))");
    expect(sql).toContain("scanmetadata");
    expect(sql).toContain('select distinct s.id as scan_id, p.owner_id as user_id');
    expect(sql).toContain('count(*) over (partition by scan_id) as owner_count');
    expect(sql).toContain('delete from public.attachment_scans');
    expect(sql).toContain('alter column user_id set not null');
    expect(sql).toContain('unique (user_id, file_id)');
  });

  it('adds token-based rescan CAS state and an atomic service-role claim RPC', () => {
    const sql = normalize(read(migrationPath));

    expect(sql).toContain('rescan_token uuid');
    expect(sql).toContain('rescan_started_at timestamptz');
    expect(sql).toContain('next_rescan_at timestamptz');
    expect(sql).toContain('create or replace function public.claim_attachment_scan_rescan');
    expect(sql).toContain('is not distinct from');
    expect(sql).toContain('revoke all on function public.claim_attachment_scan_rescan');
    expect(sql).toContain('grant execute on function public.claim_attachment_scan_rescan');
    expect(sql).toContain('create or replace function public.claim_due_attachment_scan_rescans');
    expect(sql).toContain('for update of scans skip locked');
    expect(sql).toContain("scans.status = 'scanning'");
    expect(sql).toContain('scans.rescan_started_at <= now() - make_interval');
  });

  it('keeps fresh installs aligned with the hardened attachment_scans schema and claim RPC', () => {
    const sql = normalize(read(initPath));
    const tableStart = sql.indexOf('create table if not exists public.attachment_scans');
    const tableEnd = sql.indexOf(');', tableStart);
    expect(tableStart).toBeGreaterThanOrEqual(0);
    expect(tableEnd).toBeGreaterThan(tableStart);
    const tableSql = sql.slice(tableStart, tableEnd + 2);

    expect(tableSql).toContain('user_id uuid not null references auth.users(id) on delete cascade');
    expect(tableSql).toContain('rescan_token uuid');
    expect(tableSql).toContain('next_rescan_at timestamp with time zone');
    expect(tableSql).toContain('unique (user_id, file_id)');
    expect(sql).toContain('create or replace function public.claim_attachment_scan_rescan');
    expect(sql).toContain('create or replace function public.claim_due_attachment_scan_rescans');
  });

  it('upgrades a legacy attachment_scans table before creating rescan indexes', () => {
    const sql = normalize(read(initPath));
    const addColumns = sql.indexOf(
      'alter table public.attachment_scans add column if not exists rescan_token uuid',
    );
    const nextRescanIndex = sql.indexOf('create index if not exists idx_attachment_scans_due_claim');

    expect(addColumns).toBeGreaterThanOrEqual(0);
    expect(nextRescanIndex).toBeGreaterThan(addColumns);
    expect(sql).toContain(
      "idx_attachment_scans_due_claim on public.attachment_scans (next_rescan_at, id) where status in ('clean', 'failed', 'scanning')",
    );
    expect(sql).toContain("jsonb_array_elements(coalesce(t.attachments, '[]'::jsonb))");
    expect(sql).toContain('count(*) over (partition by scan_id) as owner_count');
    expect(sql).toContain('delete from public.attachment_scans where user_id is null');
    expect(sql).toContain('partition by user_id, file_id');
    expect(sql).toContain('alter column user_id set not null');
    expect(sql).toContain('add constraint attachment_scans_user_file_key unique (user_id, file_id)');
  });

  it('provides an executable rollback-only legacy init rerun dry-run', () => {
    const sql = normalize(read(legacyInitDryRunPath));

    expect(sql).toContain('\\set on_error_stop on');
    expect(sql).toContain('begin;');
    expect(sql).toContain('drop table if exists public.attachment_scans cascade');
    expect(sql).toContain('create table public.attachment_scans');
    expect(sql).toContain('\\i scripts/init-supabase.sql');
    expect(sql).toContain("column_name = 'next_rescan_at'");
    expect(sql).toContain("constraint_name = 'attachment_scans_user_file_key'");
    expect(sql).toContain('rollback;');
  });

  it('hardens user-owned auxiliary rows before exposing non-null generated types', () => {
    const migration = normalize(read(userOwnershipMigrationPath));
    const init = normalize(read(initPath));
    const types = read(auxiliaryTypesPath);

    for (const sql of [migration, init]) {
      expect(sql).toContain('update public.black_box_entries entries');
      expect(sql).toContain('set user_id = projects.owner_id');
      expect(sql).toContain('from public.projects projects');
      expect(sql).toContain('entries.project_id = projects.id');
      expect(sql).toContain('entries.user_id is null');
      expect(sql).toContain('black_box_entries contains unresolved null user_id rows');
      expect(sql).toContain('transcription_usage contains unresolved null user_id rows');
      expect(sql).toContain('alter table public.black_box_entries alter column user_id set not null');
      expect(sql).toContain('alter table public.transcription_usage alter column user_id set not null');
    }

    for (const interfaceName of ['BlackBoxEntryRow', 'BlackBoxEntryInsert', 'TranscriptionUsageRow', 'TranscriptionUsageInsert']) {
      const block = interfaceBlock(types, interfaceName);
      expect(block).toMatch(/^\s*user_id: string;$/m);
      expect(block).not.toMatch(/^\s*user_id\??: string \| null;$/m);
    }

    for (const interfaceName of ['BlackBoxEntryUpdate', 'TranscriptionUsageUpdate']) {
      const block = interfaceBlock(types, interfaceName);
      expect(block).toMatch(/^\s*user_id\?: string;$/m);
      expect(block).not.toMatch(/^\s*user_id\?: string \| null;$/m);
    }
  });

  it('provides an auditable bounded quarter-hourly worker and manual batch invocation entry', () => {
    const sql = normalize(read(cronSetupPath));

    expect(sql).toContain("'nanoflow-virus-rescan-quarter-hourly'");
    expect(sql).toContain("'7,22,37,52 * * * *'");
    expect(sql).toContain('from vault.decrypted_secrets');
    expect(sql).toContain("secrets.name = 'virus_scan_function_url'");
    expect(sql).toContain("secrets.name = 'virus_scan_cron_secret'");
    expect(sql).not.toContain('public.get_vault_secret');
    expect(sql).toContain("'x-virus-rescan-secret'");
    expect(sql).toContain("jsonb_build_object('action', 'rescan-due'");
    expect(sql).toContain('timeout_milliseconds := 120000');
    expect(sql).toContain('select public.invoke_due_attachment_rescans');
  });

  it('lets the function perform its own user JWT and internal-secret verification', () => {
    const config = normalize(read(supabaseConfigPath));

    expect(config).toContain('[functions.virus-scan] verify_jwt = false');
  });

  it('documents user actions separately from the internal rescan-due cron secret', () => {
    const doc = read(edgeFunctionsDocPath);

    expect(doc).toContain('`verify_jwt = false`');
    expect(doc).toContain('`Authorization: Bearer <user-jwt>`');
    expect(doc).toContain('`rescan-due`');
    expect(doc).toContain('`x-virus-rescan-secret`');
    expect(doc).toContain('`VIRUS_RESCAN_CRON_SECRET`');
    expect(doc).toContain('self-verifies');
    expect(doc).not.toContain('All actions require user auth');
  });

  it('keeps real owner-scoped Storage rescans and composite first-scan upserts wired', () => {
    const source = read(virusScanFunctionPath);
    expect(source).not.toContain('TODO: 从 Storage 获取文件并重新扫描');
    expect(source).not.toContain("message: 'Rescan queued'");
    expect(source).toContain('return executeClaimedRescan(supabase, fileId, userId, claim.token, corsHeaders)');
    expect(source).toContain("supabase.rpc('claim_attachment_scan_rescan'");
    expect(source).toContain('p_file_id: fileId');
    expect(source).toContain('p_user_id: userId');
    expect(source).not.toContain(".from('storage.objects')");
    expect(source).toContain('.list(folder, { search: objectName, limit: 10 }, { signal })');

    const rescanStart = source.indexOf('async function rescanStoredFile');
    const rescanEnd = source.indexOf('// ==================== 辅助函数', rescanStart);
    expect(rescanStart).toBeGreaterThanOrEqual(0);
    expect(rescanEnd).toBeGreaterThan(rescanStart);
    const rescanBlock = source.slice(rescanStart, rescanEnd);
    const downloadIndex = rescanBlock.indexOf('.download(target.storagePath)');
    const scanIndex = rescanBlock.indexOf('scanWithClamAv(fileBytes, target.filename, signal)');
    expect(scanIndex).toBeGreaterThan(downloadIndex);
    expect(rescanBlock.slice(scanIndex)).toContain('.update({');
    expect(rescanBlock.slice(scanIndex)).not.toContain('.upsert(');
    expect(source).toContain("{ onConflict: 'user_id,file_id' }");
  });

  it('propagates one total rescan deadline and settles cancellation before the failure CAS', () => {
    const source = read(virusScanFunctionPath);

    expect(source).toContain('function createDeadlineFetch(signal: AbortSignal): typeof fetch');
    expect(source).toContain('global: { fetch: createDeadlineFetch(signal) }');
    expect(source).toContain('controller.abort(timeoutError)');
    expect(source).toContain('const response = await operation(controller.signal)');
    expect(source).not.toContain('Promise.race([operation, timeout])');
    expect(source).toContain('.list(folder, { search: objectName, limit: 10 }, { signal })');
    expect(source).toContain('.abortSignal(signal)');
    expect(source).toContain('AbortSignal.any([signal, AbortSignal.timeout(30000)])');

    const executeStart = source.indexOf('async function executeClaimedRescan');
    const rescanStart = source.indexOf('async function rescanStoredFile', executeStart);
    const executeBlock = source.slice(executeStart, rescanStart);
    expect(executeBlock.indexOf('await withTimeout(')).toBeLessThan(
      executeBlock.indexOf('await markRescanFailed('),
    );
  });
});
