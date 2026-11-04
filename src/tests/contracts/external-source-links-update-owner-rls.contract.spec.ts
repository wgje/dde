import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationDirectory = 'supabase/migrations';
const initPath = 'scripts/init-supabase.sql';
const migrationPath =
  'supabase/migrations/20260803000000_external_source_links_update_owner_guard.sql';
const writerPath = 'src/services/external-source-link-remote-writer.service.ts';
const servicePath = 'src/app/core/external-sources/external-source-link.service.ts';
const identifier = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)';
const targetTable = '(?:"?public"?\\s*\\.\\s*)?"?external_source_links"?';

type PolicyCommand = 'all' | 'select' | 'insert' | 'update' | 'delete';
type PolicyMode = 'permissive' | 'restrictive';
type Policy = {
  name: string;
  mode: PolicyMode;
  command: PolicyCommand;
  roles: string[];
  using: string | null;
  withCheck: string | null;
};
type Operation =
  | { kind: 'create'; policy: Policy }
  | { kind: 'drop'; name: string }
  | { kind: 'alter'; name: string; rename?: string; patch?: Partial<Policy> };

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}
function sqlStatements(source: string): string[] {
  const statements: string[] = [];
  let current = '';
  for (let index = 0; index < source.length;) {
    if (source.startsWith('--', index)) {
      const end = source.indexOf('\n', index + 2);
      index = end < 0 ? source.length : end + 1;
      current += ' ';
      continue;
    }
    if (source.startsWith('/*', index)) {
      let depth = 1;
      for (index += 2; index < source.length && depth > 0;) {
        if (source.startsWith('/*', index)) { depth += 1; index += 2; }
        else if (source.startsWith('*/', index)) { depth -= 1; index += 2; }
        else index += 1;
      }
      if (depth > 0) throw new Error('unterminated SQL block comment');
      current += ' ';
      continue;
    }
    const dollar = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(index))?.[0];
    if (dollar) {
      const end = source.indexOf(dollar, index + dollar.length);
      if (end < 0) throw new Error(`unterminated ${dollar}`);
      current += source.slice(index, end + dollar.length);
      index = end + dollar.length;
      continue;
    }
    if (source[index] === "'" || source[index] === '"') {
      const quote = source[index];
      current += source[index++];
      while (index < source.length) {
        const character = source[index++];
        current += character;
        if (character !== quote) continue;
        if (source[index] === quote) current += source[index++];
        else break;
      }
      continue;
    }
    if (source[index] === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      index += 1;
      continue;
    }
    current += source[index++];
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}
function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"')
    ? trimmed.slice(1, -1).replace(/""/g, '"').toLowerCase()
    : trimmed.toLowerCase();
}
function parenthesized(source: string): { expression: string; rest: string } {
  const value = source.trimStart();
  if (!value.startsWith('(')) throw new Error('policy expression must be parenthesized');
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const quote = value[index];
    if (quote === "'" || quote === '"') {
      for (index += 1; index < value.length; index += 1) {
        if (value[index] !== quote) continue;
        if (value[index + 1] === quote) index += 1;
        else break;
      }
      continue;
    }
    if (value[index] === '(') depth += 1;
    if (value[index] !== ')') continue;
    depth -= 1;
    if (depth === 0) {
      return { expression: value.slice(1, index), rest: value.slice(index + 1) };
    }
  }
  throw new Error('unterminated policy expression');
}
function rolesAndRest(source: string): { roles: string[]; rest: string } {
  const boundary = /\s+(?=using\b|with\s+check\b)/i.exec(source)?.index ?? source.length;
  const roleSource = source.slice(0, boundary).trim();
  const roles = roleSource.split(',').map(unquote);
  if (roles.some(role => !/^[a-z_][a-z0-9_$]*$/.test(role))) {
    throw new Error(`unparsed policy role list: ${roleSource}`);
  }
  return { roles, rest: source.slice(boundary) };
}
function policyClauses(source: string, allowCreateOptions: boolean): Partial<Policy> {
  const patch: Partial<Policy> = {};
  let rest = source.trim();
  if (allowCreateOptions && /^as\s+/i.test(rest)) {
    const match = /^as\s+(permissive|restrictive)\b/i.exec(rest);
    if (!match) throw new Error('unparsed policy mode');
    patch.mode = match[1].toLowerCase() as PolicyMode;
    rest = rest.slice(match[0].length).trim();
  }
  if (allowCreateOptions && /^for\s+/i.test(rest)) {
    const match = /^for\s+(all|select|insert|update|delete)\b/i.exec(rest);
    if (!match) throw new Error('unparsed policy command');
    patch.command = match[1].toLowerCase() as PolicyCommand;
    rest = rest.slice(match[0].length).trim();
  }
  if (/^to\s+/i.test(rest)) {
    const parsed = rolesAndRest(rest.replace(/^to\s+/i, ''));
    patch.roles = parsed.roles;
    rest = parsed.rest.trim();
  }
  if (/^using\b/i.test(rest)) {
    const parsed = parenthesized(rest.replace(/^using\s*/i, ''));
    patch.using = parsed.expression;
    rest = parsed.rest.trim();
  }
  if (/^with\s+check\b/i.test(rest)) {
    const parsed = parenthesized(rest.replace(/^with\s+check\s*/i, ''));
    patch.withCheck = parsed.expression;
    rest = parsed.rest.trim();
  }
  if (rest) throw new Error(`unparsed policy clauses: ${rest}`);
  return patch;
}
function parseOperation(statement: string): Operation | null {
  if (!/\bpolicy\b/i.test(statement) || !/\bexternal_source_links\b/i.test(statement)) return null;
  const create = new RegExp(
    `^create\\s+policy\\s+(${identifier})\\s+on\\s+${targetTable}\\s*(.*)$`,
    'is',
  ).exec(statement);
  if (create) {
    const clauses = policyClauses(create[2], true);
    return {
      kind: 'create',
      policy: {
        name: unquote(create[1]),
        mode: clauses.mode ?? 'permissive',
        command: clauses.command ?? 'all',
        roles: clauses.roles ?? ['public'],
        using: clauses.using ?? null,
        withCheck: clauses.withCheck ?? null,
      },
    };
  }
  const drop = new RegExp(
    `^drop\\s+policy(?:\\s+if\\s+exists)?\\s+(${identifier})\\s+on\\s+${targetTable}\\s*$`,
    'is',
  ).exec(statement);
  if (drop) return { kind: 'drop', name: unquote(drop[1]) };
  const alter = new RegExp(
    `^alter\\s+policy\\s+(${identifier})\\s+on\\s+${targetTable}\\s+(.+)$`,
    'is',
  ).exec(statement);
  if (alter) {
    const rename = new RegExp(`^rename\\s+to\\s+(${identifier})\\s*$`, 'is').exec(alter[2]);
    return rename
      ? { kind: 'alter', name: unquote(alter[1]), rename: unquote(rename[1]) }
      : { kind: 'alter', name: unquote(alter[1]), patch: policyClauses(alter[2], false) };
  }
  throw new Error(`unparsed relevant policy DDL: ${statement.slice(0, 120)}`);
}
function replay(sources: string[]): Map<string, Policy> {
  const policies = new Map<string, Policy>();
  for (const source of sources) {
    for (const statement of sqlStatements(source)) {
      const operation = parseOperation(statement);
      if (!operation) continue;
      if (operation.kind === 'drop') { policies.delete(operation.name); continue; }
      if (operation.kind === 'create') {
        if (policies.has(operation.policy.name)) throw new Error('duplicate policy without DROP');
        policies.set(operation.policy.name, operation.policy);
        continue;
      }
      const policy = policies.get(operation.name);
      if (!policy) throw new Error(`ALTER missing policy: ${operation.name}`);
      if (operation.rename) {
        if (policies.has(operation.rename)) throw new Error('ALTER POLICY rename collision');
        policies.delete(operation.name);
        policies.set(operation.rename, { ...policy, name: operation.rename });
      } else policies.set(operation.name, { ...policy, ...operation.patch });
    }
  }
  return policies;
}
function migrationSources(): string[] {
  return fs.readdirSync(path.join(process.cwd(), migrationDirectory))
    .filter(name => /^\d+.*\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map(name => read(path.join(migrationDirectory, name)));
}
function canonicalGuard(expression: string | null): string {
  if (expression === null) return '<missing>';
  const raw = expression.match(
    /"(?:[^"]|"")+"|'(?:[^']|'')*'|::|<>|!=|<=|>=|[A-Za-z_][A-Za-z0-9_$]*|\d+|[^\s]/g,
  ) ?? [];
  const tokens = raw.map(token => unquote(token));
  for (let index = 0; index <= tokens.length - 11; index += 1) {
    if (tokens.slice(index, index + 4).join(' ') !== 'from public . tasks') continue;
    const taskAlias = tokens[index + 4];
    if (tokens.slice(index + 5, index + 9).join(' ') !== 'join public . projects') continue;
    const projectAlias = tokens[index + 9];
    if (tokens[index + 10] !== 'on') continue;
    return tokens.map(token => token === taskAlias ? '@task' : token === projectAlias ? '@project' : token).join(' ');
  }
  return tokens.join(' ');
}
type PolicyProjection = {
  name: string;
  roles: string[];
  expression: string;
};
type EffectiveClause = {
  permissiveOr: PolicyProjection[];
  restrictiveAnd: PolicyProjection[];
};
type EffectiveCommand = Partial<Record<'using' | 'withCheck', EffectiveClause>>;
const RLS_COMMANDS = ['select', 'insert', 'update', 'delete'] as const;
type RlsCommand = typeof RLS_COMMANDS[number];
function appliesToCommand(policy: Policy, command: RlsCommand): boolean {
  return policy.command === 'all' || policy.command === command;
}
function effectivePolicies(
  policies: Map<string, Policy>,
  command: RlsCommand,
  expression: 'using' | 'withCheck',
): EffectiveClause {
  const matches = [...policies.values()].filter(policy =>
    appliesToCommand(policy, command)
    && policy.roles.some(role => role === 'authenticated' || role === 'public'));
  const projected = (policy: Policy): PolicyProjection => ({
    name: policy.name,
    roles: [...policy.roles].sort(),
    expression: canonicalGuard(
      expression === 'withCheck'
        ? policy.withCheck ?? policy.using ?? 'true'
        : policy.using ?? 'true',
    ),
  });
  const compareByName = (left: PolicyProjection, right: PolicyProjection): number =>
    left.name.localeCompare(right.name, 'en');
  return {
    permissiveOr: matches.filter(policy => policy.mode === 'permissive').map(projected).sort(compareByName),
    restrictiveAnd: matches.filter(policy => policy.mode === 'restrictive').map(projected).sort(compareByName),
  };
}
function effectiveCommand(policies: Map<string, Policy>, command: RlsCommand): EffectiveCommand {
  if (command === 'insert') {
    return { withCheck: effectivePolicies(policies, command, 'withCheck') };
  }
  const using = effectivePolicies(policies, command, 'using');
  return command === 'update'
    ? { using, withCheck: effectivePolicies(policies, command, 'withCheck') }
    : { using };
}
function effectivePolicySet(policies: Map<string, Policy>): Record<RlsCommand, EffectiveCommand> {
  return Object.fromEntries(RLS_COMMANDS.map(command => [command, effectiveCommand(policies, command)])) as Record<RlsCommand, EffectiveCommand>;
}
function policyProjection(policies: Map<string, Policy>): object {
  return effectivePolicySet(policies);
}
function validateFinal(extra = ''): void {
  const migrations = replay([...migrationSources(), extra]);
  const init = replay([read(initPath)]);
  const migrationPolicies = policyProjection(migrations);
  const initPolicies = policyProjection(init);
  if (JSON.stringify(migrationPolicies) !== JSON.stringify(initPolicies)) {
    throw new Error('effective migration RLS policy set does not match fresh init');
  }
  const select = effectiveCommand(migrations, 'select');
  const update = effectiveCommand(migrations, 'update');
  if (!select.using?.permissiveOr.length || !update.using?.permissiveOr.length) {
    throw new Error('UPDATE requires effective SELECT and UPDATE permissive policies');
  }
  const ownerUpdate = migrations.get('external_source_links_owner_update');
  if (!ownerUpdate) throw new Error('missing external_source_links owner UPDATE policy');
  const guard = canonicalGuard(ownerUpdate.using);
  const required = [
    'user_id = ( select auth . uid ( ) )',
    'from public . tasks @task join public . projects @project on @project . id = @task . project_id',
    'where @task . id = external_source_links . task_id',
    'and @project . owner_id = ( select auth . uid ( ) )',
  ];
  if (required.some(fragment => !guard.includes(fragment)) || guard.includes(' or ')) {
    throw new Error('UPDATE owner guard is incomplete');
  }
}
describe('external_source_links UPDATE owner RLS parity', () => {
  it('replays migration policy lifecycle into the fresh-init owner guard', () => {
    expect(() => validateFinal()).not.toThrow();
  });

  it('fails closed on later drop, weakening, role widening, or permissive OR widening', () => {
    const changes = [
      'DROP POLICY external_source_links_owner_update ON public.external_source_links;',
      `ALTER POLICY external_source_links_owner_update ON public.external_source_links
       USING (true) WITH CHECK (true);`,
      `ALTER POLICY external_source_links_owner_update ON public.external_source_links
       TO authenticated, anon;`,
      `CREATE POLICY external_source_links_update_widening ON public.external_source_links
       FOR UPDATE TO authenticated USING (true) WITH CHECK (true);`,
    ];
    for (const change of changes) expect(() => validateFinal(change)).toThrow();
  });

  it.each([
    [
      'a restrictive UPDATE false guard',
      `CREATE POLICY external_source_links_update_restriction
       ON public.external_source_links AS RESTRICTIVE FOR UPDATE TO authenticated
       USING (false) WITH CHECK (false);`,
    ],
    [
      'a dropped INSERT policy',
      'DROP POLICY external_source_links_owner_insert ON public.external_source_links;',
    ],
    [
      'a dropped DELETE policy',
      'DROP POLICY external_source_links_owner_delete ON public.external_source_links;',
    ],
  ])('rejects %s in the effective command policy set', (_label, change) => {
    expect(() => validateFinal(change)).toThrow();
  });

  it('rejects dynamic or otherwise unparsed relevant policy DDL', () => {
    const dynamic = `DO $$ BEGIN EXECUTE
      'DROP POLICY external_source_links_owner_update ON public.external_source_links';
    END $$;`;
    expect(() => validateFinal(dynamic)).toThrow(/unparsed relevant policy DDL/);
  });

  it('keeps the forward migration policy-only and the client id-conflict contract unchanged', () => {
    const migration = read(migrationPath);
    const operations = sqlStatements(migration).map(parseOperation);
    expect(operations.every(operation => operation !== null)).toBe(true);
    expect(migration).not.toMatch(/\b(?:alter\s+table|grant|revoke|function|trigger|insert\s+into|delete\s+from)\b/i);

    const writer = read(writerPath).replace(/\s+/g, ' ');
    const service = read(servicePath).replace(/\s+/g, ' ');
    expect(writer).toContain(".from('external_source_links')");
    expect(writer).toContain("onConflict: 'id'");
    expect(writer).toContain('assertSyncOperationId(operationId)');
    expect(service).toContain('local.updatedAt > remote.updatedAt');
    expect(service).toContain('errorCode === POSTGRES_UNIQUE_VIOLATION');
    expect(service).toContain('pendingEntry.operationId');
  });
});
