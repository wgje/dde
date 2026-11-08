import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const runnerPath = path.join(projectRoot, 'scripts', 'check-supabase-ready-contract.cjs');
const fixtureRoots: string[] = [];

function createFixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-supabase-ready-'));
  fixtureRoots.push(root);
  for (const [relativeFile, source] of Object.entries(files)) {
    const target = path.join(root, relativeFile);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return root;
}

function runFixture(root: string, files: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [
    runnerPath,
    `--root=${root}`,
    `--files=${files.join(',')}`,
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('check-supabase-ready-contract availability probes', () => {
  it('passes the real gate with the two bounded availability probes', () => {
    const files = {
      'src/app/core/services/sync/session-manager.service.ts':
        'try { client = this.supabase.client(); } catch { /* client remains unavailable */ }\n',
      'src/services/auth.service.ts':
        'try { this.supabase.client(); return true; } catch { return false; }\n',
    };
    const result = runFixture(createFixture(files), Object.keys(files));

    expect(result.status, String(result.stderr || result.stdout)).toBe(0);
    expect(result.stdout).toContain('通过：2 个关键文件');
  });

  it('still rejects a normal synchronous client call in a checked file', () => {
    const files = {
      'src/app/core/services/sync/session-manager.service.ts': [
        'try { client = this.supabase.client(); } catch { /* client remains unavailable */ }',
        'return this.supabase.client();',
      ].join('\n'),
    };
    const result = runFixture(createFixture(files), Object.keys(files));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('session-manager.service.ts:2');
  });

  it('rejects a drifted probe shape instead of silently widening the exception', () => {
    const files = {
      'src/services/auth.service.ts':
        'try { return this.supabase.client() !== null; } catch { return false; }\n',
    };
    const result = runFixture(createFixture(files), Object.keys(files));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('auth.service.ts:1');
  });
});
