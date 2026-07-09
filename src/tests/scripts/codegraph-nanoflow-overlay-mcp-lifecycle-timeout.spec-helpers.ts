import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpLifecycleTimeoutSpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    waitForLogEvent,
    parseJsonLines,
    readJsonLine,
  } = context;

  it('fails pending NanoFlow context packs immediately when the base CodeGraph child exits before responding', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-exit-before-response-'));
    tempRoots.push(projectRoot);
    const fakeCodegraph = path.join(projectRoot, 'fake-codegraph-context-exit-before-response.cjs');
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  if (!line.trim()) return;",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'initialize') {",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-codegraph', version: '1.0.0' } } }));",
        "    return;",
        "  }",
        "  if (message.method === 'tools/list') {",
        "    console.log(JSON.stringify({",
        "      jsonrpc: '2.0',",
        "      id: message.id,",
        "      result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] },",
        "    }));",
        "    return;",
        "  }",
        "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
        "    process.exit(70);",
        "  }",
        "});",
        '',
      ].join('\n'),
    );
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-log-')), 'wrapper.log');
    tempRoots.push(path.dirname(logPath));
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', projectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP: '0',
        },
      },
    );

    try {
      const responsePromise = readJsonLine(child, 1_500);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 94,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'context-pack child exit', overlayLimit: 1 },
        },
      })}\n`);

      const response = (await responsePromise) as {
        id: number;
        error: { code: number; message: string };
      };
      expect(response.id).toBe(94);
      expect(response.error).toEqual(expect.objectContaining({
        code: -32001,
        message: expect.stringContaining('Base CodeGraph child exited before responding'),
      }));

      const responseEvent = await waitForLogEvent(
        logPath,
        'client.response',
        2_000,
        (entry) => entry.clientId === 94,
      );
      expect(responseEvent).toEqual(expect.objectContaining({
        failureClass: 'base-codegraph-child-exit',
        runtime: expect.objectContaining({
          pendingContextPackCount: 0,
          activeRequestCount: 0,
        }),
      }));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('backs off rapid base CodeGraph restart loops instead of spinning on process initialization failures', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-crash-loop-'));
    tempRoots.push(projectRoot);
    const fakeCodegraph = path.join(projectRoot, 'fake-codegraph-crash-loop.cjs');
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "process.exit(Number(process.env.FAKE_CODEGRAPH_EXIT_CODE || '42'));",
        '',
      ].join('\n'),
    );
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-log-')), 'wrapper.log');
    tempRoots.push(path.dirname(logPath));
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', projectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
          NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_AFTER: '1',
          NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_INITIAL_MS: '200',
          NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_MAX_MS: '200',
          NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP: '0',
        },
      },
    );

    try {
      const delayedRestart = await waitForLogEvent(logPath, 'child.restart.delayed', 2_000);
      expect(delayedRestart).toEqual(expect.objectContaining({
        reason: 'unexpected-exit',
        childExitCodeHex: '0x2a',
        childExitClass: 'nonzero-exit',
        childExitName: 'EXIT_42',
        childUptimeMs: expect.any(Number),
        delayMs: 200,
        rapidExitCount: expect.any(Number),
        restartWindowMs: expect.any(Number),
        investigation: expect.objectContaining({
          failureBoundary: 'base-codegraph-child',
          failureClass: 'base-codegraph-crash-loop',
          transportShouldStayAlive: true,
        }),
      }));

      const unavailableResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 91,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'crash-loop-context-pack', overlayLimit: 1 },
        },
      })}\n`);
      const unavailableResponse = (await unavailableResponsePromise) as {
        id: number;
        error: { code: number; message: string };
      };
      expect(unavailableResponse.id).toBe(91);
      expect(unavailableResponse.error).toEqual(expect.objectContaining({
        code: -32001,
        message: expect.stringContaining('Base CodeGraph child is restarting or unavailable'),
      }));

      const events = parseJsonLines(logPath);
      expect(events).toContainEqual(expect.objectContaining({
        event: 'base-codegraph.unavailable',
        requestKind: 'nanoflow-context-pack',
        failureClass: 'base-codegraph-unavailable',
      }));
      const restartEvents = events.filter((entry) => entry.event === 'child.restart');
      expect(restartEvents.length).toBeLessThan(8);
      expect(events).not.toContainEqual(expect.objectContaining({
        event: 'wrapper.exit',
        reason: 'child-exit',
      }));
    } finally {
      child.kill();
    }
  }, 8_000);
}
