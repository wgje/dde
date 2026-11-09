import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const initPath = 'scripts/init-supabase.sql';
const replayPath = 'supabase/migrations/20260319153259_personal_backend_slimdown.sql';
const marker = '-- FINAL CONVERGENCE: 20260319153259 get_vault_secret fresh-init parity';
const functionName = 'get_vault_secret';
const roles = ['PUBLIC', 'anon', 'authenticated'] as const;
const approvedBlock = { bytes: 550, sha256: '947c74b3f76b512652b4aadc971754800459b5c12d82c66b0d4397ebfea67224' } as const;
// c078fec2 normalized init-supabase.sql whitespace outside the frozen helper block.
const frozenPreimageSha = '8a57e2f228c70be6a95da2f07af6aa26612350f00cfd78a437242923cafdfc9b';
type Token = { text: string; start: number; quoted?: true; delimiter?: string };
type Definition = { header: string; body: string };
function read(relativePath: string): string { return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8'); }
function readBytes(relativePath: string): Buffer { return fs.readFileSync(path.join(process.cwd(), relativePath)); }
function tokens(sql: string): Token[] {
  const result: Token[] = [];
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
      if (!closed) throw new Error(`Unterminated quote at ${start}`);
      result.push({ text: sql.slice(start, index), start, quoted: true });
      continue;
    }
    const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
    if (delimiter) {
      const close = sql.indexOf(delimiter, index + delimiter.length);
      if (close < 0) throw new Error(`Unterminated ${delimiter} at ${start}`);
      index = close + delimiter.length;
      result.push({ text: sql.slice(start, index), start, quoted: true, delimiter });
      continue;
    }
    if (/[A-Za-z0-9_]/.test(char)) {
      while (index < sql.length && /[A-Za-z0-9_]/.test(sql[index])) index += 1;
    } else index += 1;
    result.push({ text: sql.slice(start, index), start });
  }
  return result;
}
function normalized(sql: string): string { return tokens(sql).map(token => token.quoted ? token.text : token.text.toLowerCase()).join(' '); }
function identifier(token: Token | undefined, expected: string): boolean {
  if (!token) return false;
  if (token.text.startsWith('"')) return token.text.slice(1, -1).replaceAll('""', '"') === expected;
  return !token.quoted && token.text.toLowerCase() === expected;
}
function targetAt(all: Token[], cursor: number): boolean {
  const name = all[cursor + 1]?.text.toLowerCase() === 'if' && all[cursor + 2]?.text.toLowerCase() === 'exists' ? cursor + 3 : cursor + 1;
  return all[cursor]?.text.toLowerCase() === 'function' && identifier(all[name], 'public')
    && all[name + 1]?.text === '.' && identifier(all[name + 2], functionName) && all[name + 3]?.text === '(';
}
function definitions(sql: string): Definition[] {
  const all = tokens(sql);
  const result: Definition[] = [];
  for (let index = 0; index < all.length; index += 1) {
    if (all[index].text.toLowerCase() !== 'create') continue;
    let cursor = index + 1;
    if (all[cursor]?.text.toLowerCase() === 'or' && all[cursor + 1]?.text.toLowerCase() === 'replace') cursor += 2;
    if (!targetAt(all, cursor)) continue;
    const asIndex = all.findIndex((token, tokenIndex) => tokenIndex >= cursor + 5 && token.text.toLowerCase() === 'as');
    const body = asIndex < 0 ? undefined : all[asIndex + 1];
    if (!body?.delimiter) throw new Error(`Missing dollar body for public.${functionName}`);
    result.push({ header: sql.slice(all[index].start, body.start),
      body: body.text.slice(body.delimiter.length, -body.delimiter.length) });
  }
  return result;
}
function one<T>(values: T[], label: string): T {
  if (values.length !== 1) throw new Error(`${label} must have exactly one executable definition; found ${values.length}`);
  return values[0];
}
const targetDdlPattern = /^(?:create(?: or replace)? function|drop function(?: if exists)?|alter function) public \. get_vault_secret \(/;
const targetDdl = (sql: string): string[] => statements(sql)
  .filter(statement => targetDdlPattern.test(statement))
  .map(statement => statement.split(' ')[0]);
function executableCalls(sql: string): number {
  return tokens(sql).filter(token => token.delimiter).reduce((count, body) => {
    const inner = body.text.slice(body.delimiter!.length, -body.delimiter!.length);
    const all = tokens(inner);
    return count + all.filter((_token, index) => identifier(all[index], 'public') && all[index + 1]?.text === '.'
      && identifier(all[index + 2], functionName) && all[index + 3]?.text === '(').length;
  }, 0);
}
function statements(sql: string): string[] {
  const result: string[] = [];
  let current: Token[] = [];
  for (const token of tokens(sql)) {
    current.push(token);
    if (token.text === ';') {
      result.push(current.map(item => item.quoted ? item.text : item.text.toLowerCase()).join(' '));
      current = [];
    }
  }
  return result;
}
function expectAcl(sql: string): void {
  const actual = statements(sql);
  for (const role of roles) {
    const revoke = normalized(`REVOKE ALL ON FUNCTION public.get_vault_secret(text) FROM ${role};`);
    expect(actual.filter(statement => statement === revoke), `${role} revoke`).toHaveLength(1);
  }
  const target = normalized('ON FUNCTION public.get_vault_secret(');
  expect(actual.filter(statement => statement.startsWith('grant ') && statement.includes(target))).toHaveLength(0);
}
const sha256 = (source: Buffer): string => createHash('sha256').update(source).digest('hex');
function assertFrozenPreimage(source: Buffer): void {
  const markerBytes = Buffer.from(marker);
  const start = source.indexOf(markerBytes);
  if (start < 0 || source.indexOf(markerBytes, start + 1) >= 0) throw new Error('Final helper marker must occur exactly once');
  const end = start + approvedBlock.bytes;
  const block = source.subarray(start, end);
  expect(block.filter(byte => byte === 10)).toHaveLength(18);
  expect(sha256(block)).toBe(approvedBlock.sha256);
  const preimage = Buffer.concat([source.subarray(0, start), source.subarray(end)]);
  expect(sha256(preimage)).toBe(frozenPreimageSha);
}
function synthetic(body = 'SELECT decrypted_secret FROM vault.decrypted_secrets;', orReplace = true): string {
  return `CREATE ${orReplace ? 'OR REPLACE ' : ''}FUNCTION public.get_vault_secret(p_name text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = 'pg_catalog', 'vault' AS $body$${body}$body$;`;
}
describe('widget Vault helper SQL scanner', () => {
  it('ignores comment, string, and dollar-body definition decoys and call decoys', () => {
    const decoy = synthetic();
    const hidden = `-- ${decoy}\n/* ${decoy} */\nSELECT '${decoy.replaceAll("'", "''")}';\nCREATE FUNCTION public.wrapper() RETURNS void AS $outer$${decoy}$outer$ LANGUAGE sql;`;
    expect(definitions(`${hidden}\n${decoy}`)).toHaveLength(1);
    expect(executableCalls(`CREATE FUNCTION public.wrapper() RETURNS void AS $b$BEGIN PERFORM public.get_vault_secret('real'); PERFORM 'public.get_vault_secret(''fake'')'; -- public.get_vault_secret('fake')\nEND;$b$ LANGUAGE plpgsql;`)).toBe(1);
  });
  it('rejects duplicate/redefined helpers and later DROP or ALTER operations', () => {
    expect(() => one(definitions(`${synthetic()}\n${synthetic('SELECT NULL;', false)}`), 'synthetic')).toThrow(/exactly one/i);
    expect(targetDdl(`${synthetic()}\nDROP FUNCTION IF EXISTS public.get_vault_secret(text);`)).toEqual(['create', 'drop']);
    expect(targetDdl(`${synthetic()}\nALTER FUNCTION public.get_vault_secret(text) OWNER TO postgres;`)).toEqual(['create', 'alter']);
  });
  it('rejects each missing revoke and every target grant independently', () => {
    const acl = roles.map(role => `REVOKE ALL ON FUNCTION public.get_vault_secret(text) FROM ${role};`).join('\n');
    expectAcl(acl);
    for (const role of roles) expect(() => expectAcl(acl.replace(new RegExp(`^.*FROM ${role};$`, 'm'), ''))).toThrow();
    expect(() => expectAcl(`${acl}\nGRANT EXECUTE ON FUNCTION public.get_vault_secret(text) TO service_role;`)).toThrow();
  });
  it('rejects mutations before and after the approved helper block', () => {
    const init = readBytes(initPath);
    assertFrozenPreimage(init);
    expect(() => assertFrozenPreimage(Buffer.concat([Buffer.from('drift'), init]))).toThrow();
    expect(() => assertFrozenPreimage(Buffer.concat([init, Buffer.from('\nSELECT 1;')]))).toThrow();
  });
});
describe('widget Vault helper fresh-init parity', () => {
  it('has one final canonical helper and exactly eight executable calls', () => {
    const init = read(initPath);
    const actual = one(definitions(init), `${initPath} helper`);
    const replay = one(definitions(read(replayPath)), `${replayPath} helper`);
    const suffix = init.slice(init.indexOf(marker));
    expect(targetDdl(suffix)).toEqual(['create']);
    expect(executableCalls(init)).toBe(8);
    expect(normalized(actual.header)).toBe(normalized(replay.header));
    expect(normalized(actual.body)).toBe(normalized(replay.body));
  });
  it('revokes every direct role and grants the target to nobody', () => expectAcl(read(initPath)));
});
