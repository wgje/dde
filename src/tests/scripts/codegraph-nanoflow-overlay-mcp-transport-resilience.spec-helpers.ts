import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpTransportResilienceSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const {
    repoRoot,
    wrapperScriptPath,
    WRAPPER_REPO_OVERLAY_ENV,
    tempRoots,
    writeFile,
    makeFakeCodegraph,
    readJsonLine,
    waitForLogEvent,
  } = context;

  it('records process warnings with runtime context without closing the MCP transport', async () => {
    const fakeCodegraph = makeFakeCodegraph();
    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-warning-probe-'));
    tempRoots.push(probeRoot);
    const probePath = path.join(probeRoot, 'warning-probe.cjs');
    fs.writeFileSync(
      probePath,
      [
        "'use strict';",
        "if (String(process.argv[1] ?? '').endsWith('codegraph-nanoflow-mcp-stdio.cjs')) {",
        "  setImmediate(() => process.emitWarning('runtime warning probe', {",
        "    code: 'NANOFLOW_RUNTIME_WARNING_PROBE',",
        "    detail: 'warning probe detail',",
        '  }));',
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
      const warningEventPromise = waitForLogEvent(logPath, 'wrapper.process.warning', 2_000);
      const toolsResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 81, method: 'tools/list' })}\n`);
      const toolsResponse = await toolsResponsePromise as {
        result: { tools: Array<{ name: string }> };
      };
      const warningEvent = await warningEventPromise;

      expect(toolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'nanoflow_overlay_query' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));
      expect(warningEvent).toEqual(expect.objectContaining({
        kind: 'warning',
        failureClass: 'wrapper-process-warning',
        warning: expect.objectContaining({
          name: 'Warning',
          message: 'runtime warning probe',
          code: 'NANOFLOW_RUNTIME_WARNING_PROBE',
          detail: 'warning probe detail',
          stack: expect.stringContaining('warning-probe.cjs'),
        }),
        investigation: expect.objectContaining({
          failureBoundary: 'wrapper-process',
          failureClass: 'wrapper-process-warning',
          transportShouldStayAlive: true,
        }),
        runtime: expect.objectContaining({
          childPid: expect.any(Number),
        }),
      }));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('surfaces diagnostic log write failures on stderr without breaking MCP responses', async () => {
    const fakeCodegraph = makeFakeCodegraph();
    const logDirectoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-log-directory-'));
    tempRoots.push(logDirectoryPath);
    let stderr = '';
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', repoRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...WRAPPER_REPO_OVERLAY_ENV,
          NANOFLOW_CODEGRAPH_MCP_LOG: logDirectoryPath,
        },
      },
    );
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    try {
      const toolsResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 82, method: 'tools/list' })}\n`);
      const toolsResponse = await toolsResponsePromise as {
        result: { tools: Array<{ name: string }> };
      };
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2_000;
        const poll = () => {
          if (stderr.includes('Diagnostic log write failed')) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            reject(new Error(`Expected diagnostic log write failure on stderr, got: ${stderr}`));
            return;
          }
          setTimeout(poll, 25);
        };
        poll();
      });

      expect(toolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'nanoflow_overlay_query' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));
      expect(stderr).toContain('Diagnostic log write failed');
      expect(stderr).toContain(logDirectoryPath);
      expect(stderr).toContain('wrapper.start');
    } finally {
      child.kill();
    }
  }, 8_000);

  it('records wrapper stderr forwarding failures without closing the MCP transport', async () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-stderr-forward-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph-stderr-forward.cjs');
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  if (!line.trim()) return;",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'tools/list') {",
        "    process.stderr.write('child-stderr-probe\\n');",
        "    console.log(JSON.stringify({",
        "      jsonrpc: '2.0',",
        "      id: message.id,",
        "      result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] },",
        "    }));",
        "    return;",
        "  }",
        "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
        "});",
        '',
      ].join('\n'),
    );
    const probePath = path.join(fakeRoot, 'stderr-forward-probe.cjs');
    fs.writeFileSync(
      probePath,
      [
        "'use strict';",
        "if (String(process.argv[1] ?? '').endsWith('codegraph-nanoflow-mcp-stdio.cjs')) {",
        "  const originalWrite = process.stderr.write.bind(process.stderr);",
        "  process.stderr.write = function patchedStderrWrite(chunk, ...args) {",
        "    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);",
        "    if (text.includes('child-stderr-probe')) {",
        "      const error = new Error('stderr sink closed by probe');",
        "      error.code = 'ERR_STREAM_DESTROYED';",
        "      throw error;",
        "    }",
        "    return originalWrite(chunk, ...args);",
        "  };",
        "}",
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
      const toolsResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 83, method: 'tools/list' })}\n`);
      const toolsResponse = await toolsResponsePromise as {
        result: { tools: Array<{ name: string }> };
      };
      const forwardErrorEvent = await waitForLogEvent(logPath, 'client.stderr.forward.error', 2_000);

      expect(toolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'nanoflow_overlay_query' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));
      expect(forwardErrorEvent).toEqual(expect.objectContaining({
        failureClass: 'client-stderr-forward-error',
        operation: 'forward-child-stderr',
        error: expect.objectContaining({
          code: 'ERR_STREAM_DESTROYED',
          message: 'stderr sink closed by probe',
        }),
        investigation: expect.objectContaining({
          failureBoundary: 'mcp-host-stdio',
          transportShouldStayAlive: true,
        }),
        runtime: expect.objectContaining({
          childPid: expect.any(Number),
        }),
      }));

      const stillAliveResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 84, method: 'tools/list' })}\n`);
      const stillAliveResponse = await stillAliveResponsePromise as {
        result: { tools: Array<{ name: string }> };
      };
      expect(stillAliveResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('classifies base CodeGraph stderr exception output with active request diagnostics', async () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-stderr-exception-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph-stderr-exception.cjs');
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  if (!line.trim()) return;",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'tools/list') {",
        "    console.log(JSON.stringify({",
        "      jsonrpc: '2.0',",
        "      id: message.id,",
        "      result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] },",
        "    }));",
        "    return;",
        "  }",
        "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
        "    process.stderr.write('ReferenceError: probe base CodeGraph failure\\n    at fake-codegraph-stderr-exception.cjs:1:1\\n');",
        "    setTimeout(() => {",
        "      console.log(JSON.stringify({",
        "        jsonrpc: '2.0',",
        "        id: message.id,",
        "        result: { content: [{ type: 'text', text: 'base response after stderr exception' }] },",
        "      }));",
        "    }, 25);",
        "    return;",
        "  }",
        "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
        "});",
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
        },
      },
    );

    try {
      const responsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 85,
        method: 'tools/call',
        params: {
          name: 'codegraph_explore',
          arguments: { query: 'stderr exception active request probe' },
        },
      })}\n`);
      await responsePromise;

      const stderrEvent = await waitForLogEvent(
        logPath,
        'child.stderr',
        2_000,
        (entry) => String(entry.text ?? '').includes('probe base CodeGraph failure'),
      );

      expect(stderrEvent).toEqual(expect.objectContaining({
        failureClass: 'base-codegraph-stderr-exception',
        textTail: expect.stringContaining('probe base CodeGraph failure'),
        investigation: expect.objectContaining({
          failureBoundary: 'base-codegraph-child',
          failureClass: 'base-codegraph-stderr-exception',
          transportShouldStayAlive: true,
        }),
        rootCauseSnapshot: expect.objectContaining({
          recentClientRequests: expect.arrayContaining([
            expect.objectContaining({
              clientId: 85,
              requestKind: 'codegraph-tool',
              tool: 'codegraph_explore',
              query: 'stderr exception active request probe',
            }),
          ]),
        }),
        runtime: expect.objectContaining({
          activeRequests: expect.arrayContaining([
            expect.objectContaining({
              clientId: 85,
              requestKind: 'codegraph-tool',
              tool: 'codegraph_explore',
              query: 'stderr exception active request probe',
            }),
          ]),
        }),
      }));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('keeps request identity on asynchronous child stdin write failures', async () => {
    const fakeCodegraph = makeFakeCodegraph();
    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-child-stdin-write-probe-'));
    tempRoots.push(probeRoot);
    const probePath = path.join(probeRoot, 'child-stdin-write-error-probe.cjs');
    fs.writeFileSync(
      probePath,
      [
        "'use strict';",
        "const childProcess = require('node:child_process');",
        'const originalSpawn = childProcess.spawn;',
        'let injected = false;',
        'childProcess.spawn = function patchedSpawn(command, args) {',
        '  const child = originalSpawn.apply(this, arguments);',
        "  const commandLine = [command, ...(Array.isArray(args) ? args : [])].join(' ');",
        "  const target = process.env.FAKE_CODEGRAPH_STDIN_WRITE_ERROR_TARGET || '';",
        '  if (target && commandLine.includes(target)) {',
        '    const originalWrite = child.stdin.write.bind(child.stdin);',
        '    child.stdin.write = function patchedChildStdinWrite(chunk, encoding, callback) {',
        "      const cb = typeof encoding === 'function' ? encoding : callback;",
        "      const result = typeof encoding === 'string' ? originalWrite(chunk, encoding) : originalWrite(chunk);",
        "      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);",
        "      if (!injected && text.includes('stdin write trace probe')) {",
        '        injected = true;',
        '        setImmediate(() => {',
        "          const error = new Error('probe child stdin write callback failure');",
        "          error.code = 'NANOFLOW_STDIN_WRITE_CALLBACK_PROBE';",
        "          error.syscall = 'write';",
        "          if (typeof cb === 'function') cb(error);",
        '        });',
        "      } else if (typeof cb === 'function') {",
        '        setImmediate(() => cb());',
        '      }',
        '      return result;',
        '    };',
        '  }',
        '  return child;',
        '};',
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
          FAKE_CODEGRAPH_STDIN_WRITE_ERROR_TARGET: fakeCodegraph,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require', probePath].filter(Boolean).join(' '),
        },
      },
    );

    try {
      const responsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 86,
        method: 'tools/call',
        params: {
          name: 'codegraph_explore',
          arguments: { query: 'stdin write trace probe' },
        },
      })}\n`);
      await responsePromise;

      const writeErrorEvent = await waitForLogEvent(
        logPath,
        'child.stdin.write.error',
        2_000,
        (entry) => entry.code === 'NANOFLOW_STDIN_WRITE_CALLBACK_PROBE',
      );
      expect(writeErrorEvent).toEqual(expect.objectContaining({
        failureClass: 'child-stdin-write-error',
        reason: 'client-message',
        requestId: expect.any(String),
        clientId: 86,
        requestKind: 'codegraph-tool',
        tool: 'codegraph_explore',
        query: 'stdin write trace probe',
        error: expect.objectContaining({
          code: 'NANOFLOW_STDIN_WRITE_CALLBACK_PROBE',
          syscall: 'write',
        }),
        investigation: expect.objectContaining({
          failureBoundary: 'base-codegraph-child',
          transportShouldStayAlive: true,
        }),
        rootCauseSnapshot: expect.any(Object),
      }));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('keeps NanoFlow context packs within the overlay timeout when the overlay query wedges', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-hung-context-overlay-'));
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
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '300',
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_OVERLAY_GRACE_MS: '50',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '1000',
        },
      },
    );

    try {
      const startedAt = Date.now();
      const contextResponsePromise = readJsonLine(child, 3_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 61,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'wedged-context-overlay', overlayLimit: 1 },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(900);
      expect(elapsedMs).toBeLessThan(2_500);
      expect(contextResponse.result.isError).toBe(true);
      expect(contextResponse.result.content[0].text).toContain('NanoFlow overlay query timed out');
      const contextEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 61,
      );
      expect(contextEvent).toEqual(expect.objectContaining({
        failureClass: 'overlay-timeout',
        overlayIsError: true,
        overlayRecoveryTimedOut: false,
        overlayRecoveryTimeoutMs: expect.any(Number),
        queryPlan: expect.objectContaining({
          contextTimeoutMs: 300,
          overlayTimeoutMs: 1000,
        }),
        textBytes: expect.any(Number),
        investigation: expect.objectContaining({
          failureBoundary: 'overlay-subprocess',
          transportShouldStayAlive: true,
        }),
        runtime: expect.objectContaining({
          childPid: expect.any(Number),
        }),
      }));

      const toolsResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 62, method: 'tools/list' })}\n`);
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
}
