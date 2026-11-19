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

function extractSqlSupportedCommands(source: string): string[] {
  const match = source.match(/v_supported\s*:=\s*CASE\s+NEW\.entity_type([\s\S]*?)\bEND;/i);
  if (!match?.[1]) throw new Error('Could not find SQL v_supported entity command allowlist');
  const commands: string[] = [];
  const clauses = /WHEN\s+'([^']+)'\s+THEN\s+NEW\.command\s+(?:IN\s*\(([\s\S]*?)\)|=\s*'([^']+)')/gi;
  for (const clause of match[1].matchAll(clauses)) {
    if (clause[2] === undefined) {
      commands.push(clause[3]!);
      continue;
    }
    for (const literal of clause[2].matchAll(/'([^']+)'/g)) {
      commands.push(literal[1]!);
    }
  }
  return commands;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

const envelopeSource = read('src/services/sync/offline-sync-command-envelope.ts');
const replaySource = read('src/app/core/services/sync/offline-sync-command-replay-adapter.ts');
const fieldLwwSql = read('supabase/migrations/20261114030701_sync_offline_command_field_lww_projection.sql');
const domainApplySql = read('supabase/migrations/20261114094736_sync_offline_command_domain_apply_ack.sql');

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
    expect(sortedUnique(extractSqlSupportedCommands(fieldLwwSql))).toEqual(sortedUnique(replayable));
    expect(sortedUnique(extractSqlSupportedCommands(domainApplySql))).toEqual(sortedUnique(replayable));
  });
});