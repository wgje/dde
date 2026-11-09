import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

async function waitForProcessExit(
  exitPromise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  return Promise.race([
    exitPromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function terminateTestProcessTree(
  child: ChildProcessWithoutNullStreams,
  exitPromise: Promise<unknown>,
  logPath: string,
): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (await waitForProcessExit(exitPromise, 500)) return;
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return;
  }

  const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const fallbackPids = readLoggedChildPids(logPath);
    for (const pid of fallbackPids) {
      forceKillTestProcess(pid);
    }
    forceKillTestProcess(child.pid);
    if (await waitForProcessExit(exitPromise, 1_000)) return;
    throw new Error([
      `Failed to terminate CodeGraph test process tree ${child.pid}`,
      result.error?.message ?? '',
      result.stderr?.trim() ?? '',
      fallbackPids.length > 0 ? `fallbackPids=${fallbackPids.join(',')}` : '',
    ].filter(Boolean).join(': '));
  }
}

function readLoggedChildPids(logPath: string): number[] {
  if (!fs.existsSync(logPath)) return [];
  const pids = new Set<number>();
  for (const line of fs.readFileSync(logPath, 'utf8').split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        event?: string;
        pid?: unknown;
        childPid?: unknown;
        runtime?: { childPid?: unknown };
      };
      if (!entry.event?.startsWith('child.')) continue;
      for (const candidate of [entry.pid, entry.childPid, entry.runtime?.childPid]) {
        const pid = Number(candidate);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
    } catch {
      // Ignore a partially written final diagnostics line during forced cleanup.
    }
  }
  return [...pids];
}

function forceKillTestProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export function registerCodegraphOverlayMcpTransportTailSpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    wrapperScriptPath,
    WRAPPER_REPO_OVERLAY_ENV,
    tempRoots,
    makeBlockedInputFakeCodegraph,
    makeReplayBackpressureFakeCodegraph,
    readJsonLine,
    waitForExit,
    waitForLogEvent,
    writeManyJsonLines,
    adaptationDocPath,
  } = context;

  it('pauses client input when the codegraph child stdin applies backpressure', async () => {
    const fakeCodegraph = makeBlockedInputFakeCodegraph();
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-log-')), 'wrapper.log');
    tempRoots.push(path.dirname(logPath));
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', repoRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...WRAPPER_REPO_OVERLAY_ENV,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );
    const exitPromise = waitForExit(child);
    const closePromise = new Promise<void>((resolve) => child.once('close', () => resolve()));

    try {
      const largeQuery = 'blocked-child-stdin '.repeat(128);
      const messages = Array.from({ length: 2000 }, (_, index) => {
        const id = index + 1;
        return {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'codegraph_explore',
            arguments: { query: `${largeQuery}${id}` },
          },
        };
      });

      const eventPromise = waitForLogEvent(logPath, 'child.stdin.backpressure');
      const writePromise = writeManyJsonLines(child, messages, eventPromise);
      const event = await eventPromise;
      expect(event.queuedMessages).toBeGreaterThanOrEqual(0);
      expect(event.bytes).toBeGreaterThan(1024);
      expect(event.queryTruncated).toBe(true);
      expect(Number(event.queryChars)).toBeGreaterThan(512);
      expect(Number(event.queryBytes)).toBeGreaterThan(512);
      expect(String(event.query)).toHaveLength(512);
      await writePromise;
    } finally {
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.destroy();
      await terminateTestProcessTree(child, exitPromise, logPath);
      await exitPromise;
      await closePromise;
    }
  }, 15_000);

  it('backs off rapid base CodeGraph child restarts without closing the MCP transport', async () => {
    const fakeCodegraph = makeReplayBackpressureFakeCodegraph();
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-log-')), 'wrapper.log');
    const statePath = path.join(path.dirname(logPath), 'fake-codegraph-state.txt');
    const messagesPath = path.join(path.dirname(logPath), 'fake-codegraph-messages.jsonl');
    tempRoots.push(path.dirname(logPath));
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', repoRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...WRAPPER_REPO_OVERLAY_ENV,
          FAKE_CODEGRAPH_STATE_PATH: statePath,
          FAKE_CODEGRAPH_MESSAGES_PATH: messagesPath,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
          NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_AFTER: '2',
          NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_INITIAL_MS: '25',
          NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_MAX_MS: '50',
        },
      },
    );

    try {
      const initializeResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 71,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vitest', version: '1.0.0' } },
      })}\n`);
      await initializeResponsePromise;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

      const firstToolsResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 72, method: 'tools/list' })}\n`);
      await firstToolsResponsePromise;

      const delayedRestartEvent = await waitForLogEvent(logPath, 'child.restart.delayed', 5_000);
      expect(delayedRestartEvent).toEqual(expect.objectContaining({
        reason: 'unexpected-exit',
        rapidExitCount: expect.any(Number),
        delayMs: expect.any(Number),
        investigation: expect.objectContaining({
          failureBoundary: 'base-codegraph-child',
          failureClass: 'base-codegraph-crash-loop',
          transportShouldStayAlive: true,
        }),
      }));
      expect(Number(delayedRestartEvent.rapidExitCount)).toBeGreaterThanOrEqual(2);
      expect(Number(delayedRestartEvent.delayMs)).toBeGreaterThan(0);

      await waitForLogEvent(
        logPath,
        'child.response.suppressed',
        5_000,
        (entry) => Number(entry.seq) > Number(delayedRestartEvent.seq),
      );

      const recoveredToolsResponsePromise = readJsonLine(child, 5_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 73, method: 'tools/list' })}\n`);
      const recoveredToolsResponse = await recoveredToolsResponsePromise as {
        id: number;
        result: { tools: Array<{ name: string }> };
      };
      expect(recoveredToolsResponse.id).toBe(73);
      expect(recoveredToolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'codegraph_explore' }),
        expect.objectContaining({ name: 'nanoflow_overlay_query' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));
    } finally {
      child.kill();
    }
  }, 12_000);

  it('documents Codex MCP configuration ownership instead of treating .vscode as the current host source', () => {
    const adaptationDoc = fs.readFileSync(adaptationDocPath, 'utf8');
    expect(adaptationDoc).toContain('mcpConfig: source=codex');
    expect(adaptationDoc).toContain('C:\\Users\\MI\\.codex\\config.toml');
    expect(adaptationDoc).toContain('NANOFLOW_CODEGRAPH_CODEX_CONFIG');
    expect(adaptationDoc).toContain('no applicable Codex config exists');
    expect(adaptationDoc).toContain('scripts/codegraph-nanoflow-mcp-stdio.cjs');
    expect(adaptationDoc).toContain('nanoflow_context_pack');
    expect(adaptationDoc).toContain('type_alias/constant/');
    expect(adaptationDoc).toContain('.codegraph/nanoflow-mcp-wrapper.log');
  });
}
