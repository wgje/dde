import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const historicalMigrationPath =
  'supabase/migrations/20260531124000_advisor_followup_index_cleanup.sql';
const targetIndex = 'task_change_audit_archive_owner_id_changed_at_idx1';
const finalMarker =
  '-- Final convergence: 20260531124000 task_change_audit_archive suspicious partial index cleanup';
const archiveFunctionAnchor = 'CREATE OR REPLACE FUNCTION public.archive_old_task_change_audit(';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/--[^\r\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function targetConvergenceBlock(init: string): string {
  expect(init.match(new RegExp(escapeRegExp(finalMarker), 'g')) ?? []).toHaveLength(1);
  const start = init.indexOf(finalMarker);
  const end = init.indexOf(archiveFunctionAnchor, start);
  expect(end).toBeGreaterThan(start);
  return init.slice(start, end);
}

function mutateTargetBlock(init: string, mutate: (block: string) => string): string {
  const start = init.indexOf(finalMarker);
  const block = targetConvergenceBlock(init);
  const end = start + block.length;
  return `${init.slice(0, start)}${mutate(block)}${init.slice(end)}`;
}

function expectArchiveOwnerIndexCleanup(init: string): void {
  const normalized = normalize(targetConvergenceBlock(init));
  const identityIndex = normalized.indexOf(
    `target_index := to_regclass('public.${targetIndex}')`,
  );
  const nullGuardIndex = normalized.indexOf('if target_index is not null then', identityIndex);
  const selectIndex = normalized.indexOf('select ', nullGuardIndex);
  const raiseIndex = normalized.indexOf(
    "raise exception 'task_change_audit_archive suspicious legacy index is missing or invalid'",
  );
  const malformedGuardEndIndex = normalized.indexOf('end if;', raiseIndex);
  const nullGuardEndIndex = normalized.indexOf('end if;', malformedGuardEndIndex + 1);
  const lockIndex = normalized.indexOf("set local lock_timeout = '2s'", identityIndex);
  const dropIndex = normalized.indexOf(`drop index if exists public.${targetIndex}`, identityIndex);
  const resetIndex = normalized.indexOf('set local lock_timeout = default', identityIndex);

  expect(normalized).toContain("index_row.indrelid = 'public.task_change_audit_archive'::regclass");
  expect(normalized).toContain('index_row.indisvalid');
  expect(normalized).toContain('index_row.indisready');
  expect(normalized).toContain('index_row.indnkeyatts = 2');
  expect(normalized).toContain('index_row.indnatts = 2');
  expect(normalized).toContain('index_row.indexprs is null');
  expect(normalized).toContain('index_row.indpred is not null');
  expect(normalized).toContain("access_method.amname = 'btree'");
  expect(normalized).toContain(
    `'create index ${targetIndex} on public.task_change_audit_archive using btree (owner_id, changed_at desc) where suspicious'`,
  );
  expect(normalized).toContain("normalized_predicate is distinct from 'suspicious'");
  expect(identityIndex).toBeGreaterThanOrEqual(0);
  expect(nullGuardIndex).toBeGreaterThan(identityIndex);
  expect(selectIndex).toBeGreaterThan(nullGuardIndex);
  expect(raiseIndex).toBeGreaterThan(selectIndex);
  expect(malformedGuardEndIndex).toBeGreaterThan(raiseIndex);
  expect(nullGuardEndIndex).toBeGreaterThan(malformedGuardEndIndex);
  expect(lockIndex).toBeGreaterThan(nullGuardEndIndex);
  expect(dropIndex).toBeGreaterThan(lockIndex);
  expect(resetIndex).toBeGreaterThan(dropIndex);

  expect(normalized.match(/\bdrop\s+index\b/g) ?? []).toHaveLength(1);
  expect(normalized).not.toMatch(/\b(?:insert|update|delete)\s+(?:into|from|public\.)/);
  expect(normalized).not.toMatch(/\b(?:begin|commit)\s*;/);
  expect(normalized).not.toContain('concurrently');
}

describe('task_change_audit_archive suspicious index parity', () => {
  it('replays the historical archive index retirement in fresh init', () => {
    const historicalMigration = read(historicalMigrationPath);
    const init = read(initPath);
    const dropPattern = new RegExp(
      String.raw`\bdrop\s+index\s+if\s+exists\s+public\.${targetIndex}\b`,
      'gi',
    );

    expect(historicalMigration.match(dropPattern) ?? []).toHaveLength(1);
    expect(init).toContain('CREATE INDEX IF NOT EXISTS task_change_audit_suspicious_idx');
    expect(init).toContain('ON public.task_change_audit (owner_id, changed_at DESC)');
    expect(init).toContain('WHERE suspicious;');
    expect(init).toContain(
      'CREATE TABLE IF NOT EXISTS public.task_change_audit_archive\n  (LIKE public.task_change_audit INCLUDING ALL);',
    );
    expect.soft(
      init.match(new RegExp(escapeRegExp(finalMarker), 'g')) ?? [],
      'fresh init must include one historical cleanup parity marker',
    ).toHaveLength(1);
    expect.soft(
      init.match(dropPattern) ?? [],
      'fresh init must retire the copied suspicious partial index exactly once',
    ).toHaveLength(1);

    expect(init).toContain('ALTER TABLE public.task_change_audit_archive FORCE ROW LEVEL SECURITY;');
    expect(init).toContain('CREATE POLICY task_change_audit_archive_service_all');
    expect(init).toContain('GRANT ALL ON public.task_change_audit_archive TO service_role;');
    expect(init).toContain('CREATE OR REPLACE FUNCTION public.archive_old_task_change_audit(');
  });

  it('raises on malformed same-name identity before lock or drop', () => {
    expectArchiveOwnerIndexCleanup(read(initPath));
  });

  it('does not borrow strict identity checks from prior retirement blocks', () => {
    const strictClauses = [
      "index_row.indrelid = 'public.task_change_audit_archive'::regclass",
      'index_row.indisvalid',
      'index_row.indisready',
      'index_row.indnkeyatts = 2',
      'index_row.indnatts = 2',
      'index_row.indexprs IS NULL',
      'index_row.indpred IS NOT NULL',
      "access_method.amname = 'btree'",
    ];
    const mutated = mutateTargetBlock(read(initPath), block => strictClauses.reduce(
      (sql, clause) => sql.replace(new RegExp(`^\\s+AND ${escapeRegExp(clause)};?\\r?$`, 'mi'), ''),
      block,
    ));

    expect(() => expectArchiveOwnerIndexCleanup(mutated)).toThrow();
  });

  it('requires the target-index null guard for missing-index no-op', () => {
    const mutated = mutateTargetBlock(
      read(initPath),
      block => block.replace('IF target_index IS NOT NULL THEN', 'IF true THEN'),
    );

    expect(() => expectArchiveOwnerIndexCleanup(mutated)).toThrow();
  });
});
