import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');

function extractTsArray(source: string, symbol: string): string[] {
  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`export\\s+const\\s+${escapedSymbol}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s+as\\s+const`));
  if (!match?.[1]) throw new Error(`Could not find command array ${symbol}`);
  return Array.from(match[1].matchAll(/'([^']+)'/g), item => item[1]!);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

const envelopeSource = read('src/services/sync/offline-sync-command-envelope.ts');
const replaySource = read('src/app/core/services/sync/offline-sync-command-replay-adapter.ts');
const fieldLwwSql = read('supabase/migrations/20261114030701_sync_offline_command_field_lww_projection.sql');
const domainApplySql = read('supabase/migrations/20261115165939_sync_offline_command_final_domain_apply_fence.sql');
const connectionDeleteFenceSql = read('supabase/migrations/20261125120000_offline_command_quarantine_connection_delete.sql');

function lastFunctionBody(source: string, functionName: string): string {
  const declaration = 'CREATE OR REPLACE FUNCTION public.' + functionName + '()';
  const start = source.lastIndexOf(declaration);
  if (start < 0) throw new Error('Could not find ' + functionName + ' declaration');
  const bodyStart = source.indexOf('AS $$', start);
  const bodyEnd = source.indexOf('$$;', bodyStart + 5);
  if (bodyStart < start || bodyEnd < 0) throw new Error('Could not extract ' + functionName + ' body');
  return source.slice(bodyStart + 5, bodyEnd);
}

describe('offline command capability alignment', () => {
  it('partitions every registered command into envelope replay or explicit quarantine', () => {
    const registered = extractTsArray(envelopeSource, 'OFFLINE_SYNC_COMMAND_KINDS');
    const replayable = extractTsArray(replaySource, 'OFFLINE_SYNC_SERVER_DOMAIN_COMMANDS');
    const quarantined = extractTsArray(replaySource, 'OFFLINE_SYNC_INTENTIONALLY_QUARANTINED_COMMANDS');
    expect(new Set(registered).size).toBe(registered.length);
    expect(new Set([...replayable, ...quarantined]).size).toBe(replayable.length + quarantined.length);
    expect(sortedUnique([...replayable, ...quarantined])).toEqual(sortedUnique(registered));
  });

  it('only projects commands that have a final v1 domain-apply acknowledgement route', () => {
    const replayable = extractTsArray(replaySource, 'OFFLINE_SYNC_SERVER_DOMAIN_COMMANDS');
    const supportedStart = domainApplySql.indexOf('v_supported := CASE NEW.entity_type');
    const supportedEnd = domainApplySql.indexOf('END;', supportedStart);
    expect(supportedStart).toBeGreaterThan(-1);
    expect(supportedEnd).toBeGreaterThan(supportedStart);
    const serverAllowlist = domainApplySql.slice(supportedStart, supportedEnd);
    for (const command of replayable) expect(serverAllowlist).toContain(command);
    expect(serverAllowlist).not.toContain('connection.delete');
    expect(replayable).not.toContain('connection.delete');
    expect(fieldLwwSql).toContain('[\"field-lww-v1\"]');
    expect(fieldLwwSql).toContain('CREATE TRIGGER trg_sync_command_projection');
    expect(fieldLwwSql).toContain('sync_pull_offline_projections');
    expect(domainApplySql).toContain('[\"domain-apply-v1\"]');
    expect(domainApplySql).toContain('sync_command_domain_apply_log');
  });

  it('keeps connection.delete quarantined in final fresh-init and forward-migration function bodies', () => {
    const initSql = read('scripts/init-supabase.sql');
    const initDomainApply = lastFunctionBody(initSql, 'sync_apply_command_domain_tables');
    const forwardDomainApply = lastFunctionBody(connectionDeleteFenceSql, 'sync_apply_command_domain_tables');
    for (const body of [initDomainApply, forwardDomainApply]) {
      expect(body).not.toContain('connection.delete');
      const connectionClause = body.match(/WHEN\s+'connection'\s+THEN\s+NEW\.command\s+IN\s*\(([^)]*)\)/i)?.[1] ?? '';
      const supportedCommands = Array.from(connectionClause.matchAll(/'([^']+)'/g), match => match[1]!);
      expect(supportedCommands).toEqual([
        'connection.create',
        'connection.update',
        'connection.restore',
        'connection.reorder',
      ]);
    }
    expect(connectionDeleteFenceSql).toContain('idx_sync_command_domain_apply_log_user');
  });
});
