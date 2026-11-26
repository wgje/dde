import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const wrapperScript = path.join(repoRoot, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');

interface WrapperSmokeResult {
  root: string;
  trace: string;
  events: Array<Record<string, unknown>>;
  exitCode: number | null;
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return predicate();
}

async function runWrapper(overrides: Record<string, string | undefined>, expectPrewarm: boolean): Promise<WrapperSmokeResult> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-overlay-worker-default-'));
  const tracePath = path.join(root, 'worker-trace.jsonl');
  const logPath = path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log');
  const fakeCodegraphPath = path.join(root, 'fake-codegraph.cjs');
  const overlayScriptPath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.mkdirSync(path.dirname(overlayScriptPath), { recursive: true });
  fs.writeFileSync(fakeCodegraphPath, [
    "'use strict';",
    "process.stdin.resume();",
    "process.stdin.on('end', () => process.exit(0));",
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(overlayScriptPath, [
    "import fs from 'node:fs';",
    "import readline from 'node:readline';",
    "const trace = value => fs.appendFileSync(process.env.OVERLAY_WORKER_TEST_TRACE, value + '\\n');",
    "trace('worker-start');",
    "const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "input.on('line', line => {",
    "  if (!line.trim()) return;",
    "  const request = JSON.parse(line);",
    "  trace('worker-request:' + JSON.stringify(request.args));",
    "  process.stdout.write(JSON.stringify({ id: request.id, ok: true, outputText: '', generationId: 'worker-smoke', cacheHit: false, profileEvents: [] }) + '\\n');",
    "});",
    '',
  ].join('\n'), 'utf8');

  const child = spawn(process.execPath, [
    wrapperScript,
    fakeCodegraphPath,
    'serve', '--mcp', '--path', root,
  ], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      CODEGRAPH_NO_DAEMON: '0',
      CODEGRAPH_NO_WATCH: '0',
      NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
      NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP: '0',
      NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
      NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '5000',
      NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '5000',
      OVERLAY_WORKER_TEST_TRACE: tracePath,
      NANOFLOW_CODEGRAPH_OVERLAY_WORKER_ENABLED: undefined,
      NANOFLOW_CODEGRAPH_OVERLAY_WORKER_POOL_SIZE: undefined,
      NANOFLOW_CODEGRAPH_OVERLAY_PREWARM: undefined,
      ...overrides,
    },
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', chunk => { stderr += chunk; });

  if (expectPrewarm) {
    const observed = await waitFor(() => fs.existsSync(tracePath)
      && fs.readFileSync(tracePath, 'utf8').includes('worker-request:["--prewarm"]'), 5_000);
    expect(observed, stderr || `prewarm trace missing for ${root}`).toBe(true);
  } else {
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  child.stdin.end();
  const exitCode = await waitForExit(child, 5_000);
  expect(exitCode, stderr).toBe(0);

  const events = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    : [];
  const trace = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8') : '';
  fs.rmSync(root, { recursive: true, force: true });
  return { root, trace, events, exitCode };
}

describe('shared-daemon overlay worker default and prewarm contract', () => {
  it('disables worker and prewarm when WORKER_ENABLED=0 even if PREWARM=1', async () => {
    const result = await runWrapper({
      CODEGRAPH_NO_DAEMON: '0',
      NANOFLOW_CODEGRAPH_OVERLAY_WORKER_ENABLED: '0',
      NANOFLOW_CODEGRAPH_OVERLAY_PREWARM: '1',
    }, false);
    expect(result.trace).toBe('');
    expect(result.events).toContainEqual(expect.objectContaining({
      event: 'wrapper.start',
      overlayQueryWorkerEnabled: false,
      overlayQueryWorkerPrewarmEnabled: false,
      overlayQueryWorkerSelection: 'explicit-disabled',
    }));
    expect(result.events.some(event => event.event === 'overlay.worker.pool.selected')).toBe(false);
  }, 15_000);

  it('keeps the legacy direct-session path without prewarm even if PREWARM=1', async () => {
    const result = await runWrapper({
      CODEGRAPH_NO_DAEMON: '1',
      NANOFLOW_CODEGRAPH_OVERLAY_PREWARM: '1',
    }, false);
    expect(result.trace).toBe('');
    expect(result.events).toContainEqual(expect.objectContaining({
      event: 'wrapper.start',
      overlayQueryWorkerEnabled: false,
      overlayQueryWorkerPrewarmEnabled: false,
      overlayQueryWorkerSelection: 'legacy-default',
    }));
  }, 15_000);

  it('selects and prewarms the worker for shared daemon when flags are omitted', async () => {
    const result = await runWrapper({ CODEGRAPH_NO_DAEMON: '0' }, true);
    expect(result.trace).toContain('worker-request:["--prewarm"]');
    expect(result.events).toContainEqual(expect.objectContaining({
      event: 'wrapper.start',
      overlayQueryWorkerEnabled: true,
      overlayQueryWorkerPrewarmEnabled: true,
      overlayQueryWorkerSelection: 'shared-daemon-default',
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      event: 'overlay.worker.pool.selected',
      mode: 'process-local',
    }));
  }, 15_000);

  it('selects the worker but disables prewarm for explicit PREWARM=0', async () => {
    const result = await runWrapper({
      CODEGRAPH_NO_DAEMON: '0',
      NANOFLOW_CODEGRAPH_OVERLAY_PREWARM: '0',
    }, false);
    expect(result.trace).toBe('');
    expect(result.events).toContainEqual(expect.objectContaining({
      event: 'wrapper.start',
      overlayQueryWorkerEnabled: true,
      overlayQueryWorkerPrewarmEnabled: false,
      overlayQueryWorkerSelection: 'shared-daemon-default',
    }));
    expect(result.events.some(event => event.event === 'overlay.worker.pool.selected')).toBe(false);
  }, 15_000);

});
