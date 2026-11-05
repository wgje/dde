import fs from 'node:fs';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { registerSqlSecurityHardeningFunctionContractSpecs } from './sql-security-hardening-function.contract.spec-helpers';
import { registerSqlSecurityHardeningPolicyContractSpecs } from './sql-security-hardening-policy.contract.spec-helpers';

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

function expectOwnerOnlyBatchUpsert(section: string, ownerMarker: string): void {
  const preservesAttachmentsWithLegacyCoalesce = section.includes("attachments = COALESCE(existing.attachments, '[]'::jsonb)");
  const preservesAttachmentsWithIntentCase = section.includes('attachments = CASE')
    && section.includes('WHEN NOT v_has_attachments THEN existing.attachments');

  expect(section).toContain(ownerMarker);
  expect(section).not.toContain('FROM public.project_members pm');
  expect(section).toContain('INSERT INTO public.tasks AS existing');
  expect(section).toContain('WHERE existing.project_id = p_project_id');
  expect(section).toContain("RAISE EXCEPTION 'Task project mismatch'");
  expect(section).not.toContain('attachments = EXCLUDED.attachments');
  expect(preservesAttachmentsWithLegacyCoalesce || preservesAttachmentsWithIntentCase).toBe(true);
}

function expectOwnerOnlyPurge(section: string): void {
  const normalized = section.replace(/\s+/g, ' ');

  const hasDirectOwnerCheck = normalized.includes('p.id = p_project_id')
    && normalized.includes('p.owner_id = auth.uid()');
  const hasAccessHelperCheck = normalized.includes('public.user_has_project_access(p_project_id)');

  expect(hasDirectOwnerCheck || hasAccessHelperCheck).toBe(true);
  expect(section).toContain("RAISE EXCEPTION 'not authorized'");
  expect(section).toContain('WHERE t.project_id = p_project_id');
}

function expectOwnerOnlyAttachmentStorageRead(section: string): void {
  const normalized = section
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replaceAll('(select auth.uid())::text', 'auth.uid()::text')
    .replaceAll('(auth.uid())::text', 'auth.uid()::text');

  expect(normalized).toContain("bucket_id = 'attachments'");
  expect(normalized).toContain('(storage.foldername(name))[1] = auth.uid()::text');
  expect(normalized).not.toContain('project_members');
}

function expectOwnerOnlyProjectMembersPolicy(section: string): void {
  const normalized = section.replaceAll('"', '').replace(/\s+/g, ' ');

  expect(normalized).toContain('p.owner_id');
  expect(normalized).toContain('auth.uid()');
  expect(normalized).not.toContain('user_id =');
  expect(normalized).not.toContain('FROM public.project_members pm');
  expect(normalized).not.toContain("pm.role = 'admin'");
}

function expectSecurityDefinerFunctionsSetSearchPath(relativePath: string): void {
  const sql = readSql(relativePath);
  const functionPattern = /create\s+(?:or\s+replace\s+)?function\s+([\w."]+)\s*\([^;]*?security\s+definer[\s\S]*?\$\$\s*;/gi;
  const missing: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = functionPattern.exec(sql)) !== null) {
    if (!/set\s+search_path/i.test(match[0])) {
      missing.push(match[1]);
    }
  }

  expect(missing, `${relativePath} SECURITY DEFINER functions missing search_path`).toEqual([]);
}

function listTopLevelMigrationPaths(): string[] {
  const migrationDir = path.join(process.cwd(), 'supabase/migrations');
  return fs.readdirSync(migrationDir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => `supabase/migrations/${file}`);
}

describe('SQL 安全加固契约', () => {
  registerSqlSecurityHardeningFunctionContractSpecs({
    readSql,
    getSection,
    expectSecurityDefinerFunctionsSetSearchPath,
    listTopLevelMigrationPaths,
  });
  registerSqlSecurityHardeningPolicyContractSpecs({
    readSql,
    getSection,
    expectOwnerOnlyBatchUpsert,
    expectOwnerOnlyPurge,
    expectOwnerOnlyAttachmentStorageRead,
    expectOwnerOnlyProjectMembersPolicy,
  });
});
