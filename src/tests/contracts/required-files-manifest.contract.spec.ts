import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const packageJsonPath = path.join(repoRoot, 'package.json');
const tempRoots: string[] = [];

const actionqueueGuardPath = path.join(
  repoRoot,
  'scripts',
  'contracts',
  'check-actionqueue-durable-enqueue.cjs',
);
const retryqueueGuardPath = path.join(
  repoRoot,
  'scripts',
  'contracts',
  'check-retryqueue-durable-add.cjs',
);
const coupledGuardPath = path.join(
  repoRoot,
  'scripts',
  'contracts',
  'check-coupled-changes.cjs',
);
const context7GuardPath = path.join(
  repoRoot,
  'scripts',
  'contracts',
  'check-context7-coupled-changes.cjs',
);
const humanDocsGuardPath = path.join(
  repoRoot,
  'scripts',
  'contracts',
  'check-human-docs-coupled-changes.cjs',
);
const secretsGuardPath = path.join(
  repoRoot,
  'scripts',
  'contracts',
  'check-secrets.cjs',
);
const encodingGuardPath = path.join(
  repoRoot,
  'scripts',
  'contracts',
  'check-encoding-corruption.cjs',
);

const defaultTestContractsScript = 'npm run test:prepare-env && npm run audit:secrets && npm run quality:guard:encoding && cross-env REQUIRED_FILES_MANIFEST_REQUIRED=0 REQUIRED_FILES_MANIFEST_PATH= npm run quality:guard:actionqueue-durable-enqueue && cross-env REQUIRED_FILES_MANIFEST_REQUIRED=0 REQUIRED_FILES_MANIFEST_PATH= npm run quality:guard:retryqueue-durable-add && node scripts/contracts/check-flow-current-userid.cjs && cross-env REQUIRED_FILES_MANIFEST_REQUIRED=0 REQUIRED_FILES_MANIFEST_PATH= npm run quality:guard:coupled-changes && cross-env REQUIRED_FILES_MANIFEST_REQUIRED=0 REQUIRED_FILES_MANIFEST_PATH= npm run quality:guard:context7-coupled && cross-env REQUIRED_FILES_MANIFEST_REQUIRED=0 REQUIRED_FILES_MANIFEST_PATH= npm run quality:guard:human-docs-coupled && cross-env REQUIRED_FILES_MANIFEST_REQUIRED=0 REQUIRED_FILES_MANIFEST_PATH= npm run test:contract-specs';
const repoSafeManifestFile = 'src/tests/scripts/check-actionqueue-durable-enqueue.spec.ts';
const repoHumanDocsManifestFiles = [
  'docs/handbook/catalog.json',
  'docs/handbook/change-coverage.json',
  repoSafeManifestFile,
] as const;

function canonicalRoot(root: string): string {
  return typeof realpathSync.native === 'function'
    ? realpathSync.native(root)
    : realpathSync(root);
}

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeFixtureFile(root: string, relativePath: string, source: string | NodeJS.ArrayBufferView): string {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source);
  return absolutePath;
}

function createDirectoryAlias(targetDir: string, linkDir: string): void {
  mkdirSync(path.dirname(linkDir), { recursive: true });
  symlinkSync(targetDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
}

function writeManifest(
  projectRoot: string,
  entries: readonly string[],
  options: {
    schemaLine?: string;
    rootLine?: string;
    trailingLf?: boolean;
  } = {},
): string {
  const manifestRoot = createTempRoot('nanoflow-required-files-manifest-');
  const manifestPath = path.join(manifestRoot, 'required-files-manifest.txt');
  const lines = [
    options.schemaLine ?? 'schemaVersion=1',
    options.rootLine ?? `root=${canonicalRoot(projectRoot)}`,
    ...entries,
  ];
  const text = lines.join('\n') + (options.trailingLf === false ? '' : '\n');
  writeFileSync(manifestPath, text, 'utf8');
  return manifestPath;
}

function initGitRepo(root: string): void {
  const initResult = spawnSync('git', ['init'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(initResult.status, `${initResult.stdout}${initResult.stderr}`).toBe(0);
}

function manifestEnv(manifestPath: string): NodeJS.ProcessEnv {
  return {
    REQUIRED_FILES_MANIFEST_REQUIRED: '1',
    REQUIRED_FILES_MANIFEST_PATH: manifestPath,
  };
}

function runNodeScript(
  scriptPath: string,
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      REQUIRED_FILES_MANIFEST_REQUIRED: '0',
      REQUIRED_FILES_MANIFEST_PATH: '',
      ...env,
    },
  });
}

function combinedOutput(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function expectFailure(result: SpawnSyncReturns<string>, ...needles: readonly string[]): void {
  const output = combinedOutput(result);
  expect(result.status, output).toBe(1);
  for (const needle of needles) {
    expect(output).toContain(needle);
  }
}

function expectPassed(result: SpawnSyncReturns<string>, needle = 'passed'): void {
  const output = combinedOutput(result);
  expect(result.status, output).toBe(0);
  expect(output).toContain(needle);
}

function expectInOrder(value: string, snippets: readonly string[]): void {
  let previousIndex = -1;
  for (const snippet of snippets) {
    const index = value.indexOf(snippet);
    expect(index, `missing "${snippet}" in "${value}"`).toBeGreaterThanOrEqual(0);
    expect(index, `"${snippet}" must appear after the previous gate in "${value}"`).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

function createActionqueueFixtureRoot(): {
  root: string;
  safeFile: string;
  secondSafeFile: string;
  badFile: string;
} {
  const root = createTempRoot('nanoflow-required-files-actionqueue-');
  const safeFile = 'src/app/features/tasks/a-safe-task-save.service.ts';
  const secondSafeFile = 'src/app/features/tasks/b-safe-task-save.service.ts';
  const badFile = 'src/app/features/tasks/bad-task-save.service.ts';

  writeFixtureFile(
    root,
    safeFile,
    `
export class SafeTaskSaveService {
  saveTask(): string {
    return 'ok';
  }
}
`,
  );
  writeFixtureFile(
    root,
    secondSafeFile,
    `
export class AnotherSafeTaskSaveService {
  saveTask(): string {
    return 'also-ok';
  }
}
`,
  );
  writeFixtureFile(
    root,
    badFile,
    `
export class BadTaskSaveService {
  constructor(private readonly actionQueue: ActionQueueService) {}

  saveTask(): void {
    this.actionQueue.enqueue({ type: 'create' });
  }
}
`,
  );

  return { root, safeFile, secondSafeFile, badFile };
}

function createRetryqueueFixtureRoot(): {
  root: string;
  safeFile: string;
  badFile: string;
} {
  const root = createTempRoot('nanoflow-required-files-retryqueue-');
  const safeFile = 'src/app/features/tasks/safe-task-retry.service.ts';
  const badFile = 'src/app/features/tasks/bad-task-retry.service.ts';

  writeFixtureFile(
    root,
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        module: 'CommonJS',
        strict: true,
        target: 'ES2022',
      },
      include: ['src/**/*.ts'],
    }),
  );
  writeFixtureFile(
    root,
    'src/app/core/services/sync/retry-queue.service.ts',
    `
export class RetryQueueService {
  add(..._args: unknown[]): boolean { return true; }
  async addDurably(..._args: unknown[]): Promise<boolean> { return true; }
}
`,
  );
  writeFixtureFile(
    root,
    safeFile,
    `
import { RetryQueueService } from '../../core/services/sync/retry-queue.service';

export class SafeTaskRetryService {
  constructor(private readonly retryQueue: RetryQueueService) {}

  async queueTask(): Promise<void> {
    await this.retryQueue.addDurably('task', 'upsert', { id: 'task-1' });
  }
}
`,
  );
  writeFixtureFile(
    root,
    badFile,
    `
import { RetryQueueService } from '../../core/services/sync/retry-queue.service';

export class BadTaskRetryService {
  constructor(private readonly retryQueue: RetryQueueService) {}

  queueTask(): void {
    this.retryQueue.add('task', 'upsert', { id: 'task-1' });
  }
}
`,
  );

  return { root, safeFile, badFile };
}

function runActionqueueGuard(root: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return runNodeScript(actionqueueGuardPath, repoRoot, [`--root=${root}`, ...args], env);
}

function runRetryqueueGuard(root: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return runNodeScript(retryqueueGuardPath, repoRoot, [`--root=${root}`, ...args], env);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('required-files manifest parser', () => {
  const parserCases = [
    {
      name: 'fails closed when activation is requested without REQUIRED_FILES_MANIFEST_PATH',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => (
        runActionqueueGuard(fixture.root, [], { REQUIRED_FILES_MANIFEST_REQUIRED: '1' })
      ),
      expected: ['REQUIRED_FILES_MANIFEST_PATH'],
    },
    {
      name: 'rejects a manifest without schemaVersion=1',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        const manifestPath = writeManifest(fixture.root, [fixture.safeFile], { schemaLine: '' });
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['schemaVersion=1'],
    },
    {
      name: 'rejects a malformed schema line',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        const manifestPath = writeManifest(fixture.root, [fixture.safeFile], { schemaLine: 'schemaVersion=2' });
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['schemaVersion=1'],
    },
    {
      name: 'rejects a missing root line',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        const manifestPath = writeManifest(fixture.root, [fixture.safeFile], { rootLine: fixture.safeFile });
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['root='],
    },
    {
      name: 'rejects an empty root line',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        const manifestPath = writeManifest(fixture.root, [fixture.safeFile], { rootLine: 'root=' });
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['root must not be empty'],
    },
    {
      name: 'rejects a foreign root',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        const foreignRoot = createTempRoot('nanoflow-required-files-foreign-root-');
        const manifestPath = writeManifest(fixture.root, [fixture.safeFile], {
          rootLine: `root=${canonicalRoot(foreignRoot)}`,
        });
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['must match project root'],
    },
    {
      name: 'rejects absolute file paths',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        const absoluteEntry = path.join(fixture.root, fixture.safeFile).replace(/\\/g, '/');
        const manifestPath = writeManifest(fixture.root, [absoluteEntry]);
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['repo-relative'],
    },
    {
      name: 'rejects backslash separators',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        const manifestPath = writeManifest(fixture.root, [fixture.safeFile.replace(/\//g, '\\')]);
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['forward slashes'],
    },
    {
      name: 'rejects noncanonical relative paths',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        const manifestPath = writeManifest(
          fixture.root,
          ['src/app/features/tasks/../tasks/a-safe-task-save.service.ts'],
        );
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['canonical'],
    },
    {
      name: 'rejects dot-prefixed paths',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        const manifestPath = writeManifest(
          fixture.root,
          [`./${fixture.safeFile}`],
        );
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['repo-relative'],
    },
    {
      name: 'rejects dotdot escapes',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        const manifestPath = writeManifest(fixture.root, ['../outside.ts']);
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['repo-relative'],
    },
    {
      name: 'rejects duplicate entries',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        const manifestPath = writeManifest(fixture.root, [fixture.safeFile, fixture.safeFile]);
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['duplicate'],
    },
    {
      name: 'rejects an in-repo directory alias before canonicalizing it into a manifest entry',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        createDirectoryAlias(
          path.join(fixture.root, 'src', 'app', 'features', 'tasks'),
          path.join(fixture.root, 'src', 'app', 'features', 'z-tasks-alias'),
        );
        const manifestPath = writeManifest(
          fixture.root,
          ['src/app/features/z-tasks-alias/a-safe-task-save.service.ts'],
        );
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['must be canonical repo-relative path'],
    },
    {
      name: 'rejects a duplicate identity reached through an in-repo directory alias at the manifest boundary',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        createDirectoryAlias(
          path.join(fixture.root, 'src', 'app', 'features', 'tasks'),
          path.join(fixture.root, 'src', 'app', 'features', 'z-tasks-alias'),
        );
        const manifestPath = writeManifest(
          fixture.root,
          [fixture.safeFile, 'src/app/features/z-tasks-alias/a-safe-task-save.service.ts'],
        );
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['must be canonical repo-relative path'],
    },
    {
      name: 'rejects unsorted entries',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        const manifestPath = writeManifest(
          fixture.root,
          [fixture.secondSafeFile, fixture.safeFile],
        );
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['sorted'],
    },
    {
      name: 'rejects missing file paths',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        const manifestPath = writeManifest(
          fixture.root,
          ['src/app/features/tasks/missing-task-save.service.ts'],
        );
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['missing path'],
    },
    {
      name: 'rejects entries that resolve outside the repo through an external directory alias',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        const externalRoot = createTempRoot('nanoflow-required-files-external-target-');
        const externalDir = path.join(externalRoot, 'external-dir');
        mkdirSync(externalDir, { recursive: true });
        writeFileSync(path.join(externalDir, 'external-safe.ts'), 'export const externalSafe = true;\n', 'utf8');
        createDirectoryAlias(
          externalDir,
          path.join(fixture.root, 'src', 'app', 'features', 'z-external-link'),
        );
        const manifestPath = writeManifest(
          fixture.root,
          ['src/app/features/z-external-link/external-safe.ts'],
        );
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['resolve within the project root'],
    },
    {
      name: 'rejects an empty allowlist',
      run: (fixture: ReturnType<typeof createActionqueueFixtureRoot>) => {
        const manifestPath = writeManifest(fixture.root, []);
        return runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));
      },
      expected: ['at least one'],
    },
  ] as const;

  for (const parserCase of parserCases) {
    it(parserCase.name, () => {
      const fixture = createActionqueueFixtureRoot();
      const result = parserCase.run(fixture);
      expectFailure(result, ...parserCase.expected);
    });
  }

  it('rejects a case-only manifest alias on Windows before duplicate classification', () => {
    if (process.platform !== 'win32') {
      return;
    }

    const fixture = createActionqueueFixtureRoot();
    const upperCaseAlias = fixture.safeFile
      .split('/')
      .map(segment => segment.toUpperCase())
      .join('/');
    const manifestPath = writeManifest(fixture.root, [upperCaseAlias, fixture.safeFile]);
    const result = runActionqueueGuard(fixture.root, [], manifestEnv(manifestPath));

    expectFailure(result, 'must be canonical repo-relative path');
  });
});

describe('required-files manifest guard selection', () => {
  it('makes the actionqueue guard prefer the manifest over explicit --files input', () => {
    const fixture = createActionqueueFixtureRoot();
    const manifestPath = writeManifest(fixture.root, [fixture.safeFile]);
    const result = runActionqueueGuard(
      fixture.root,
      [`--files=${fixture.badFile}`],
      manifestEnv(manifestPath),
    );

    expectPassed(result, '[quality:guard:actionqueue-durable-enqueue] passed');
  });

  it('makes the retryqueue guard prefer the manifest over explicit --files input', () => {
    const fixture = createRetryqueueFixtureRoot();
    const manifestPath = writeManifest(fixture.root, [fixture.safeFile]);
    const result = runRetryqueueGuard(
      fixture.root,
      [`--files=${fixture.badFile}`],
      manifestEnv(manifestPath),
    );

    expectPassed(result, '[quality:guard:retryqueue-durable-add] passed');
  });

  it('rejects a single in-repo alias before RetryQueue explicit-file classification', () => {
    const fixture = createRetryqueueFixtureRoot();
    createDirectoryAlias(
      path.join(fixture.root, 'src', 'app', 'features', 'tasks'),
      path.join(fixture.root, 'src', 'app', 'features', 'z-tasks-alias'),
    );
    const manifestPath = writeManifest(
      fixture.root,
      ['src/app/features/z-tasks-alias/bad-task-retry.service.ts'],
    );
    const result = runRetryqueueGuard(fixture.root, [], manifestEnv(manifestPath));

    expectFailure(result, 'must be canonical repo-relative path');
    expect(combinedOutput(result)).not.toContain('RetryQueueService.add()');
  });

  it('rejects an aliased coupled-change trigger instead of letting it masquerade as the canonical trigger', () => {
    const root = createTempRoot('nanoflow-required-files-coupled-alias-');
    const triggerFile = 'src/services/dock-snapshot-persistence.service.ts';
    writeFixtureFile(
      root,
      triggerFile,
      "localStorage.setItem('nanoflow.snapshot', 'value');\n",
    );
    createDirectoryAlias(
      path.join(root, 'src', 'services'),
      path.join(root, 'src', 'z-services-alias'),
    );
    const manifestPath = writeManifest(
      root,
      ['src/z-services-alias/dock-snapshot-persistence.service.ts'],
    );
    const result = runNodeScript(coupledGuardPath, root, [], manifestEnv(manifestPath));

    expectFailure(result, 'must be canonical repo-relative path');
    expect(combinedOutput(result)).not.toContain('local-persistence-backup-restore');
    expect(combinedOutput(result)).not.toContain("localStorage.setItem('nanoflow.snapshot', 'value')");
  });

  const explicitFileCases = [
    {
      name: 'makes the coupled-changes guard prefer the manifest over explicit --files input',
      scriptPath: coupledGuardPath,
      args: ['--files=src/services/dock-snapshot-persistence.service.ts'],
      manifestFiles: [repoSafeManifestFile],
      success: '[quality:guard:coupled-changes] passed',
    },
    {
      name: 'makes the Context7 coupled-changes guard prefer the manifest over explicit --files input',
      scriptPath: context7GuardPath,
      args: ['--files=package.json'],
      manifestFiles: [repoSafeManifestFile],
      success: '[context7-coupled-changes] passed',
    },
    {
      name: 'makes the human-docs coupled-changes guard prefer the manifest over explicit --files input',
      scriptPath: humanDocsGuardPath,
      args: ['--files=src/app/features/text/components/text-task-editor.component.ts'],
      manifestFiles: repoHumanDocsManifestFiles,
      success: '[human-docs-coupled-changes] passed',
    },
  ] as const;

  for (const explicitFileCase of explicitFileCases) {
    it(explicitFileCase.name, () => {
      const manifestPath = writeManifest(repoRoot, explicitFileCase.manifestFiles);
      const result = runNodeScript(
        explicitFileCase.scriptPath,
        repoRoot,
        explicitFileCase.args,
        manifestEnv(manifestPath),
      );

      expectPassed(result, explicitFileCase.success);
    });
  }

  const invalidModeCases = [
    {
      name: 'makes the coupled-changes guard ignore invalid --mode when the manifest is active',
      scriptPath: coupledGuardPath,
      manifestFiles: [repoSafeManifestFile],
      success: '[quality:guard:coupled-changes] passed',
    },
    {
      name: 'makes the Context7 coupled-changes guard ignore invalid --mode when the manifest is active',
      scriptPath: context7GuardPath,
      manifestFiles: [repoSafeManifestFile],
      success: '[context7-coupled-changes] passed',
    },
    {
      name: 'makes the human-docs coupled-changes guard ignore invalid --mode when the manifest is active',
      scriptPath: humanDocsGuardPath,
      manifestFiles: repoHumanDocsManifestFiles,
      success: '[human-docs-coupled-changes] passed',
    },
  ] as const;

  for (const invalidModeCase of invalidModeCases) {
    it(invalidModeCase.name, () => {
      const manifestPath = writeManifest(repoRoot, invalidModeCase.manifestFiles);
      const result = runNodeScript(
        invalidModeCase.scriptPath,
        repoRoot,
        ['--mode=manifest-must-ignore-this'],
        manifestEnv(manifestPath),
      );

      expectPassed(result, invalidModeCase.success);
    });
  }
});

describe('required-files manifest integration boundaries', () => {
  it('does not activate when REQUIRED_FILES_MANIFEST_PATH is set without REQUIRED_FILES_MANIFEST_REQUIRED', () => {
    const manifestPath = writeManifest(repoRoot, [repoSafeManifestFile]);
    const result = runNodeScript(
      coupledGuardPath,
      repoRoot,
      ['--files=src/services/dock-snapshot-persistence.service.ts'],
      {
        REQUIRED_FILES_MANIFEST_PATH: manifestPath,
      },
    );

    expectFailure(result, 'local-persistence-backup-restore');
  });

  it('does not inherit an unmentioned manifest complement in helper subprocesses', () => {
    const fixture = createActionqueueFixtureRoot();
    const manifestPath = writeManifest(fixture.root, [fixture.safeFile]);
    const previousRequired = process.env['REQUIRED_FILES_MANIFEST_REQUIRED'];
    const previousPath = process.env['REQUIRED_FILES_MANIFEST_PATH'];

    try {
      process.env['REQUIRED_FILES_MANIFEST_REQUIRED'] = '1';
      process.env['REQUIRED_FILES_MANIFEST_PATH'] = manifestPath;

      const pathOnly = runActionqueueGuard(
        fixture.root,
        [`--files=${fixture.badFile}`],
        { REQUIRED_FILES_MANIFEST_PATH: manifestPath },
      );
      expectFailure(pathOnly, fixture.badFile);

      const requiredOnly = runActionqueueGuard(
        fixture.root,
        [],
        { REQUIRED_FILES_MANIFEST_REQUIRED: '1' },
      );
      expectFailure(requiredOnly, 'REQUIRED_FILES_MANIFEST_PATH is required');
    } finally {
      if (previousRequired === undefined) delete process.env['REQUIRED_FILES_MANIFEST_REQUIRED'];
      else process.env['REQUIRED_FILES_MANIFEST_REQUIRED'] = previousRequired;
      if (previousPath === undefined) delete process.env['REQUIRED_FILES_MANIFEST_PATH'];
      else process.env['REQUIRED_FILES_MANIFEST_PATH'] = previousPath;
    }
  });

  it('keeps audit:secrets full-tree even when the manifest excludes the leaked file', () => {
    const root = createTempRoot('nanoflow-required-files-secrets-');
    initGitRepo(root);

    const safeFile = 'src/safe.ts';
    const leakedFile = 'src/secret-leak.ts';
    const syntheticSupabaseSecret = ['sb', 'secret', 'abcdefghijklmnopqrstuvwxyz'].join('_');
    writeFixtureFile(root, safeFile, 'export const safe = true;\n');
    writeFixtureFile(root, leakedFile, `export const leaked = '${syntheticSupabaseSecret}';\n`);

    const manifestPath = writeManifest(root, [safeFile]);
    const result = runNodeScript(
      secretsGuardPath,
      root,
      ['--mode=audit'],
      manifestEnv(manifestPath),
    );

    expectFailure(result, 'secret-leak.ts', '[check-secrets]');
  });

  it('keeps quality:guard:encoding full-tree even when the manifest excludes the corrupted file', () => {
    const root = createTempRoot('nanoflow-required-files-encoding-');
    initGitRepo(root);

    const safeFile = 'src/safe.ts';
    const corruptFile = 'src/corrupt.ts';
    writeFixtureFile(root, safeFile, 'export const safe = true;\n');
    writeFixtureFile(
      root,
      corruptFile,
      Buffer.from([0xef, 0xbb, 0xbf, 0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x0a]),
    );

    const manifestPath = writeManifest(root, [safeFile]);
    const result = runNodeScript(
      encodingGuardPath,
      root,
      [],
      manifestEnv(manifestPath),
    );

    expectFailure(result, 'corrupt.ts', 'utf8_bom');
  });

  it('keeps test:contracts full-scope by explicitly disabling inherited manifest env and keeps test:contracts:manifest opt-in', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    expect(scripts['test:contracts']).toBe(defaultTestContractsScript);
    expectInOrder(scripts['test:contracts'], [
      'cross-env REQUIRED_FILES_MANIFEST_REQUIRED=0 REQUIRED_FILES_MANIFEST_PATH= npm run quality:guard:actionqueue-durable-enqueue',
      'cross-env REQUIRED_FILES_MANIFEST_REQUIRED=0 REQUIRED_FILES_MANIFEST_PATH= npm run quality:guard:retryqueue-durable-add',
      'cross-env REQUIRED_FILES_MANIFEST_REQUIRED=0 REQUIRED_FILES_MANIFEST_PATH= npm run quality:guard:coupled-changes',
      'cross-env REQUIRED_FILES_MANIFEST_REQUIRED=0 REQUIRED_FILES_MANIFEST_PATH= npm run quality:guard:context7-coupled',
      'cross-env REQUIRED_FILES_MANIFEST_REQUIRED=0 REQUIRED_FILES_MANIFEST_PATH= npm run quality:guard:human-docs-coupled',
      'cross-env REQUIRED_FILES_MANIFEST_REQUIRED=0 REQUIRED_FILES_MANIFEST_PATH= npm run test:contract-specs',
    ]);
    expect(
      scripts['test:contracts'].match(/REQUIRED_FILES_MANIFEST_REQUIRED=0/g)?.length,
    ).toBeGreaterThanOrEqual(6);
    expect(
      scripts['test:contracts'].match(/REQUIRED_FILES_MANIFEST_PATH=/g)?.length,
    ).toBeGreaterThanOrEqual(6);
    expect(scripts['test:contracts']).not.toContain('REQUIRED_FILES_MANIFEST_REQUIRED=1');
    expect(scripts['test:contracts:manifest']).toBeTruthy();
    expectInOrder(scripts['test:contracts:manifest'], [
      'npm run test:prepare-env',
      'npm run audit:secrets',
      'npm run quality:guard:encoding',
      'quality:guard:actionqueue-durable-enqueue',
      'quality:guard:retryqueue-durable-add',
      'quality:guard:coupled-changes',
      'quality:guard:context7-coupled',
      'quality:guard:human-docs-coupled',
      'npm run test:contract-specs',
    ]);
    expect(
      scripts['test:contracts:manifest'].match(/REQUIRED_FILES_MANIFEST_REQUIRED=1/g)?.length,
    ).toBeGreaterThanOrEqual(5);
  });
});
