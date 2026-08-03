import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'scripts', 'contracts', 'check-human-docs-coupled-changes.cjs');
const manifestHelperPath = path.join(repoRoot, 'scripts', 'contracts', 'required-files-manifest.cjs');
const coveragePath = 'docs/handbook/change-coverage.json';
const catalogPath = 'docs/handbook/catalog.json';

const tempRoots: string[] = [];
const commandKey = (...args: string[]): string => JSON.stringify(args);
const GIT_COMMANDS = {
  staged: commandKey('diff', '--cached', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRDT'),
  unstaged: commandKey('diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRDT'),
  untracked: commandKey('ls-files', '--others', '--exclude-standard', '-z'),
  head: commandKey('diff-tree', '--no-commit-id', '--name-status', '-z', '--find-renames', '-r', '--diff-filter=ACMRDT', 'HEAD'),
  verifyFixtureBase: commandKey('rev-parse', '--verify', 'fixture-base'),
  fixtureBaseRange: commandKey('diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRDT', 'fixture-base...HEAD'),
  showCoverage: commandKey('show', `HEAD:${coveragePath}`),
  showCatalog: commandKey('show', `HEAD:${catalogPath}`),
} as const;

type FakeGitResponse = { fields?: string[]; stdout?: string; status?: number; stderr?: string };
type GitFixture = { root: string; runner: string; fakeBin: string; logPath: string };
function createGitFixture(): GitFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'human-docs-coupled-'));
  tempRoots.push(root);
  const contractsDir = path.join(root, 'scripts', 'contracts');
  const handbookDir = path.join(root, 'docs', 'handbook');
  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(contractsDir, { recursive: true });
  fs.mkdirSync(handbookDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'app'), { recursive: true });
  fs.mkdirSync(fakeBin);
  fs.copyFileSync(scriptPath, path.join(contractsDir, path.basename(scriptPath)));
  fs.copyFileSync(manifestHelperPath, path.join(contractsDir, path.basename(manifestHelperPath)));
  fs.writeFileSync(path.join(handbookDir, 'page.md'), '---\naudience: user\n---\n');
  fs.writeFileSync(path.join(root, 'src', 'app', 'feature.ts'), 'export {};\n');
  fs.writeFileSync(path.join(handbookDir, 'catalog.json'), JSON.stringify({
    root: 'docs/handbook/index.md',
    categories: [{ landing: 'docs/handbook/category.md', articles: [{ path: 'docs/handbook/page.md' }] }],
  }));
  fs.writeFileSync(path.join(handbookDir, 'change-coverage.json'), JSON.stringify({
    version: 1,
    routes: [{
      id: 'fixture-route',
      description: 'Fixture user-visible behavior',
      triggers: ['src/app/**', 'src/app/line\nbreak.ts'],
      handbook: ['docs/handbook/page.md'],
    }],
  }));

  const fakeGitScript = path.join(fakeBin, 'fake-git.cjs');
  fs.writeFileSync(fakeGitScript, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(process.env.FAKE_GIT_LOG, `${JSON.stringify(args)}\\n`);",
    "const response = JSON.parse(process.env.FAKE_GIT_RESPONSES || '{}')[JSON.stringify(args)];",
    "if (!response) process.exit(97);",
    "if (response.stderr) process.stderr.write(response.stderr);",
    "if (typeof response.stdout === 'string') process.stdout.write(response.stdout);",
    "if (response.fields?.length) process.stdout.write(`${response.fields.join('\\0')}\\0`);",
    "process.exit(response.status || 0);",
    '',
  ].join('\n'));
  if (process.platform === 'win32') {
    const gitPath = path.join(fakeBin, 'git.exe');
    try { fs.linkSync(process.execPath, gitPath); } catch { fs.copyFileSync(process.execPath, gitPath); }
    for (const command of ['diff', 'diff-tree', 'ls-files', 'rev-parse', 'show']) {
      fs.writeFileSync(path.join(root, command), `process.argv.splice(2, 0, ${JSON.stringify(command)}); require(${JSON.stringify(fakeGitScript)});\n`);
    }
  } else {
    const gitPath = path.join(fakeBin, 'git');
    fs.writeFileSync(gitPath, `#!${process.execPath}\nrequire(${JSON.stringify(fakeGitScript)});\n`);
    fs.chmodSync(gitPath, 0o755);
  }
  return { root, runner: path.join(contractsDir, path.basename(scriptPath)), fakeBin, logPath: path.join(root, 'git.log') };
}

function fixtureEnv(
  fixture: GitFixture,
  responses: Record<string, FakeGitResponse>,
  explicit: NodeJS.ProcessEnv = {},
  contaminated: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const blocked = new Set([
    'PATH', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
    'HUMAN_DOCS_GUARD_DIFF_BASE', 'COUPLED_GUARD_DIFF_BASE', 'GITHUB_EVENT_BEFORE', 'GITHUB_BASE_REF',
    'REQUIRED_FILES_MANIFEST_REQUIRED', 'REQUIRED_FILES_MANIFEST_PATH', 'FAKE_GIT_LOG', 'FAKE_GIT_RESPONSES',
  ].map(key => key.toLowerCase()));
  const clean = Object.fromEntries(Object.entries({ ...process.env, ...contaminated })
    .filter(([key]) => !blocked.has(key.toLowerCase())));
  return {
    ...clean,
    PATH: fixture.fakeBin,
    REQUIRED_FILES_MANIFEST_REQUIRED: '0',
    REQUIRED_FILES_MANIFEST_PATH: '',
    FAKE_GIT_LOG: fixture.logPath,
    FAKE_GIT_RESPONSES: JSON.stringify(responses),
    ...explicit,
  };
}

function runGitFixture(
  fixture: GitFixture,
  responses: Record<string, FakeGitResponse>,
  mode = 'working-tree-or-head',
  explicit: NodeJS.ProcessEnv = {},
  contaminated: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [fixture.runner, `--mode=${mode}`], {
    cwd: fixture.root,
    env: fixtureEnv(fixture, responses, explicit, contaminated),
    encoding: 'utf8',
    timeout: 8_000,
  });
}
function runRealGit(root: string, args: readonly string[], input?: string) {
  const blocked = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].map(key => key.toLowerCase()));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !blocked.has(key.toLowerCase())));
  return spawnSync('git', [...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    input,
    timeout: 8_000,
  });
}
function expectGitSucceeded(result: ReturnType<typeof spawnSync>): void {
  expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
}
function gitLog(fixture: GitFixture): string[][] {
  if (!fs.existsSync(fixture.logPath)) return [];
  return fs.readFileSync(fixture.logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function expectEvidenceUnavailable(result: ReturnType<typeof spawnSync>, fixture: GitFixture): void {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('[human-docs-coupled-changes] human-docs-coupled-evidence-unavailable\n');
  expect(result.stderr).not.toContain(fixture.root);
}
function headPolicyResponses(fixture: GitFixture): Record<string, FakeGitResponse> {
  return {
    [GIT_COMMANDS.showCoverage]: {
      stdout: fs.readFileSync(path.join(fixture.root, coveragePath), 'utf8'),
    },
    [GIT_COMMANDS.showCatalog]: {
      stdout: fs.readFileSync(path.join(fixture.root, catalogPath), 'utf8'),
    },
  };
}
function runGuard(files: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [scriptPath, `--files=${files.join(',')}`], {
    cwd: repoRoot,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('required_files_manifest_'))),
    encoding: 'utf8',
    timeout: 8_000,
  });
}
describe('check-human-docs-coupled-changes', { timeout: 10_000 }, () => {
  it('blocks a text-view implementation change when its Chinese user guide is absent', () => {
    const result = runGuard(['src/app/features/text/components/text-task-editor.component.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('text-task-workflow');
    expect(result.stderr).toContain('docs/handbook/02-use-nanoflow/01-text-view.md');
  });

  it('accepts the matching Chinese user-guide update with the implementation change', () => {
    const result = runGuard([
      'src/app/features/text/components/text-task-editor.component.ts',
      'docs/handbook/02-use-nanoflow/01-text-view.md',
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });

  it('does not require a user-guide update for a test-only change', () => {
    const result = runGuard(['src/app/features/text/components/text-task-editor.component.spec.ts']);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });

  it('blocks a task-sidecar implementation change when its handbook page is absent', () => {
    const result = runGuard(['src/utils/task-sidecar.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('task-sidecar-and-planning');
    expect(result.stderr).toContain('docs/handbook/02-use-nanoflow/08-task-sidecar-and-planning.md');
  });

  it('accepts the task-sidecar handbook page with the implementation change', () => {
    const result = runGuard([
      'src/utils/task-sidecar.ts',
      'docs/handbook/02-use-nanoflow/08-task-sidecar-and-planning.md',
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });

  it('blocks a workspace settings or trash change when its handbook page is absent', () => {
    const result = runGuard(['src/app/shared/modals/trash-modal.component.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('workspace-settings-and-recovery');
    expect(result.stderr).toContain('docs/handbook/02-use-nanoflow/09-project-settings-and-recovery.md');
  });

  it('accepts the workspace settings handbook page with the trash change', () => {
    const result = runGuard([
      'src/app/shared/modals/trash-modal.component.ts',
      'docs/handbook/02-use-nanoflow/09-project-settings-and-recovery.md',
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });

  it('blocks an appearance preference sync change when the settings handbook page is absent', () => {
    const result = runGuard(['src/services/theme.service.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('appearance-and-preference-sync');
    expect(result.stderr).toContain('docs/handbook/02-use-nanoflow/09-project-settings-and-recovery.md');
  });

  it('accepts the settings handbook page with an appearance preference sync change', () => {
    const result = runGuard([
      'src/services/theme.service.ts',
      'docs/handbook/02-use-nanoflow/09-project-settings-and-recovery.md',
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });

  it('blocks an attachment editor change when its user handbook page is absent', () => {
    const result = runGuard(['src/app/features/text/components/text-task-editor-attachment.controller.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('attachments-and-file-safety');
    expect(result.stderr).toContain('docs/handbook/02-use-nanoflow/10-attachments-and-file-safety.md');
  });

  it('accepts the attachment handbook page with an attachment editor change', () => {
    const result = runGuard([
      'src/app/features/text/components/text-task-editor-attachment.controller.ts',
      'docs/handbook/02-use-nanoflow/10-attachments-and-file-safety.md',
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });

  it('blocks a PWA install or offline recovery change when its handbook page is absent', () => {
    const result = runGuard(['src/app/shared/components/pwa-install-prompt-banner.component.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pwa-offline-and-error-recovery');
    expect(result.stderr).toContain('docs/handbook/01-get-started/06-pwa-offline-and-error-recovery.md');
  });

  it('accepts the PWA recovery handbook page with an install prompt change', () => {
    const result = runGuard([
      'src/app/shared/components/pwa-install-prompt-banner.component.ts',
      'docs/handbook/01-get-started/06-pwa-offline-and-error-recovery.md',
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });

  it('blocks a fatal error page change when its recovery handbook page is absent', () => {
    const result = runGuard(['src/app/shared/components/error-page.component.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('route-and-fatal-error-recovery');
    expect(result.stderr).toContain('docs/handbook/01-get-started/06-pwa-offline-and-error-recovery.md');
  });

  it('accepts the recovery handbook page with a fatal error page change', () => {
    const result = runGuard([
      'src/app/shared/components/error-page.component.ts',
      'docs/handbook/01-get-started/06-pwa-offline-and-error-recovery.md',
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });

  it('blocks a sync diagnostics dashboard change when its handbook page is absent', () => {
    const result = runGuard(['src/app/shared/modals/dashboard-modal.component.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('sync-diagnostics-and-conflict-center');
    expect(result.stderr).toContain('docs/handbook/03-data-sync-safety/05-sync-diagnostics-and-conflict-center.md');
  });

  it('accepts the sync diagnostics handbook page with a dashboard change', () => {
    const result = runGuard([
      'src/app/shared/modals/dashboard-modal.component.ts',
      'docs/handbook/03-data-sync-safety/05-sync-diagnostics-and-conflict-center.md',
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });

  it('blocks a storage escape recovery change when its diagnostics page is absent', () => {
    const result = runGuard(['src/app/shared/modals/storage-escape-modal.component.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('sync-diagnostics-and-conflict-center');
    expect(result.stderr).toContain('docs/handbook/03-data-sync-safety/05-sync-diagnostics-and-conflict-center.md');
  });

  it('blocks a migration recovery banner change when its PWA recovery page is absent', () => {
    const result = runGuard(['src/app/shared/components/migration-recovery.component.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pwa-offline-and-error-recovery');
    expect(result.stderr).toContain('docs/handbook/01-get-started/06-pwa-offline-and-error-recovery.md');
  }, 10_000);

  it('blocks a login modal change when its startup handbook page is absent', () => {
    const result = runGuard(['src/app/shared/modals/login-modal.component.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('workspace-startup-and-session');
    expect(result.stderr).toContain('docs/handbook/01-get-started/05-startup-login-and-status.md');
  });

  it('blocks a local-mode guard change when its handbook page is absent', () => {
    const result = runGuard(['src/services/guards/auth.guard.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('local-only-workspace');
    expect(result.stderr).toContain('docs/handbook/01-get-started/02-local-only-mode.md');
  });

  it('accepts the local-only handbook page with a Demo mode banner change', () => {
    const result = runGuard([
      'src/app/shared/components/demo-banner.component.ts',
      'docs/handbook/01-get-started/02-local-only-mode.md',
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });

  it('blocks a local development server change when the quickstart is absent', () => {
    const result = runGuard(['scripts/run-ng.cjs']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('local-development-startup');
    expect(result.stderr).toContain('docs/handbook/01-get-started/01-quickstart.md');
  });

  it('accepts the quickstart with a local development server change', () => {
    const result = runGuard([
      'scripts/run-ng.cjs',
      'docs/handbook/01-get-started/01-quickstart.md',
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });

  it('blocks a knowledge anchor component change when its handbook page is absent', () => {
    const result = runGuard(['src/app/shared/components/knowledge-anchor/knowledge-anchor.component.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('siyuan-knowledge-anchor-workflow');
    expect(result.stderr).toContain('docs/handbook/02-use-nanoflow/06-siyuan-knowledge-anchors.md');
  });

  it('blocks a Black Box service change when its focus handbook pages are absent', () => {
    const result = runGuard(['src/services/black-box.service.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('focus-and-capture-workflow');
    expect(result.stderr).toContain('docs/handbook/02-use-nanoflow/05-black-box.md');
  });

  it('blocks a guest-data migration modal change when its recovery handbook page is absent', () => {
    const result = runGuard(['src/app/shared/modals/migration-modal.component.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('guest-data-migration');
    expect(result.stderr).toContain('docs/handbook/02-use-nanoflow/09-project-settings-and-recovery.md');
  });

  it('blocks an offline configuration-help modal change when its cloud setup handbook pages are absent', () => {
    const result = runGuard(['src/app/shared/modals/config-help-modal.component.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cloud-configuration-help');
    expect(result.stderr).toContain('docs/handbook/01-get-started/04-cloud-sync-setup.md');
  });

  it('accepts the recovery handbook page with a guest-data migration modal change', () => {
    const result = runGuard([
      'src/app/shared/modals/migration-modal.component.ts',
      'docs/handbook/02-use-nanoflow/09-project-settings-and-recovery.md',
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });

  it('accepts the cloud setup handbook page with an offline configuration-help modal change', () => {
    const result = runGuard([
      'src/app/shared/modals/config-help-modal.component.ts',
      'docs/handbook/01-get-started/04-cloud-sync-setup.md',
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });

  it('blocks a daily routine slot service change when its workflow handbook pages are absent', () => {
    const result = runGuard(['src/services/dock-daily-slot.service.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('daily-routines-and-focus-preferences');
    expect(result.stderr).toContain('docs/handbook/02-use-nanoflow/03-parking-dock.md');
  });

  it('accepts the Parking Dock handbook page with a daily routine slot service change', () => {
    const result = runGuard([
      'src/services/dock-daily-slot.service.ts',
      'docs/handbook/02-use-nanoflow/03-parking-dock.md',
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });

  it('blocks a conflict resolution policy change when its sync handbook pages are absent', () => {
    const result = runGuard(['src/services/preference.service.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('conflict-resolution-policy');
    expect(result.stderr).toContain('docs/handbook/03-data-sync-safety/02-sync-and-conflicts.md');
  });

  it('accepts the sync handbook page with a conflict resolution policy change', () => {
    const result = runGuard([
      'src/services/preference.service.ts',
      'docs/handbook/03-data-sync-safety/02-sync-and-conflicts.md',
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });

  it('blocks an offline action-queue storage change when its handbook pages are absent', () => {
    const result = runGuard(['src/services/action-queue-storage.service.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('offline-sync-and-recovery');
    expect(result.stderr).toContain('docs/handbook/03-data-sync-safety/01-offline-first-model.md');
  });

  it('accepts the offline-first handbook page with an action-queue storage change', () => {
    const result = runGuard([
      'src/services/action-queue-storage.service.ts',
      'docs/handbook/03-data-sync-safety/01-offline-first-model.md',
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });

  it('blocks a Dock task-flow change when the Parking Dock handbook page is absent', () => {
    const result = runGuard(['src/services/dock-task-flow.service.ts']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('parking-workflow');
    expect(result.stderr).toContain('docs/handbook/02-use-nanoflow/03-parking-dock.md');
  });

  it('accepts the Parking Dock handbook page with a Dock task-flow change', () => {
    const result = runGuard([
      'src/services/dock-task-flow.service.ts',
      'docs/handbook/02-use-nanoflow/03-parking-dock.md',
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });
});

describe('check-human-docs-coupled-changes Git evidence', { timeout: 10_000 }, () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const unavailable = (root: string): FakeGitResponse => ({ status: 2, stderr: `secret:${root}` });
  const empty: FakeGitResponse = { fields: [] };
  it.each([
    ['staged', [GIT_COMMANDS.staged]],
    ['unstaged', [GIT_COMMANDS.staged, GIT_COMMANDS.unstaged]],
    ['untracked', [GIT_COMMANDS.staged, GIT_COMMANDS.unstaged, GIT_COMMANDS.untracked]],
    ['HEAD', [GIT_COMMANDS.staged, GIT_COMMANDS.unstaged, GIT_COMMANDS.untracked, GIT_COMMANDS.head]],
  ])('fails closed when %s evidence acquisition fails', (_label, commands) => {
    const fixture = createGitFixture();
    const responses = Object.fromEntries(commands.map(command => [command, empty]));
    responses[commands.at(-1)!] = unavailable(fixture.root);
    const result = runGitFixture(fixture, responses);
    expectEvidenceUnavailable(result, fixture);
    expect(gitLog(fixture)).toEqual(commands.map(command => JSON.parse(command)));
  });
  it('preserves NUL-delimited deletion, rename, newline, untracked, and deduplicated paths', () => {
    const fixture = createGitFixture();
    const result = runGitFixture(fixture, {
      [GIT_COMMANDS.staged]: { fields: ['D', 'src/app/deleted.ts', 'R100', 'src/app/old.ts', 'src/app/new.ts', 'M', 'src/app/duplicate.ts'] },
      [GIT_COMMANDS.unstaged]: { fields: ['M', 'src/app/duplicate.ts', 'M', 'src/app/line\nbreak.ts'] },
      [GIT_COMMANDS.untracked]: { fields: ['src/app/untracked.ts'] },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('changed: src/app/deleted.ts, src/app/duplicate.ts, src/app/line\nbreak.ts, src/app/new.ts, src/app/old.ts, src/app/untracked.ts');
    expect(gitLog(fixture)).toEqual([GIT_COMMANDS.staged, GIT_COMMANDS.unstaged, GIT_COMMANDS.untracked].map(command => JSON.parse(command)));
  });
  it('treats a single-path Git type change as changed trigger evidence', () => {
    const fixture = createGitFixture();
    const typeChange = { fields: ['T', 'src/app/feature.ts'] };
    const result = runGitFixture(fixture, {
      [commandKey('diff', '--cached', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRD')]: typeChange,
      [commandKey('diff', '--cached', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRDT')]: typeChange,
      [commandKey('diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRD')]: empty,
      [commandKey('diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRDT')]: empty,
      [GIT_COMMANDS.untracked]: empty,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fixture-route');
    expect(result.stderr).toContain('changed: src/app/feature.ts');
    expect(gitLog(fixture)).toEqual([
      GIT_COMMANDS.staged,
      GIT_COMMANDS.unstaged,
      GIT_COMMANDS.untracked,
    ].map(command => JSON.parse(command)));
  });
  it('collects a single-path Git type change from an explicit comparison range', () => {
    const fixture = createGitFixture();
    const result = runGitFixture(fixture, {
      [GIT_COMMANDS.staged]: empty,
      [GIT_COMMANDS.verifyFixtureBase]: empty,
      [GIT_COMMANDS.fixtureBaseRange]: { fields: ['T', 'src/app/feature.ts'] },
    }, 'staged-or-head', {
      HUMAN_DOCS_GUARD_DIFF_BASE: 'fixture-base',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fixture-route');
    expect(result.stderr).toContain('changed: src/app/feature.ts');
    expect(gitLog(fixture)).toEqual([
      GIT_COMMANDS.staged,
      GIT_COMMANDS.verifyFixtureBase,
      GIT_COMMANDS.fixtureBaseRange,
    ].map(command => JSON.parse(command)));
  });
  it('collects a real Git regular-file-to-symlink type change from an explicit comparison range', () => {
    const fixture = createGitFixture();
    expectGitSucceeded(runRealGit(fixture.root, ['init', '--quiet']));
    expectGitSucceeded(runRealGit(fixture.root, ['config', 'user.email', 'nanoflow-tests@example.invalid']));
    expectGitSucceeded(runRealGit(fixture.root, ['config', 'user.name', 'NanoFlow Tests']));
    expectGitSucceeded(runRealGit(fixture.root, [
      'add',
      'scripts/contracts/check-human-docs-coupled-changes.cjs',
      'scripts/contracts/required-files-manifest.cjs',
      coveragePath,
      catalogPath,
      'docs/handbook/page.md',
      'src/app/feature.ts',
    ]));
    expectGitSucceeded(runRealGit(fixture.root, ['commit', '--quiet', '-m', 'base']));

    const baseResult = runRealGit(fixture.root, ['rev-parse', 'HEAD']);
    expectGitSucceeded(baseResult);
    const base = String(baseResult.stdout).trim();
    const blobResult = runRealGit(fixture.root, ['hash-object', '-w', '--stdin'], 'feature-target.ts');
    expectGitSucceeded(blobResult);
    const symlinkBlob = String(blobResult.stdout).trim();
    expectGitSucceeded(runRealGit(fixture.root, [
      'update-index',
      '--cacheinfo',
      `120000,${symlinkBlob},src/app/feature.ts`,
    ]));
    expectGitSucceeded(runRealGit(fixture.root, ['commit', '--quiet', '-m', 'type change']));

    const range = `${base}...HEAD`;
    const typeChange = runRealGit(fixture.root, [
      'diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRDT', range,
    ]);
    expectGitSucceeded(typeChange);
    expect(typeChange.stdout).toBe('T\0src/app/feature.ts\0');

    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ![
      'git_dir', 'git_work_tree', 'git_index_file',
      'required_files_manifest_required', 'required_files_manifest_path',
      'human_docs_guard_diff_base', 'coupled_guard_diff_base',
    ].includes(key.toLowerCase())));
    const result = spawnSync(process.execPath, [fixture.runner, '--mode=staged-or-head'], {
      cwd: fixture.root,
      env: {
        ...cleanEnv,
        REQUIRED_FILES_MANIFEST_REQUIRED: '0',
        REQUIRED_FILES_MANIFEST_PATH: '',
        HUMAN_DOCS_GUARD_DIFF_BASE: base,
      },
      encoding: 'utf8',
      timeout: 8_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fixture-route');
    expect(result.stderr).toContain('changed: src/app/feature.ts');
  });
  it('accepts a mixed staged trigger and unstaged handbook companion', () => {
    const fixture = createGitFixture();
    const result = runGitFixture(fixture, {
      [GIT_COMMANDS.staged]: { fields: ['M', 'src/app/feature.ts'] },
      [GIT_COMMANDS.unstaged]: { fields: ['M', 'docs/handbook/page.md'] },
      [GIT_COMMANDS.untracked]: empty,
    });
    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
  });
  it('uses HEAD only after three successful empty worktree acquisitions under a contaminated parent', () => {
    const fixture = createGitFixture();
    const responses = {
      [GIT_COMMANDS.staged]: empty,
      [GIT_COMMANDS.unstaged]: empty,
      [GIT_COMMANDS.untracked]: empty,
      [GIT_COMMANDS.head]: { fields: ['M', 'src/app/feature.ts', 'M', 'docs/handbook/page.md'] },
    };
    const result = runGitFixture(fixture, responses, 'working-tree-or-head', {}, {
      Human_Docs_Guard_Diff_Base: 'secret-ref', Coupled_Guard_Diff_Base: 'secret-ref',
      Github_Event_Before: 'secret-sha', Github_Base_Ref: 'secret-base', Git_Dir: 'secret-git-dir',
      Required_Files_Manifest_Required: '1', Required_Files_Manifest_Path: 'secret-manifest', pAtH: 'secret-path',
    });
    expect(result.status, String(result.stderr)).toBe(0);
    expect(gitLog(fixture)).toEqual(Object.keys(responses).map(command => JSON.parse(command)));
  });
  it('does not use HEAD when unrelated worktree evidence exists', () => {
    const fixture = createGitFixture();
    const result = runGitFixture(fixture, {
      [GIT_COMMANDS.staged]: empty,
      [GIT_COMMANDS.unstaged]: empty,
      [GIT_COMMANDS.untracked]: { fields: ['notes.txt'] },
    });
    expect(result.status, String(result.stderr)).toBe(0);
    expect(gitLog(fixture)).toHaveLength(3);
  });

  it.each(['staged', 'staged-or-head'])('preserves %s mode without extra Git calls', mode => {
    const fixture = createGitFixture();
    const result = runGitFixture(fixture, {
      [GIT_COMMANDS.staged]: { fields: ['M', 'src/app/feature.ts'] },
    }, mode);
    expect(result.status).toBe(1);
    expect(gitLog(fixture)).toEqual([JSON.parse(GIT_COMMANDS.staged)]);
  });

  it('validates the required-files manifest before consulting dirty policy files', () => {
    const fixture = createGitFixture();
    fs.writeFileSync(path.join(fixture.root, coveragePath), 'secret dirty coverage');
    fs.writeFileSync(path.join(fixture.root, catalogPath), 'secret dirty catalog');
    const manifestPath = path.join(fixture.root, 'required-files.txt');
    fs.writeFileSync(manifestPath, `schemaVersion=2\nroot=${fixture.root}\ndocs/handbook/page.md\nsrc/app/feature.ts\n`);

    const result = runGitFixture(fixture, {}, 'working-tree-or-head', {
      REQUIRED_FILES_MANIFEST_REQUIRED: '1',
      REQUIRED_FILES_MANIFEST_PATH: manifestPath,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('schemaVersion=1');
    expect(result.stderr).not.toContain('secret dirty');
    expect(gitLog(fixture)).toEqual([]);
  });

  it('uses HEAD policy for manifest-omitted coverage and catalog despite dirty worktree bypasses', () => {
    const fixture = createGitFixture();
    const responses = headPolicyResponses(fixture);
    fs.writeFileSync(path.join(fixture.root, coveragePath), JSON.stringify({ version: 1, routes: [] }));
    fs.writeFileSync(path.join(fixture.root, catalogPath), 'secret dirty catalog bypass');
    const manifestPath = path.join(fixture.root, 'required-files.txt');
    fs.writeFileSync(manifestPath, `schemaVersion=1\nroot=${fixture.root}\ndocs/handbook/page.md\nsrc/app/feature.ts\n`);

    const result = runGitFixture(fixture, responses, 'working-tree-or-head', {
      REQUIRED_FILES_MANIFEST_REQUIRED: '1',
      REQUIRED_FILES_MANIFEST_PATH: manifestPath,
    });

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
    expect(result.stderr).not.toContain('secret dirty');
    expect(gitLog(fixture)).toEqual([
      JSON.parse(GIT_COMMANDS.showCoverage),
      JSON.parse(GIT_COMMANDS.showCatalog),
    ]);
  });

  it('fails closed without leaking Git stderr when HEAD policy cannot be read', () => {
    const fixture = createGitFixture();
    const responses = headPolicyResponses(fixture);
    responses[GIT_COMMANDS.showCoverage] = unavailable(fixture.root);
    const manifestPath = path.join(fixture.root, 'required-files.txt');
    fs.writeFileSync(manifestPath, `schemaVersion=1\nroot=${fixture.root}\ndocs/handbook/page.md\nsrc/app/feature.ts\n`);

    const result = runGitFixture(fixture, responses, 'working-tree-or-head', {
      REQUIRED_FILES_MANIFEST_REQUIRED: '1',
      REQUIRED_FILES_MANIFEST_PATH: manifestPath,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('human-docs-coupled-evidence-unavailable');
    expect(result.stderr).not.toContain(fixture.root);
    expect(result.stderr).not.toContain('secret:');
    expect(gitLog(fixture)).toEqual([
      JSON.parse(GIT_COMMANDS.showCoverage),
      JSON.parse(GIT_COMMANDS.showCatalog),
    ]);
  });

  it('reads worktree policy without Git only when both policy files are in the manifest', () => {
    const fixture = createGitFixture();
    const manifestPath = path.join(fixture.root, 'required-files.txt');
    fs.writeFileSync(manifestPath, `schemaVersion=1\nroot=${fixture.root}\ndocs/handbook/catalog.json\ndocs/handbook/change-coverage.json\ndocs/handbook/page.md\nsrc/app/feature.ts\n`);
    const result = runGitFixture(fixture, {}, 'working-tree-or-head', {
      REQUIRED_FILES_MANIFEST_REQUIRED: '1',
      REQUIRED_FILES_MANIFEST_PATH: manifestPath,
    });

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
    expect(gitLog(fixture)).toEqual([]);
  });

  it.each([
    {
      name: 'reads listed coverage from worktree and omitted catalog from HEAD',
      listedPolicy: coveragePath,
      omittedPolicy: catalogPath,
      showCommand: GIT_COMMANDS.showCatalog,
      dirtyOmittedPolicy: 'secret dirty catalog bypass',
    },
    {
      name: 'reads listed catalog from worktree and omitted coverage from HEAD',
      listedPolicy: catalogPath,
      omittedPolicy: coveragePath,
      showCommand: GIT_COMMANDS.showCoverage,
      dirtyOmittedPolicy: JSON.stringify({ version: 1, routes: [] }),
    },
  ])('$name', ({ listedPolicy, omittedPolicy, showCommand, dirtyOmittedPolicy }) => {
    const fixture = createGitFixture();
    const headPolicy = fs.readFileSync(path.join(fixture.root, omittedPolicy), 'utf8');
    fs.writeFileSync(path.join(fixture.root, omittedPolicy), dirtyOmittedPolicy);
    const manifestPath = path.join(fixture.root, 'required-files.txt');
    fs.writeFileSync(manifestPath, [
      'schemaVersion=1',
      `root=${fixture.root}`,
      listedPolicy,
      'docs/handbook/page.md',
      'src/app/feature.ts',
      '',
    ].join('\n'));

    const result = runGitFixture(fixture, {
      [showCommand]: { stdout: headPolicy },
    }, 'working-tree-or-head', {
      REQUIRED_FILES_MANIFEST_REQUIRED: '1',
      REQUIRED_FILES_MANIFEST_PATH: manifestPath,
    });

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
    expect(result.stderr).not.toContain('secret dirty');
    expect(gitLog(fixture)).toEqual([JSON.parse(showCommand)]);
  });

  it('preserves required-files manifest precedence while loading omitted policy from HEAD', () => {
    const fixture = createGitFixture();
    const manifestPath = path.join(fixture.root, 'required-files.txt');
    fs.writeFileSync(manifestPath, `schemaVersion=1\nroot=${fixture.root}\ndocs/handbook/page.md\nsrc/app/feature.ts\n`);
    const result = runGitFixture(fixture, headPolicyResponses(fixture), 'working-tree-or-head', {
      REQUIRED_FILES_MANIFEST_REQUIRED: '1',
      REQUIRED_FILES_MANIFEST_PATH: manifestPath,
    });
    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain('[human-docs-coupled-changes] passed');
    expect(gitLog(fixture)).toEqual([
      JSON.parse(GIT_COMMANDS.showCoverage),
      JSON.parse(GIT_COMMANDS.showCatalog),
    ]);
  });
});
