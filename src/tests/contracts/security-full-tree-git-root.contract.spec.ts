import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

interface GitVisibleRecord {
  relativePath: string;
  mode: string | null;
  tracked: boolean;
  readBuffer(): Buffer;
}

interface GitVisibleHelper {
  getGitVisibleErrorCode(error: unknown): string;
  sanitizeGitChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  parseGitLsFilesRecords(
    output: Buffer,
    options?: {
      platform?: NodeJS.Platform;
      rawPathExists?: (candidate: string) => boolean;
    },
  ): Array<{ relativePath: string; mode: string | null; tracked: boolean }>;
  listGitVisibleWorktreeFiles(root: string): GitVisibleRecord[];
}

const require = createRequire(import.meta.url);
const helperPath = path.join(process.cwd(), 'scripts/contracts/git-visible-worktree.cjs');
const secretsPath = path.join(process.cwd(), 'scripts/contracts/check-secrets.cjs');
const encodingPath = path.join(process.cwd(), 'scripts/contracts/check-encoding-corruption.cjs');
const tempPaths: string[] = [];

function helper(): GitVisibleHelper {
  return require(helperPath) as GitVisibleHelper;
}

function makeTemp(prefix: string): string {
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempPaths.push(tempPath);
  return tempPath;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`git command failed: ${args[0] ?? 'unknown'}`);
  }
  return result.stdout;
}

function initRepo(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'contract@example.invalid']);
  git(root, ['config', 'user.name', 'Contract Test']);
}

function runScript(
  scriptPath: string,
  cwd: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function errorCode(action: () => unknown): string {
  try {
    action();
    return 'no-error';
  } catch (error) {
    return helper().getGitVisibleErrorCode(error);
  }
}

function commitFile(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
  git(root, ['add', '--', relativePath]);
  git(root, ['commit', '--quiet', '-m', `add ${relativePath}`]);
}

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

describe('Git-visible full-tree helper', () => {
  it('strips every case form of GIT_ variables without mutating the parent environment', () => {
    const input = {
      PATH: process.env.PATH,
      GIT_DIR: 'foreign-dir',
      Git_Work_Tree: 'foreign-tree',
      git_index_file: 'foreign-index',
    };

    expect(helper().sanitizeGitChildEnv(input)).toEqual({ PATH: process.env.PATH });
    expect(input).toHaveProperty('GIT_DIR', 'foreign-dir');
    expect(input).toHaveProperty('Git_Work_Tree', 'foreign-tree');
    expect(input).toHaveProperty('git_index_file', 'foreign-index');
  });

  it('parses one mixed NUL listing of staged records and untracked raw paths', () => {
    const objectId = 'a'.repeat(40);
    const output = Buffer.from(
      `100644 ${objectId} 0\ttracked.ts\0untracked.ts\0`,
      'utf8',
    );

    expect(helper().parseGitLsFilesRecords(output)).toEqual([
      { relativePath: 'tracked.ts', mode: '100644', tracked: true },
      { relativePath: 'untracked.ts', mode: null, tracked: false },
    ]);
  });

  it.each([
    ['nonzero stage', `100644 ${'a'.repeat(40)} 2\tconflict.ts\0`, 'git-visible-stage-unsupported'],
    ['malformed stage row', '100644 broken\tfile.ts\0', 'git-visible-record-malformed'],
    ['absolute path', 'C:/foreign/file.ts\0', 'git-visible-path-unsafe'],
    ['backslash path', 'nested\\file.ts\0', 'git-visible-path-unsafe'],
    ['parent escape', '../foreign.ts\0', 'git-visible-path-unsafe'],
    ['dot segment', 'nested/./file.ts\0', 'git-visible-path-unsafe'],
    ['empty segment', 'nested//file.ts\0', 'git-visible-path-unsafe'],
    ['LF control', 'bad\nname.ts\0', 'git-visible-path-control'],
    ['CR control', 'bad\rname.ts\0', 'git-visible-path-control'],
    ['DEL control', 'bad\u007fname.ts\0', 'git-visible-path-control'],
  ])('rejects %s before returning any path', (_label, listing, expectedCode) => {
    expect(errorCode(() => helper().parseGitLsFilesRecords(Buffer.from(listing, 'utf8'))))
      .toBe(expectedCode);
  });

  it('rejects duplicate path identity with Windows case-insensitive semantics', () => {
    const listing = Buffer.from('Folder/File.ts\0folder/file.ts\0', 'utf8');

    expect(errorCode(() => helper().parseGitLsFilesRecords(listing, { platform: 'win32' })))
      .toBe('git-visible-path-duplicate');
  });

  it('does not let an untracked raw path mimic a tracked stage row', () => {
    const lookalike = `100644 ${'a'.repeat(40)} 0\tcamouflage.ts`;
    const listing = Buffer.from(`${lookalike}\0`, 'utf8');

    expect(errorCode(() => helper().parseGitLsFilesRecords(listing, {
      rawPathExists: candidate => candidate === lookalike,
    }))).toBe('git-visible-path-control');
  });

  it('fails closed at the requested root instead of accepting a nested directory', () => {
    const root = makeTemp('nanoflow-git-root-mismatch-');
    initRepo(root);
    fs.mkdirSync(path.join(root, 'nested'));

    expect(errorCode(() => helper().listGitVisibleWorktreeFiles(path.join(root, 'nested'))))
      .toBe('git-visible-root-mismatch');
  });

  it('returns a stable failure for a non-repository root', () => {
    const root = makeTemp('nanoflow-git-root-missing-');
    fs.writeFileSync(path.join(root, '.git'), 'not a gitfile\n');

    expect(errorCode(() => helper().listGitVisibleWorktreeFiles(root)))
      .toBe('git-visible-root-unverified');
  });

  it('hard-fails a tracked 120000 symlink before reading its target', () => {
    const root = makeTemp('nanoflow-git-symlink-mode-');
    initRepo(root);
    const objectId = git(root, ['hash-object', '-w', '--stdin'], {
      ...process.env,
    }).trim();
    git(root, ['update-index', '--add', '--cacheinfo', `120000,${objectId},linked-secret`]);

    expect(errorCode(() => helper().listGitVisibleWorktreeFiles(root)))
      .toBe('git-visible-mode-symlink');
  });

  it('hard-fails a parent gitlink while the nested repository works at its own exact root', () => {
    const parent = makeTemp('nanoflow-gitlink-parent-');
    const nested = makeTemp('nanoflow-gitlink-nested-');
    initRepo(parent);
    initRepo(nested);
    commitFile(nested, 'nested.txt', 'nested root\n');
    const nestedHead = git(nested, ['rev-parse', 'HEAD']).trim();
    git(parent, ['update-index', '--add', '--cacheinfo', `160000,${nestedHead},nested`]);

    expect(errorCode(() => helper().listGitVisibleWorktreeFiles(parent)))
      .toBe('git-visible-mode-gitlink');
    const nestedRecords = helper().listGitVisibleWorktreeFiles(nested);
    expect(nestedRecords.map(record => record.relativePath)).toContain('nested.txt');
    expect(nestedRecords.find(record => record.relativePath === 'nested.txt')?.readBuffer().toString('utf8'))
      .toBe('nested root\n');
  });

  it('rejects an external symlink or junction without exposing the target', () => {
    const root = makeTemp('nanoflow-git-external-link-root-');
    const outside = makeTemp('nanoflow-git-external-link-target-');
    initRepo(root);
    fs.writeFileSync(path.join(outside, 'payload.ts'), 'outside\n');
    fs.symlinkSync(outside, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');

    expect(errorCode(() => helper().listGitVisibleWorktreeFiles(root)))
      .toBe('git-visible-path-symlink');
  });

  it('omits a deleted tracked regular file', () => {
    const root = makeTemp('nanoflow-git-deleted-');
    initRepo(root);
    fs.writeFileSync(path.join(root, 'deleted.ts'), 'deleted\n');
    git(root, ['add', '--', 'deleted.ts']);
    fs.rmSync(path.join(root, 'deleted.ts'));

    expect(helper().listGitVisibleWorktreeFiles(root)).toEqual([]);
  });

  it('omits a tracked regular file when its parent directory is absent', () => {
    const root = makeTemp('nanoflow-git-deleted-parent-');
    initRepo(root);
    commitFile(root, 'dir/deleted.ts', 'deleted with parent\n');
    fs.rmSync(path.join(root, 'dir'), { recursive: true });

    expect(helper().listGitVisibleWorktreeFiles(root)).toEqual([]);
  });

  it('detects replacement between enumeration and the safe read', () => {
    const root = makeTemp('nanoflow-git-read-race-');
    initRepo(root);
    fs.writeFileSync(path.join(root, 'race.ts'), 'before\n');
    const record = helper().listGitVisibleWorktreeFiles(root)
      .find(candidate => candidate.relativePath === 'race.ts');
    expect(record).toBeDefined();
    fs.rmSync(path.join(root, 'race.ts'));
    fs.writeFileSync(path.join(root, 'race.ts'), 'after replacement\n');

    expect(errorCode(() => record!.readBuffer())).toBe('git-visible-file-race');
  });

  it('supports a real linked worktree at its own canonical root', () => {
    const root = makeTemp('nanoflow-linked-main-');
    const linked = makeTemp('nanoflow-linked-worktree-');
    fs.rmSync(linked, { recursive: true, force: true });
    initRepo(root);
    commitFile(root, 'tracked.txt', 'linked content\n');
    git(root, ['worktree', 'add', '--quiet', '-b', 'contract-linked', linked]);

    const records = helper().listGitVisibleWorktreeFiles(linked);
    expect(records.map(record => record.relativePath)).toContain('tracked.txt');
    expect(records.find(record => record.relativePath === 'tracked.txt')?.readBuffer().toString('utf8'))
      .toMatch(/^linked content\r?\n$/u);
    git(root, ['worktree', 'remove', '--force', linked]);
  });

  it('uses one staged mixed listing command and has no fallback scanner', () => {
    const source = fs.readFileSync(helperPath, 'utf8');
    expect(source).toContain("['ls-files', '-z', '--stage', '--cached', '--others', '--exclude-standard']");
    expect(source.match(/\['ls-files'/g)).toHaveLength(1);
    expect(source).not.toContain('readdirSync');
    expect(source).not.toContain('walkDir');
  });
});

describe('full-tree security callers', () => {
  it.each([
    ['secrets', secretsPath, ['--mode=audit'], 'token.ts', Buffer.from(`const token = 'sbp_${'a'.repeat(40)}';\n`), 'SUPABASE_PAT'],
    ['encoding', encodingPath, [], 'invalid.txt', Buffer.from([0xff, 0xfe, 0xfd]), 'invalid_utf8'],
  ])('ignores inherited foreign Git roots for %s', (
    _label,
    scriptPath,
    args,
    relativePath,
    content,
    expectedRule,
  ) => {
    const victim = makeTemp('nanoflow-security-victim-');
    const foreign = makeTemp('nanoflow-security-foreign-');
    initRepo(victim);
    initRepo(foreign);
    fs.writeFileSync(path.join(victim, relativePath), content);
    const result = runScript(scriptPath, victim, args, {
      ...process.env,
      GIT_DIR: path.join(foreign, '.git'),
      GIT_WORK_TREE: foreign,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expectedRule);
    expect(result.stderr).not.toContain(content.toString('utf8'));
    expect(result.stderr).not.toContain(foreign);
  });

  it('rejects a control-character Git path without logging the raw path', () => {
    const root = makeTemp('nanoflow-security-control-path-');
    initRepo(root);
    const unsafeName = `unsafe\u007fname.ts`;
    fs.writeFileSync(path.join(root, unsafeName), 'export {};\n');

    const result = runScript(secretsPath, root, ['--mode=audit']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reason=git-visible-path-control');
    expect(result.stderr).not.toContain(unsafeName);
  });

  it('does not expose decoder messages, line previews, URIs, tokens or file content', () => {
    const root = makeTemp('nanoflow-encoding-safe-output-');
    initRepo(root);
    const marker = `https://example.invalid/reset?token=${'sensitive-value-' + 'x'.repeat(20)}`;
    fs.writeFileSync(path.join(root, 'corrupt.txt'), `prefix \uFFFD ${marker}\n`);

    const result = runScript(encodingPath, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[replacement_char] line 1');
    expect(result.stderr).not.toContain(marker);
    expect(result.stderr).not.toContain('prefix');
    expect(result.stderr).not.toContain('The encoded data was not valid');
  });

  it('preserves alternate GIT_INDEX_FILE behavior for staged precommit scans', () => {
    const root = makeTemp('nanoflow-security-alt-index-');
    initRepo(root);
    commitFile(root, 'baseline.txt', 'baseline\n');
    const alternateIndex = path.join(root, 'alternate-index');
    const env = { ...process.env, GIT_INDEX_FILE: alternateIndex };
    git(root, ['read-tree', 'HEAD'], env);
    const token = `ghp_${'z'.repeat(36)}`;
    fs.writeFileSync(path.join(root, 'staged.ts'), `const token = '${token}';\n`);
    git(root, ['add', '--', 'staged.ts'], env);

    const result = runScript(secretsPath, root, [], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GITHUB_TOKEN');
    expect(result.stderr).not.toContain(token);
  });
});
