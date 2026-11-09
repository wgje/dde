import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import {
  registerCodegraphOverlayMcpLifecycleTailSpecs,
} from './codegraph-nanoflow-overlay-mcp-lifecycle-tail.spec-helpers';
import {
  registerCodegraphOverlayMcpLifecycleTimeoutSpecs,
} from './codegraph-nanoflow-overlay-mcp-lifecycle-timeout.spec-helpers';

export function registerCodegraphOverlayMcpLifecycleSpecs(context: CodegraphOverlaySpecContext): void {
  const { repoRoot, wrapperScriptPath, WRAPPER_REPO_OVERLAY_ENV, tempRoots, writeFile, makeDelayedExploreFakeCodegraph, makeMalformedContentFakeCodegraph, makeExitingToolsListFakeCodegraph, makeReplayBackpressureFakeCodegraph, waitForExit, waitForLogEvent, parseJsonLines, readJsonLine } = context;
  it('logs actionable diagnostics when a local CodeGraph target is missing', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-missing-target-'));
    tempRoots.push(projectRoot);
    const missingTarget = path.join(projectRoot, 'missing-codegraph-entry.cjs');
    const logPath = path.join(projectRoot, 'wrapper.log');
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, missingTarget, 'serve', '--mcp', '--path', projectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
          NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP: '0',
        },
      },
    );

    const exitPromise = waitForExit(child);
    const spawnError = await waitForLogEvent(logPath, 'child.spawn.error', 2_000);
    const exit = await exitPromise;

    expect(exit).toEqual({ code: 2, signal: null });
    expect(spawnError).toEqual(expect.objectContaining({
      event: 'child.spawn.error',
      mode: 'local',
      reason: 'missing-target',
      code: 'ENOENT',
      message: expect.stringContaining('Local codegraph entry not found'),
      target: missingTarget,
      resolvedTarget: missingTarget,
      exists: false,
      runtime: expect.objectContaining({
        childPid: null,
        activeRequestCount: 0,
        pendingToolsListCount: 0,
      }),
      investigation: expect.objectContaining({
        failureBoundary: 'base-codegraph-child',
        failureClass: 'child-spawn-missing-target',
        transportShouldStayAlive: false,
      }),
    }));
  }, 8_000);

  it('swallows a late base CodeGraph response after a NanoFlow context pack timeout', async () => {
    const fakeCodegraph = makeDelayedExploreFakeCodegraph();
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
          FAKE_CODEGRAPH_EXPLORE_DELAY_MS: '200',
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '50',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '100',
        },
      },
    );
    child.stdin.on('error', () => {
      // The RED path closes the wrapper before the second request; absorb the expected broken pipe.
    });

    try {
      const contextResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 51,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'late-base-codegraph', overlayLimit: 1 },
        },
      })}\n`);

      const contextResponse = (await contextResponsePromise) as {
        id: number;
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(contextResponse.id).toBe(51);
      expect(contextResponse.result.isError).toBe(true);
      expect(contextResponse.result.content[0].text).toContain('timed out waiting for base CodeGraph');
      const lateResponseEvent = await waitForLogEvent(logPath, 'nanoflow.context.late-response', 2_000);
      expect(lateResponseEvent.runtime).toEqual(expect.objectContaining({
        expiredContextPackCount: 0,
        expiredContextPackTimerCount: 0,
      }));

      const toolsResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 52, method: 'tools/list' })}\n`);
      const toolsResponse = (await toolsResponsePromise) as {
        id: number;
        result: { tools: Array<{ name: string }> };
      };
      expect(toolsResponse.id).toBe(52);
      expect(toolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'nanoflow_overlay_query' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('clears expired context pack ids when the base CodeGraph child exits after a timeout', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-expired-context-cleanup-'));
    tempRoots.push(projectRoot);
    const fakeCodegraph = path.join(projectRoot, 'fake-codegraph-expired-context-cleanup.cjs');
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  if (!line.trim()) return;",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
        "    setTimeout(() => process.exit(70), 120);",
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
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '50',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '1000',
          NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP: '0',
        },
      },
    );

    try {
      const responsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 61,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'expired-context-cleanup', overlayLimit: 1 },
        },
      })}\n`);

      const response = (await responsePromise) as {
        id: number;
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(response.id).toBe(61);
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toContain('timed out waiting for base CodeGraph');

      const timeoutEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.timeout',
        2_000,
        (entry) => entry.internalId === -1,
      );
      expect(timeoutEvent).toEqual(expect.objectContaining({
        internalId: -1,
      }));

      const cleanupEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.expired.clear',
        2_000,
      );
      expect(cleanupEvent).toEqual(expect.objectContaining({
        reason: 'child-exit-before-expired-context-response',
        clearedCount: 1,
        runtime: expect.objectContaining({
          expiredContextPackCount: 0,
          expiredContextPackTimerCount: 0,
        }),
      }));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('keeps serving after a NanoFlow context pack formatter error', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-malformed-context-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'console.log(JSON.stringify({',
        '  matches: [],',
        '  relationshipGroups: {},',
        '  nodes: [null],',
        '  coverage: {},',
        '}));',
        '',
      ].join('\n'),
    );

    const fakeCodegraph = makeMalformedContentFakeCodegraph();
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
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '1000',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '1000',
        },
      },
    );

    try {
      const contextResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 71,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'malformed-context-pack', overlayLimit: 1 },
        },
      })}\n`);

      const contextResponse = (await contextResponsePromise) as {
        id: number;
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(contextResponse.id).toBe(71);
      expect(contextResponse.result.isError).toBe(true);
      expect(contextResponse.result.content[0].text).toContain('NanoFlow context pack failed');
      await waitForLogEvent(logPath, 'nanoflow.context.error', 2_000);

      const toolsResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 72, method: 'tools/list' })}\n`);
      const toolsResponse = (await toolsResponsePromise) as {
        id: number;
        result: { tools: Array<{ name: string }> };
      };
      expect(toolsResponse.id).toBe(72);
      expect(toolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'nanoflow_overlay_query' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('keeps serving when a NanoFlow context pack entry helper fails before forwarding to base CodeGraph', async () => {
    const fakeCodegraph = makeMalformedContentFakeCodegraph();
    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-entry-probe-'));
    tempRoots.push(probeRoot);
    const probePath = path.join(probeRoot, 'context-entry-helper-probe.cjs');
    fs.writeFileSync(
      probePath,
      [
        "'use strict';",
        "if (String(process.argv[1] ?? '').endsWith('codegraph-nanoflow-mcp-stdio.cjs')) {",
        '  const originalString = global.String;',
        '  function patchedString(value) {',
        "    if (value === 'context-pack-entry-helper-throw') {",
        "      throw new Error('probe context pack entry helper failure');",
        '    }',
        '    return originalString(value);',
        '  }',
        '  Object.setPrototypeOf(patchedString, originalString);',
        '  patchedString.prototype = originalString.prototype;',
        '  global.String = patchedString;',
        '}',
        '',
      ].join('\n'),
    );
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
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            '--require',
            probePath,
          ].filter(Boolean).join(' '),
        },
      },
    );

    try {
      const contextResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 73,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'context-pack-entry-helper-throw', overlayLimit: 1 },
        },
      })}\n`);

      const contextResponse = (await contextResponsePromise) as {
        id: number;
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(contextResponse.id).toBe(73);
      expect(contextResponse.result.isError).toBe(true);
      expect(contextResponse.result.content[0].text).toContain('NanoFlow context pack failed before forwarding to base CodeGraph.');
      expect(contextResponse.result.content[0].text).toContain('probe context pack entry helper failure');

      const errorEvent = await waitForLogEvent(logPath, 'nanoflow.context.error', 2_000);
      expect(errorEvent).toEqual(expect.objectContaining({
        clientId: 73,
        requestKind: 'nanoflow-context-pack',
        query: 'context-pack-entry-helper-throw',
        failureClass: 'context-pack-entry-error',
        message: 'probe context pack entry helper failure',
        investigation: expect.objectContaining({
          failureBoundary: 'context-pack-wrapper',
          failureClass: 'context-pack-entry-error',
          transportShouldStayAlive: true,
        }),
        rootCauseSnapshot: expect.objectContaining({
          recentClientRequests: expect.arrayContaining([
            expect.objectContaining({
              clientId: 73,
              requestKind: 'nanoflow-context-pack',
              tool: 'nanoflow_context_pack',
              query: 'context-pack-entry-helper-throw',
            }),
          ]),
        }),
      }));

      const toolsResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 74, method: 'tools/list' })}\n`);
      const toolsResponse = (await toolsResponsePromise) as {
        id: number;
        result: { tools: Array<{ name: string }> };
      };
      expect(toolsResponse.id).toBe(74);
      expect(toolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'nanoflow_overlay_query' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('restarts the base CodeGraph child after an unexpected exit without closing the MCP transport', async () => {
    const fakeCodegraph = makeExitingToolsListFakeCodegraph();
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

    try {
      const firstToolsResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 81, method: 'tools/list' })}\n`);
      const firstToolsResponse = (await firstToolsResponsePromise) as {
        id: number;
        result: { tools: Array<{ name: string }> };
      };
      expect(firstToolsResponse.id).toBe(81);
      expect(firstToolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'nanoflow_overlay_query' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));

      const childExitEvent = await waitForLogEvent(
        logPath,
        'child.exit',
        2_000,
        (entry) => entry.shuttingDown === false,
      );
      expect(childExitEvent).toEqual(expect.objectContaining({
        runtime: expect.objectContaining({
          childPid: expect.any(Number),
          activeRequestCount: expect.any(Number),
          pendingToolsListCount: expect.any(Number),
          clientMode: 'newline',
        }),
      }));

      const secondToolsResponsePromise = readJsonLine(child, 3_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 82, method: 'tools/list' })}\n`);
      const secondToolsResponse = (await secondToolsResponsePromise) as {
        id: number;
        result: { tools: Array<{ name: string }> };
      };
      expect(secondToolsResponse.id).toBe(82);
      expect(secondToolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'codegraph_explore' }),
        expect.objectContaining({ name: 'nanoflow_overlay_query' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));

      const events = parseJsonLines(logPath);
      expect(events).toContainEqual(expect.objectContaining({
        event: 'child.restart.request',
        reason: 'unexpected-exit',
        runtime: expect.objectContaining({
          childPid: expect.any(Number),
          activeRequestCount: expect.any(Number),
          pendingToolsListIds: expect.any(Array),
        }),
      }));
      expect(events).toContainEqual(expect.objectContaining({
        event: 'child.restart',
        reason: 'unexpected-exit',
        runtime: expect.objectContaining({
          childPid: expect.any(Number),
        }),
      }));
      expect(events).not.toContainEqual(expect.objectContaining({
        event: 'wrapper.exit',
        reason: 'child-exit',
      }));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('drops stale replay messages from a failed child before replaying a session to the next child', async () => {
    const fakeCodegraph = makeReplayBackpressureFakeCodegraph();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-replay-backpressure-'));
    tempRoots.push(tempRoot);
    const statePath = path.join(tempRoot, 'state.txt');
    const messagesPath = path.join(tempRoot, 'messages.jsonl');
    const logPath = path.join(tempRoot, 'wrapper.log');
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', repoRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
          NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP: '0',
          FAKE_CODEGRAPH_STATE_PATH: statePath,
          FAKE_CODEGRAPH_MESSAGES_PATH: messagesPath,
        },
      },
    );

    try {
      const initializeResponsePromise = readJsonLine(child, 3_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 101,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'replay-backpressure-test', version: '1.0.0' },
          filler: 'x'.repeat(1024 * 1024),
        },
      })}\n`);
      const initializeResponse = await initializeResponsePromise as { id: number };
      expect(initializeResponse.id).toBe(101);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

      const firstToolsResponsePromise = readJsonLine(child, 3_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'tools/list' })}\n`);
      const firstToolsResponse = await firstToolsResponsePromise as {
        id: number;
        result: { tools: Array<{ name: string }> };
      };
      expect(firstToolsResponse.id).toBe(102);
      expect(firstToolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));

      const discardEvent = await waitForLogEvent(
        logPath,
        'child.stdin.queue.discard-stale-replay',
        3_000,
        (entry) => Array.isArray(entry.discardedReasons)
          && entry.discardedReasons.includes('replay-initialized'),
      );
      expect(discardEvent).toEqual(expect.objectContaining({
        discardedReasons: expect.arrayContaining(['replay-initialized']),
        retainedCount: 0,
        runtime: expect.objectContaining({
          childInputQueueLength: 0,
        }),
      }));

      const secondToolsResponsePromise = readJsonLine(child, 3_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 103, method: 'tools/list' })}\n`);
      const secondToolsResponse = await secondToolsResponsePromise as {
        id: number;
        result: { tools: Array<{ name: string }> };
      };
      expect(secondToolsResponse.id).toBe(103);
      expect(secondToolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'codegraph_explore' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));

      const childMessages = parseJsonLines(messagesPath);
      expect(childMessages).toEqual(expect.arrayContaining([
        expect.objectContaining({ runCount: 2, lineCount: 1, method: 'initialize' }),
        expect.objectContaining({ runCount: 2, lineCount: 2, method: 'notifications/initialized' }),
      ]));
      expect(childMessages).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ runCount: 2, lineCount: 1, method: 'notifications/initialized' }),
      ]));
      const finalResponseEvent = await waitForLogEvent(
        logPath,
        'client.response',
        2_000,
        (entry) => entry.clientId === 103,
      );
      expect(finalResponseEvent.runtime).toEqual(expect.objectContaining({
        suppressedChildResponseCount: 0,
      }));
    } finally {
      child.kill();
    }
  }, 12_000);

  it('does not retain pending tools/list ids when the base CodeGraph child is unavailable', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-tools-list-unavailable-'));
    tempRoots.push(projectRoot);
    const fakeCodegraph = path.join(projectRoot, 'fake-codegraph-crash-loop.cjs');
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "process.exit(42);",
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
          NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_INITIAL_MS: '500',
          NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_MAX_MS: '500',
          NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP: '0',
        },
      },
    );

    try {
      await waitForLogEvent(logPath, 'child.restart.delayed', 2_000);

      const toolsResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 92, method: 'tools/list' })}\n`);
      const toolsResponse = (await toolsResponsePromise) as {
        id: number;
        error: { code: number; message: string };
      };
      expect(toolsResponse.id).toBe(92);
      expect(toolsResponse.error).toEqual(expect.objectContaining({
        code: -32001,
      }));

      const responseEvent = await waitForLogEvent(
        logPath,
        'client.response',
        2_000,
        (entry) => entry.clientId === 92,
      );
      expect(responseEvent.runtime).toEqual(expect.objectContaining({
        pendingToolsListCount: 0,
        pendingToolsListIds: [],
      }));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('fails active base CodeGraph requests when the child exits before responding', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-exit-before-response-'));
    tempRoots.push(projectRoot);
    const fakeCodegraph = path.join(projectRoot, 'fake-codegraph-exit-before-response.cjs');
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  if (!line.trim()) return;",
        "  const message = JSON.parse(line);",
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
          NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP: '0',
        },
      },
    );

    try {
      const responsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 93,
        method: 'tools/call',
        params: {
          name: 'codegraph_explore',
          arguments: { query: 'exit-before-response' },
        },
      })}\n`);

      const response = (await responsePromise) as {
        id: number;
        error: { code: number; message: string };
      };
      expect(response.id).toBe(93);
      expect(response.error).toEqual(expect.objectContaining({
        code: -32001,
        message: expect.stringContaining('Base CodeGraph child exited before responding'),
      }));

      const responseEvent = await waitForLogEvent(
        logPath,
        'client.response',
        2_000,
        (entry) => entry.clientId === 93,
      );
      expect(responseEvent).toEqual(expect.objectContaining({
        failureClass: 'base-codegraph-child-exit',
        runtime: expect.objectContaining({
          activeRequestCount: 0,
        }),
      }));
    } finally {
      child.kill();
    }
  }, 8_000);

  registerCodegraphOverlayMcpLifecycleTimeoutSpecs(context);
  registerCodegraphOverlayMcpLifecycleTailSpecs(context);
}
