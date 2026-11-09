import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const migrationPath =
  'supabase/migrations/20260715017900_owner_scoped_rls_final_convergence.sql';
const quotaImmutabilityMigrationPath =
  'supabase/migrations/20260730000000_transcription_usage_quota_immutability.sql';
const quotaMarker = '-- final convergence: 20260730000000 transcription usage quota immutability';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function lastPolicyBlock(sql: string, policyName: string): string {
  const normalized = normalize(sql);
  const start = normalized.lastIndexOf(`create policy "${policyName.toLowerCase()}"`);
  expect(start, `${policyName} should exist`).toBeGreaterThanOrEqual(0);
  const end = normalized.indexOf(';', start);
  expect(end, `${policyName} should terminate`).toBeGreaterThan(start);
  return normalized.slice(start, end + 1);
}

const expectedPolicies = new Map<string, string>([
  [
    'owner select',
    'create policy "owner select" on public.projects for select to authenticated using ((select auth.uid()) = owner_id);',
  ],
  [
    'owner insert',
    'create policy "owner insert" on public.projects for insert to authenticated with check ((select auth.uid()) = owner_id);',
  ],
  [
    'owner update',
    'create policy "owner update" on public.projects for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);',
  ],
  [
    'owner delete',
    'create policy "owner delete" on public.projects for delete to authenticated using ((select auth.uid()) = owner_id and deleted_at is null);',
  ],
  [
    'focus_sessions_select',
    'create policy "focus_sessions_select" on public.focus_sessions for select to authenticated using ((select auth.uid()) = user_id);',
  ],
  [
    'focus_sessions_insert',
    'create policy "focus_sessions_insert" on public.focus_sessions for insert to authenticated with check ((select auth.uid()) = user_id);',
  ],
  [
    'focus_sessions_update',
    'create policy "focus_sessions_update" on public.focus_sessions for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);',
  ],
  [
    'focus_sessions_delete',
    'create policy "focus_sessions_delete" on public.focus_sessions for delete to authenticated using ((select auth.uid()) = user_id);',
  ],
  [
    'routine_tasks_update',
    'create policy "routine_tasks_update" on public.routine_tasks for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);',
  ],
  [
    'Users can view own preferences',
    'create policy "users can view own preferences" on public.user_preferences for select to authenticated using ((select auth.uid()) = user_id);',
  ],
  [
    'Users can insert own preferences',
    'create policy "users can insert own preferences" on public.user_preferences for insert to authenticated with check ((select auth.uid()) = user_id);',
  ],
  [
    'Users can update own preferences',
    'create policy "users can update own preferences" on public.user_preferences for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);',
  ],
  [
    'Users can delete own preferences',
    'create policy "users can delete own preferences" on public.user_preferences for delete to authenticated using ((select auth.uid()) = user_id);',
  ],
]);

function expectFinalPolicies(sql: string): void {
  for (const [policyName, expected] of expectedPolicies) {
    expect(lastPolicyBlock(sql, policyName)).toBe(expected);
  }
}

function expectReadOnlyTranscriptionUsage(sql: string): void {
  const normalized = normalize(sql);
  const statements = [
    'alter table public.transcription_usage enable row level security;',
    'alter table public.transcription_usage force row level security;',
    ...['transcription_usage_select_policy', 'transcription_usage_select',
      'transcription_usage_insert_policy', 'transcription_usage_update_policy',
      'transcription_usage_delete_policy'].map(name =>
      `drop policy if exists "${name}" on public.transcription_usage;`),
    'create policy "transcription_usage_select" on public.transcription_usage for select to authenticated using ((select auth.uid()) = user_id);',
    'revoke all on table public.transcription_usage from public, anon, authenticated;',
    'grant select on table public.transcription_usage to authenticated;',
    'grant all on table public.transcription_usage to service_role;',
    "notify pgrst, 'reload schema';",
  ];
  let previous = -1;
  for (const statement of statements) {
    const index = normalized.indexOf(statement);
    expect(index, statement).toBeGreaterThan(previous);
    expect(normalized.indexOf(statement, index + 1), `${statement} should be unique`).toBe(-1);
    previous = index;
  }
  expect(normalized.match(/create policy "[^"]+" on public\.transcription_usage/g)).toEqual(['create policy "transcription_usage_select" on public.transcription_usage']);
  expect(normalized.match(/grant [^;]+ on table public\.transcription_usage to authenticated;/g)).toEqual(['grant select on table public.transcription_usage to authenticated;']);
  expect(normalized).not.toMatch(/create policy "transcription_usage_(?:insert|update|delete)_policy"/);
  expect(normalized).not.toContain('grant select, insert, update, delete on table public.transcription_usage');
}

describe('owner-scoped RLS final convergence contract', () => {
  it('adds a transaction-safe forward migration for all remaining policy anomalies', () => {
    const migration = read(migrationPath);
    const normalized = normalize(migration);

    expectFinalPolicies(migration);
    expect(normalized).not.toContain('begin;');
    expect(normalized).not.toContain('commit;');
    expect(normalized).not.toContain('concurrently');
  });

  it('keeps the fresh initializer final policy state aligned with the forward migration', () => {
    expectFinalPolicies(read(initPath));
  });

  it('narrows user-owned tables to authenticated CRUD and removes direct purge-table access', () => {
    const migration = normalize(read(migrationPath));

    for (const table of [
      'projects',
      'focus_sessions',
      'routine_tasks',
      'user_preferences',
    ]) {
      expect(migration).toContain(
        `revoke all on table public.${table} from public, anon, authenticated;`,
      );
      expect(migration).toContain(
        `grant select, insert, update, delete on table public.${table} to authenticated;`,
      );
      expect(migration).toContain(
        `grant all on table public.${table} to service_role;`,
      );
    }

    expect(migration).toContain(
      'drop policy if exists "purge_rate_limits_own" on public.purge_rate_limits;',
    );
    expect(migration).toContain(
      'revoke all on table public.purge_rate_limits from public, anon, authenticated;',
    );
    expect(migration).toContain(
      'grant all on table public.purge_rate_limits to service_role;',
    );
    expect(migration).not.toContain(
      'create policy "purge_rate_limits_own" on public.purge_rate_limits',
    );
  });

  it('makes transcription quota records server-written in the forward migration', () => {
    expectReadOnlyTranscriptionUsage(read(quotaImmutabilityMigrationPath));
  });

  it('places the fresh-init read-only quota state after the Widget final notify', () => {
    const init = normalize(read(initPath));
    const marker = init.lastIndexOf(quotaMarker);
    expect(marker, 'quota convergence marker should exist').toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(init.indexOf("notify pgrst, 'reload schema';", init.lastIndexOf('-- final convergence: 20260729000000 widget black box action idempotency')));
    expectReadOnlyTranscriptionUsage(init.slice(marker));
  });

  it('places the fresh-init purge policy drop after every historical create', () => {
    const init = normalize(read(initPath));
    expect(init.lastIndexOf(
      'drop policy if exists "purge_rate_limits_own" on public.purge_rate_limits;',
    )).toBeGreaterThan(init.lastIndexOf(
      'create policy "purge_rate_limits_own" on public.purge_rate_limits',
    ));
  });
});
