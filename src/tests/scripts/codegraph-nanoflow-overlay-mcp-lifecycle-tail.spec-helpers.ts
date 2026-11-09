import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import {
  registerCodegraphOverlayMcpContextPackSpecs,
} from './codegraph-nanoflow-overlay-mcp-context-pack.spec-helpers';
import {
  registerCodegraphOverlayMcpLifecycleDiagnosticSpecs,
} from './codegraph-nanoflow-overlay-mcp-lifecycle-diagnostics.spec-helpers';
import {
  registerCodegraphOverlayMcpRefreshSpecs,
} from './codegraph-nanoflow-overlay-mcp-refresh.spec-helpers';

export function registerCodegraphOverlayMcpLifecycleTailSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const {
    repoRoot,
    wrapperScriptPath,
    WRAPPER_REPO_OVERLAY_ENV,
    tempRoots,
    parseJsonLines,
    readJsonLine,
    waitForExit,
    codexConfigHelperPath,
    adapterContextScriptPath,
    adapterDoctorScriptPath,
    mcpSmokeScriptPath,
    adaptationDocPath,
  } = context;

  it('treats host stdin close as a graceful wrapper shutdown', async () => {
    const fakeCodegraph = context.makeSlowFakeCodegraph();
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
    child.stdin.end();

    const exit = await exitPromise;

    expect(exit).toEqual({ code: 0, signal: null });
    const events = parseJsonLines(logPath);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'wrapper.shutdown.client-stdin',
      streamEvent: 'end',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: 'wrapper.exit',
      code: 0,
      reason: 'child-exit',
    }));
  }, 15_000);

  it('keeps Codex MCP configuration ownership on the NanoFlow adapter scripts', () => {
    const codexConfigHelper = fs.readFileSync(codexConfigHelperPath, 'utf8');
    expect(codexConfigHelper).toContain('function readCodexCodegraphMcpConfig');
    expect(codexConfigHelper).toContain('NANOFLOW_CODEGRAPH_CODEX_CONFIG');
    expect(codexConfigHelper).toContain('config.toml');

    for (const scriptPath of [
      adapterContextScriptPath,
      adapterDoctorScriptPath,
      mcpSmokeScriptPath,
    ]) {
      const script = fs.readFileSync(scriptPath, 'utf8');
      expect(script).toContain('readCodexCodegraphMcpConfig');
      expect(script).toContain("require('./codegraph-codex-config.cjs')");
    }

    const adaptationDoc = fs.readFileSync(adaptationDocPath, 'utf8');
    expect(adaptationDoc).toContain('mcpConfig: source=codex');
    expect(adaptationDoc).toContain('C:\\Users\\MI\\.codex\\config.toml');
    expect(adaptationDoc).toMatch(/no applicable Codex config exists|without an\s+applicable Codex config/);
    expect(adaptationDoc).toContain('scripts/codegraph-nanoflow-mcp-stdio.cjs');
    expect(adaptationDoc).toContain('nanoflow_context_pack');
    expect(adaptationDoc).toContain('type_alias/constant/');
    expect(adaptationDoc).toContain('.codegraph/nanoflow-mcp-wrapper.log');
  });

  registerCodegraphOverlayMcpRefreshSpecs(context);
  registerCodegraphOverlayMcpLifecycleDiagnosticSpecs(context);
  registerCodegraphOverlayMcpContextPackSpecs(context);
}
