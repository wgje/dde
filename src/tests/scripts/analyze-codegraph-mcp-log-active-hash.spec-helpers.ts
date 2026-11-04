import path from 'node:path';

import { expect, it } from 'vitest';

import {
  contextResponseEvent,
  makeCodexMcpConfig,
  makeLog,
  makeScriptFile,
  runAnalyzer,
  toolsListResponseEvent,
  wrapperStartEvent,
} from './analyze-codegraph-mcp-log.spec-helpers';

export function registerAnalyzeCodegraphMcpLogActiveHashSpecs(): void {
  it('summarizes active wrapper CodeGraph target and MCP env drift in log diagnostics', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-on-disk" };\n');
    const oldHash = '6'.repeat(64);
    const logPath = makeLog([
      wrapperStartEvent('old-host-run', script, {
        wrapperVersion: 'nanoflow-codegraph-wrapper-2026-06-13',
        scriptSha256: oldHash,
        codegraphTarget: '@colbymchenry/codegraph@1.1.1',
        env: {
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
        },
      }),
      contextResponseEvent('old-host-run', 'old-host-context', {
        ts: '2026-06-13T18:01:00.000Z',
      }),
      wrapperStartEvent('fresh-host-run', script, {
        ts: '2026-06-13T18:02:00.000Z',
        codegraphTarget: '@colbymchenry/codegraph@1.6.2',
        env: {
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '1',
        },
      }),
      toolsListResponseEvent('fresh-host-run', {
        ts: '2026-06-13T18:02:01.000Z',
      }),
    ]);

    const result = runAnalyzer(logPath);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.activeWrappers).toEqual(expect.objectContaining({
      distinctCodegraphTargets: 2,
      codegraphTargets: {
        '@colbymchenry/codegraph@1.1.1': 1,
        '@colbymchenry/codegraph@1.6.2': 1,
      },
      contextPackTimeoutMs: {
        30000: 1,
        60000: 1,
      },
      staleWrapperAutoRecycle: {
        0: 1,
        1: 1,
      },
    }));
    expect(summary.activeWrappers.latest).toEqual([
      expect.objectContaining({
        runId: 'fresh-host-run',
        codegraphTarget: '@colbymchenry/codegraph@1.6.2',
        env: expect.objectContaining({
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '1',
        }),
      }),
      expect.objectContaining({
        runId: 'old-host-run',
        codegraphTarget: '@colbymchenry/codegraph@1.1.1',
        env: expect.objectContaining({
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
        }),
      }),
    ]);
    expect(summary.currentWrapper).toEqual(expect.objectContaining({
      codegraphTarget: '@colbymchenry/codegraph@1.6.2',
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('Multiple active CodeGraph targets are handling MCP requests'),
      expect.stringContaining('Multiple active MCP wrapper env values are present'),
    ]));
  }, 15_000);

  it('summarizes mixed active wrapper hashes when stale long-lived sessions keep handling requests', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-on-disk" };\n');
    const staleHash = '5'.repeat(64);
    const logPath = makeLog([
      wrapperStartEvent('stale-long-run', script, {
        wrapperVersion: 'nanoflow-codegraph-wrapper-2026-06-13',
        scriptSha256: staleHash,
      }),
      contextResponseEvent('stale-long-run', 'stale-first-context', {
        ts: '2026-06-13T18:01:00.000Z',
      }),
      wrapperStartEvent('fresh-short-run', script, {
        ts: '2026-06-13T18:02:00.000Z',
      }),
      toolsListResponseEvent('fresh-short-run', {
        ts: '2026-06-13T18:02:01.000Z',
      }),
      contextResponseEvent('stale-long-run', 'stale-latest-context', {
        ts: '2026-06-13T18:03:00.000Z',
      }),
    ]);

    const result = runAnalyzer(logPath);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.currentWrapper).toEqual(expect.objectContaining({
      runId: 'stale-long-run',
      matchesDisk: false,
    }));
    expect(summary.currentDiskWrapper).toEqual(expect.objectContaining({
      runId: 'fresh-short-run',
      latestEvent: 'client.response',
      latestRequestKind: 'tools-list',
      matchesDisk: true,
      staleAgainstDisk: false,
    }));
    expect(summary.activeWrappers).toEqual(expect.objectContaining({
      total: 2,
      matchingDisk: 1,
      staleAgainstDisk: 1,
      unknownDiskHash: 0,
    }));
    expect(summary.activeWrappers.latest).toEqual([
      expect.objectContaining({
        runId: 'stale-long-run',
        latestEvent: 'nanoflow.context.response',
        latestRequestId: 'stale-latest-context',
        matchesDisk: false,
        staleAgainstDisk: true,
      }),
      expect.objectContaining({
        runId: 'fresh-short-run',
        latestEvent: 'client.response',
        latestRequestKind: 'tools-list',
        matchesDisk: true,
        staleAgainstDisk: false,
      }),
    ]);
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('Multiple active wrapper script hashes are handling MCP requests'),
      expect.stringContaining('Active wrapper sessions still use an older on-disk script hash'),
      expect.stringContaining('currentDiskWrapper matches the current disk script'),
    ]));

    const guardResult = runAnalyzer(logPath, ['--fail-on-active-stale-wrappers']);
    expect(guardResult.status).toBe(1);
  }, 15_000);

  it('distinguishes disk-fresh wrappers from wrappers that match the current Codex MCP config', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-script-old-config" };\n');
    const staleHash = '7'.repeat(64);
    const logPath = makeLog([
      wrapperStartEvent('disk-fresh-old-config-run', script, {
        ts: '2026-06-13T18:01:00.000Z',
        codegraphTarget: '@colbymchenry/codegraph@1.1.1',
        env: {
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
        },
      }),
      toolsListResponseEvent('disk-fresh-old-config-run', {
        ts: '2026-06-13T18:01:01.000Z',
      }),
      wrapperStartEvent('stale-current-run', script, {
        ts: '2026-06-13T18:02:00.000Z',
        scriptSha256: staleHash,
        codegraphTarget: '@colbymchenry/codegraph@1.1.1',
        env: {
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
        },
      }),
      contextResponseEvent('stale-current-run', 'stale-current-context', {
        ts: '2026-06-13T18:02:01.000Z',
      }),
    ]);
    const configPath = makeCodexMcpConfig({
      root: path.dirname(logPath),
      wrapperScriptPath: script.path,
      codegraphTarget: '@colbymchenry/codegraph@1.6.2',
      env: {
        NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
        NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
      },
    });

    const result = runAnalyzer(logPath, [], {
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: configPath,
    });
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.currentWrapper).toEqual(expect.objectContaining({
      runId: 'stale-current-run',
      matchesDisk: false,
      codegraphTarget: '@colbymchenry/codegraph@1.1.1',
    }));
    expect(summary.currentDiskWrapper).toEqual(expect.objectContaining({
      runId: 'disk-fresh-old-config-run',
      matchesDisk: true,
      codegraphTarget: '@colbymchenry/codegraph@1.1.1',
    }));
    expect(summary.currentConfiguredWrapper).toBeNull();
    expect(summary.currentConfiguredContextWrapper).toBeNull();
    expect(summary.rootCauseSummary.observed).toEqual(expect.objectContaining({
      currentDiskWrapperTarget: '@colbymchenry/codegraph@1.1.1',
      currentConfiguredWrapperRunId: null,
      currentConfiguredContextWrapperRunId: null,
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('currentDiskWrapper matches the current disk script but not the current Codex target/env'),
    ]));
  }, 15_000);
}
