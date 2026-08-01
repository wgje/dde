import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const guardPath = path.join(repoRoot, 'scripts', 'contracts', 'check-coupled-changes.cjs');
const tempRoots: string[] = [];
const triggerA = 'src/services/dock-snapshot-persistence.service.ts';
const triggerB = 'src/services/launch-snapshot.service.ts';
const companion = 'src/services/disaster-backup.service.ts';
const unrelated = 'src/unrelated.ts';
const evidence = "localStorage.setItem('nanoflow.snapshot', 'value');\n";

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-coupled-working-tree-'));
  tempRoots.push(root);
  return root;
}

function writeFixture(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return result.stdout;
}

function initRepo(files: Record<string, string> = { [unrelated]: 'baseline\n' }): string {
  const root = createRoot();
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'contract@example.invalid']);
  git(root, ['config', 'user.name', 'Contract Test']);
  for (const [relativePath, content] of Object.entries(files)) {
    writeFixture(root, relativePath, content);
  }
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'fixture baseline']);
  return root;
}

function initRepoWithHeadTrigger(): string {
  const root = initRepo();
  writeFixture(root, triggerA, evidence);
  git(root, ['add', '--', triggerA]);
  git(root, ['commit', '--quiet', '-m', 'add trigger evidence']);
  return root;
}

function childEnv(contamination: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const blocked = new Set([
    'required_files_manifest_required',
    'required_files_manifest_path',
    'coupled_guard_diff_base',
    'github_event_before',
    'github_base_ref',
    'git_dir',
    'git_work_tree',
    'git_index_file',
    'git_object_directory',
    'git_alternate_object_directories',
    'git_common_dir',
  ]);
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...contamination })
      .filter(([name]) => !blocked.has(name.toLowerCase())),
  );
  return {
    ...env,
    REQUIRED_FILES_MANIFEST_REQUIRED: '0',
    REQUIRED_FILES_MANIFEST_PATH: '',
  };
}

function runGuard(
  root: string,
  args: readonly string[] = ['--mode=working-tree-or-head'],
  contamination: NodeJS.ProcessEnv = {},
  explicitEnv: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [guardPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...childEnv(contamination), ...explicitEnv },
    timeout: 8_000,
  });
}

function runGuardWithIndexGap(root: string, relPath: string, role: 'cached' | 'unstaged', status: readonly string[]): SpawnSyncReturns<string> {
  const fixture = createRoot();
  const preload = path.join(fixture, 'git-index-gap.cjs');
  writeFileSync(preload, `
const childProcess = require('node:child_process');
const realExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = (file, args, options) => {
  const role = args[0] === 'diff' && args.includes('--name-status') ? (args[1] === '--cached' ? 'cached' : 'unstaged') : '';
  if (file === 'git' && role === process.env.GIT_SHIM_ROLE) return JSON.parse(process.env.GIT_SHIM_STATUS).join('\\0');
  if (file === 'git' && args[0] === 'ls-files' && args[1] === '--stage' && args.at(-1) === process.env.GIT_SHIM_PATH) return '';
  return realExecFileSync(file, args, options);
};
`, 'utf8');
  return runGuard(root, undefined, {}, {
    NODE_OPTIONS: `--require=${preload}`,
    GIT_SHIM_PATH: relPath,
    GIT_SHIM_ROLE: role,
    GIT_SHIM_STATUS: JSON.stringify(status),
  });
}

function expectViolation(result: SpawnSyncReturns<string>, ...paths: string[]): void {
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
  expect(result.stderr).toContain('local-persistence-backup-restore');
  expect(result.stderr).not.toContain('coupled-change-evidence-unavailable');
  for (const relativePath of paths) expect(result.stderr).toContain(relativePath);
}

function expectPassed(result: SpawnSyncReturns<string>): void {
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  expect(result.stdout).toContain('[quality:guard:coupled-changes] passed');
}

function expectUnavailable(result: SpawnSyncReturns<string>): void {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.trim()).toBe('[quality:guard:coupled-changes] coupled-change-evidence-unavailable');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('coupled-change working-tree-or-head evidence', { timeout: 20_000 }, () => {
  it('uses exactly three NUL-delimited worktree acquisitions', () => {
    const root = initRepo();
    writeFixture(root, unrelated, 'dirty\n');
    const tracePath = path.join(createRoot(), 'git-trace.json');
    expectPassed(runGuard(root, undefined, {}, { GIT_TRACE2_EVENT: tracePath }));
    const commands = readFileSync(tracePath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line) as { event?: string; argv?: string[] })
      .filter(event => event.event === 'start')
      .map(event => event.argv?.slice(1));
    expect(commands).toEqual([
      ['diff', '--cached', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRD'],
      ['diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRD'],
      ['ls-files', '--others', '--exclude-standard', '-z'],
    ]);
  });

  it('uses current content for an unstaged tracked trigger', () => {
    const root = initRepo({ [triggerA]: 'export {};\n' });
    writeFixture(root, triggerA, evidence);
    expectViolation(runGuard(root), triggerA);
  });

  it('uses current content and proven absence for an untracked trigger', () => {
    const root = initRepo();
    writeFixture(root, triggerA, evidence);
    expectViolation(runGuard(root), triggerA);
    writeFixture(root, triggerA, 'export {};\n');
    expectPassed(runGuard(root));
  });

  it('retains deleted trigger evidence', () => {
    const root = initRepo({ [triggerA]: evidence });
    unlinkSync(path.join(root, triggerA));
    expectViolation(runGuard(root), triggerA);
  });

  it('fails closed when staged deletion diff evidence cannot be read', () => {
    const root = initRepo({ [triggerA]: 'export {};\n' });
    unlinkSync(path.join(root, triggerA));
    git(root, ['add', '--all']);
    expectPassed(runGuard(root, ['--mode=staged']));
    const blob = git(root, ['rev-parse', `HEAD:${triggerA}`]).trim();
    unlinkSync(path.join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    expectUnavailable(runGuard(root, ['--mode=staged']));
  });

  it('retains both old and new paths for a rename', () => {
    const root = initRepo({ [triggerA]: evidence });
    renameSync(path.join(root, triggerA), path.join(root, triggerB));
    git(root, ['add', '--all']);
    expectViolation(runGuard(root), triggerA, triggerB);
  });

  for (const fixture of [
    ['fails closed for a copy source with missing index evidence', 'cached', ['C100', triggerA, 'src/copied.ts', '']],
    ['fails closed for an unstaged rename new-side without index proof', 'unstaged', ['R100', 'src/old.ts', triggerA, '']],
  ] as const) {
    it(fixture[0], () => {
      const root = initRepo({ [triggerA]: 'export {};\n' });
      expectUnavailable(runGuardWithIndexGap(root, triggerA, fixture[1], fixture[2]));
    });
  }

  it('orders mixed-case trigger diagnostics ordinally', () => {
    const root = initRepo();
    for (const name of ['B.sql', 'Z.sql', 'a.sql']) writeFixture(root, `supabase/migrations/${name}`, 'create table t(id int);\n');
    const result = runGuard(root);
    expect(result.stderr).toContain('changed: supabase/migrations/B.sql, supabase/migrations/Z.sql, supabase/migrations/a.sql');
  });

  for (const [name, stagedPath, stagedContent, currentPath, currentContent, passes] of [
    ['accepts an unstaged companion for a staged trigger', triggerA, evidence, companion, 'unstaged companion\n', true],
    ['retains staged evidence when current content is restored to HEAD', triggerA, evidence, triggerA, 'export {};\n', false],
    ['accepts a staged companion for current trigger evidence', companion, 'staged companion\n', triggerA, evidence, true],
  ] as const) {
    it(name, () => {
      const root = initRepo({ [triggerA]: 'export {};\n', [companion]: 'baseline\n' });
      writeFixture(root, stagedPath, stagedContent);
      git(root, ['add', '--', stagedPath]);
      writeFixture(root, currentPath, currentContent);
      if (passes) expectPassed(runGuard(root));
      else expectViolation(runGuard(root), triggerA);
    });
  }

  it('deduplicates a path changed in both index and worktree', () => {
    const root = initRepo({ [triggerA]: 'export {};\n' });
    writeFixture(root, triggerA, evidence);
    git(root, ['add', '--', triggerA]);
    appendFileSync(path.join(root, triggerA), 'export const unstaged = true;\n');
    const result = runGuard(root);
    expectViolation(result, triggerA);
    expect(result.stderr.split(triggerA)).toHaveLength(2);
  });

  it('falls back to HEAD only after a successful empty-worktree observation', () => {
    const dirtyRoot = initRepoWithHeadTrigger();
    writeFixture(dirtyRoot, unrelated, 'dirty but unrelated\n');
    expectPassed(runGuard(dirtyRoot));
    const cleanRoot = initRepoWithHeadTrigger();
    expectViolation(runGuard(cleanRoot), triggerA);
  });

  it('fails closed with a sanitized diagnostic when Git evidence is unavailable', () => {
    expectUnavailable(runGuard(createRoot()));
  });

  it('preserves staged, staged-or-head and explicit-file behavior', () => {
    const stagedRoot = initRepo({ [triggerA]: 'export {};\n' });
    writeFixture(stagedRoot, triggerA, evidence);
    git(stagedRoot, ['add', '--', triggerA]);
    expectViolation(runGuard(stagedRoot, ['--mode=staged']), triggerA);

    const cleanRoot = initRepoWithHeadTrigger();
    expectViolation(runGuard(cleanRoot, ['--mode=staged-or-head']), triggerA);

    const explicitRoot = createRoot();
    writeFixture(explicitRoot, triggerA, evidence);
    expectViolation(runGuard(explicitRoot, [`--files=${triggerA}`]), triggerA);
  });

  it('keeps required-files manifest precedence under a contaminated parent', () => {
    const root = initRepo({ [triggerA]: evidence, [unrelated]: 'safe\n' });
    const manifestPath = path.join(root, 'required-files-manifest.txt');
    writeFixture(root, 'required-files-manifest.txt', `schemaVersion=1\nroot=${realpathSync(root)}\n${unrelated}\n`);
    const result = runGuard(
      root,
      [`--files=${triggerA}`, '--mode=invalid'],
      {
        Required_Files_Manifest_Required: '1',
        required_files_manifest_path: 'poisoned-parent-path',
        Coupled_Guard_Diff_Base: 'poisoned-parent-ref',
        Git_Dir: 'poisoned-parent-git-dir',
      },
      {
        REQUIRED_FILES_MANIFEST_REQUIRED: '1',
        REQUIRED_FILES_MANIFEST_PATH: manifestPath,
      },
    );
    expectPassed(result);
  });

  it('wires the formal quality guard to working-tree-or-head mode', () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.['quality:guard:coupled-changes']).toBe(
      'node scripts/contracts/check-coupled-changes.cjs --mode=working-tree-or-head',
    );
  });
});
