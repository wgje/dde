import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpContextSourceRankingBudgetSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    makeFakeCodegraph,
    readJsonLine,
    waitForLogEvent,
  } = context;

  it('fills context-pack overlay source budget with production relation evidence before spec helpers', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-relation-budget-'));
    tempRoots.push(projectRoot);
    const productionFile = 'supabase/functions/cleanup-attachments/index.ts';
    const helperFiles = ['alpha', 'beta', 'gamma', 'delta'].map(name => (
      `src/app/core/services/sync/edge-function-header-${name}.spec-helpers.ts`
    ));
    writeFile(
      projectRoot,
      productionFile,
      [
        'export async function verifyMaintenanceBearer(req: Request): Promise<boolean> {',
        '  const authHeader = req.headers.get("Authorization");',
        '  return authHeader === "Bearer secret";',
        '}',
        '',
      ].join('\n'),
    );
    for (const helperFile of helperFiles) {
      writeFile(
        projectRoot,
        helperFile,
        [
          'export function edgeFunctionHeaderFixture(): string {',
          '  return "edge-function-header";',
          '}',
          '',
        ].join('\n'),
      );
    }
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        `const helperFiles = ${JSON.stringify(helperFiles)};`,
        `const productionFile = ${JSON.stringify(productionFile)};`,
        'const helperNodes = helperFiles.map((file, index) => ({',
        '  id: `function:${file}:edgeFunctionHeaderFixture${index}`,',
        '  kind: "function",',
        '  name: `edgeFunctionHeaderFixture${index}`,',
        '  qualifiedName: `edgeFunctionHeaderFixture${index}`,',
        '  filePath: file,',
        '  language: "typescript",',
        '  startLine: 1,',
        '  endLine: 3',
        '}));',
        'const functionNode = {',
        '  id: `function:${productionFile}:cleanup-attachments`,',
        '  kind: "function",',
        '  name: "cleanup-attachments",',
        '  qualifiedName: "cleanup-attachments",',
        '  filePath: productionFile,',
        '  language: "typescript",',
        '  startLine: 1,',
        '  endLine: 4',
        '};',
        'const headerNode = {',
        '  id: `variable:${productionFile}:edge-function-header:authorization:2`,',
        '  kind: "variable",',
        '  name: "Authorization",',
        '  qualifiedName: "cleanup-attachments::Authorization",',
        '  filePath: productionFile,',
        '  language: "typescript",',
        '  startLine: 2,',
        '  endLine: 2,',
        '  metadata: { relation: "edge-function-header" }',
        '};',
        'const response = {',
        '  query: "edge-function-header",',
        '  matches: [',
        '    ...helperFiles.map((file, index) => ({',
        '      kind: "function",',
        '      name: `edgeFunctionHeaderFixture${index}`,',
        '      file,',
        '      score: 20000',
        '    })),',
        '    { kind: "supabase-edge-function", name: "cleanup-attachments", file: productionFile, score: 1000 }',
        '  ],',
        '  nodes: [...helperNodes, functionNode, headerNode],',
        '  relationshipGroups: { references: [{ source: "cleanup-attachments", target: "Authorization", relation: "edge-function-header" }] },',
        '  coverage: { typescriptFiles: 5, graphNodes: 6, graphEdges: 1 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );
    const fakeCodegraph = makeFakeCodegraph();
    const logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-relation-budget-log-')),
      'wrapper.log',
    );
    tempRoots.push(path.dirname(logPath));

    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', projectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    try {
      const contextResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 52,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'edge-function-header',
            overlayLimit: 20,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      expect(text).toContain(`#### ${productionFile}`);
      expect(text).toContain('req.headers.get("Authorization")');
      for (const helperFile of helperFiles) {
        expect(text).not.toContain(`#### ${helperFile}`);
      }

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 52,
      );
      expect(responseEvent.sourceOrdering).toEqual(expect.objectContaining({
        topRankedOverlayFile: productionFile,
        topRankedOverlayFileVisibleIndex: 0,
        firstSourceBlockIsTopRankedOverlayFile: true,
        topRankedOverlayFileMissing: false,
      }));
    } finally {
      child.kill();
    }
  }, 12_000);

  it('enforces maxFiles across final context-pack source and relation evidence', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-hard-file-budget-'));
    tempRoots.push(projectRoot);
    const files = ['src/primary-budget.ts', 'src/secondary-budget.ts'];
    for (const [index, file] of files.entries()) {
      writeFile(projectRoot, file, `export function BudgetEvidence${index}(): number { return ${index}; }\n`);
    }
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        `const files = ${JSON.stringify(files)};`,
        'const nodes = files.map((file, index) => ({',
        '  id: `function:${file}:BudgetEvidence${index}`,',
        '  kind: "function",',
        '  name: `BudgetEvidence${index}`,',
        '  qualifiedName: `BudgetEvidence${index}`,',
        '  filePath: file,',
        '  language: "typescript",',
        '  startLine: 1,',
        '  endLine: 1',
        '}));',
        'process.stdout.write(JSON.stringify({',
        '  query: "BudgetEvidence",',
        '  matches: nodes.map(node => ({ kind: node.kind, name: node.name, file: node.filePath })),',
        '  nodes,',
        '  edges: [{ source: nodes[0].id, target: nodes[1].id, kind: "calls" }],',
        '  relationshipGroups: { calls: [{ source: nodes[0].id, target: nodes[1].id, kind: "calls" }] },',
        '  relatedFiles: files,',
        '  coverage: { graphNodes: 2, graphEdges: 1 }',
        '}));',
        '',
      ].join('\n'),
    );
    const fakeCodegraph = makeFakeCodegraph();
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', projectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '5000',
        },
      },
    );

    try {
      const responsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 53,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'BudgetEvidence', maxFiles: 1, overlayLimit: 1 },
        },
      })}\n`);
      const response = await responsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = response.result.content[0].text;
      expect(response.result.isError).toBe(false);
      expect([...text.matchAll(/^####\s+(.+)$/gm)]).toHaveLength(1);
      expect(text).toContain(files[0]);
      expect(text).not.toContain(files[1]);
    } finally {
      child.kill();
    }
  }, 12_000);
}
