import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readSql(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function getSection(sql: string, startMarker: string, endMarker: string): string {
  const startIndex = sql.indexOf(startMarker);
  expect(startIndex).toBeGreaterThanOrEqual(0);

  const endIndex = sql.indexOf(endMarker, startIndex);
  expect(endIndex).toBeGreaterThan(startIndex);

  return sql.slice(startIndex, endIndex);
}

function expectConnectionTombstoneBeforeDelete(section: string): void {
  const insertIndex = section.indexOf('INSERT INTO public.connection_tombstones');
  const deleteIndex = section.indexOf('DELETE FROM public.connections');

  expect(insertIndex).toBeGreaterThanOrEqual(0);
  expect(deleteIndex).toBeGreaterThan(insertIndex);
  expect(section).toContain('ON CONFLICT (connection_id)');
  expect(section).toContain('DO UPDATE SET');
}

function expectTaskTombstoneRefreshSupportsExistingDeletes(section: string): void {
  expect(section).toContain('FROM public.task_tombstones tt');
  expect(section).toContain('tt.project_id = p_project_id');
}

function expectPhysicalDeleteTriggerAlwaysWritesTombstone(section: string): void {
  expect(section).toContain('INSERT INTO public.connection_tombstones');
  expect(section).toContain('DO UPDATE SET');
  expect(section).not.toContain('IF OLD.deleted_at IS NOT NULL');
}

describe('任务 purge 连接 tombstone 契约', () => {
  const sources = [
    {
      label: 'migration',
      path: 'supabase/migrations/20260126074130_remote_commit.sql',
      purgeV2Start: 'CREATE OR REPLACE FUNCTION "public"."purge_tasks_v2"',
      purgeV2End: 'ALTER FUNCTION "public"."purge_tasks_v2"',
      purgeV3Start: 'CREATE OR REPLACE FUNCTION "public"."purge_tasks_v3"',
      purgeV3End: 'ALTER FUNCTION "public"."purge_tasks_v3"',
      triggerStart: 'CREATE OR REPLACE FUNCTION "public"."record_connection_tombstone"',
      triggerEnd: 'ALTER FUNCTION "public"."record_connection_tombstone"',
    },
    {
      label: 'init script',
      path: 'scripts/init-supabase.sql',
      purgeV2Start: 'CREATE OR REPLACE FUNCTION purge_tasks_v2',
      purgeV2End: 'GRANT EXECUTE ON FUNCTION purge_tasks_v2(UUID, UUID[]) TO authenticated;',
      purgeV3Start: 'CREATE OR REPLACE FUNCTION public.purge_tasks_v3',
      purgeV3End: 'GRANT EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) TO authenticated;',
      triggerStart: 'CREATE OR REPLACE FUNCTION record_connection_tombstone()',
      triggerEnd: 'DROP TRIGGER IF EXISTS trg_record_connection_tombstone ON public.connections;',
    },
    {
      label: 'forward repair migration',
      path: 'supabase/migrations/20260403110000_purge_connection_tombstone_hardening.sql',
      purgeV2Start: 'CREATE OR REPLACE FUNCTION public.purge_tasks_v2(',
      purgeV2End: 'COMMENT ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) IS',
      purgeV3Start: 'CREATE OR REPLACE FUNCTION public.purge_tasks_v3(',
      purgeV3End: 'COMMENT ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) IS',
      triggerStart: 'CREATE OR REPLACE FUNCTION public.record_connection_tombstone()',
      triggerEnd: 'DROP TRIGGER IF EXISTS trg_record_connection_tombstone ON public.connections;',
    },
  ] as const;

  for (const source of sources) {
    it(`${source.label} 中 purge_tasks_v2 应先写 connection tombstones 再删连接`, () => {
      const sql = readSql(source.path);
      const section = getSection(sql, source.purgeV2Start, source.purgeV2End);

      expectConnectionTombstoneBeforeDelete(section);
      expectTaskTombstoneRefreshSupportsExistingDeletes(section);
    });

    it(`${source.label} 中 purge_tasks_v3 应先写 connection tombstones 再删连接`, () => {
      const sql = readSql(source.path);
      const section = getSection(sql, source.purgeV3Start, source.purgeV3End);

      expectConnectionTombstoneBeforeDelete(section);
      expectTaskTombstoneRefreshSupportsExistingDeletes(section);
    });

    it(`${source.label} 中 record_connection_tombstone 应覆盖任何物理删除`, () => {
      const sql = readSql(source.path);
      const section = getSection(sql, source.triggerStart, source.triggerEnd);

      expectPhysicalDeleteTriggerAlwaysWritesTombstone(section);
    });
  }
});