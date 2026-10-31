import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

function copyWrapperRuntimeBundle(wrapperScriptPath: string, destinationPath: string): void {
  const sourceDir = path.dirname(wrapperScriptPath);
  const destinationDir = path.dirname(destinationPath);
  fs.copyFileSync(wrapperScriptPath, destinationPath);
  for (const helperPath of [
    'codegraph-nanoflow-dedup-query.cjs',
    'codegraph-nanoflow-specialized-query.cjs',
    'codegraph-codex-config.cjs',
    path.join('lib', 'codegraph-context-outcome.cjs'),
  ]) {
    const targetPath = path.join(destinationDir, helperPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(
      path.join(sourceDir, helperPath),
      targetPath,
    );
  }
}

interface CopiedWrapperContextResponse {
  result: {
    isError?: boolean;
    content: Array<{ text: string }>;
    structuredContent?: { outcome?: unknown };
  };
}

function expectUsableCanonicalContext(response: CopiedWrapperContextResponse): void {
  const outcome = response.result.structuredContent?.outcome as {
    schemaVersion?: number;
    status?: string;
    usableContext?: boolean;
    primaryFailureClass?: string | null;
    base?: { textBytes?: number };
    overlay?: { status?: string; isError?: boolean; failureClass?: string | null };
  } | undefined;
  expect(outcome).toEqual(expect.objectContaining({
    schemaVersion: 1,
    usableContext: true,
    base: expect.objectContaining({
      status: 'available',
      isError: false,
      textBytes: expect.any(Number),
    }),
  }));
  expect(outcome?.base?.textBytes).toBeGreaterThan(0);
  expect(['complete', 'partial']).toContain(outcome?.status);
  expect(response.result.isError).toBe(outcome?.status === 'partial');
  if (outcome?.status === 'partial') {
    expect(outcome.primaryFailureClass).toEqual(expect.any(String));
    expect(['stale', 'unavailable']).toContain(outcome.overlay?.status);
    expect(outcome.overlay?.isError).toBe(true);
    expect(outcome.overlay?.failureClass).toEqual(expect.any(String));
  } else {
    expect(outcome?.primaryFailureClass).toBeNull();
    expect(outcome?.overlay).toEqual(expect.objectContaining({
      status: 'available',
      isError: false,
      failureClass: null,
    }));
  }
}

export function registerCodegraphOverlayMcpLifecycleDiagnosticSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const {
    repoRoot,
    wrapperScriptPath,
    WRAPPER_REPO_OVERLAY_ENV,
    tempRoots,
    makeFakeCodegraph,
    parseJsonLines,
    waitForLogEvent,
    readJsonLine,
    WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS,
    WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS,
  } = context;

  it('logs the effective shared-daemon topology for MCP root-cause diagnosis', async () => {
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-log-')), 'wrapper.log');
    tempRoots.push(path.dirname(logPath));
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, '@colbymchenry/codegraph@1.5.0', 'serve', '--mcp', '--path', repoRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...WRAPPER_REPO_OVERLAY_ENV,
          CODEGRAPH_NO_DAEMON: '0',
          CODEGRAPH_NO_WATCH: '0',
          CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '300000',
          CODEGRAPH_DAEMON_MAX_IDLE_MS: '1800000',
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    try {
      const spawnEvent = await waitForLogEvent(logPath, 'child.spawn');
      expect(spawnEvent).toEqual(expect.objectContaining({
        mode: 'npx-package',
        target: '@colbymchenry/codegraph@1.5.0',
        packageVersion: '1.5.0',
        env: expect.objectContaining({
          CODEGRAPH_NO_DAEMON: '0',
          CODEGRAPH_NO_WATCH: '0',
          CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '300000',
          CODEGRAPH_DAEMON_MAX_IDLE_MS: '1800000',
        }),
        runtimeTopology: expect.objectContaining({
          mode: 'shared-daemon-proxy',
          watcherOwnership: 'shared-daemon-single-watcher',
          fileLockContentionRisk: 'single-writer',
        }),
      }));
    } finally {
      child.kill();
    }
  }, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS);

  it('logs Codex MCP config drift from the wrapper process itself', async () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-config-drift-'));
    tempRoots.push(logRoot);
    const fakeCodegraph = makeFakeCodegraph();
    const logPath = path.join(logRoot, 'wrapper.log');
    const codexConfigPath = path.join(logRoot, 'config.toml');
    fs.writeFileSync(codexConfigPath, [
      '[mcp_servers.codegraph]',
      'command = "node"',
      'args = [',
      `  ${JSON.stringify(wrapperScriptPath)},`,
      '  "@colbymchenry/codegraph@1.5.0",',
      '  "serve",',
      '  "--mcp",',
      `  ${JSON.stringify(repoRoot)}`,
      ']',
      '',
      '[mcp_servers.codegraph.env]',
      'CODEGRAPH_NO_DAEMON = "0"',
      'CODEGRAPH_NO_WATCH = "0"',
      'CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS = "0"',
      'CODEGRAPH_DAEMON_MAX_IDLE_MS = "0"',
      'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS = "30000"',
      'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE = "0"',
      '',
    ].join('\n'));

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
          NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
        },
      },
    );

    try {
      const mismatchEvent = await waitForLogEvent(logPath, 'wrapper.config.mismatch', 2_000);
      const runtimeDiagnosticEvent = await waitForLogEvent(
        logPath,
        'wrapper.runtime.diagnostic',
        2_000,
        (entry) => entry.failureClass === 'mcp-host-config-mismatch',
      );
      expect(mismatchEvent).toEqual(expect.objectContaining({
        event: 'wrapper.config.mismatch',
        source: 'startup',
        failureClass: 'mcp-host-config-mismatch',
        expected: expect.objectContaining({
          codegraphTarget: '@colbymchenry/codegraph@1.5.0',
          env: expect.objectContaining({
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
          }),
        }),
        actual: expect.objectContaining({
          codegraphTarget: fakeCodegraph,
          env: expect.objectContaining({
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
          }),
        }),
        mismatches: expect.arrayContaining([
          expect.objectContaining({
            field: 'codegraphTarget',
            expected: '@colbymchenry/codegraph@1.5.0',
            actual: fakeCodegraph,
          }),
          expect.objectContaining({
            field: 'env.NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
            expected: '30000',
            actual: '60000',
          }),
        ]),
        investigation: expect.objectContaining({
          failureBoundary: 'codex-mcp-host',
          failureClass: 'mcp-host-config-mismatch',
          transportShouldStayAlive: true,
          nextEvidence: expect.arrayContaining([
            'wrapper.start.codexConfigAlignment',
            'codegraph:adapter:doctor -- --explain',
          ]),
        }),
        misdiagnosisGuards: expect.arrayContaining([
          expect.objectContaining({
            mistakenConclusion: 'adapter-source-regression',
            blockedBy: expect.stringContaining('codex-mcp-host'),
            requiredEvidenceBeforeConclusion: expect.stringContaining('fresh adapter fallback'),
          }),
          expect.objectContaining({
            mistakenConclusion: 'wrapper-transport-crash',
            blockedBy: expect.stringContaining('transportShouldStayAlive=true'),
          }),
          expect.objectContaining({
            mistakenConclusion: 'overlay-timeout',
            requiredEvidenceBeforeConclusion: expect.stringContaining('matching Codex config'),
          }),
        ]),
        requiredEvidenceBeforeConclusion: expect.arrayContaining([
          expect.objectContaining({
            conclusion: 'adapter-source-regression',
            requiredEvidence: expect.arrayContaining([
              expect.stringContaining('fresh adapter fallback'),
              expect.stringContaining('adapter doctor'),
            ]),
          }),
          expect.objectContaining({
            conclusion: 'wrapper-transport-crash',
            requiredEvidence: expect.arrayContaining([
              expect.stringContaining('wrapper.fatal'),
            ]),
          }),
        ]),
      }));
      expect(runtimeDiagnosticEvent).toEqual(expect.objectContaining({
        kind: 'configAlignment',
        failureClass: 'mcp-host-config-mismatch',
        fatal: false,
        configAlignment: expect.objectContaining({
          status: 'mismatch',
          mismatchCount: expect.any(Number),
          mismatches: expect.arrayContaining([
            expect.objectContaining({ field: 'codegraphTarget' }),
            expect.objectContaining({ field: 'env.NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS' }),
          ]),
        }),
        recovery: expect.arrayContaining([
          expect.stringContaining('Restart the Codex MCP host/session'),
          expect.stringContaining('codegraph:adapter:context'),
        ]),
        investigation: expect.objectContaining({
          failureBoundary: 'codex-mcp-host',
          failureClass: 'mcp-host-config-mismatch',
          transportShouldStayAlive: true,
        }),
        misdiagnosisGuards: expect.arrayContaining([
          expect.objectContaining({
            mistakenConclusion: 'adapter-source-regression',
            blockedBy: expect.stringContaining('codex-mcp-host'),
          }),
          expect.objectContaining({
            mistakenConclusion: 'wrapper-transport-crash',
            blockedBy: expect.stringContaining('transportShouldStayAlive=true'),
          }),
        ]),
        requiredEvidenceBeforeConclusion: expect.arrayContaining([
          expect.objectContaining({
            conclusion: 'adapter-source-regression',
            requiredEvidence: expect.arrayContaining([
              expect.stringContaining('fresh adapter fallback'),
            ]),
          }),
        ]),
        runtime: expect.objectContaining({
          childPid: null,
          activeRequestCount: 0,
        }),
      }));
    } finally {
      child.kill();
    }
  }, 15_000);

  it('logs startup config-alignment inspector failures instead of crashing the wrapper', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-missing-config-inspector-'));
    tempRoots.push(projectRoot);
    const wrapperCopyPath = path.join(projectRoot, 'codegraph-nanoflow-mcp-stdio.cjs');
    copyWrapperRuntimeBundle(wrapperScriptPath, wrapperCopyPath);
    fs.writeFileSync(
      wrapperCopyPath,
      fs.readFileSync(wrapperCopyPath, 'utf8').replace(
        'function inspectCodexMcpConfigAlignment()',
        'function removedInspectCodexMcpConfigAlignment()',
      ),
    );

    const fakeCodegraph = makeFakeCodegraph();
    const logPath = path.join(projectRoot, 'wrapper.log');
    const child = spawn(
      process.execPath,
      [wrapperCopyPath, fakeCodegraph, 'serve', '--mcp', '--path', repoRoot],
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
      const unavailableEvent = await waitForLogEvent(logPath, 'wrapper.config.unavailable', 2_000);
      expect(unavailableEvent).toEqual(expect.objectContaining({
        event: 'wrapper.config.unavailable',
        source: 'startup',
        failureClass: 'mcp-host-config-unknown',
        status: 'unavailable',
        reason: 'codex-config-alignment-inspector-missing',
        investigation: expect.objectContaining({
          failureBoundary: 'codex-mcp-host',
          failureClass: 'mcp-host-config-unknown',
          transportShouldStayAlive: true,
        }),
      }));

      const toolsResponsePromise = readJsonLine(child, 2_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/list' })}\n`);
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
  }, 15_000);

  it('classifies adapter fallback timeout overrides separately from Codex host config drift', async () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-config-override-'));
    tempRoots.push(logRoot);
    const fakeCodegraph = makeFakeCodegraph();
    const logPath = path.join(logRoot, 'wrapper.log');
    const codexConfigPath = path.join(logRoot, 'config.toml');
    fs.writeFileSync(codexConfigPath, [
      '[mcp_servers.codegraph]',
      'command = "node"',
      'args = [',
      `  ${JSON.stringify(wrapperScriptPath)},`,
      `  ${JSON.stringify(fakeCodegraph)},`,
      '  "serve",',
      '  "--mcp",',
      `  ${JSON.stringify(repoRoot)}`,
      ']',
      '',
      '[mcp_servers.codegraph.env]',
      'CODEGRAPH_NO_DAEMON = "0"',
      'CODEGRAPH_NO_WATCH = "0"',
      'CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS = "0"',
      'CODEGRAPH_DAEMON_MAX_IDLE_MS = "0"',
      'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS = "30000"',
      'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE = "0"',
      '',
    ].join('\n'));

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
          NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
          NANOFLOW_CODEGRAPH_CONFIG_ALIGNMENT_MODE: 'adapter-fallback',
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
        },
      },
    );

    try {
      const overrideEvent = await waitForLogEvent(logPath, 'wrapper.config.override', 2_000);
      expect(overrideEvent).toEqual(expect.objectContaining({
        event: 'wrapper.config.override',
        source: 'startup',
        status: 'override',
        alignmentMode: 'adapter-fallback',
        failureClass: 'mcp-host-config-intentional-override',
        mismatches: expect.arrayContaining([
          expect.objectContaining({
            field: 'env.NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
            expected: '30000',
            actual: '60000',
          }),
        ]),
        investigation: expect.objectContaining({
          failureBoundary: 'codex-mcp-host',
          failureClass: 'mcp-host-config-intentional-override',
          transportShouldStayAlive: true,
        }),
        misdiagnosisGuards: expect.arrayContaining([
          expect.objectContaining({
            mistakenConclusion: 'live-codex-host-config-drift',
            blockedBy: expect.stringContaining('status=override'),
            requiredEvidenceBeforeConclusion: expect.stringContaining('direct Codex MCP wrapper.start'),
          }),
        ]),
        requiredEvidenceBeforeConclusion: expect.arrayContaining([
          expect.objectContaining({
            conclusion: 'live-codex-host-config-drift',
            requiredEvidence: expect.arrayContaining([
              expect.stringContaining('direct Codex MCP wrapper.start'),
            ]),
          }),
        ]),
      }));
      const events = parseJsonLines(logPath);
      expect(events.some((event) => event.event === 'wrapper.config.mismatch')).toBe(false);
    } finally {
      child.kill();
    }
  }, 15_000);

  it('keeps stale wrapper sessions serving by default instead of closing the MCP transport', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-stale-wrapper-keepalive-'));
    tempRoots.push(projectRoot);
    const wrapperCopyPath = path.join(projectRoot, 'codegraph-nanoflow-mcp-stdio.cjs');
    copyWrapperRuntimeBundle(wrapperScriptPath, wrapperCopyPath);

    const fakeCodegraph = makeFakeCodegraph();
    const logPath = path.join(projectRoot, 'wrapper.log');
    const child = spawn(
      process.execPath,
      [wrapperCopyPath, fakeCodegraph, 'serve', '--mcp', '--path', repoRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...WRAPPER_REPO_OVERLAY_ENV,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
        },
      },
    );

    try {
      const childExitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      await waitForLogEvent(logPath, 'wrapper.start', 2_000);
      fs.appendFileSync(wrapperCopyPath, '\n// stale wrapper keepalive mutation\n');

      const contextPromise = readJsonLine(child, WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 90,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'ProjectShellComponent', overlayLimit: 1 },
        },
      })}\n`);
      const contextResponse = await contextPromise as CopiedWrapperContextResponse;
      expectUsableCanonicalContext(contextResponse);

      const staleEvent = await waitForLogEvent(logPath, 'wrapper.script.stale', 2_000);
      expect(staleEvent).toEqual(expect.objectContaining({
        event: 'wrapper.script.stale',
        staleAgainstDisk: true,
        investigation: expect.objectContaining({
          failureBoundary: 'mcp-host-transport',
          failureClass: 'stale-wrapper-script',
          transportShouldStayAlive: true,
          nextEvidence: expect.arrayContaining([
            'wrapper.script.stale.recycle.skipped',
          ]),
        }),
        runtime: expect.objectContaining({
          staleWrapperAutoRecycle: false,
          staleWrapperRecycleRequested: false,
        }),
      }));

      const skippedEvent = await waitForLogEvent(logPath, 'wrapper.script.stale.recycle.skipped', 2_000);
      expect(skippedEvent).toEqual(expect.objectContaining({
        event: 'wrapper.script.stale.recycle.skipped',
        reason: 'nanoflow-context-pack',
        failureClass: 'stale-wrapper-script',
        expectedExit: false,
        autoRecycle: false,
        investigation: expect.objectContaining({
          failureBoundary: 'mcp-host-transport',
          failureClass: 'stale-wrapper-script',
          transportShouldStayAlive: true,
        }),
        runtime: expect.objectContaining({
          staleWrapperAutoRecycle: false,
          staleWrapperRecycleRequested: false,
          staleWrapperRecycleSkippedLogged: true,
        }),
      }));

      const exitRace = await Promise.race([
        childExitPromise.then(() => 'exited' as const),
        new Promise<'alive'>((resolve) => {
          setTimeout(() => resolve('alive'), 250);
        }),
      ]);
      expect(exitRace).toBe('alive');

      const toolsPromise = readJsonLine(child, WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 92,
        method: 'tools/list',
      })}\n`);
      const toolsResponse = await toolsPromise as {
        result: { tools: Array<{ name: string }> };
      };
      expect(toolsResponse.result.tools.some((tool) => tool.name === 'nanoflow_context_pack')).toBe(true);
    } finally {
      child.kill();
    }
  }, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS);

  it('auto-recycles stale wrapper state after completing NanoFlow context tools when explicitly enabled', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-stale-wrapper-'));
    tempRoots.push(projectRoot);
    const wrapperCopyPath = path.join(projectRoot, 'codegraph-nanoflow-mcp-stdio.cjs');
    copyWrapperRuntimeBundle(wrapperScriptPath, wrapperCopyPath);

    const fakeCodegraph = makeFakeCodegraph();
    const logPath = path.join(projectRoot, 'wrapper.log');
    const child = spawn(
      process.execPath,
      [wrapperCopyPath, fakeCodegraph, 'serve', '--mcp', '--path', repoRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...WRAPPER_REPO_OVERLAY_ENV,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '1',
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_RECYCLE_GRACE_MS: '100',
        },
      },
    );

    try {
      const childExitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      await waitForLogEvent(logPath, 'wrapper.start', 2_000);
      fs.appendFileSync(wrapperCopyPath, '\n// stale wrapper smoke mutation\n');

      const contextPromise = readJsonLine(child, WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 91,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'ProjectShellComponent', overlayLimit: 1 },
        },
      })}\n`);
      const contextResponse = await contextPromise as CopiedWrapperContextResponse;
      expectUsableCanonicalContext(contextResponse);
      expect(contextResponse.result.content[0].text).toMatch(
        /(?:## Exploration: ProjectShellComponent|\*\*Exploration: ProjectShellComponent\*\*)/,
      );

      const staleEvent = await waitForLogEvent(logPath, 'wrapper.script.stale', 2_000);
      expect(staleEvent).toEqual(expect.objectContaining({
        event: 'wrapper.script.stale',
        scriptPath: wrapperCopyPath,
        startupScriptSha256: expect.any(String),
        diskScriptSha256: expect.any(String),
        staleAgainstDisk: true,
        runtime: expect.objectContaining({
          activeRequestCount: expect.any(Number),
          staleWrapperAutoRecycle: true,
        }),
        investigation: expect.objectContaining({
          failureBoundary: 'mcp-host-transport',
          failureClass: 'stale-wrapper-script',
          transportShouldStayAlive: false,
        }),
      }));
      expect(staleEvent.startupScriptSha256).not.toBe(staleEvent.diskScriptSha256);

      const continuationEvent = await waitForLogEvent(logPath, 'wrapper.script.stale.continue', 2_000);
      expect(continuationEvent).toEqual(expect.objectContaining({
        event: 'wrapper.script.stale.continue',
        source: 'nanoflow-context-pack',
        tool: 'nanoflow_context_pack',
        query: 'ProjectShellComponent',
        failureClass: 'stale-wrapper-script',
        investigation: expect.objectContaining({
          failureBoundary: 'mcp-host-transport',
          failureClass: 'stale-wrapper-script',
          transportShouldStayAlive: false,
        }),
      }));
      const recycleEvent = await waitForLogEvent(logPath, 'wrapper.script.stale.recycle.request', 2_000);
      expect(recycleEvent).toEqual(expect.objectContaining({
        event: 'wrapper.script.stale.recycle.request',
        reason: 'nanoflow-context-pack',
        failureClass: 'stale-wrapper-script',
        staleAgainstDisk: true,
        investigation: expect.objectContaining({
          failureBoundary: 'mcp-host-transport',
          failureClass: 'stale-wrapper-script',
          transportShouldStayAlive: false,
        }),
      }));
      const shutdownEvent = await waitForLogEvent(logPath, 'wrapper.shutdown.stale-wrapper-script', 2_000);
      expect(shutdownEvent).toEqual(expect.objectContaining({
        event: 'wrapper.shutdown.stale-wrapper-script',
        failureClass: 'stale-wrapper-script',
        expectedExit: true,
        transportClosedBy: 'wrapper-script-stale',
        investigation: expect.objectContaining({
          failureBoundary: 'mcp-host-transport',
          transportShouldStayAlive: false,
        }),
      }));
      await expect(childExitPromise).resolves.toEqual(expect.objectContaining({
        code: 0,
        signal: null,
      }));
    } finally {
      child.kill();
    }
  }, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS);
}
