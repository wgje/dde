import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayMcpTransportResilienceSpecs } from './codegraph-nanoflow-overlay-mcp-transport-resilience.spec-helpers';
import { registerCodegraphOverlayMcpTransportTailSpecs } from './codegraph-nanoflow-overlay-mcp-transport-tail.spec-helpers';

export function registerCodegraphOverlayMcpTransportSpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    wrapperScriptPath,
    WRAPPER_REPO_OVERLAY_ENV,
    tempRoots,
    writeFile,
    makeFakeCodegraph,
    makeExitingToolsListFakeCodegraph,
    readJsonLine,
    waitForLogEvent,
    waitForExit,
    parseJsonLines,
  } = context;

  it('classifies host stdin shutdown so Transport closed can be separated from wrapper crashes', async () => {
    const fakeCodegraph = makeFakeCodegraph();
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

    const toolsResponsePromise = readJsonLine(child);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 44, method: 'tools/list' })}\n`);
    await toolsResponsePromise;
    child.stdin.end();
    await waitForExit(child);

    const shutdownEvent = await waitForLogEvent(logPath, 'wrapper.shutdown.client-stdin', 2_000);
    expect(shutdownEvent).toEqual(expect.objectContaining({
      failureClass: 'host-stdin-closed',
      expectedExit: true,
      transportClosedBy: 'client-stdin',
      activeRequestsAtShutdown: 0,
      investigation: expect.objectContaining({
        failureBoundary: 'mcp-host-transport',
        transportShouldStayAlive: false,
        likelyRootCause: expect.stringContaining('host closed wrapper stdin'),
      }),
    }));
    const exitEvent = await waitForLogEvent(
      logPath,
      'wrapper.exit',
      2_000,
      (entry) => entry.reason === 'child-exit',
    );
    expect(exitEvent).toEqual(expect.objectContaining({
      failureClass: 'host-stdin-closed',
      expectedExit: true,
      transportClosedBy: 'client-stdin',
      activeRequestsAtShutdown: 0,
      investigation: expect.objectContaining({
        failureBoundary: 'mcp-host-transport',
        transportShouldStayAlive: false,
      }),
    }));
  }, 8_000);

  it('records child close diagnostics after an unexpected base CodeGraph exit', async () => {
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
          NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_AFTER: '10',
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    try {
      const toolsResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 45, method: 'tools/list' })}\n`);
      await toolsResponsePromise;

      const closeEvent = await waitForLogEvent(logPath, 'child.close', 5_000);
      expect(closeEvent).toEqual(expect.objectContaining({
        pid: expect.any(Number),
        code: 0,
        signal: null,
        currentChild: true,
        childExitClass: 'zero-exit',
        childExitName: 'EXIT_SUCCESS',
        rootCauseSnapshot: expect.any(Object),
        runtime: expect.objectContaining({
          childPid: expect.any(Number),
        }),
      }));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('records uncaught wrapper exceptions before the MCP transport closes', async () => {
    const fakeCodegraph = makeFakeCodegraph();
    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-fatal-probe-'));
    tempRoots.push(probeRoot);
    const probePath = path.join(probeRoot, 'fatal-probe.cjs');
    fs.writeFileSync(
      probePath,
      [
        "'use strict';",
        "if (String(process.argv[1] ?? '').endsWith('codegraph-nanoflow-mcp-stdio.cjs')) {",
        "  setImmediate(() => { throw new Error('fatal probe uncaught'); });",
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
    const exitPromise = waitForExit(child);

    try {
      const fatalEvent = await waitForLogEvent(logPath, 'wrapper.fatal', 2_000);
      const exit = await exitPromise;
      const fatalExitEvent = await waitForLogEvent(
        logPath,
        'wrapper.exit',
        2_000,
        (entry) => entry.reason === 'wrapper-fatal',
      );

      expect(exit.code).not.toBe(0);
      expect(fatalEvent).toEqual(expect.objectContaining({
        failureClass: 'wrapper-uncaught-exception',
        expectedExit: false,
        transportClosedBy: 'wrapper-process-fatal',
        error: expect.objectContaining({
          name: 'Error',
          message: 'fatal probe uncaught',
          stack: expect.stringContaining('fatal-probe.cjs'),
        }),
        investigation: expect.objectContaining({
          failureBoundary: 'wrapper-process',
          transportShouldStayAlive: false,
          likelyRootCause: expect.stringContaining('Uncaught exception'),
        }),
        runtime: expect.objectContaining({
          childPid: expect.any(Number),
        }),
      }));
      expect(fatalExitEvent).toEqual(expect.objectContaining({
        code: 1,
        reason: 'wrapper-fatal',
        kind: 'uncaughtException',
        failureClass: 'wrapper-uncaught-exception',
        expectedExit: false,
        transportClosedBy: 'wrapper-process-fatal',
        activeRequestsAtShutdown: expect.any(Number),
        investigation: expect.objectContaining({
          failureBoundary: 'wrapper-process',
          transportShouldStayAlive: false,
        }),
      }));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('records unhandled wrapper rejections before the MCP transport closes', async () => {
    const fakeCodegraph = makeFakeCodegraph();
    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-fatal-probe-'));
    tempRoots.push(probeRoot);
    const probePath = path.join(probeRoot, 'fatal-rejection-probe.cjs');
    fs.writeFileSync(
      probePath,
      [
        "'use strict';",
        "if (String(process.argv[1] ?? '').endsWith('codegraph-nanoflow-mcp-stdio.cjs')) {",
        "  setImmediate(() => Promise.reject(new Error('fatal probe rejected')));",
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
    const exitPromise = waitForExit(child);

    try {
      const fatalEvent = await waitForLogEvent(logPath, 'wrapper.fatal', 2_000);
      const exit = await exitPromise;
      const fatalExitEvent = await waitForLogEvent(
        logPath,
        'wrapper.exit',
        2_000,
        (entry) => entry.reason === 'wrapper-fatal',
      );

      expect(exit.code).not.toBe(0);
      expect(fatalEvent).toEqual(expect.objectContaining({
        kind: 'unhandledRejection',
        failureClass: 'wrapper-unhandled-rejection',
        expectedExit: false,
        transportClosedBy: 'wrapper-process-fatal',
        error: expect.objectContaining({
          name: 'Error',
          message: 'fatal probe rejected',
          stack: expect.stringContaining('fatal-rejection-probe.cjs'),
        }),
        investigation: expect.objectContaining({
          failureBoundary: 'wrapper-process',
          transportShouldStayAlive: false,
          likelyRootCause: expect.stringContaining('Unhandled Promise rejection'),
        }),
        runtime: expect.objectContaining({
          childPid: expect.any(Number),
        }),
      }));
      expect(fatalExitEvent).toEqual(expect.objectContaining({
        code: 1,
        reason: 'wrapper-fatal',
        kind: 'unhandledRejection',
        failureClass: 'wrapper-unhandled-rejection',
        expectedExit: false,
        transportClosedBy: 'wrapper-process-fatal',
        activeRequestsAtShutdown: expect.any(Number),
        investigation: expect.objectContaining({
          failureBoundary: 'wrapper-process',
          transportShouldStayAlive: false,
        }),
      }));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('records detailed child process error diagnostics before exiting the wrapper', async () => {
    const fakeCodegraph = makeFakeCodegraph();
    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-child-process-probe-'));
    tempRoots.push(probeRoot);
    const probePath = path.join(probeRoot, 'child-process-error-probe.cjs');
    fs.writeFileSync(
      probePath,
      [
        "'use strict';",
        "const childProcess = require('node:child_process');",
        'const originalSpawn = childProcess.spawn;',
        'let emitted = false;',
        'childProcess.spawn = function patchedSpawn(command, args) {',
        '  const child = originalSpawn.apply(this, arguments);',
        "  const commandLine = [command, ...(Array.isArray(args) ? args : [])].join(' ');",
        "  const target = process.env.FAKE_CODEGRAPH_PROCESS_ERROR_TARGET || '';",
        '  if (!emitted && target && commandLine.includes(target)) {',
        '    emitted = true;',
        '    setImmediate(() => {',
        "      const error = new Error('probe child process failure');",
        "      error.code = 'NANOFLOW_CHILD_PROCESS_PROBE';",
        "      error.syscall = 'spawn';",
        "      child.emit('error', error);",
        '    });',
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
          FAKE_CODEGRAPH_PROCESS_ERROR_TARGET: fakeCodegraph,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            '--require',
            probePath,
          ].filter(Boolean).join(' '),
        },
      },
    );
    const exitPromise = waitForExit(child);

    try {
      const processErrorEvent = await waitForLogEvent(logPath, 'child.error', 2_000);
      const exit = await exitPromise;
      const exitEvent = await waitForLogEvent(
        logPath,
        'wrapper.exit',
        2_000,
        (entry) => entry.reason === 'child-error',
      );

      expect(exit.code).toBe(1);
      expect(processErrorEvent).toEqual(expect.objectContaining({
        pid: expect.any(Number),
        failureClass: 'child-process-error',
        error: expect.objectContaining({
          name: 'Error',
          message: 'probe child process failure',
          code: 'NANOFLOW_CHILD_PROCESS_PROBE',
          stack: expect.stringContaining('child-process-error-probe.cjs'),
        }),
        investigation: expect.objectContaining({
          failureBoundary: 'base-codegraph-child',
          failureClass: 'child-process-error',
          transportShouldStayAlive: false,
          likelyRootCause: expect.stringContaining('base CodeGraph child'),
        }),
        rootCauseSnapshot: expect.any(Object),
        runtime: expect.objectContaining({
          childPid: expect.any(Number),
        }),
      }));
      expect(exitEvent).toEqual(expect.objectContaining({
        code: 1,
        reason: 'child-error',
        failureClass: 'child-process-error',
        expectedExit: false,
        transportClosedBy: 'base-codegraph-child',
        investigation: expect.objectContaining({
          failureBoundary: 'base-codegraph-child',
          transportShouldStayAlive: true,
        }),
      }));
    } finally {
      child.kill();
    }
  }, 8_000);

  it('records detailed child stdin stream diagnostics without closing the wrapper transport', async () => {
    const fakeCodegraph = makeFakeCodegraph();
    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-child-stdin-probe-'));
    tempRoots.push(probeRoot);
    const probePath = path.join(probeRoot, 'child-stdin-error-probe.cjs');
    fs.writeFileSync(
      probePath,
      [
        "'use strict';",
        "const childProcess = require('node:child_process');",
        'const originalSpawn = childProcess.spawn;',
        'let emitted = false;',
        'childProcess.spawn = function patchedSpawn(command, args) {',
        '  const child = originalSpawn.apply(this, arguments);',
        "  const commandLine = [command, ...(Array.isArray(args) ? args : [])].join(' ');",
        "  const target = process.env.FAKE_CODEGRAPH_STDIN_ERROR_TARGET || '';",
        '  if (!emitted && target && commandLine.includes(target)) {',
        '    emitted = true;',
        '    setImmediate(() => {',
        "      const error = new Error('probe child stdin stream failure');",
        "      error.code = 'NANOFLOW_STDIN_STREAM_PROBE';",
        "      child.stdin.emit('error', error);",
        '    });',
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
          FAKE_CODEGRAPH_STDIN_ERROR_TARGET: fakeCodegraph,
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
      const stdinErrorEvent = await waitForLogEvent(logPath, 'child.stdin.error', 2_000);
      expect(stdinErrorEvent).toEqual(expect.objectContaining({
        pid: expect.any(Number),
        stream: 'stdin',
        failureClass: 'child-stdin-stream-error',
        error: expect.objectContaining({
          name: 'Error',
          message: 'probe child stdin stream failure',
          code: 'NANOFLOW_STDIN_STREAM_PROBE',
          stack: expect.stringContaining('child-stdin-error-probe.cjs'),
        }),
        investigation: expect.objectContaining({
          failureBoundary: 'base-codegraph-child',
          failureClass: 'child-stdin-stream-error',
          transportShouldStayAlive: true,
          likelyRootCause: expect.stringContaining('stdin'),
        }),
        rootCauseSnapshot: expect.any(Object),
        runtime: expect.objectContaining({
          childPid: expect.any(Number),
        }),
      }));

      const exitRace = await Promise.race([
        waitForExit(child).then(() => 'exited' as const),
        new Promise<'alive'>((resolve) => {
          setTimeout(() => resolve('alive'), 250);
        }),
      ]);
      expect(exitRace).toBe('alive');
    } finally {
      child.kill();
    }
  }, 8_000);

  it('records child stdout stream errors and restarts the base child without closing the MCP transport', async () => {
    const fakeCodegraph = makeFakeCodegraph();
    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-stream-probe-'));
    tempRoots.push(probeRoot);
    const probePath = path.join(probeRoot, 'child-stdout-error-probe.cjs');
    fs.writeFileSync(
      probePath,
      [
        "'use strict';",
        "const childProcess = require('node:child_process');",
        'const originalSpawn = childProcess.spawn;',
        'let emitted = false;',
        'childProcess.spawn = function patchedSpawn(command, args, options) {',
        '  const child = originalSpawn.apply(this, arguments);',
        "  const commandLine = [command, ...(Array.isArray(args) ? args : [])].join(' ');",
        "  const target = process.env.FAKE_CODEGRAPH_STREAM_ERROR_TARGET || '';",
        '  if (!emitted && target && commandLine.includes(target)) {',
        '    emitted = true;',
        '    setImmediate(() => {',
        "      const error = new Error('probe child stdout stream failure');",
        "      error.code = 'NANOFLOW_STDOUT_STREAM_PROBE';",
        "      child.stdout.emit('error', error);",
        '    });',
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
          FAKE_CODEGRAPH_STREAM_ERROR_TARGET: fakeCodegraph,
          NANOFLOW_CODEGRAPH_CHILD_RESTART_BACKOFF_AFTER: '10',
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
      const streamErrorEvent = await waitForLogEvent(logPath, 'child.stdout.error', 2_000);
      expect(streamErrorEvent).toEqual(expect.objectContaining({
        pid: expect.any(Number),
        stream: 'stdout',
        failureClass: 'child-stdout-stream-error',
        error: expect.objectContaining({
          name: 'Error',
          message: 'probe child stdout stream failure',
          code: 'NANOFLOW_STDOUT_STREAM_PROBE',
        }),
        investigation: expect.objectContaining({
          failureBoundary: 'base-codegraph-child',
          failureClass: 'child-stdout-stream-error',
          transportShouldStayAlive: true,
        }),
        runtime: expect.objectContaining({
          childPid: expect.any(Number),
        }),
      }));

      const restartEvent = await waitForLogEvent(
        logPath,
        'child.restart',
        5_000,
        (entry) => entry.reason === 'stdout-stream-error',
      );
      expect(restartEvent).toEqual(expect.objectContaining({
        reason: 'stdout-stream-error',
        previousPid: expect.any(Number),
        pid: expect.any(Number),
      }));

      const toolsResponsePromise = readJsonLine(child, 5_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 83, method: 'tools/list' })}\n`);
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
  }, 10_000);

  it('classifies wrapper stdout stream errors as host transport closure instead of wrapper fatal crashes', async () => {
    const fakeCodegraph = makeFakeCodegraph();
    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-client-stdout-probe-'));
    tempRoots.push(probeRoot);
    const probePath = path.join(probeRoot, 'client-stdout-error-probe.cjs');
    fs.writeFileSync(
      probePath,
      [
        "'use strict';",
        "if (String(process.argv[1] ?? '').endsWith('codegraph-nanoflow-mcp-stdio.cjs')) {",
        '  setImmediate(() => {',
        "    const error = new Error('probe wrapper stdout pipe closed');",
        "    error.code = 'EPIPE';",
        "    error.syscall = 'write';",
        "    process.stdout.emit('error', error);",
        '  });',
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
    const exitPromise = waitForExit(child);

    try {
      const stdoutErrorEvent = await waitForLogEvent(logPath, 'client.stdout.error', 2_000);
      const shutdownEvent = await waitForLogEvent(logPath, 'wrapper.shutdown.client-stdio', 2_000);
      const exit = await exitPromise;
      const logEntries = parseJsonLines(logPath);

      expect(logEntries.some(entry => entry.event === 'wrapper.fatal')).toBe(false);
      expect(exit.code).toBe(0);
      expect(stdoutErrorEvent).toEqual(expect.objectContaining({
        stream: 'stdout',
        failureClass: 'host-stdout-closed',
        benignStreamClose: true,
        transportClosedBy: 'client-stdout',
        error: expect.objectContaining({
          name: 'Error',
          message: 'probe wrapper stdout pipe closed',
          code: 'EPIPE',
          syscall: 'write',
          stack: expect.stringContaining('client-stdout-error-probe.cjs'),
        }),
        investigation: expect.objectContaining({
          failureBoundary: 'mcp-host-transport',
          failureClass: 'host-stdout-closed',
          transportShouldStayAlive: false,
        }),
        rootCauseSnapshot: expect.objectContaining({
          recentClientRequests: expect.any(Array),
        }),
        runtime: expect.objectContaining({
          childPid: expect.any(Number),
        }),
      }));
      expect(shutdownEvent).toEqual(expect.objectContaining({
        stream: 'stdout',
        streamEvent: 'error',
        failureClass: 'host-stdout-closed',
        expectedExit: true,
        transportClosedBy: 'client-stdout',
        investigation: expect.objectContaining({
          failureBoundary: 'mcp-host-transport',
          failureClass: 'host-stdout-closed',
          transportShouldStayAlive: false,
        }),
      }));
    } finally {
      child.kill();
    }
  }, 8_000);

  registerCodegraphOverlayMcpTransportResilienceSpecs(context);
  registerCodegraphOverlayMcpTransportTailSpecs(context);
}
