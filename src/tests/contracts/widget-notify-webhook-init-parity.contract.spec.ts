import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const replayPath = 'supabase/migrations/20260421054415_widget_notify_webhook_if_elsif_fix.sql';
const functionName = 'public.invoke_widget_notify_webhook';
const finalMarker = '-- FINAL CONVERGENCE: 20260421054415 widget notify webhook timeout and payload parity';
const limitsMarker = '-- [MIGRATION] 20260413121000_widget_notify_limits_backfill.sql';
const nextAnchor = '-- Sync protocol / disaster-recovery final-state overlay (2026-06-06)';
const revokeStatement = 'REVOKE ALL ON FUNCTION public.invoke_widget_notify_webhook() FROM PUBLIC, anon, authenticated;';
type SqlFunctionDefinition = { header: string; body: string };
type SqlToken = { text: string; start: number; end: number; quoted?: true; delimiter?: string };
function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}
function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  for (let index = 0; index < sql.length;) {
    const start = index;
    const char = sql[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index + 2);
      index = newline < 0 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      let depth = 1;
      for (index += 2; index < sql.length && depth > 0;) {
        if (sql.startsWith('/*', index)) { depth += 1; index += 2; }
        else if (sql.startsWith('*/', index)) { depth -= 1; index += 2; }
        else index += 1;
      }
      if (depth > 0) throw new Error(`Unterminated block comment at ${start}`);
      continue;
    }
    if (char === "'" || char === '"') {
      let closed = false;
      for (index += 1; index < sql.length;) {
        if (sql[index] !== char) { index += 1; continue; }
        if (sql[index + 1] === char) { index += 2; continue; }
        index += 1; closed = true; break;
      }
      if (!closed) throw new Error(`Unterminated ${char} quote at ${start}`);
      tokens.push({ text: sql.slice(start, index), start, end: index, quoted: true });
      continue;
    }
    const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
    if (delimiter) {
      const close = sql.indexOf(delimiter, index + delimiter.length);
      if (close < 0) throw new Error(`Unterminated ${delimiter} quote at ${start}`);
      index = close + delimiter.length;
      tokens.push({ text: sql.slice(start, index), start, end: index, quoted: true, delimiter });
      continue;
    }
    if (/[A-Za-z0-9_]/.test(char)) {
      while (index < sql.length && /[A-Za-z0-9_]/.test(sql[index])) index += 1;
    } else index += 1;
    tokens.push({ text: sql.slice(start, index), start, end: index });
  }
  return tokens;
}
function normalizeSql(sql: string): string {
  return sqlTokens(sql).map(token => token.quoted ? token.text : token.text.toLowerCase()).join(' ');
}
function matchesIdentifier(token: SqlToken | undefined, expected: string): boolean {
  if (!token) return false;
  if (token.text.startsWith('"')) return token.text.slice(1, -1).replaceAll('""', '"') === expected;
  return !token.quoted && token.text.toLowerCase() === expected;
}
function extractFunctionDefinitions(sql: string): SqlFunctionDefinition[] {
  const tokens = sqlTokens(sql);
  const target = ['function', 'public', '.', 'invoke_widget_notify_webhook', '(', ')'];
  const signatures = [['create', ...target], ['create', 'or', 'replace', ...target]];
  const starts = tokens.flatMap((_token, index) => signatures.flatMap(signature =>
    signature.every((part, offset) => ['public', 'invoke_widget_notify_webhook'].includes(part)
      ? matchesIdentifier(tokens[index + offset], part)
      : tokens[index + offset]?.text.toLowerCase() === part)
      ? [[index, signature.length] as const] : []));
  return starts.map(([tokenIndex, signatureLength], definitionIndex) => {
    const boundary = starts[definitionIndex + 1]?.[0] ?? tokens.length;
    const asIndex = tokens.findIndex((token, index) => index >= tokenIndex + signatureLength
      && index < boundary && token.text.toLowerCase() === 'as');
    const bodyToken = asIndex < 0 ? undefined : tokens[asIndex + 1];
    if (!bodyToken?.delimiter) {
      throw new Error(`Missing dollar-quote body for ${functionName} at ${tokens[tokenIndex].start}`);
    }
    return {
      header: sql.slice(tokens[tokenIndex].start, bodyToken.start),
      body: bodyToken.text.slice(bodyToken.delimiter.length, -bodyToken.delimiter.length),
    };
  });
}
function requireSingleDefinition(sql: string, sourceName: string): SqlFunctionDefinition {
  const definitions = extractFunctionDefinitions(sql);
  if (definitions.length !== 1) throw new Error(
    `${sourceName} must have exactly one executable ${functionName} definition; found ${definitions.length}`);
  return definitions[0];
}
function requireInitDefinition(init: string): SqlFunctionDefinition {
  const marker = init.indexOf(finalMarker);
  const anchor = init.indexOf(nextAnchor);
  if (marker < 0 || init.indexOf(finalMarker, marker + 1) >= 0) throw new Error('Non-unique final marker');
  if (anchor <= marker || init.indexOf(nextAnchor, anchor + 1) >= 0) throw new Error('Non-unique next anchor');
  return requireSingleDefinition(init.slice(marker + finalMarker.length), `${initPath} final suffix`);
}
function expectExactProjection(body: string, table: string, keys: string[]): void {
  const branch = new RegExp(
    String.raw`(?:IF|ELSIF)\s+TG_TABLE_NAME\s*=\s*'${table}'\s+THEN([\s\S]*?)(?=\r?\n\s*(?:ELSIF\s+TG_TABLE_NAME|ELSE\b))`,
    'i',
  ).exec(body)?.[1];
  if (!branch) throw new Error(`Missing ${table} projection branch`);
  const projections = [...branch.matchAll(/jsonb_build_object\(([\s\S]*?)\r?\n\s*\);/gi)]
    .map(match => [...match[1].matchAll(/'([^']+)'\s*,/g)].map(key => key[1]));
  expect(projections, `${table} must project NEW and OLD`).toEqual([keys, keys]);
}
function syntheticFunction(body: string, delimiter = '$function$', orReplace = true, args = '', name = functionName): string {
  return `CREATE ${orReplace ? 'OR REPLACE ' : ''}FUNCTION ${name}(${args})\nRETURNS trigger\nAS ${delimiter}\n${body}\n${delimiter};`;
}
const quotedFunctionName = '"public"."invoke_widget_notify_webhook"';
describe('widget notify webhook SQL parser', () => {
  it.each([
    ['line comment', (sql: string) => sql.split('\n').map(line => `-- ${line}`).join('\n')],
    ['block comment', (sql: string) => `/* ${sql} */`],
    ['single-quoted string', (sql: string) => `SELECT '${sql.replaceAll("'", "''")}';`],
  ])('ignores canonical definitions inside a %s', (_label, hide) => {
    expect(requireSingleDefinition(`${syntheticFunction('BEGIN PERFORM 1000; END;')}\n${hide(syntheticFunction('BEGIN PERFORM 30000; END;'))}`, 'synthetic').body).toContain('PERFORM 1000');
  });
  it('rejects multiple executable definitions', () => expect(() => requireSingleDefinition(`${syntheticFunction('BEGIN NULL; END;')}\n${syntheticFunction('BEGIN NULL; END;')}`, 'synthetic')).toThrow(/exactly one/i));
  it('rejects OR REPLACE followed by DROP and a drifted plain CREATE', () => expect(() => requireSingleDefinition(`${syntheticFunction('BEGIN PERFORM 30000; END;')}\nDROP FUNCTION ${functionName}();\n${syntheticFunction('BEGIN PERFORM 1000; END;', '$plain$', false)}`, 'synthetic')).toThrow(/exactly one/i));
  it('extracts one executable plain CREATE', () => expect(requireSingleDefinition(syntheticFunction('BEGIN PERFORM 1000; END;', '$plain$', false), 'plain').body).toContain('PERFORM 1000'));
  it('does not count an overload as the zero-argument target', () => expect(() => requireSingleDefinition(syntheticFunction('BEGIN NULL; END;', '$overload$', true, 'integer'), 'overload')).toThrow(/found 0/i));
  it('selects the zero-argument body when an overload also exists', () => expect(requireSingleDefinition(`${syntheticFunction('BEGIN PERFORM 30000; END;')}\n${syntheticFunction('BEGIN PERFORM 1000; END;', '$overload$', true, 'integer')}`, 'mixed').body).toContain('PERFORM 30000'));
  it('counts a quoted-lowercase target as a duplicate', () => expect(() => requireSingleDefinition(`${syntheticFunction('BEGIN NULL; END;')}\n${syntheticFunction('BEGIN NULL; END;', '$quoted$', true, '', quotedFunctionName)}`, 'quoted duplicate')).toThrow(/exactly one/i));
  it('extracts a quoted-lowercase zero-argument target', () => expect(requireSingleDefinition(syntheticFunction('BEGIN PERFORM 30000; END;', '$quoted$', true, '', quotedFunctionName), 'quoted').body).toContain('PERFORM 30000'));
  it.each(['"Public"."invoke_widget_notify_webhook"', '"public"."Invoke_Widget_Notify_Webhook"'])('does not fold mixed-case quoted target %s', name => expect(() => requireSingleDefinition(syntheticFunction('BEGIN NULL; END;', '$mixed$', true, '', name), 'mixed case')).toThrow(/found 0/i));
  it('keeps quoted-literal case observable during normalization', () => {
    const canonical = requireSingleDefinition(syntheticFunction("BEGIN PERFORM '^v1,Whsec_'; END;"), 'canonical');
    const drifted = requireSingleDefinition(syntheticFunction("BEGIN PERFORM '^v1,whsec_'; END;"), 'drifted');
    expect(normalizeSql(canonical.body)).not.toBe(normalizeSql(drifted.body));
  });
  it('binds a custom dollar tag and ignores CREATE text inside its body', () => {
    const nested = syntheticFunction('SELECT 2;', '$inner$');
    expect(requireSingleDefinition(syntheticFunction(`BEGIN\n${nested}\nEND;`, '$outer$'), 'synthetic').body).toContain(nested);
  });
  it('rejects a target redefinition after the former next anchor', () => expect(() => requireInitDefinition(`${finalMarker}\n${syntheticFunction('BEGIN PERFORM 30000; END;')}\n${nextAnchor}\n${syntheticFunction('BEGIN PERFORM 1000; END;', '$late$')}`)).toThrow(/exactly one/i));
});
describe('widget notify webhook fresh-init parity', () => {
  it('keeps the final init definition normalized-equivalent to replay truth', () => {
    const init = read(initPath);
    const initDefinition = requireInitDefinition(init);
    const replayDefinition = requireSingleDefinition(read(replayPath), replayPath);
    expect(init.split(finalMarker)).toHaveLength(2);
    expect(init.indexOf(finalMarker)).toBeGreaterThan(init.indexOf(limitsMarker));
    expect(init.lastIndexOf(revokeStatement, init.indexOf(finalMarker))).toBeGreaterThanOrEqual(0);
    expect(normalizeSql(initDefinition.header)).toBe(normalizeSql(replayDefinition.header));
    expect(normalizeSql(initDefinition.body)).toBe(normalizeSql(replayDefinition.body));
  });
  it('locks SECURITY DEFINER to the replay search path', () => {
    const header = normalizeSql(requireInitDefinition(read(initPath)).header);
    expect(header).toContain('security definer');
    expect(header).toContain(normalizeSql("set search_path to 'pg_catalog', 'vault', 'extensions'"));
  });
  it('preserves minimal table projections, signing, and the 30-second timeout', () => {
    const body = requireInitDefinition(read(initPath)).body;
    const normalized = normalizeSql(body);
    expectExactProjection(body, 'focus_sessions', ['id', 'user_id', 'started_at', 'ended_at', 'updated_at']);
    expectExactProjection(body, 'black_box_entries', ['id', 'user_id', 'updated_at', 'created_at']);
    expectExactProjection(body, 'tasks', ['id', 'project_id', 'updated_at', 'deleted_at', 'created_at']);
    expectExactProjection(body, 'projects', ['id', 'owner_id', 'updated_at', 'deleted_at']);
    expect(normalized).toContain(normalizeSql(
      "convert_to(v_event_id || '.' || v_timestamp || '.' || v_payload::text, 'utf8')",
    ));
    expect(normalized).toContain(normalizeSql("'x-widget-webhook-signature', v_signature"));
    expect(normalized).toContain(normalizeSql('body := v_payload'));
    expect(normalized).toContain(normalizeSql('timeout_milliseconds := 30000'));
  });
});
