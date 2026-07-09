import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('tooling security contracts', () => {
  it('run-ng must prepare the ignored generated index before Angular build and serve entrypoints', () => {
    const source = readText('scripts/run-ng.cjs');

    expect(source).toContain('function ensureGeneratedIndexForAngularCommand(argsToInspect)');
    expect(source).toContain("path.join(__dirname, 'set-env.cjs')");
    expect(source).toContain("path.join(__dirname, '..', '.tmp', 'index.generated.html')");
    expect(source).toContain("arg === 'build' || arg === 'serve'");
    expect(source).toContain('ensureGeneratedIndexForAngularCommand(resolvedArgs)');
    expect(source).toContain('if (!isAngularBuildOrServeCommand(argsToInspect))');
    expect(source).not.toContain('|| fs.existsSync(generatedIndexHtmlPath)');
  });

  it('keeps Codex hook configuration wired to the repository guard scripts', () => {
    const hookConfigPath = path.join(process.cwd(), '.github/hooks/hooks.json');
    expect(fs.existsSync(hookConfigPath)).toBe(true);

    const config = JSON.parse(readText('.github/hooks/hooks.json')) as {
      hooks?: Record<string, Array<{ type?: string; command?: string; timeout?: number }>>;
    };

    expect(config.hooks?.PreToolUse).toContainEqual({
      type: 'command',
      command: 'node .github/hooks/scripts/pre-tool-check.mjs',
      timeout: 10,
    });
    expect(config.hooks?.Stop).toContainEqual({
      type: 'command',
      command: 'node .github/hooks/scripts/stop-guard.mjs',
      timeout: 5,
    });

    for (const command of [
      'node .github/hooks/scripts/pre-tool-check.mjs',
      'node .github/hooks/scripts/stop-guard.mjs',
    ]) {
      const scriptPath = command.replace(/^node\s+/, '');
      expect(fs.existsSync(path.join(process.cwd(), scriptPath))).toBe(true);
    }
  });

  it('test setup must reset browser network suspension listeners before PollutionGuard checks', () => {
    const source = readText('src/test-setup.mocks.ts');

    expect(source).toContain("import { resetBrowserNetworkSuspensionTrackingForTests } from './utils/browser-network-suspension'");
    expect(source).toContain('resetBrowserNetworkSuspensionTrackingForTests();');
    expect(source.indexOf('resetBrowserNetworkSuspensionTrackingForTests();')).toBeLessThan(
      source.indexOf('const leakedListeners = Array.from(listenerRegistry.values())'),
    );
  });

  it('test setup must not leave background IndexedDB deleteDatabase requests', () => {
    const source = readText('src/test-setup.mocks.ts');

    expect(source).toContain('function resetIndexedDatabasesForTests');
    expect(source).toContain('export async function resetMocks()');
    expect(source).toContain('resetIndexedDatabasesForTests();');
    expect(source).toContain('beforeEach(async () =>');
    expect(source).toContain('await resetMocks();');
    expect(source).not.toContain('dbFactory.databases()');
    expect(source).not.toContain('indexedDB.deleteDatabase(db.name)');
  });

  it('test setup must restore document visibility before browser suspension checks', () => {
    const source = readText('src/test-setup.mocks.ts');

    expect(source).toContain('function resetDocumentVisibilityForTests()');
    expect(source).toContain("Object.defineProperty(document, 'visibilityState'");
    expect(source).toContain("value: 'visible'");
    expect(source).toContain('resetDocumentVisibilityForTests();');
    expect(source.indexOf('resetDocumentVisibilityForTests();')).toBeLessThan(
      source.indexOf('resetBrowserNetworkSuspensionTrackingForTests();'),
    );
  });

  it('test setup must restore real timers before any optional TestBed reset skip', () => {
    const source = readText('src/test-setup.ts');

    expect(source).toContain("import { afterEach, vi } from 'vitest'");
    expect(source).toContain('vi.useRealTimers();');
    expect(source).toContain('ensureAnimationFramePolyfill();');
    expect(source.indexOf('vi.useRealTimers();')).toBeLessThan(
      source.indexOf('if (g[testBedResetSkipKey] === true)'),
    );
  });

  it('test setup must restore browser storage references and methods before clearing values', () => {
    const source = readText('src/test-setup.mocks.ts');
    const storageHelperPath = path.join(process.cwd(), 'src/test-setup-browser-storage.mock.ts');

    expect(fs.existsSync(storageHelperPath)).toBe(true);
    const storageSource = readText('src/test-setup-browser-storage.mock.ts');
    expect(source).toContain("import { createBrowserStorageResetController } from './test-setup-browser-storage.mock'");
    expect(source).toContain('createBrowserStorageResetController();');
    expect(storageSource).toContain('export function createBrowserStorageResetController()');
    expect(storageSource).toContain('function restoreBrowserStorageForTests()');
    expect(storageSource).toContain('function clearBrowserStorageForTests()');
    expect(storageSource).toContain('const browserStorageMethodBaselines');
    expect(storageSource).toContain("restoreStorageReference(window, 'sessionStorage'");
    expect(storageSource).toContain('Object.defineProperty(owner, method, descriptor)');
    expect(source).toContain('restoreBrowserStorageForTests();');
    expect(source).toContain('clearBrowserStorageForTests();');
    expect(source.indexOf('restoreBrowserStorageForTests();')).toBeLessThan(
      source.indexOf('clearBrowserStorageForTests();'),
    );
  });

  it('conflict storage service specs must close IndexedDB connections they open', () => {
    const source = readText('src/services/conflict-storage.service.spec.ts');

    expect(source).toContain("import { afterEach, beforeEach");
    expect(source).toContain('afterEach(async () =>');
    expect(source).toContain('await service.closeStorageConnections();');
  });

  it('test setup must reset shared Supabase mock implementations between specs', () => {
    const source = readText('src/test-setup.mocks.ts');

    expect(source).toContain('function resetSupabaseMocksForTests()');
    expect(source).toContain('mockSupabaseClient.from.mockReset();');
    expect(source).toContain('mockSupabaseClient.from.mockImplementation');
    expect(source).toContain('mockSupabaseAuth.getSession.mockResolvedValue');
    expect(source).toContain('resetSupabaseMocksForTests();');
    expect(source).not.toContain('mockSupabaseClient.from.mockClear();');
  });

  it('services lane must isolate files because it includes browser storage and IndexedDB specs', () => {
    const source = readText('vitest.services.config.mts');

    expect(source).toContain('isolate: true');
    expect(source).toContain('fileParallelism: false');
    expect(source).not.toContain('isolate: false');
  });

  it('test matrix TestBed lanes must isolate shared browser and fake timer state', () => {
    const source = readText('scripts/run-test-matrix.cjs');

    expect(source).toMatch(/\[LANE_NAMES\.testbedService\]: \{[\s\S]*defaultIsolate: true,[\s\S]*extraArgs: \['--no-file-parallelism'\]/);
    expect(source).toMatch(/\[LANE_NAMES\.testbedComponent\]: \{[\s\S]*defaultIsolate: true,[\s\S]*extraArgs: \['--no-file-parallelism'\]/);
  });

  it('test matrix browser lane must isolate and serialize files because it uses browser globals', () => {
    const source = readText('scripts/run-test-matrix.cjs');

    expect(source).toMatch(/\[LANE_NAMES\.browserMinimal\]: \{[\s\S]*defaultIsolate: true,[\s\S]*extraArgs: \['--no-file-parallelism'\]/);
  });

  it('component TestBed config must isolate files when run outside the matrix', () => {
    const source = readText('vitest.components.config.mts');

    expect(source).toContain('fileParallelism: false');
    expect(source).toContain('isolate: true');
    expect(source).not.toContain('isolate: false');
  });

  it('MCP workspace config must not pin executable packages to latest or expose tokens as plain prompts', () => {
    const config = JSON.parse(readText('.vscode/mcp.json')) as {
      inputs?: Array<{ id?: string; password?: boolean; description?: string; default?: string }>;
      servers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
    };

    const inputById = new Map((config.inputs ?? []).map(input => [input.id, input]));
    expect(inputById.get('SUPABASE_ACCESS_TOKEN')?.password).toBe(true);
    expect(inputById.get('SUPABASE_ACCESS_TOKEN')?.description).toContain('personal access token');
    expect(inputById.get('SUPABASE_ACCESS_TOKEN')?.description).toContain('do not use a service role key');
    expect(inputById.get('context7_api_key')?.password).toBe(true);
    expect((config.inputs ?? [])
      .filter(input => input.password === true && Object.hasOwn(input, 'default'))
      .map(input => input.id)
      .sort()).toEqual([]);

    const serverArgs = Object.values(config.servers ?? {}).flatMap(server => server.args ?? []);
    expect(serverArgs.some(arg => arg.endsWith('@latest'))).toBe(false);
    expect(serverArgs).toContain('chrome-devtools-mcp@1.1.1');
    expect(serverArgs).not.toContain('--no-sandbox');
    expect(config.servers?.['codegraph']?.command).toBe('node');
    const codegraphArgs = config.servers?.['codegraph']?.args ?? [];
    expect(codegraphArgs[0]).toBe('${workspaceFolder}/scripts/codegraph-nanoflow-mcp-stdio.cjs');
    expect(codegraphArgs[1]).toMatch(/^@colbymchenry\/codegraph@\d+\.\d+\.\d+$/);
    expect(fs.existsSync(path.join(process.cwd(), 'scripts/codegraph-nanoflow-mcp-stdio.cjs'))).toBe(true);
    expect(codegraphArgs.slice(2, 6)).toEqual(['serve', '--mcp', '--path', '${workspaceFolder}']);
    expect(codegraphArgs).not.toContain('--liftoff-only');
    expect(codegraphArgs).not.toContain('--');
    expect(JSON.stringify(config.servers?.['codegraph'])).not.toContain('C:\\Users\\');
    expect(JSON.stringify(config.servers?.['codegraph'])).not.toContain('codegraph-win32-x64');
    expect(config.servers?.['codegraph']?.env?.CODEGRAPH_NO_DAEMON).toBe('1');
    expect(config.servers?.['codegraph']?.env?.CODEGRAPH_NO_WATCH).toBe('0');
    expect(config.servers?.['codegraph']?.env?.CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS).toBe('60000');
    expect(config.servers?.['codegraph']?.env?.CODEGRAPH_DAEMON_MAX_IDLE_MS).toBe('60000');
    expect(config.servers?.['codegraph']?.env?.NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE).toBe('1');
    expect(readText('scripts/codegraph-adapter-context.cjs')).toContain("DEFAULT_CODEGRAPH_TARGET = '@colbymchenry/codegraph@1.2.0'");
    expect(readText('scripts/smoke-codegraph-mcp-wrapper.cjs')).toContain("DEFAULT_CODEGRAPH_TARGET = '@colbymchenry/codegraph@1.2.0'");
    expect(serverArgs).toContain('@upstash/context7-mcp@2.1.1');
    expect(serverArgs).toContain('@supabase/mcp-server-supabase@0.5.9');

    const supabaseArgs = config.servers?.['Supabase']?.args ?? [];
    expect(supabaseArgs).toEqual([
      '-y',
      '@supabase/mcp-server-supabase@0.5.9',
      '--project-ref',
      '${input:project-ref}',
    ]);
  });

  it('Chrome diagnostic script must inspect the configured Chrome DevTools MCP server key', () => {
    const config = JSON.parse(readText('.vscode/mcp.json')) as {
      servers?: Record<string, unknown>;
    };
    const source = readText('scripts/diagnose-chrome.sh');

    expect(config.servers?.['ChromeDevTools/chrome-devtools-mcp']).toBeDefined();
    expect(source).toContain('ChromeDevTools/chrome-devtools-mcp');
    expect(source).not.toContain('io.github.ChromeDevTools/chrome-devtools-mcp');
  });

  it('bundle analyzer must use the generated index and Angular CLI wrapper build path', () => {
    const source = readText('scripts/analyze-bundle.sh');

    expect(source).toContain('npm run config');
    expect(source).toContain('node scripts/run-ng.cjs build --source-map');
    expect(source).not.toMatch(/(^|\n)ng build --source-map(\r?\n|$)/);
  });

  it('Node engine baseline must match dependencies that require Node 20+ tooling', () => {
    const packageJson = JSON.parse(readText('package.json')) as {
      engines?: Record<string, string>;
    };
    const packageLock = JSON.parse(readText('package-lock.json')) as {
      packages?: Record<string, { engines?: Record<string, string> }>;
    };
    const readme = readText('README.md');

    expect(packageJson.engines?.node).toBe('>=22.14.0');
    expect(packageLock.packages?.['']?.engines?.node).toBe('>=22.14.0');
    expect(readme).toContain('Node.js 要求**：`>= 22.14.0`');
    expect(readme).toContain('**Node.js** `>= 22.14.0`');
  });

  it('CLI wrappers must not use shell:true on Windows argument passthrough', () => {
    for (const scriptPath of ['scripts/run-ng.cjs', 'scripts/sentry-cli.cjs', 'scripts/supabase-cli.cjs']) {
      const source = readText(scriptPath);
      expect(source).toContain('function quoteCmdArg(value)');
      expect(source).toContain("replace(/%/g, '^%')");
      expect(source).toContain("process.platform === 'win32'");
      expect(source).toContain("'cmd.exe'");
      expect(source).toContain("'/d'");
      expect(source).toContain("'/c'");
      expect(source).not.toContain('shell: process.platform ===');
      expect(source).not.toContain('shell: true');
    }
  });

  it('Supabase CLI wrapper must not inject duplicate project ref when --project-ref=value is provided', () => {
    const source = readText('scripts/supabase-cli.cjs');

    expect(source).toContain('function hasOption(argsToInspect, optionNames)');
    expect(source).toContain('arg === optionName || arg.startsWith(`${optionName}=`)');
    expect(source).toContain("!hasOption(args, ['--project-ref'])");
    expect(source).not.toContain("!args.includes('--project-ref')");
  });

  it('codegraph MCP wrapper must preserve stdio framing, refresh NanoFlow overlay, and use a pinned package spec', () => {
    const config = JSON.parse(readText('.vscode/mcp.json')) as {
      servers?: Record<string, { args?: string[] }>;
    };
    const configuredWrapperArg = config.servers?.['codegraph']?.args?.[0];
    expect(configuredWrapperArg).toBeDefined();
    const configuredWrapper = configuredWrapperArg!.replace('${workspaceFolder}/', '');
    expect(configuredWrapper).toBe('scripts/codegraph-nanoflow-mcp-stdio.cjs');
    const source = readText(configuredWrapper);

    expect(source).toContain("target.startsWith('@colbymchenry/codegraph@')");
    expect(source).toContain("['-y', target, ...childArgs]");
    expect(source).toContain("'scripts', 'generate-codegraph-nanoflow-overlay.mjs'");
    expect(source).toContain('refreshNanoFlowOverlay(projectRoot)');
    expect(source).toContain("process.platform === 'win32'");
    expect(source).toContain("'cmd.exe'");
    expect(source).toContain('Content-Length: ${payload.length}');
    expect(source).toContain('forwardToCodegraph(body)');
    expect(source).toContain('terminateChildTree(child.pid)');
    expect(source).toContain("NANOFLOW_CODEGRAPH_ALLOW_DAEMON");
    expect(source).toContain("CODEGRAPH_NO_DAEMON: allowDaemon ? (process.env.CODEGRAPH_NO_DAEMON ?? '0') : '1'");
    expect(source).toContain("CODEGRAPH_NO_WATCH: process.env.CODEGRAPH_NO_WATCH ?? '0'");
    expect(source).toContain("CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: process.env.CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS ?? '60000'");
    expect(source).toContain("CODEGRAPH_DAEMON_MAX_IDLE_MS: process.env.CODEGRAPH_DAEMON_MAX_IDLE_MS ?? '60000'");
    expect(source).toContain('normalizePath(args[index])');

    for (const wrapperPath of ['scripts/codegraph-mcp-stdio.cjs', configuredWrapper]) {
      const wrapperSource = readText(wrapperPath);
      expect(wrapperSource).toContain('let childStdoutBuffer = Buffer.alloc(0)');
      expect(wrapperSource).toContain('function drainChildContentLengthMessage()');
      expect(wrapperSource).toContain('startsWithContentLengthHeader(childStdoutBuffer)');
      expect(wrapperSource).toContain('childStdoutBuffer.slice(bodyStart, bodyEnd).toString');
      expect(wrapperSource).toContain('child.stdin.once(\'drain\'');
      expect(wrapperSource).toContain('process.stdout.once(\'drain\'');
      expect(wrapperSource).toContain('process.stdin.pause?.()');
      expect(wrapperSource).toContain('child.stdout.pause?.()');
      expect(wrapperSource).toContain('return forwardToCodegraph(line);');
      expect(wrapperSource).not.toContain("child.stdout.setEncoding('utf8')");
    }
  });

  it('codegraph MCP workspace wiring must be checked into git, not just left as local files', () => {
    if (!fs.existsSync(path.join(process.cwd(), '.git'))) {
      return;
    }

    for (const filePath of [
      '.vscode/mcp.json',
      'scripts/codegraph-mcp-stdio.cjs',
      'scripts/codegraph-nanoflow-mcp-stdio.cjs',
      'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
      'src/tests/contracts/tooling-security.contract.spec.ts',
    ]) {
      const result = spawnSync('git', ['ls-files', '--error-unmatch', filePath], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });

      expect(result.status, `${filePath} must be tracked by git`).toBe(0);
    }
  });

  it('secrets audit must cover tracked and untracked non-ignored workspace files', () => {
    const packageJson = JSON.parse(readText('package.json')) as {
      scripts?: Record<string, string>;
    };
    const source = readText('scripts/contracts/check-secrets.cjs');

    expect(packageJson.scripts?.['audit:secrets']).toBe('node scripts/contracts/check-secrets.cjs --mode=audit');
    expect(packageJson.scripts?.['test:contract-specs']).toBe('npm run test:prepare-env && vitest run --config vitest.config.mts src/tests/contracts');
    expect(packageJson.scripts?.['test:contracts']).toContain('npm run test:contract-specs');
    expect(source).toContain("['ls-files', '--others', '--exclude-standard']");
    expect(source).toContain('function getAuditFiles()');
    expect(source).toContain('[...getTrackedFiles(), ...getUntrackedFiles()]');
    expect(source).toContain('scanning tracked and untracked files');
    expect(source).toContain('SUPABASE_ACCESS_TOKEN_LITERAL');
    expect(source).toContain('SUPABASE_ACCESS_TOKEN');
    expect(source).toContain('SENTRY_AUTH_TOKEN_LITERAL');
    expect(source).toContain('SENTRY_AUTH_TOKEN');
    expect(source).not.toContain('/\\.spec\\.ts$/');
    expect(source).not.toContain('/\\.test\\.ts$/');
    expect(source).not.toContain('/^src\\/tests\\//');
    expect(source).not.toContain('/^e2e\\//');
    expect(packageJson.scripts?.['test:contracts']).toContain('npm run audit:secrets');
  });

  it('secrets audit must scan tests and detect CLI token classes without logging token contents', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-secret-audit-'));
    const scannerPath = path.join(process.cwd(), 'scripts/contracts/check-secrets.cjs');
    const supabasePat = 'sbp_' + 'a'.repeat(40);
    const sentryToken = 'sntrys_' + 'b'.repeat(40);
    const supabaseSecret = 'sb_secret_' + 'c'.repeat(40);

    try {
      spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8' });
      fs.mkdirSync(path.join(tempDir, 'src/tests/contracts'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'e2e'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'scripts'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/tests/contracts/leaky.spec.ts'),
        `const token = '${supabasePat}';\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, 'e2e/leaky.test.ts'),
        `const token = '${sentryToken}';\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, 'scripts/leaky.cjs'),
        `const token = '${supabaseSecret}';\n`,
      );

      const result = spawnSync(process.execPath, [scannerPath, '--mode=audit'], {
        cwd: tempDir,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('path=src/tests/contracts/leaky.spec.ts:1 rule=SUPABASE_PAT');
      expect(result.stderr).toContain('path=e2e/leaky.test.ts:1 rule=SENTRY_AUTH_TOKEN');
      expect(result.stderr).toContain('path=scripts/leaky.cjs:1 rule=SUPABASE_SECRET');
      expect(result.stderr).not.toContain(supabasePat);
      expect(result.stderr).not.toContain(sentryToken);
      expect(result.stderr).not.toContain(supabaseSecret);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('secrets audit must block local Sentry and Cloudflare credential files by path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-secret-path-audit-'));
    const scannerPath = path.join(process.cwd(), 'scripts/contracts/check-secrets.cjs');

    try {
      spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8' });
      fs.mkdirSync(path.join(tempDir, '.wrangler'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, '.sentryclirc'), '[auth]\ntoken=placeholder\n');
      fs.writeFileSync(path.join(tempDir, 'sentry.properties'), 'auth.token=placeholder\n');
      fs.writeFileSync(path.join(tempDir, '.wrangler', 'state.json'), '{}\n');
      fs.writeFileSync(path.join(tempDir, '.dev.vars.local'), 'SECRET=placeholder\n');

      const result = spawnSync(process.execPath, [scannerPath, '--mode=audit'], {
        cwd: tempDir,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('path=.sentryclirc rule=PATH_BLACKLIST');
      expect(result.stderr).toContain('path=sentry.properties rule=PATH_BLACKLIST');
      expect(result.stderr).toContain('path=.wrangler/state.json rule=PATH_BLACKLIST');
      expect(result.stderr).toContain('path=.dev.vars.local rule=PATH_BLACKLIST');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('secrets audit must scan env templates and keep knip configuration checked in', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-env-template-audit-'));
    const scannerPath = path.join(process.cwd(), 'scripts/contracts/check-secrets.cjs');
    const supabasePat = 'sbp_' + 'd'.repeat(40);

    try {
      spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8' });
      fs.writeFileSync(path.join(tempDir, '.env.template'), `SUPABASE_ACCESS_TOKEN=${supabasePat}\n`);

      const result = spawnSync(process.execPath, [scannerPath, '--mode=audit'], {
        cwd: tempDir,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('path=.env.template:1 rule=SUPABASE_ACCESS_TOKEN_LITERAL');
      expect(result.stderr).not.toContain(supabasePat);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    const knipConfigPath = path.join(process.cwd(), 'knip.config.js');
    expect(fs.existsSync(knipConfigPath)).toBe(true);
    const knipConfig = readText('knip.config.js');
    expect(fs.existsSync(path.join(process.cwd(), '.knip.jsonc'))).toBe(false);
    expect(knipConfig).toContain('entry:');
    expect(knipConfig).toContain('project:');
    expect(knipConfig).toContain('compilers:');
    expect(knipConfig).toContain('ignoreBinaries:');
  });

  it('secrets audit must not block placeholder credential examples', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-placeholder-secret-audit-'));
    const scannerPath = path.join(process.cwd(), 'scripts/contracts/check-secrets.cjs');

    try {
      spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8' });
      fs.mkdirSync(path.join(tempDir, 'docs'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'docs', 'examples.md'),
        [
          'supabase secrets set GROQ_API_KEY=gsk_your_actual_key_here',
          'NG_APP_SUPABASE_ANON_KEY=eyJ...',
          '',
        ].join('\n'),
      );

      const result = spawnSync(process.execPath, [scannerPath, '--mode=audit'], {
        cwd: tempDir,
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('secrets audit must not let a placeholder token exempt another secret on the same line', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-placeholder-mixed-secret-audit-'));
    const scannerPath = path.join(process.cwd(), 'scripts/contracts/check-secrets.cjs');
    const githubToken = `ghp_${'a'.repeat(36)}`;

    try {
      spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8' });
      fs.mkdirSync(path.join(tempDir, 'docs'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'docs', 'mixed.md'),
        `example GROQ_API_KEY=gsk_your_actual_key_here leaked=${githubToken}\n`,
      );

      const result = spawnSync(process.execPath, [scannerPath, '--mode=audit'], {
        cwd: tempDir,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('path=docs/mixed.md:1 rule=GITHUB_TOKEN');
      expect(result.stderr).not.toContain(githubToken);
      expect(result.stderr).not.toContain('gsk_your_actual_key_here');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('set-env must escape generated TypeScript and inline script string literals', () => {
    const source = readText('scripts/set-env.cjs');

    expect(source).toContain('function tsStringLiteral(value)');
    expect(source).toContain('JSON.stringify(String(value))');
    expect(source).toContain('function htmlScriptStringLiteral(value)');

    for (const rawInterpolation of [
      "supabaseUrl: '${finalUrl}'",
      "supabaseAnonKey: '${finalKey}'",
      "SENTRY_DSN: '${sentryDsn}'",
      "gojsLicenseKey: '${gojsLicenseKey}'",
      "canonicalOrigin: '${canonicalOrigin}'",
      "deploymentTarget: '${deploymentTarget}'",
      "devAutoLoginEmail}', password: '${devAutoLoginPassword}",
      "var supabaseUrl = '${finalUrl}';",
      "var supabaseAnonKey = '${finalKey}';",
      "var CANONICAL_ORIGIN = '${escapeHtmlString(canonicalOrigin)}';",
    ]) {
      expect(source).not.toContain(rawInterpolation);
    }

    expect(source).toContain('supabaseUrl: ${tsStringLiteral(finalUrl)},');
    expect(source).toContain('supabaseAnonKey: ${tsStringLiteral(finalKey)},');
    expect(source).toContain('email: ${tsStringLiteral(devAutoLoginEmail)}');
    expect(source).toContain('password: ${tsStringLiteral(devAutoLoginPassword)}');
    expect(source).toContain('var supabaseUrl = ${htmlScriptStringLiteral(finalUrl)};');
    expect(source).toContain('var SUPABASE_ANON_KEY = ${htmlScriptStringLiteral(finalKey)};');
  });

  it('set-env must validate origin gate mode before emitting the runtime config union', () => {
    const source = readText('scripts/set-env.cjs');

    expect(source).toContain('function normalizeOriginGateMode(value)');
    expect(source).toContain("'off', 'redirect', 'read-only', 'export-only'");
    expect(source).toContain('const originGateMode = normalizeOriginGateMode(');
    expect(source).not.toContain("const originGateMode = (process.env.NG_APP_ORIGIN_GATE_MODE");
    expect(source).not.toContain("originGateMode || 'off'");
  });
});
