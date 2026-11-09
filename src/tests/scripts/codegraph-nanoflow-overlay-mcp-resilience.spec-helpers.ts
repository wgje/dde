import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import { assertWrapperDiagnosticsLog } from './codegraph-nanoflow-overlay-mcp-diagnostics.spec-assertions';
import { registerCodegraphOverlayMcpContextSourceOrderingSpecs } from './codegraph-nanoflow-overlay-mcp-context-source-ordering.spec-helpers';
import { registerCodegraphOverlayMcpSourceBlockSpecs } from './codegraph-nanoflow-overlay-mcp-source-blocks.spec-helpers';
import { registerCodegraphOverlayMcpTransportSpecs } from './codegraph-nanoflow-overlay-mcp-transport.spec-helpers';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpResilienceSpecs(context: CodegraphOverlaySpecContext): void {
  const { repoRoot, wrapperScriptPath, WRAPPER_REPO_OVERLAY_ENV, WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS, tempRoots, writeFile, makeFreshMcpFixture, makeContentLengthFakeCodegraph, makeFakeCodegraph, makeHangingExploreFakeCodegraph, makeBlockedInputFakeCodegraph, readJsonLine, readMcpFrame, writeMcpFrame, writeManyJsonLines, waitForLogEvent, waitForExit, parseJsonLines } = context;
  it('translates child Content-Length MCP frames before augmenting tools/list', async () => {
    const fakeCodegraph = makeContentLengthFakeCodegraph();
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', repoRoot],
      { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    try {
      const toolsResponsePromise = readJsonLine(child);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/list' })}\n`);
      const toolsResponse = await toolsResponsePromise as {
        result: { tools: Array<{ name: string }> };
      };

      expect(toolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'codegraph_explore' }),
        expect.objectContaining({ name: 'nanoflow_overlay_query' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));
    } finally {
      child.kill();
    }
  }, 15_000);

  it('preserves Content-Length framing end-to-end for MCP clients', async () => {
    const fakeCodegraph = makeContentLengthFakeCodegraph();
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', repoRoot],
      { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    try {
      const toolsResponsePromise = readMcpFrame(child);
      writeMcpFrame(child, { jsonrpc: '2.0', id: 22, method: 'tools/list' });
      const toolsResponse = await toolsResponsePromise as {
        result: { tools: Array<{ name: string }> };
      };

      expect(toolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'codegraph_explore' }),
        expect.objectContaining({ name: 'nanoflow_overlay_query' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));
    } finally {
      child.kill();
    }
  }, 15_000);

  it('logs a runtime diagnostic and wrapper exit before closing on invalid MCP client headers', async () => {
    const fakeCodegraph = makeFakeCodegraph();
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-invalid-header-')), 'wrapper.log');
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
      await waitForLogEvent(logPath, 'wrapper.start', 2_000);
      const exitPromise = waitForExit(child);
      child.stdin.write('Content-Length: nope\r\n\r\n{}');

      const invalidHeaderEvent = await waitForLogEvent(logPath, 'client.header.invalid', 2_000);
      expect(invalidHeaderEvent).toEqual(expect.objectContaining({
        failureClass: 'client-invalid-header',
        headerPreview: 'Content-Length: nope',
        investigation: expect.objectContaining({
          failureBoundary: 'mcp-client-input',
          failureClass: 'client-invalid-header',
          transportShouldStayAlive: false,
        }),
        rootCauseSnapshot: expect.objectContaining({
          runtime: expect.objectContaining({
            childPid: expect.any(Number),
          }),
        }),
      }));

      const runtimeDiagnosticEvent = await waitForLogEvent(
        logPath,
        'wrapper.runtime.diagnostic',
        2_000,
        (entry) => entry.kind === 'clientInvalidHeader',
      );
      expect(runtimeDiagnosticEvent).toEqual(expect.objectContaining({
        kind: 'clientInvalidHeader',
        failureClass: 'client-invalid-header',
        fatal: true,
        transportClosedBy: 'client-invalid-header',
        activeRequestsAtShutdown: expect.any(Number),
        investigation: expect.objectContaining({
          failureBoundary: 'mcp-client-input',
          failureClass: 'client-invalid-header',
          transportShouldStayAlive: false,
        }),
        runtime: expect.objectContaining({
          childPid: expect.any(Number),
        }),
        rootCauseSnapshot: expect.objectContaining({
          recentClientRequests: expect.any(Array),
        }),
      }));

      const wrapperExitEvent = await waitForLogEvent(logPath, 'wrapper.exit', 2_000);
      expect(wrapperExitEvent).toEqual(expect.objectContaining({
        code: 1,
        reason: 'client-invalid-header',
        failureClass: 'client-invalid-header',
        expectedExit: false,
        transportClosedBy: 'client-invalid-header',
        rootCauseSnapshot: expect.objectContaining({
          runtime: expect.objectContaining({
            childPid: expect.any(Number),
          }),
        }),
      }));
      await expect(exitPromise).resolves.toEqual(expect.objectContaining({
        code: 1,
        signal: null,
      }));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('writes wrapper diagnostics for startup, tool injection, and overlay calls', async () => {
    const projectRoot = makeFreshMcpFixture();
    const fakeCodegraph = makeFakeCodegraph();
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
          ...WRAPPER_REPO_OVERLAY_ENV,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    try {
      const toolsResponsePromise = readJsonLine(child);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list' })}\n`);
      await toolsResponsePromise;

      const queryResponsePromise = readJsonLine(child, WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'nanoflow_overlay_query',
          arguments: { query: 'ProjectShellComponent', limit: 1 },
        },
      })}\n`);
      await queryResponsePromise;

      const logEntries = parseJsonLines(logPath);
      assertWrapperDiagnosticsLog(logEntries, { logPath, repoRoot: projectRoot, wrapperScriptPath });
    } finally {
      child.kill();
    }
  }, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS);

  it('times out a wedged NanoFlow overlay query without wedging the MCP wrapper', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-hung-overlay-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        "process.stderr.write('profile: before wedge\\n');",
        'setTimeout(() => setInterval(() => {}, 1000), 100);',
        '',
      ].join('\n'),
    );

    const fakeCodegraph = makeFakeCodegraph();
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
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '100',
        },
      },
    );

    try {
      const queryResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: {
          name: 'nanoflow_overlay_query',
          arguments: { query: 'wedged-overlay', limit: 1 },
        },
      })}\n`);

      const queryResponse = await queryResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(queryResponse.result.isError).toBe(true);
      expect(queryResponse.result.content[0].text).toContain('timed out');
      const timeoutEvent = await waitForLogEvent(logPath, 'overlay.query.timeout', 2_000);
      expect(timeoutEvent).toEqual(expect.objectContaining({
        requestId: expect.any(String),
        requestKind: 'nanoflow-overlay',
        clientId: 31,
        query: 'wedged-overlay',
        failureClass: 'overlay-timeout',
        outputMode: 'markdown',
        jsonExpected: false,
        overlayFile: expect.objectContaining({
          relativePath: '.codegraph/nanoflow-generations/CURRENT.json',
        }),
        investigation: expect.objectContaining({
          failureBoundary: 'overlay-subprocess',
          transportShouldStayAlive: true,
        }),
        runtime: expect.objectContaining({
          childPid: expect.any(Number),
          activeRequestCount: expect.any(Number),
        }),
      }));
      const timeoutRequestId = timeoutEvent.requestId;
      const timeoutQueryId = timeoutEvent.queryId;
      const exitEvent = await waitForLogEvent(
        logPath,
        'overlay.query.exit',
        2_000,
        (entry) => entry.queryId === timeoutQueryId,
      );
      expect(exitEvent).toEqual(expect.objectContaining({
        requestId: timeoutRequestId,
        failureClass: 'overlay-timeout',
        timedOut: true,
        investigation: expect.objectContaining({
          failureBoundary: 'overlay-subprocess',
          transportShouldStayAlive: true,
        }),
        runtime: expect.objectContaining({
          childPid: expect.any(Number),
        }),
        rootCauseSnapshot: expect.objectContaining({
          runtime: expect.objectContaining({
            childPid: expect.any(Number),
            activeRequestCount: expect.any(Number),
          }),
        }),
      }));
      const overlayResponseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.overlay.response',
        2_000,
        (entry) => entry.queryId === timeoutQueryId,
      );
      expect(overlayResponseEvent).toEqual(expect.objectContaining({
        requestId: timeoutRequestId,
        failureClass: 'overlay-timeout',
        rootCauseSnapshot: expect.objectContaining({
          runtime: expect.objectContaining({
            childPid: expect.any(Number),
            activeRequestCount: expect.any(Number),
          }),
        }),
      }));
      await waitForLogEvent(
        logPath,
        'client.response',
        2_000,
        (entry) => entry.requestId === timeoutRequestId
          && entry.failureClass === 'overlay-timeout'
          && entry.isError === true,
      ).then((clientResponseEvent) => {
        expect(clientResponseEvent).toEqual(expect.objectContaining({
          rootCauseSnapshot: expect.objectContaining({
            runtime: expect.objectContaining({
              childPid: expect.any(Number),
              activeRequestCount: expect.any(Number),
            }),
          }),
        }));
      });

      const toolsResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 32, method: 'tools/list' })}\n`);
      const toolsResponse = await toolsResponsePromise as {
        result: { tools: Array<{ name: string }> };
      };
      expect(toolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'nanoflow_overlay_query' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('times out a wedged base CodeGraph explore for NanoFlow context packs without wedging the wrapper', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-wedged-overlay-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );
    const fakeCodegraph = makeHangingExploreFakeCodegraph();
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
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '100',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '100',
        },
      },
    );

    try {
      const contextResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 41,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'wedged-base-codegraph', overlayLimit: 1 },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(contextResponse.result.isError).toBe(true);
      expect(contextResponse.result.content[0].text).toContain('timed out waiting for base CodeGraph');
      const contextTimeoutEvent = await waitForLogEvent(logPath, 'nanoflow.context.timeout', 2_000);
      expect(contextTimeoutEvent).toEqual(expect.objectContaining({
        failureClass: 'base-codegraph-timeout',
        investigation: expect.objectContaining({
          failureBoundary: 'base-codegraph-child',
          transportShouldStayAlive: true,
        }),
        runtime: expect.objectContaining({
          pendingContextPackCount: expect.any(Number),
          childPid: expect.any(Number),
        }),
      }));

      const toolsResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list' })}\n`);
      const toolsResponse = await toolsResponsePromise as {
        result: { tools: Array<{ name: string }> };
      };
      expect(toolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'nanoflow_overlay_query' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('returns overlay-only context when base CodeGraph explore times out', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-overlay-only-context-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        "const response = {",
        "  matches: [{",
        "    kind: 'class',",
        "    name: 'OverlayOnlyController',",
        "    file: 'src/overlay-only.controller.ts',",
        "    score: 10,",
        "    item: {",
        "      kind: 'class',",
        "      name: 'OverlayOnlyController',",
        "      qualifiedName: 'OverlayOnlyController',",
        "      filePath: 'src/overlay-only.controller.ts',",
        "      language: 'typescript',",
        "      startLine: 1,",
        "      endLine: 6",
        "    }",
        "  }],",
        "  nodes: [{",
        "    id: 'class:OverlayOnlyController',",
        "    kind: 'class',",
        "    name: 'OverlayOnlyController',",
        "    qualifiedName: 'OverlayOnlyController',",
        "    filePath: 'src/overlay-only.controller.ts',",
        "    language: 'typescript',",
        "    startLine: 1,",
        "    endLine: 6",
        "  }],",
        "  edges: [{",
        "    kind: 'calls',",
        "    source: 'OverlayOnlyController::setup',",
        "    target: 'OverlayOnlyService::initialize'",
        "  }],",
        "  relationshipGroups: {",
        "    calls: [{",
        "      source: 'OverlayOnlyController::setup',",
        "      target: 'OverlayOnlyService::initialize',",
        "      metadata: { relation: 'call' }",
        "    }]",
        "  },",
        "  coverage: { overlayOnlyFixture: 1 }",
        "};",
        "process.stdout.write(JSON.stringify(response));",
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/overlay-only.controller.ts',
      [
        'export class OverlayOnlyController {',
        '  setup(service: OverlayOnlyService): void {',
        '    service.initialize();',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const fakeCodegraph = makeHangingExploreFakeCodegraph();
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
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '100',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '2000',
        },
      },
    );

    try {
      const contextResponsePromise = readJsonLine(child, 3_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 45,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'OverlayOnlyController setup initialize', overlayLimit: 1 },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: {
          isError: boolean;
          content: Array<{ text: string }>;
          structuredContent?: { outcome?: Record<string, unknown> };
          _meta?: Record<string, unknown>;
        };
      };
      expect(contextResponse.result.isError).toBe(true);
      expect(contextResponse.result.content[0].text).toContain('No base CodeGraph context was returned.');
      expect(contextResponse.result.content[0].text).toContain('OverlayOnlyController');
      expect(contextResponse.result.content[0].text).toContain('OverlayOnlyController::setup → OverlayOnlyService::initialize');
      expect(contextResponse.result.content[0].text).toContain('overlayOnlyFixture: 1');
      expect(contextResponse.result.structuredContent?.outcome).toEqual({
        schemaVersion: 1,
        status: 'partial',
        usableContext: true,
        primaryFailureClass: 'base-codegraph-timeout-overlay-only',
        base: { status: 'unavailable', isError: true, textBytes: 0 },
        overlay: { status: 'available', isError: false, failureClass: null, generationId: null },
      });
      expect(contextResponse.result._meta).toEqual({
        nanoflowFailureClass: 'base-codegraph-timeout-overlay-only',
        nanoflowOutcomeSchemaVersion: 1,
        nanoflowOutcomeStatus: 'partial',
        nanoflowContextUsable: true,
      });

      const timeoutEvent = await waitForLogEvent(logPath, 'nanoflow.context.timeout', 2_000);
      expect(timeoutEvent).toEqual(expect.objectContaining({
        failureClass: 'base-codegraph-timeout-overlay-only',
        recoveredWithOverlayOnly: true,
        overlayMatchCount: 1,
        investigation: expect.objectContaining({
          failureBoundary: 'base-codegraph-child',
          transportShouldStayAlive: true,
        }),
      }));
      await waitForLogEvent(
        logPath,
        'client.response',
        2_000,
        (entry) => entry.clientId === 45
          && entry.failureClass === 'base-codegraph-timeout-overlay-only'
          && entry.isError === true,
      );
    } finally {
      child.kill();
    }
  }, 8_000);

  it('records a named child stdin reason for backpressured NanoFlow context pack explores', async () => {
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
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '100',
        },
      },
    );

    try {
      const largeQuery = 'context-pack-child-stdin-backpressure '.repeat(512);
      const timeoutResponsePromise = readJsonLine(child, 2_000);
      const backpressureEventPromise = waitForLogEvent(
        logPath,
        'child.stdin.backpressure',
        2_000,
      );

      const messages = Array.from({ length: 2000 }, (_, index) => ({
          jsonrpc: '2.0',
          id: 43 + index,
          method: 'tools/call',
          params: {
            name: 'nanoflow_context_pack',
            arguments: { query: `${largeQuery}${index}`, overlayLimit: 1 },
          },
      }));
      await writeManyJsonLines(child, messages, backpressureEventPromise);

      const backpressureEvent = await backpressureEventPromise;
      expect(backpressureEvent).toEqual(expect.objectContaining({
        reason: 'context-pack-codegraph-explore',
        runtime: expect.objectContaining({
          pendingContextPackCount: expect.any(Number),
        }),
      }));

      const timeoutResponse = await timeoutResponsePromise as {
        result?: { isError: boolean; content: Array<{ text: string }> };
        error?: { message: string };
      };
      expect(timeoutResponse).toEqual(expect.objectContaining({
        jsonrpc: '2.0',
        id: 43,
      }));
    } finally {
      child.kill();
    }
  }, 8_000);

  registerCodegraphOverlayMcpContextSourceOrderingSpecs(context);
  registerCodegraphOverlayMcpSourceBlockSpecs(context);
  registerCodegraphOverlayMcpTransportSpecs(context);
}
