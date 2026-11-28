import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const wrapperPath = path.join(process.cwd(), 'scripts', 'supabase-cli.cjs');

type ProjectTargetResult = {
  ok: boolean;
  reason?: 'missing-configured-project-ref' | 'missing-linked-project-ref' | 'project-ref-mismatch';
};

type ProjectSafetyModule = {
  evaluateDbPushPreflight: (
    args: string[],
    options?: { ledgerSnapshots?: Array<Record<string, unknown>>; expectedProjectRef?: string; expectedGitSha?: string; sourceIsAncestor?: (sourceSha: string, targetSha: string) => boolean; configuredProjectRef?: string; linkedProjectRef?: string; targetSha?: string; currentTargetSha?: string; nowUtc?: string },
  ) => { ok: boolean; runGuard: boolean; reason?: string; local?: boolean };
  isDbPushCommand: (args: string[]) => boolean;
  evaluateRemoteProjectTarget: (
    args: string[],
    configuredProjectRef: string,
    linkedProjectRef: string,
  ) => ProjectTargetResult;
  isRemoteProjectCommand: (args: string[]) => boolean;
  executeCli: (args: string[], dependencies: Record<string, unknown>) => { exitCode: number; spawned: boolean; reason?: string };
  loadLedgerSnapshots: (root: string) => { ok: boolean; ledgers: Array<Record<string, unknown>>; expectedProjectRef?: string; expectedGitSha?: string; reason?: string };
};

function loadSafetyModule(): ProjectSafetyModule | null {
  if (!fs.existsSync(wrapperPath)) {
    return null;
  }
  delete require.cache[require.resolve(wrapperPath)];
  return require(wrapperPath) as ProjectSafetyModule;
}

function makeWrapperProbe() {
  const tempBase = path.join(process.cwd(), '.tmp', 'supabase-push-probes');
  fs.mkdirSync(tempBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'probe-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'supabase', '.temp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  fs.copyFileSync(wrapperPath, path.join(root, 'scripts', 'supabase-cli.cjs'));
  fs.copyFileSync(path.join(process.cwd(), 'scripts', 'validate-migration-dry-run-rollback.cjs'), path.join(root, 'scripts', 'validate-migration-dry-run-rollback.cjs'));
  fs.writeFileSync(path.join(root, 'supabase', '.temp', 'project-ref'), 'fkhihclpghmmtbbywvoj');
  const marker = path.join(root, 'spawned.txt');
  fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'supabase.cmd'), `@echo off\r\necho STUB_SPAWNED>>"${marker}"\r\nexit /b 0\r\n`);
  fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'supabase'), '#!/bin/sh\necho STUB_SPAWNED >> "' + marker.split(path.sep).join('/') + '"\nexit 0\n');
  fs.copyFileSync(path.join(process.cwd(), 'package-lock.json'), path.join(root, 'package-lock.json'));
  return { root, marker };
}

function runWrapperProbe(root: string) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'supabase-cli.cjs'), 'db', 'push', '--linked'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SUPABASE_PROJECT_REF: 'fkhihclpghmmtbbywvoj',
      NANOFLOW_PUSH_TARGET_SHA: '3db29530188c15afdb6913ddcd8799a74a32d644',
    },
  });
}

describe('Supabase CLI project safety', () => {
  it('keeps the CLI wrapper import-safe for direct behavior tests', () => {
    const wrapper = fs.readFileSync(wrapperPath, 'utf8');

    expect(wrapper).toContain('if (require.main === module)');
    expect(wrapper).toContain('module.exports = {');
  });

  it('exports remote project validation from the import-safe wrapper', () => {
    expect(fs.existsSync(wrapperPath)).toBe(true);
  });

  it('recognizes commands that can access a linked remote project', () => {
    const safety = loadSafetyModule();
    if (!safety) return;

    for (const args of [
      ['db', 'push', '--dry-run'],
      ['db', 'pull'],
      ['db', 'query', '--linked', '--file', 'secret.sql'],
      ['db', 'dump', '--dry-run'],
      ['db', 'reset', '--linked'],
      ['gen', 'types', 'typescript', '--linked'],
      ['functions', 'deploy', 'example'],
      ['secrets', 'set', 'EXAMPLE=value'],
    ]) {
      expect(safety.isRemoteProjectCommand(args), args.join(' ')).toBe(true);
    }

    for (const args of [
      ['link'],
      ['start'],
      ['status'],
      ['db', 'reset'],
      ['functions', 'serve'],
      ['--version'],
    ]) {
      expect(safety.isRemoteProjectCommand(args), args.join(' ')).toBe(false);
    }
  });

  it('treats an explicitly linked db query as remote and leaves local query local', () => {
    const safety = loadSafetyModule();
    if (!safety) return;
    expect(safety.isRemoteProjectCommand(['db', 'query', '--linked', '--file', 'secret.sql'])).toBe(true);
    expect(safety.isRemoteProjectCommand(['db', 'query', '--local', '--file', 'secret.sql'])).toBe(false);
    expect(safety.isRemoteProjectCommand(['db', 'query', '--file', 'secret.sql'])).toBe(false);
  });

  it('does not spawn a linked db query when the configured project ref mismatches', () => {
    const safety = loadSafetyModule();
    if (!safety) return;
    let spawnCalls = 0;
    const result = safety.executeCli(['db', 'query', '--linked', '--file', 'secret.sql'], {
      env: { SUPABASE_PROJECT_REF: 'preview-ref' },
      root: process.cwd(),
      readLinkedProjectRef: () => 'production-ref',
      invokeCliCommand: () => { spawnCalls += 1; return { status: 0 }; },
      logError: () => undefined,
    });
    expect(result).toEqual({ exitCode: 2, spawned: false });
    expect(spawnCalls).toBe(0);
  });
  it('blocks remote access unless configured and linked project refs match', () => {
    const safety = loadSafetyModule();
    if (!safety) return;

    expect(safety.evaluateRemoteProjectTarget(['db', 'push'], '', 'production-ref')).toEqual({
      ok: false,
      reason: 'missing-configured-project-ref',
    });
    expect(safety.evaluateRemoteProjectTarget(['db', 'push'], 'preview-ref', '')).toEqual({
      ok: false,
      reason: 'missing-linked-project-ref',
    });
    expect(safety.evaluateRemoteProjectTarget(['db', 'push'], 'preview-ref', 'production-ref')).toEqual({
      ok: false,
      reason: 'project-ref-mismatch',
    });
    expect(safety.evaluateRemoteProjectTarget(['db', 'push'], 'preview-ref', 'preview-ref')).toEqual({
      ok: true,
    });
    expect(safety.evaluateRemoteProjectTarget(['db', 'reset'], 'preview-ref', 'production-ref')).toEqual({
      ok: true,
    });
  });

  it('binds the committed source SHA to the current target across later commits', () => {
    const safety = loadSafetyModule();
    if (!safety) return;
    const ledgerState = safety.loadLedgerSnapshots(process.cwd());
    expect(ledgerState.ok).toBe(true);
    expect(ledgerState.expectedProjectRef).toBe('fkhihclpghmmtbbywvoj');
    const sourceSha = ledgerState.expectedGitSha;
    const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
    const capturedAtUtc = String((ledgerState.ledgers[0] as Record<string, unknown>).capturedAtUtc);
    const nowUtc = new Date(Date.parse(capturedAtUtc) + 60_000).toISOString();
    expect(sourceSha).toMatch(/^[a-f0-9]{40}$/i);
    expect(ledgerState.ledgers[0]?.sourceGitSha).toBe(sourceSha);
    const seen: string[] = [];
    const result = safety.evaluateDbPushPreflight(['db', 'push', '--linked'], {
      ledgerSnapshots: ledgerState.ledgers,
      expectedProjectRef: ledgerState.expectedProjectRef,
      configuredProjectRef: 'fkhihclpghmmtbbywvoj',
      linkedProjectRef: 'fkhihclpghmmtbbywvoj',
      targetSha,
      currentTargetSha: targetSha,
      expectedGitSha: sourceSha,
      nowUtc,
      sourceIsAncestor: (left: string, right: string) => { seen.push(left, right); return true; },
    });
    expect(result).toMatchObject({ ok: true, runGuard: true });
    expect(seen).toEqual([sourceSha, targetSha]);
  });
  it('requires an explicit linked target and a bound ledger snapshot for remote db push', () => {
    const safety = loadSafetyModule();
    if (!safety) return;
    const projectRef = 'abcdefghijklmnopqrst';
    const targetSha = 'a'.repeat(40);
    const sourceSha = 'c'.repeat(40);
    const bound = { projectRef, sourceGitSha: sourceSha, capturedAtUtc: '2026-11-22T08:20:00Z', maxAgeSeconds: 86400, sourceEvidence: { tool: 'mcp__supabase.execute_sql', queryId: 'test', query: 'SELECT', resultRowCount: 0 }, rows: [] };
    const exact = { ledgerSnapshots: [bound], expectedProjectRef: projectRef, configuredProjectRef: projectRef, linkedProjectRef: projectRef, targetSha, currentTargetSha: targetSha, expectedGitSha: sourceSha, sourceIsAncestor: () => true, nowUtc: '2026-11-22T09:00:00Z' };

    expect(safety.evaluateDbPushPreflight(['db', 'push'], exact)).toEqual({
      ok: false, runGuard: false, reason: 'explicit-target-required',
    });
    expect(safety.evaluateDbPushPreflight(['db', 'push', '--local'], exact)).toEqual({
      ok: true, runGuard: false, local: true,
    });
    expect(safety.evaluateDbPushPreflight(['db', 'push', '--linked'], { ...exact, ledgerSnapshots: [] })).toEqual({
      ok: false, runGuard: false, reason: 'ledger-snapshot-not-target-bound',
    });
    expect(safety.evaluateDbPushPreflight(['db', 'push', '--linked'], { ...exact, configuredProjectRef: 'zzzzzzzzzzzzzzzzzzzz' })).toEqual({
      ok: false, runGuard: false, reason: 'project-ref-mismatch',
    });
    expect(safety.evaluateDbPushPreflight(['db', 'push', '--linked'], { ...exact, targetSha: 'b'.repeat(40) })).toEqual({
      ok: false, runGuard: false, reason: 'current-target-sha-mismatch',
    });
    expect(safety.evaluateDbPushPreflight(['db', 'push', '--linked'], exact)).toEqual({
      ok: true, runGuard: true,
    });
  });

  it('never spawns the CLI when the known alias chain is empty or missing', () => {
    const probe = makeWrapperProbe();
    try {
      fs.mkdirSync(path.join(probe.root, 'supabase', 'migrations'), { recursive: true });
      fs.writeFileSync(path.join(probe.root, 'supabase', 'migrations', '20260101000000_safe.sql'), 'SELECT 1;');
      fs.writeFileSync(path.join(probe.root, 'scripts', 'migration-version-alias-manifest.json'), JSON.stringify({
        schemaVersion: 2, format: 'MIGRATION_VERSION_ALIASES_V1', ledgerSnapshotPath: 'scripts/migration-ledger-snapshot.json', aliases: [],
      }));
      fs.writeFileSync(path.join(probe.root, 'scripts', 'migration-ledger-snapshot.json'), JSON.stringify({
        format: 'SUPABASE_SCHEMA_MIGRATIONS_V1', source: 'mcp__supabase.execute_sql', capturedAtUtc: '2026-11-22T08:20:00Z', projectRef: 'fkhihclpghmmtbbywvoj', sourceGitSha: '3db29530188c15afdb6913ddcd8799a74a32d644', rows: [], rowCount: 0, canonicalRowsSha256: 'A'.repeat(64),
      }));
      const result = runWrapperProbe(probe.root);
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(probe.marker)).toBe(false);
    } finally {
      fs.rmSync(probe.root, { recursive: true, force: true });
    }
  });


  it('rejects stale, wrong-target, and unverifiable ledger evidence before CLI spawn', () => {
    const safety = loadSafetyModule();
    if (!safety) return;
    const projectRef = 'abcdefghijklmnopqrst';
    const targetSha = 'a'.repeat(40);
    const base = { projectRef, sourceGitSha: targetSha, capturedAtUtc: '2026-11-20T00:00:00Z', maxAgeSeconds: 60, rows: [], sourceEvidence: { tool: 'mcp__supabase.execute_sql', queryId: 'test', query: 'SELECT', resultRowCount: 0 } };
    const opts = { ledgerSnapshots: [base], expectedProjectRef: projectRef, configuredProjectRef: projectRef, linkedProjectRef: projectRef, targetSha, currentTargetSha: targetSha, expectedGitSha: targetSha, sourceIsAncestor: () => true, nowUtc: '2026-11-22T00:00:00Z' };
    expect(safety.evaluateDbPushPreflight(['db', 'push', '--linked'], opts)).toMatchObject({ ok: false, runGuard: false, reason: 'ledger-snapshot-stale' });
    expect(safety.evaluateDbPushPreflight(['db', 'push', '--linked'], { ...opts, currentTargetSha: 'b'.repeat(40) })).toMatchObject({ ok: false, reason: 'current-target-sha-mismatch', runGuard: false });
    expect(safety.evaluateDbPushPreflight(['db', 'push', '--linked'], { ...opts, ledgerSnapshots: [{ ...base, capturedAtUtc: '2026-11-22T00:00:00Z', sourceEvidence: null }] })).toMatchObject({ ok: false, runGuard: false, reason: 'ledger-capture-evidence-unverified' });
  });


  it('does not call the injected CLI executor on stale evidence in the real main control flow', () => {
    const safety = loadSafetyModule();
    if (!safety) return;
    const projectRef = 'abcdefghijklmnopqrst';
    const targetSha = 'a'.repeat(40);
    let calls = 0;
    const result = safety.executeCli(['db', 'push', '--linked'], {
      env: {
        SUPABASE_PROJECT_REF: projectRef,
        NANOFLOW_PUSH_TARGET_SHA: targetSha,
        NANOFLOW_CURRENT_TARGET_SHA: targetSha,
        NANOFLOW_PREFLIGHT_NOW_UTC: '2026-11-22T00:00:00Z',
      },
      root: process.cwd(),
      readLinkedProjectRef: () => projectRef,
      loadLedgerSnapshots: () => ({
        ok: true,
        ledgers: [{
          projectRef,
          sourceGitSha: targetSha,
          capturedAtUtc: '2026-11-20T00:00:00Z',
          maxAgeSeconds: 60,
          rows: [],
          sourceEvidence: { tool: 'mcp__supabase.execute_sql', queryId: 'test', query: 'SELECT', resultRowCount: 0 },
        }],
        expectedGitSha: targetSha,
        expectedProjectRef: projectRef,
      }),
      gitIsAncestor: () => true,
      invokeCliCommand: () => { calls += 1; throw new Error('CLI must not run'); },
      runMigrationPreflight: () => { throw new Error('preflight must not run'); },
      logError: () => undefined,
    });
    expect(result).toMatchObject({ exitCode: 2, spawned: false, reason: 'ledger-snapshot-stale' });
    expect(calls).toBe(0);
  });


  it.each([
    ['missing manifest expectedGitSha', undefined],
    ['wrong manifest expectedGitSha', 'b'.repeat(40)],
  ])('real wrapper subprocess does not spawn on %s', (_case, manifestExpectedGitSha) => {
    const probe = makeWrapperProbe();
    const targetSha = 'a'.repeat(40);
    try {
      fs.mkdirSync(path.join(probe.root, 'supabase', 'migrations'), { recursive: true });
      fs.writeFileSync(path.join(probe.root, 'supabase', 'migrations', '20260101000000_safe.sql'), 'SELECT 1;');
      fs.writeFileSync(path.join(probe.root, 'scripts', 'migration-version-alias-manifest.json'), JSON.stringify({
        schemaVersion: 2,
        format: 'MIGRATION_VERSION_ALIASES_V1',
        ledgerSnapshotPath: 'scripts/migration-ledger-snapshot.json',
        expectedProjectRef: 'fkhihclpghmmtbbywvoj',
        expectedGitSha: manifestExpectedGitSha,
        aliases: [{
          sourcePath: 'supabase/migrations/20261121060000_widget_focus_action_durable_receipt.sql',
          sourceVersion: '20261121060000',
          sourceName: 'widget_focus_action_durable_receipt',
          sourceSha256: 'A'.repeat(64),
          appliedAliases: [
            { version: '20261122053816', name: 'widget_focus_action_durable_receipt' },
            { version: '20261122053936', name: 'widget_focus_action_durable_receipt_exact_repair' },
          ],
        }],
      }));
      fs.writeFileSync(path.join(probe.root, 'scripts', 'migration-ledger-snapshot.json'), JSON.stringify({
        format: 'SUPABASE_SCHEMA_MIGRATIONS_V1', source: 'mcp__supabase.execute_sql', capturedAtUtc: '2026-11-22T08:20:00Z', projectRef: 'fkhihclpghmmtbbywvoj', sourceGitSha: targetSha, expectedGitSha: targetSha, rows: [], rowCount: 0, canonicalRowsSha256: 'A'.repeat(64), sourceEvidence: { tool: 'mcp__supabase.execute_sql', queryId: 'q', query: 'SELECT', resultRowCount: 0 },
      }));
      const result = spawnSync(process.execPath, [path.join(probe.root, 'scripts', 'supabase-cli.cjs'), 'db', 'push', '--linked'], {
        cwd: probe.root,
        encoding: 'utf8',
        env: {
          ...process.env,
          SUPABASE_PROJECT_REF: 'fkhihclpghmmtbbywvoj',
          NANOFLOW_PUSH_TARGET_SHA: targetSha,
          NANOFLOW_CURRENT_TARGET_SHA: targetSha,
          NANOFLOW_PREFLIGHT_NOW_UTC: '2026-11-22T08:21:00Z',
        },
      });
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(probe.marker)).toBe(false);
    } finally {
      fs.rmSync(probe.root, { recursive: true, force: true });
    }
  });

  it.each([
    ['malformed now', 'not-a-date', '2026-11-22T08:20:00Z', 'ledger-current-time-invalid'],
    ['malformed capturedAt', '2026-11-22T08:21:00Z', 'not-a-date', 'ledger-snapshot-captured-at-invalid'],
    ['future capturedAt', '2026-11-22T08:20:00Z', '2026-11-22T08:20:01Z', 'ledger-snapshot-captured-in-future'],
    ['missing capturedAt', '2026-11-22T08:20:00Z', '', 'ledger-snapshot-captured-at-invalid'],
    ['missing query identity', '2026-11-22T08:20:00Z', '2026-11-22T08:20:00Z', 'ledger-capture-evidence-unverified'],
  ])('executeCli does not spawn on %s', (_case, nowUtc, capturedAtUtc, expectedReason) => {
    const safety = loadSafetyModule();
    if (!safety) return;
    const projectRef = 'abcdefghijklmnopqrst';
    const targetSha = 'a'.repeat(40);
    let spawnCalls = 0;
    const sourceEvidence = expectedReason === 'ledger-capture-evidence-unverified'
      ? { tool: 'mcp__supabase.execute_sql', resultRowCount: 0 }
      : { tool: 'mcp__supabase.execute_sql', queryId: 'q', query: 'SELECT', resultRowCount: 0 };
    const result = safety.executeCli(['db', 'push', '--linked'], {
      env: { SUPABASE_PROJECT_REF: projectRef, NANOFLOW_PUSH_TARGET_SHA: targetSha, NANOFLOW_CURRENT_TARGET_SHA: targetSha, NANOFLOW_PREFLIGHT_NOW_UTC: nowUtc },
      root: process.cwd(),
      readLinkedProjectRef: () => projectRef,
      loadLedgerSnapshots: () => ({ ok: true, ledgers: [{ projectRef, sourceGitSha: targetSha, capturedAtUtc, maxAgeSeconds: 60, rows: [], sourceEvidence }], expectedGitSha: targetSha, expectedProjectRef: projectRef }),
      gitIsAncestor: () => true,
      invokeCliCommand: () => { spawnCalls += 1; return { status: 0 }; },
      runMigrationPreflight: () => ({ ok: true, status: 0 }),
      logError: () => undefined,
    });
    expect((result as { reason?: string }).reason).toBe(expectedReason);
    expect(result).toMatchObject({ exitCode: 2, spawned: false });
    expect(spawnCalls).toBe(0);
  });

  it.each([
    ['missing expectedGitSha', undefined],
    ['wrong expectedGitSha', 'b'.repeat(40)],
  ])('executeCli does not spawn on %s', (_case, expectedGitSha) => {
    const safety = loadSafetyModule();
    if (!safety) return;
    const projectRef = 'abcdefghijklmnopqrst';
    const targetSha = 'a'.repeat(40);
    const sourceSha = 'c'.repeat(40);
    let spawnCalls = 0;
    const result = safety.executeCli(['db', 'push', '--linked'], {
      env: {
        SUPABASE_PROJECT_REF: projectRef,
        NANOFLOW_PUSH_TARGET_SHA: targetSha,
        NANOFLOW_CURRENT_TARGET_SHA: targetSha,
        NANOFLOW_PREFLIGHT_NOW_UTC: '2026-11-22T08:21:00Z',
      },
      root: process.cwd(),
      readLinkedProjectRef: () => projectRef,
      loadLedgerSnapshots: () => ({
        ok: true,
        ledgers: [{
          projectRef,
          sourceGitSha: sourceSha,
          capturedAtUtc: '2026-11-22T08:20:00Z',
          maxAgeSeconds: 60,
          rows: [],
          sourceEvidence: { tool: 'mcp__supabase.execute_sql', queryId: 'q', query: 'SELECT', resultRowCount: 0 },
        }],
        expectedGitSha,
        expectedProjectRef: projectRef,
      }),
      gitIsAncestor: (_root: string, ancestor: string, descendant: string) => ancestor === sourceSha && descendant === targetSha,
      invokeCliCommand: () => { spawnCalls += 1; return { status: 0 }; },
      runMigrationPreflight: () => ({ ok: true, status: 0 }),
      logError: () => undefined,
    });
    expect(result).toMatchObject({ exitCode: 2, spawned: false, reason: 'ledger-source-sha-mismatch' });
    expect(spawnCalls).toBe(0);
  });

  it('delegates the guard once and executes the CLI only after successful preflight', () => {
    const safety = loadSafetyModule();
    if (!safety) return;
    const projectRef = 'abcdefghijklmnopqrst';
    const sourceSha = 'c'.repeat(40);
    const targetSha = 'd'.repeat(40);
    let spawnCalls = 0;
    let guardCalls = 0;
    const result = safety.executeCli(['db', 'push', '--linked'], {
      env: { SUPABASE_PROJECT_REF: projectRef, NANOFLOW_PUSH_TARGET_SHA: targetSha, NANOFLOW_CURRENT_TARGET_SHA: targetSha, NANOFLOW_PREFLIGHT_NOW_UTC: '2026-11-22T08:21:00Z' },
      root: process.cwd(),
      readLinkedProjectRef: () => projectRef,
      loadLedgerSnapshots: () => ({ ok: true, ledgers: [{ projectRef, sourceGitSha: sourceSha, capturedAtUtc: '2026-11-22T08:20:00Z', maxAgeSeconds: 60, rows: [], sourceEvidence: { tool: 'mcp__supabase.execute_sql', queryId: 'q', query: 'SELECT', resultRowCount: 0 } }], expectedGitSha: sourceSha, expectedProjectRef: projectRef }),
      gitIsAncestor: () => true,
      invokeCliCommand: () => { spawnCalls += 1; return { status: 0 }; },
      runMigrationPreflight: () => { guardCalls += 1; return { ok: true, status: 0 }; },
      logError: () => undefined,
    });
    expect(result).toEqual({ exitCode: 0, spawned: true });
    expect(guardCalls).toBe(1);
    expect(spawnCalls).toBe(1);
  });

  it('does not spawn on project-ref mismatch in executeCli', () => {
    const safety = loadSafetyModule();
    if (!safety) return;
    let spawnCalls = 0;
    let guardCalls = 0;
    const result = safety.executeCli(['db', 'push', '--linked'], {
      env: { SUPABASE_PROJECT_REF: 'aaaaaaaaaaaaaaaaaaaa', NANOFLOW_PUSH_TARGET_SHA: 'a'.repeat(40) },
      root: process.cwd(),
      readLinkedProjectRef: () => 'bbbbbbbbbbbbbbbbbbbb',
      loadLedgerSnapshots: () => { throw new Error('ledger must not load'); },
      invokeCliCommand: () => { spawnCalls += 1; return { status: 0 }; },
      runMigrationPreflight: () => { guardCalls += 1; return { ok: true, status: 0 }; },
      logError: () => undefined,
    });
    expect(result).toMatchObject({ exitCode: 2, spawned: false });
    expect(spawnCalls).toBe(0);
    expect(guardCalls).toBe(0);
  });

  it('accepts a source snapshot that is an ancestor of the actual pushed HEAD', () => {
    const safety = loadSafetyModule();
    if (!safety) return;
    const projectRef = 'abcdefghijklmnopqrst';
    const sourceSha = 'c'.repeat(40);
    const targetSha = 'd'.repeat(40);
    let spawnCalls = 0;
    let ancestorArgs: unknown;
    const result = safety.executeCli(['db', 'push', '--linked'], {
      env: { SUPABASE_PROJECT_REF: projectRef, NANOFLOW_PUSH_TARGET_SHA: targetSha, NANOFLOW_CURRENT_TARGET_SHA: targetSha, NANOFLOW_PREFLIGHT_NOW_UTC: '2026-11-22T08:21:00Z' },
      root: process.cwd(),
      readLinkedProjectRef: () => projectRef,
      loadLedgerSnapshots: () => ({
        ok: true,
        ledgers: [{ projectRef, sourceGitSha: sourceSha, expectedGitSha: sourceSha, capturedAtUtc: '2026-11-22T08:20:00Z', maxAgeSeconds: 60, rows: [], sourceEvidence: { tool: 'mcp__supabase.execute_sql', queryId: 'q', query: 'SELECT', resultRowCount: 0 } }],
        expectedGitSha: sourceSha,
        expectedProjectRef: projectRef,
      }),
      gitIsAncestor: (root: string, ancestor: string, descendant: string) => { ancestorArgs = { root, ancestor, descendant }; return true; },
      invokeCliCommand: () => { spawnCalls += 1; return { status: 0 }; },
      runMigrationPreflight: () => ({ ok: true, status: 0 }),
      logError: () => undefined,
    });
    expect(result).toEqual({ exitCode: 0, spawned: true });
    expect(spawnCalls).toBe(1);
    expect(ancestorArgs).toEqual({ root: process.cwd(), ancestor: sourceSha, descendant: targetSha });
  });

  it('does not spawn when snapshot source is not an ancestor of the pushed HEAD', () => {
    const safety = loadSafetyModule();
    if (!safety) return;
    const projectRef = 'abcdefghijklmnopqrst';
    const sourceSha = 'c'.repeat(40);
    const targetSha = 'd'.repeat(40);
    let spawnCalls = 0;
    const result = safety.executeCli(['db', 'push', '--linked'], {
      env: { SUPABASE_PROJECT_REF: projectRef, NANOFLOW_PUSH_TARGET_SHA: targetSha, NANOFLOW_CURRENT_TARGET_SHA: targetSha, NANOFLOW_PREFLIGHT_NOW_UTC: '2026-11-22T08:21:00Z' },
      root: process.cwd(),
      readLinkedProjectRef: () => projectRef,
      loadLedgerSnapshots: () => ({
        ok: true,
        ledgers: [{ projectRef, sourceGitSha: sourceSha, expectedGitSha: sourceSha, capturedAtUtc: '2026-11-22T08:20:00Z', maxAgeSeconds: 60, rows: [], sourceEvidence: { tool: 'mcp__supabase.execute_sql', queryId: 'q', query: 'SELECT', resultRowCount: 0 } }],
        expectedGitSha: sourceSha,
        expectedProjectRef: projectRef,
      }),
      gitIsAncestor: () => false,
      invokeCliCommand: () => { spawnCalls += 1; return { status: 0 }; },
      runMigrationPreflight: () => ({ ok: true, status: 0 }),
      logError: () => undefined,
    });
    expect(result).toMatchObject({ exitCode: 2, spawned: false, reason: 'ledger-source-sha-not-ancestor' });
    expect(spawnCalls).toBe(0);
  });
  it('accepts freshness exactly at the max-age boundary and proceeds to the executor', () => {
    const safety = loadSafetyModule();
    if (!safety) return;
    const projectRef = 'abcdefghijklmnopqrst';
    const targetSha = 'a'.repeat(40);
    let spawnCalls = 0;
    let preflightArgs: unknown;
    const result = safety.executeCli(['db', 'push', '--linked'], {
      env: { SUPABASE_PROJECT_REF: projectRef, NANOFLOW_PUSH_TARGET_SHA: targetSha, NANOFLOW_CURRENT_TARGET_SHA: targetSha, NANOFLOW_PREFLIGHT_NOW_UTC: '2026-11-22T08:21:00Z' },
      root: process.cwd(),
      readLinkedProjectRef: () => projectRef,
      loadLedgerSnapshots: () => ({ ok: true, ledgers: [{ projectRef, sourceGitSha: 'c'.repeat(40), capturedAtUtc: '2026-11-22T08:20:00Z', maxAgeSeconds: 60, rows: [], sourceEvidence: { tool: 'mcp__supabase.execute_sql', queryId: 'q', query: 'SELECT', resultRowCount: 0 } }], expectedGitSha: 'c'.repeat(40), expectedProjectRef: projectRef }),
      gitIsAncestor: () => true,
      invokeCliCommand: () => { spawnCalls += 1; return { status: 0 }; },
      runMigrationPreflight: (_root: string, options: unknown) => { preflightArgs = options; return { ok: true, status: 0 }; },
      logError: () => undefined,
    });
    expect(result).toEqual({ exitCode: 0, spawned: true });
    expect(spawnCalls).toBe(1);
    expect(preflightArgs).toEqual({ nowUtc: '2026-11-22T08:21:00Z', currentTargetSha: targetSha });
  });

});
