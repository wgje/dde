import type { SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

interface CodegraphAdapterDoctorHostMcpConfigSpecContext {
  makeRoot(): string;
  trackTempRoot(root: string): void;
  runDoctor(root: string, args?: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  writePackage(root: string, scripts: Record<string, string>): void;
  requiredScripts(): Record<string, string>;
  writeCodexConfig(
    root: string,
    codexConfigPath: string,
    command?: string,
    codegraphTarget?: string,
  ): void;
}

export function registerCodegraphAdapterDoctorHostMcpConfigSpecs(
  context: CodegraphAdapterDoctorHostMcpConfigSpecContext,
): void {
  const {
    makeRoot,
    trackTempRoot,
    runDoctor,
    writePackage,
    requiredScripts,
    writeCodexConfig,
  } = context;

  it('ignores PowerShell process-list commands that mention the wrapper path', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    writeFileSync(wrapperPath, 'fresh wrapper\n');
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath, process.execPath);

    const result = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify([
        {
          pid: 7773,
          parentPid: 13880,
          commandLine: `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${wrapperPath}*' }"`,
        },
      ]),
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.hostMcp.liveProcesses).toEqual(expect.objectContaining({
      checked: true,
      matchingWrapperCount: 0,
      commandMismatchCount: 0,
      targetMismatchCount: 0,
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'host-mcp:live-process-config',
        ok: true,
      }),
    ]));
  });

  it('prints expected and actual values for failing Codex MCP environment checks', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    writeFileSync(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'), 'fresh wrapper\n');
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeFileSync(
      codexConfigPath,
      [
        '[mcp_servers.codegraph]',
        'command = "node"',
        'args = [',
        `  ${JSON.stringify(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'))},`,
        '  "@colbymchenry/codegraph@1.6.2",',
        '  "serve",',
        '  "--mcp",',
        `  ${JSON.stringify('--path')},`,
        `  ${JSON.stringify(root)},`,
        ']',
        '',
        '[mcp_servers.codegraph.env]',
        'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS = "1000"',
        '',
      ].join('\n'),
    );

    const result = runDoctor(root, ['--explain'], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      '- FAIL mcp-config:env:NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS expected=30000 actual=1000',
    );
    expect(result.stdout).toContain(
      '- FAIL mcp-config:env:NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE expected=0 actual=<missing>',
    );
  });
}
