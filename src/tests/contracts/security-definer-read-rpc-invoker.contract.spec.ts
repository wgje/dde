import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20261123010000_non_destructive_security_definer_read_rpc_invoker.sql';
const manifestPath = 'scripts/security-definer-read-rpc-hardening-manifest.json';

const guardedFunctions = [
  'get_dashboard_stats()',
  'get_all_projects_data(timestamp with time zone)',
  'get_projects_list(integer,integer)',
  'list_project_heads_since(timestamp with time zone)',
] as const;

const expectedStatements = [
  'ALTER FUNCTION public.get_dashboard_stats() SECURITY INVOKER',
  'ALTER FUNCTION public.get_all_projects_data(TIMESTAMPTZ) SECURITY INVOKER',
  'ALTER FUNCTION public.get_projects_list(INT, INT) SECURITY INVOKER',
  'ALTER FUNCTION public.list_project_heads_since(TIMESTAMPTZ) SECURITY INVOKER',
  "COMMENT ON FUNCTION public.get_dashboard_stats() IS 'Owner-scoped dashboard aggregate executed with caller RLS.'",
  "COMMENT ON FUNCTION public.get_all_projects_data(TIMESTAMPTZ) IS 'Owner-scoped project metadata reader executed with caller RLS.'",
  "COMMENT ON FUNCTION public.get_projects_list(INT, INT) IS 'Owner-scoped paginated project summary executed with caller RLS.'",
  "COMMENT ON FUNCTION public.list_project_heads_since(TIMESTAMPTZ) IS 'Owner-scoped changed project heads executed with caller RLS.'",
  "NOTIFY pgrst, 'reload schema'",
] as const;

interface HardeningManifestFunction {
  signature: string;
  body: string;
  bodySha256: string;
  bodyBytes: number;
  owner: string;
  securityDefinerPreimage: boolean;
  volatility: string;
  searchPath: string[];
  acl: string;
  authenticatedExecute: boolean;
  anonExecute: boolean;
  serviceRoleExecute: boolean;
  inverseSql: string;
  ownerFence: { authUid: boolean; ownerId: boolean; readOnly: boolean };
}

interface HardeningManifest {
  selectedFunctions: HardeningManifestFunction[];
  excludedSignatures: {
    unprovenCount: number;
    destructiveCount: number;
    unproven: string[];
    destructive: string[];
  };
}

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readText(relativePath)) as T;
}

type SqlScanMode =
  | { kind: 'normal' }
  | { kind: 'single' }
  | { kind: 'double' }
  | { kind: 'line' }
  | { kind: 'block'; depth: number }
  | { kind: 'dollar'; tag: string };

interface SqlSanitization {
  sql: string[];
  error: string | null;
}

function sanitizeSql(sql: string): SqlSanitization {
  const characters: string[] = [];
  let index = 0;
  while (index < sql.length) characters.push(sql[index++]);
  const output: string[] = [];
  let mode: SqlScanMode = { kind: 'normal' };

  for (index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    const next = characters[index + 1];

    if (mode.kind === 'line') {
      if (character === '\r' || character === '\n') {
        output.push(character);
        if (character === '\r' && next === '\n') {
          output.push(next);
          index += 1;
        }
        mode = { kind: 'normal' };
      }
      continue;
    }

    if (mode.kind === 'block') {
      if (character === '/' && next === '*') {
        mode = { kind: 'block', depth: mode.depth + 1 };
        index += 1;
      } else if (character === '*' && next === '/') {
        mode = mode.depth === 1 ? { kind: 'normal' } : { kind: 'block', depth: mode.depth - 1 };
        index += 1;
      }
      continue;
    }

    if (mode.kind === 'single') {
      output.push(character);
      if (character === "'" && next === "'") {
        output.push(next!);
        index += 1;
      } else if (character === "'") {
        mode = { kind: 'normal' };
      }
      continue;
    }

    if (mode.kind === 'double') {
      output.push(character);
      if (character === '"' && next === '"') {
        output.push(next!);
        index += 1;
      } else if (character === '"') {
        mode = { kind: 'normal' };
      }
      continue;
    }

    if (mode.kind === 'dollar') {
      if (sql.startsWith(mode.tag, index)) {
        output.push(mode.tag);
        index += mode.tag.length - 1;
        mode = { kind: 'normal' };
      } else {
        output.push(character);
      }
      continue;
    }

    if (character === '-' && next === '-') {
      mode = { kind: 'line' };
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      mode = { kind: 'block', depth: 1 };
      index += 1;
      continue;
    }
    if (character === "'") {
      output.push(character);
      mode = { kind: 'single' };
      continue;
    }
    if (character === '"') {
      output.push(character);
      mode = { kind: 'double' };
      continue;
    }
    if (character === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index));
      if (tag) {
        output.push(tag[0]);
        mode = { kind: 'dollar', tag: tag[0] };
        index += tag[0].length - 1;
        continue;
      }
    }
    output.push(character);
  }

  return {
    sql: output,
    error: mode.kind === 'block' || mode.kind === 'single' || mode.kind === 'double' || mode.kind === 'dollar'
      ? `unterminated-sql-${mode.kind}`
      : null,
  };
}

function executableStatements(sql: string): { statements: string[]; error: string | null } {
  const sanitized = sanitizeSql(sql);
  if (sanitized.error) return { statements: [], error: sanitized.error };

  const statements: string[] = [];
  let current: string[] = [];
  let mode: SqlScanMode = { kind: 'normal' };
  for (let index = 0; index < sanitized.sql.length; index += 1) {
    const character = sanitized.sql[index];
    const next = sanitized.sql[index + 1];

    if (mode.kind === 'single') {
      current.push(character);
      if (character === "'" && next === "'") {
        current.push(next);
        index += 1;
      } else if (character === "'") {
        mode = { kind: 'normal' };
      }
      continue;
    }
    if (mode.kind === 'double') {
      current.push(character);
      if (character === '"' && next === '"') {
        current.push(next);
        index += 1;
      } else if (character === '"') {
        mode = { kind: 'normal' };
      }
      continue;
    }
    if (mode.kind === 'dollar') {
      if (sanitized.sql.join('').startsWith(mode.tag, index)) {
        current.push(mode.tag);
        index += mode.tag.length - 1;
        mode = { kind: 'normal' };
      } else {
        current.push(character);
      }
      continue;
    }
    if (character === "'") {
      current.push(character);
      mode = { kind: 'single' };
      continue;
    }
    if (character === '"') {
      current.push(character);
      mode = { kind: 'double' };
      continue;
    }
    if (character === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index));
      if (tag) {
        mode = { kind: 'dollar', tag: tag[0] };
        current.push(tag[0]);
        index += tag[0].length - 1;
        continue;
      }
    }
    if (character === ';') {
      const statement = current.join('').replace(/\s+/g, ' ').trim();
      if (statement) statements.push(statement);
      current = [];
      continue;
    }
    current.push(character);
  }

  const finalStatement = current.join('').replace(/\s+/g, ' ').trim();
  if (finalStatement) statements.push(finalStatement);
  return { statements, error: null };
}
function validateMigrationSql(sql: string): string[] {
  const errors: string[] = [];
  const parsed = executableStatements(sql);
  const actual = parsed.statements;
  if (parsed.error) errors.push(parsed.error);

  if (actual.length !== expectedStatements.length) {
    errors.push(`expected ${expectedStatements.length} executable statements, received ${actual.length}`);
  }

  for (const statement of expectedStatements) {
    if (!actual.includes(statement)) {
      errors.push(`missing reviewed statement: ${statement}`);
    }
  }

  for (const statement of actual) {
    if (!(expectedStatements as readonly string[]).includes(statement)) {
      errors.push(`unreviewed executable statement: ${statement}`);
    }
  }

  return errors;
}

function bodyOnly(definition: string): string {
  const marker = '$function$';
  const first = definition.indexOf(marker);
  const last = definition.lastIndexOf(marker);
  if (first < 0 || last <= first) return definition;
  return definition.slice(first + marker.length, last);
}

function validateManifest(manifest: HardeningManifest): string[] {
  const errors: string[] = [];
  const signatures = manifest.selectedFunctions.map(entry => entry.signature);

  if (manifest.selectedFunctions.length !== guardedFunctions.length) {
    errors.push(`expected ${guardedFunctions.length} selected functions, received ${manifest.selectedFunctions.length}`);
  }
  if (new Set(signatures).size !== signatures.length) {
    errors.push('selected function signatures are duplicated');
  }
  for (const signature of guardedFunctions) {
    if (!signatures.includes(signature)) errors.push(`missing selected signature: ${signature}`);
  }
  for (const signature of signatures) {
    if (!(guardedFunctions as readonly string[]).includes(signature)) {
      errors.push(`unreviewed selected signature: ${signature}`);
    }
  }

  const excluded = [
    ...manifest.excludedSignatures.unproven,
    ...manifest.excludedSignatures.destructive,
  ];
  if (manifest.excludedSignatures.unprovenCount !== 19) errors.push('unproven signature count must be 19');
  if (manifest.excludedSignatures.destructiveCount !== 7) errors.push('destructive signature count must be 7');
  if (excluded.length !== 26 || new Set(excluded).size !== 26) {
    errors.push('excluded signature inventory must contain 26 unique signatures');
  }
  for (const signature of excluded) {
    if (signatures.includes(signature)) errors.push(`excluded signature selected: ${signature}`);
  }

  for (const entry of manifest.selectedFunctions) {
    if (!entry.body || !entry.bodySha256 || !Number.isInteger(entry.bodyBytes) || entry.bodyBytes <= 0) {
      errors.push(`missing pre-image evidence: ${entry.signature}`);
    }
    if (entry.body) {
      if (createHash('sha256').update(entry.body).digest('hex') !== entry.bodySha256) {
        errors.push(`body hash mismatch: ${entry.signature}`);
      }
      if (Buffer.byteLength(entry.body) !== entry.bodyBytes) {
        errors.push(`body byte count mismatch: ${entry.signature}`);
      }
      if (/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|FUNCTION)|ALTER|DROP|GRANT|REVOKE)\b/i.test(bodyOnly(entry.body))) {
        errors.push(`selected body is not read-only: ${entry.signature}`);
      }
      if (!/auth\.uid\(\)/i.test(entry.body) || !/owner_id/i.test(entry.body)) {
        errors.push(`selected body lacks owner fence: ${entry.signature}`);
      }
    }
    if (entry.owner !== 'postgres') errors.push(`unexpected owner: ${entry.signature}`);
    if (!entry.securityDefinerPreimage) errors.push(`missing SECURITY DEFINER pre-image: ${entry.signature}`);
    if (entry.volatility !== 'v') errors.push(`unexpected volatility: ${entry.signature}`);
    if (!Array.isArray(entry.searchPath) || entry.searchPath.length === 0) {
      errors.push(`missing search_path pre-image: ${entry.signature}`);
    }
    if (entry.acl !== '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') {
      errors.push(`unexpected ACL pre-image: ${entry.signature}`);
    }
    if (!entry.authenticatedExecute || entry.anonExecute || !entry.serviceRoleExecute) {
      errors.push(`unexpected execute ACL: ${entry.signature}`);
    }
    if (entry.ownerFence.authUid !== true || entry.ownerFence.ownerId !== true || entry.ownerFence.readOnly !== true) {
      errors.push(`invalid owner fence: ${entry.signature}`);
    }
    if (entry.inverseSql.replace(/;\s*$/, '') !== `ALTER FUNCTION public.${entry.signature} SECURITY DEFINER`) {
      errors.push(`missing or mismatched inverse: ${entry.signature}`);
    }
    for (const excludedSignature of excluded) {
      if (entry.inverseSql.includes(excludedSignature)) {
        errors.push(`inverse references excluded signature: ${excludedSignature}`);
      }
    }
  }

  return errors;
}

describe('SECURITY DEFINER read RPC invoker hardening', () => {
  const migration = readText(migrationPath);
  const manifest = readJson<HardeningManifest>(manifestPath);

  it('accepts only the exact reviewed executable migration statements', () => {
    expect(validateMigrationSql(migration)).toEqual([]);
    expect((executableStatements(migration).statements.join(" ").match(/SECURITY INVOKER/gi) ?? [])).toHaveLength(guardedFunctions.length);
  });

  it('accepts the complete linked pre-image, ACL, body and inverse manifest', () => {
    expect(validateManifest(manifest)).toEqual([]);
  });

  it.each([
    ['write statement injection', `${migration}\nDELETE FROM public.tasks;`],
    ['selected signature corruption', migration.replace('get_dashboard_stats()', 'get_dashboard_stats(uuid)')],
    ['unreviewed ALTER injection', `${migration}\nALTER FUNCTION public.user_has_project_access(uuid) SECURITY INVOKER;`],
    ['unreviewed executable spoof', `${migration}\nALTER FUNCTION public.safe_delete_tasks(uuid[],uuid) SECURITY INVOKER;`],
    ['literal-embedded block-comment spoof', migration.replace('Owner-scoped dashboard aggregate executed with caller RLS.', 'Owner-scoped dashboard aggregate /* injected').replace('Owner-scoped project metadata reader executed with caller RLS.', 'injected */ executed with caller RLS.') + 'DELETE FROM public.tasks;'],
    ['bare-CR line-comment spoof', migration + String.fromCharCode(10) + '-- harmless' + String.fromCharCode(13) + 'SELECT 1;' + String.fromCharCode(10)],
    ['comment-before-dollar-quote and semicolon spoof', migration + String.fromCharCode(10) + '-- strip before literal' + String.fromCharCode(10) + 'DO ' + String.fromCharCode(36) + String.fromCharCode(36) + ' SELECT 1; SELECT 2; ' + String.fromCharCode(36) + String.fromCharCode(36) + ';'],
  ])('rejects %s mutation', (_label, mutatedSql) => {
    expect(validateMigrationSql(mutatedSql).length).toBeGreaterThan(0);
  });

  it.each([
    ['body pre-image omission', (value: HardeningManifest) => { delete (value.selectedFunctions[0] as Partial<HardeningManifestFunction>).body; }],
    ['body hash corruption', (value: HardeningManifest) => { value.selectedFunctions[0].bodySha256 = '0'.repeat(64); }],
    ['inverse mode corruption', (value: HardeningManifest) => { value.selectedFunctions[1].inverseSql = value.selectedFunctions[1].inverseSql.replace('SECURITY DEFINER', 'SECURITY INVOKER'); }],
    ['inverse signature corruption', (value: HardeningManifest) => { value.selectedFunctions[2].inverseSql = value.selectedFunctions[2].inverseSql.replace('integer,integer', 'integer'); }],
    ['body write injection', (value: HardeningManifest) => { value.selectedFunctions[3].body = value.selectedFunctions[3].body.replace('BEGIN\n', 'BEGIN\n  DELETE FROM public.tasks;\n'); }],
    ['owner fence corruption', (value: HardeningManifest) => { value.selectedFunctions[0].ownerFence.ownerId = false; }],
    ['excluded signature promotion', (value: HardeningManifest) => { value.selectedFunctions.push(value.selectedFunctions[0]); value.selectedFunctions[4].signature = 'user_has_project_access(uuid)'; }],
    ['ACL corruption', (value: HardeningManifest) => { value.selectedFunctions[0].anonExecute = true; }],
  ])('rejects %s mutation', (_label, mutate) => {
    const mutated = structuredClone(manifest);
    mutate(mutated);
    expect(validateManifest(mutated).length).toBeGreaterThan(0);
  });

  it('keeps every excluded function family out of executable migration and inverses', () => {
    const statements = executableStatements(migration).statements;
    const excluded = [...manifest.excludedSignatures.unproven, ...manifest.excludedSignatures.destructive];

    for (const signature of excluded) {
      const name = signature.replace(/\(.*$/, '');
      expect(statements.some(statement => statement.includes(name)), signature).toBe(false);
      expect(manifest.selectedFunctions.some(entry => entry.inverseSql.includes(name)), signature).toBe(false);
    }
  });
});
