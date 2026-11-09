import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const migrationPath = 'supabase/migrations/20260731000000_external_source_link_operation_identity.sql';
const cachePath = 'src/app/core/external-sources/external-source-cache.service.ts';
const servicePath = 'src/app/core/external-sources/external-source-link.service.ts';
const marker = '-- FINAL CONVERGENCE: 20260731000000 external source link operation identity';
const banner = '-- ============================================================\n-- 初始化完成';
const initPreimage = '0603f73bc13facfdd4f48a008c2bf66900414a5bdf81fc30a21ff98ad7a3bb42';
const widgetMarker = '-- FINAL CONVERGENCE: 20260729000000 widget black box action idempotency';
const quotaMarker = '-- FINAL CONVERGENCE: 20260730000000 transcription usage quota immutability';
const widgetHash = 'b8c0e4eaf5598216f2efc5afb8b0841879fc36de03e32939f6b2ac457b539ff1';
type Token = { text: string; start: number; end: number; dollar?: string; quoted?: true };

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function tokens(sql: string): Token[] {
  const result: Token[] = [];
  for (let index = 0; index < sql.length;) {
    const start = index;
    if (/\s/.test(sql[index])) { index += 1; continue; }
    if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index + 2);
      index = newline < 0 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      let depth = 1;
      for (index += 2; index < sql.length && depth;) {
        if (sql.startsWith('/*', index)) { depth += 1; index += 2; }
        else if (sql.startsWith('*/', index)) { depth -= 1; index += 2; }
        else index += 1;
      }
      if (depth) throw new Error(`Unterminated SQL comment at ${start}`);
      continue;
    }
    const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
    if (delimiter) {
      const close = sql.indexOf(delimiter, index + delimiter.length);
      if (close < 0) throw new Error(`Unterminated ${delimiter}`);
      index = close + delimiter.length;
      result.push({ text: sql.slice(start, index), start, end: index, dollar: delimiter, quoted: true });
      continue;
    }
    if (sql[index] === "'" || sql[index] === '"') {
      const quote = sql[index++];
      while (index < sql.length) {
        if (sql[index] !== quote) { index += 1; continue; }
        if (sql[index + 1] === quote) { index += 2; continue; }
        index += 1; break;
      }
      result.push({ text: sql.slice(start, index), start, end: index, quoted: true });
      continue;
    }
    if (/[A-Za-z0-9_]/.test(sql[index])) {
      while (index < sql.length && /[A-Za-z0-9_]/.test(sql[index])) index += 1;
    } else index += 1;
    result.push({ text: sql.slice(start, index), start, end: index });
  }
  return result;
}

function normalize(sql: string): string {
  return tokens(sql).map(token => {
    if (!token.dollar) return token.quoted ? token.text : token.text.toLowerCase();
    const body = token.text.slice(token.dollar.length, -token.dollar.length);
    const normalizedBody = tokens(body)
      .map(part => part.quoted ? part.text : part.text.toLowerCase())
      .join(' ');
    return `${token.dollar} ${normalizedBody} ${token.dollar}`;
  }).join(' ');
}

function functionDefinition(sql: string, label: string): string {
  const all = tokens(sql);
  const starts: number[] = [];
  for (let index = 0; index < all.length; index += 1) {
    const text = all.slice(index, index + 9).map(token => token.text.toLowerCase());
    const plain = ['create', 'function', 'public', '.', 'prevent_external_source_links_stale_write', '(', ')'];
    const replace = ['create', 'or', 'replace', ...plain.slice(1)];
    if (plain.every((part, offset) => text[offset] === part)
      || replace.every((part, offset) => text[offset] === part)) starts.push(index);
  }
  if (starts.length !== 1) throw new Error(`${label} must contain one executable target definition; found ${starts.length}`);
  const start = starts[0];
  const body = all.findIndex((token, index) => index > start && token.dollar);
  if (body < 0) throw new Error(`${label} target definition has no dollar body`);
  return sql.slice(all[start].start, all[body].end);
}

function uniqueOffset(source: string, value: string): number {
  const offset = source.indexOf(value);
  if (offset < 0 || source.indexOf(value, offset + 1) >= 0) throw new Error(`Expected one ${value}`);
  return offset;
}

describe('external source link operation identity convergence', () => {
  it('preserves the accepted init preimage and Widget block byte-for-byte', () => {
    const init = read(initPath);
    const start = uniqueOffset(init, marker);
    const end = uniqueOffset(init, banner);
    expect(start).toBeLessThan(end);
    expect(sha256(init.slice(0, start) + init.slice(end))).toBe(initPreimage);
    const widgetStart = uniqueOffset(init, widgetMarker);
    const widgetEnd = uniqueOffset(init, quotaMarker);
    const widget = init.slice(widgetStart, widgetEnd);
    expect(Buffer.byteLength(widget)).toBe(11111);
    expect(widget.split(/\r?\n/)).toHaveLength(358);
    expect(sha256(widget)).toBe(widgetHash);
  });

  it('binds exact operation replay to one canonical payload before stale handling', () => {
    const migration = read(migrationPath);
    const init = read(initPath);
    const finalBlock = init.slice(uniqueOffset(init, marker), uniqueOffset(init, banner));
    const migrationDefinition = normalize(functionDefinition(migration, migrationPath));
    const initDefinition = normalize(functionDefinition(finalBlock, `${initPath} final block`));
    expect(initDefinition).toBe(migrationDefinition);
    expect(migrationDefinition).toContain('security definer set search_path = pg_catalog , public');
    expect(migrationDefinition).toContain('old . operation_id is not null and new . operation_id = old . operation_id');
    const fields = ['id', 'user_id', 'task_id', 'source_type', 'target_id', 'uri', 'label', 'hpath', 'role', 'sort_order', 'deleted_at', 'created_at', 'updated_at'];
    const row = (name: string) => `row ( ${fields.map(field => `${name} . ${field}`).join(' , ')} )`;
    expect(migrationDefinition).toContain(`${row('old')} is distinct from ${row('new')}`);
    expect(migrationDefinition.indexOf("errcode = '22023'")).toBeLessThan(migrationDefinition.indexOf("old . updated_at > new . updated_at + interval '1 second'"));
    expect(migrationDefinition).toContain('return old');
    expect(normalize(migration)).toContain('revoke all on function public . prevent_external_source_links_stale_write ( ) from public , anon , authenticated');
  });

  it('requires every terminal pending mutation to carry operation identity', () => {
    const cache = normalize(read(cachePath));
    const service = normalize(read(servicePath));
    expect(cache).toContain('removependinglink ( linkid : string , operationid : string )');
    expect(cache).toContain('recordpendingfailure ( linkid : string , operationid : string , errorcode : string ,');
    expect(cache).toContain('replacependinglinkforretry');
    expect(cache).toContain('restorependinglinksnapshot');
    expect(service).toContain('restorependinglinksnapshot ( linkid , current . operationid , snapshot . previouspending )');
    expect(service).toContain('removependinglink ( retryentry . link . id , retryentry . operationid )');
    expect(service).toContain('recordpendingfailure ( retryentry . link . id , retryentry . operationid , result . errorcode )');
    expect(service.indexOf('replacependinglinkforretry')).toBeLessThan(
      service.indexOf('client , pendingentry . link , token . ownerid , pendingentry . operationid'),
    );
  });
});
