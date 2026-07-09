import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpToolSpecs(context: CodegraphOverlaySpecContext): void {
  const { repoRoot, wrapperScriptPath, WRAPPER_REPO_OVERLAY_ENV, WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS, tempRoots, makeFakeCodegraph, readJsonLine, parseJsonLines } = context;
  it('adds a NanoFlow overlay MCP tool beside the base codegraph tools', async () => {
    const fakeCodegraph = makeFakeCodegraph();
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', repoRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...WRAPPER_REPO_OVERLAY_ENV,
        },
      },
    );

    try {
      const toolsResponsePromise = readJsonLine(child);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
      const toolsResponse = toolsResponsePromise as Promise<{
        result: { tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> };
      }>;

      const resolvedToolsResponse = await toolsResponse;
      expect(resolvedToolsResponse).toEqual(expect.objectContaining({
        result: expect.objectContaining({
          tools: expect.arrayContaining([
            expect.objectContaining({ name: 'codegraph_explore' }),
            expect.objectContaining({ name: 'nanoflow_overlay_query' }),
            expect.objectContaining({ name: 'nanoflow_context_pack' }),
          ]),
        }),
      }));
      const overlayTool = resolvedToolsResponse.result.tools.find(tool => tool.name === 'nanoflow_overlay_query');
      expect(overlayTool?.inputSchema?.properties).toEqual(expect.objectContaining({
        nativeJson: expect.objectContaining({ type: 'boolean' }),
        nativeMarkdown: expect.objectContaining({ type: 'boolean' }),
      }));

      const queryResponsePromise = readJsonLine(child, WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'nanoflow_overlay_query',
          arguments: { query: 'ProjectShellComponent', limit: 1 },
        },
      })}\n`);

      const queryResponse = await queryResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const overlayText = queryResponse.result.content[0].text;

      expect(queryResponse.result.isError).toBe(false);
      expect(overlayText.trim().startsWith('{')).toBe(false);
      expect(overlayText).toContain('## Exploration: ProjectShellComponent');
      expect(overlayText).toContain('### Related Symbols');
      expect(overlayText).toContain('### Source Code');
      expect(overlayText).toContain('ProjectShellComponent');

      const jsonQueryResponsePromise = readJsonLine(child, WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'nanoflow_overlay_query',
          arguments: { query: 'ProjectShellComponent', limit: 1, json: true },
        },
      })}\n`);

      const jsonQueryResponse = await jsonQueryResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const jsonOverlayText = jsonQueryResponse.result.content[0].text;
      const jsonOverlay = JSON.parse(jsonOverlayText);

      expect(jsonQueryResponse.result.isError).toBe(false);
      expect(jsonOverlayText.trim().startsWith('{')).toBe(true);
      expect(jsonOverlay.markdown).toContain('## Exploration: ProjectShellComponent');
      expect(jsonOverlay.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'ProjectShellComponent' }),
      ]));

      const nativeJsonQueryResponsePromise = readJsonLine(child, WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'nanoflow_overlay_query',
          arguments: { query: 'ProjectShellComponent', limit: 1, nativeJson: true },
        },
      })}\n`);

      const nativeJsonQueryResponse = await nativeJsonQueryResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const nativeJsonOverlayText = nativeJsonQueryResponse.result.content[0].text;
      const nativeJsonOverlay = JSON.parse(nativeJsonOverlayText);

      expect(nativeJsonQueryResponse.result.isError).toBe(false);
      expect(Object.keys(nativeJsonOverlay)).toEqual([
        'query',
        'summary',
        'entryPoints',
        'nodes',
        'edges',
        'codeBlocks',
        'relatedFiles',
        'stats',
      ]);
      expect(nativeJsonOverlay).not.toHaveProperty('markdown');
      expect(nativeJsonOverlay).not.toHaveProperty('displayEdges');
      expect(nativeJsonOverlay.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'ProjectShellComponent' }),
      ]));
      for (const node of nativeJsonOverlay.nodes as Array<Record<string, unknown>>) {
        expect(node).not.toHaveProperty('metadata');
      }

      const nativeMarkdownQueryResponsePromise = readJsonLine(child, WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'nanoflow_overlay_query',
          arguments: { query: 'ProjectShellComponent', limit: 1, nativeMarkdown: true },
        },
      })}\n`);

      const nativeMarkdownQueryResponse = await nativeMarkdownQueryResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const nativeMarkdownOverlayText = nativeMarkdownQueryResponse.result.content[0].text;

      expect(nativeMarkdownQueryResponse.result.isError).toBe(false);
      expect(nativeMarkdownOverlayText).toContain('## Code Context');
      expect(nativeMarkdownOverlayText).toContain('**Query:** ProjectShellComponent');
      expect(nativeMarkdownOverlayText).toContain('### Entry Points');
      expect(nativeMarkdownOverlayText).toContain('### Code');
      expect(nativeMarkdownOverlayText).not.toContain('## Exploration: ProjectShellComponent');
      expect(nativeMarkdownOverlayText).not.toContain('### Source Code');
      expect(nativeMarkdownOverlayText).not.toContain('### NanoFlow Coverage');
    } finally {
      child.kill();
    }
  }, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS);

  it('rejects ambiguous NanoFlow overlay MCP output modes before running the overlay query', async () => {
    const fakeProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-mcp-output-mode-'));
    tempRoots.push(fakeProjectRoot);
    const fakeCodegraph = makeFakeCodegraph();
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', fakeProjectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...WRAPPER_REPO_OVERLAY_ENV,
        },
      },
    );

    try {
      const nativeJsonConflictResponsePromise = readJsonLine(child);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'nanoflow_overlay_query',
          arguments: { query: 'ProjectShellComponent', nativeJson: true, nativeMarkdown: true },
        },
      })}\n`);

      const nativeJsonConflictResponse = await nativeJsonConflictResponsePromise as {
        error?: { code: number; message: string };
        result?: unknown;
      };
      expect(nativeJsonConflictResponse.result).toBeUndefined();
      expect(nativeJsonConflictResponse.error).toEqual(expect.objectContaining({
        code: -32602,
        message: expect.stringContaining('nativeMarkdown'),
      }));

      const jsonConflictResponsePromise = readJsonLine(child);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'nanoflow_overlay_query',
          arguments: { query: 'ProjectShellComponent', json: true, nativeMarkdown: true },
        },
      })}\n`);

      const jsonConflictResponse = await jsonConflictResponsePromise as {
        error?: { code: number; message: string };
        result?: unknown;
      };
      expect(jsonConflictResponse.result).toBeUndefined();
      expect(jsonConflictResponse.error).toEqual(expect.objectContaining({
        code: -32602,
        message: expect.stringContaining('nativeMarkdown'),
      }));
    } finally {
      child.kill();
    }
  }, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS);

  it('rejects non-boolean NanoFlow overlay MCP output flags before running the overlay query', async () => {
    const fakeProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-mcp-output-flag-'));
    tempRoots.push(fakeProjectRoot);
    const fakeCodegraph = makeFakeCodegraph();
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', fakeProjectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...WRAPPER_REPO_OVERLAY_ENV,
        },
      },
    );

    try {
      const jsonFlagResponsePromise = readJsonLine(child);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: {
          name: 'nanoflow_overlay_query',
          arguments: { query: 'ProjectShellComponent', json: 'true' },
        },
      })}\n`);

      const jsonFlagResponse = await jsonFlagResponsePromise as {
        error?: { code: number; message: string };
        result?: unknown;
      };
      expect(jsonFlagResponse.result).toBeUndefined();
      expect(jsonFlagResponse.error).toEqual(expect.objectContaining({
        code: -32602,
        message: expect.stringContaining('json'),
      }));

      const nativeMarkdownFlagResponsePromise = readJsonLine(child);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: {
          name: 'nanoflow_overlay_query',
          arguments: { query: 'ProjectShellComponent', nativeMarkdown: 'true' },
        },
      })}\n`);

      const nativeMarkdownFlagResponse = await nativeMarkdownFlagResponsePromise as {
        error?: { code: number; message: string };
        result?: unknown;
      };
      expect(nativeMarkdownFlagResponse.result).toBeUndefined();
      expect(nativeMarkdownFlagResponse.error).toEqual(expect.objectContaining({
        code: -32602,
        message: expect.stringContaining('nativeMarkdown'),
      }));
    } finally {
      child.kill();
    }
  }, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS);

  it('rejects NanoFlow overlay MCP limits outside the declared schema bounds before running the overlay query', async () => {
    const fakeProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-mcp-limit-'));
    tempRoots.push(fakeProjectRoot);
    const fakeCodegraph = makeFakeCodegraph();
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', fakeProjectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...WRAPPER_REPO_OVERLAY_ENV,
        },
      },
    );

    try {
      const highLimitResponsePromise = readJsonLine(child);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: {
          name: 'nanoflow_overlay_query',
          arguments: { query: 'ProjectShellComponent', limit: 101 },
        },
      })}\n`);

      const highLimitResponse = await highLimitResponsePromise as {
        error?: { code: number; message: string };
        result?: unknown;
      };
      expect(highLimitResponse.result).toBeUndefined();
      expect(highLimitResponse.error).toEqual(expect.objectContaining({
        code: -32602,
        message: expect.stringContaining('limit'),
      }));

      const invalidLimitTypeResponsePromise = readJsonLine(child);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: {
          name: 'nanoflow_overlay_query',
          arguments: { query: 'ProjectShellComponent', limit: '20' },
        },
      })}\n`);

      const invalidLimitTypeResponse = await invalidLimitTypeResponsePromise as {
        error?: { code: number; message: string };
        result?: unknown;
      };
      expect(invalidLimitTypeResponse.result).toBeUndefined();
      expect(invalidLimitTypeResponse.error).toEqual(expect.objectContaining({
        code: -32602,
        message: expect.stringContaining('limit'),
      }));
    } finally {
      child.kill();
    }
  }, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS);

  it('rejects NanoFlow context pack MCP limits outside the declared schema bounds before forwarding to CodeGraph', async () => {
    const fakeProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-mcp-context-limit-'));
    tempRoots.push(fakeProjectRoot);
    const fakeCodegraph = makeFakeCodegraph();
    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', fakeProjectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...WRAPPER_REPO_OVERLAY_ENV,
        },
      },
    );

    try {
      const highMaxFilesResponsePromise = readJsonLine(child);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 25,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'ProjectShellComponent', maxFiles: 21 },
        },
      })}\n`);

      const highMaxFilesResponse = await highMaxFilesResponsePromise as {
        error?: { code: number; message: string };
        result?: unknown;
      };
      expect(highMaxFilesResponse.result).toBeUndefined();
      expect(highMaxFilesResponse.error).toEqual(expect.objectContaining({
        code: -32602,
        message: expect.stringContaining('maxFiles'),
      }));

      const invalidOverlayLimitTypeResponsePromise = readJsonLine(child);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 26,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'ProjectShellComponent', overlayLimit: '20' },
        },
      })}\n`);

      const invalidOverlayLimitTypeResponse = await invalidOverlayLimitTypeResponsePromise as {
        error?: { code: number; message: string };
        result?: unknown;
      };
      expect(invalidOverlayLimitTypeResponse.result).toBeUndefined();
      expect(invalidOverlayLimitTypeResponse.error).toEqual(expect.objectContaining({
        code: -32602,
        message: expect.stringContaining('overlayLimit'),
      }));
    } finally {
      child.kill();
    }
  }, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS);

  it('answers MCP resource discovery without surfacing base CodeGraph method errors', async () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-resource-error-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph-resource-error.cjs');
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
        "  if (message.method === 'resources/list' || message.method === 'resources/templates/list') {",
        "    console.log(JSON.stringify({",
        "      jsonrpc: '2.0',",
        "      id: message.id,",
        "      error: { code: -32601, message: 'Method not found: ' + message.method },",
        "    }));",
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
      const resourcesResponsePromise = readJsonLine(child);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 71, method: 'resources/list' })}\n`);
      const resourcesResponse = await resourcesResponsePromise as {
        result?: { resources?: unknown[] };
        error?: unknown;
      };
      expect(resourcesResponse.error).toBeUndefined();
      expect(resourcesResponse.result?.resources).toEqual([]);

      const templatesResponsePromise = readJsonLine(child);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 72, method: 'resources/templates/list' })}\n`);
      const templatesResponse = await templatesResponsePromise as {
        result?: { resourceTemplates?: unknown[] };
        error?: unknown;
      };
      expect(templatesResponse.error).toBeUndefined();
      expect(templatesResponse.result?.resourceTemplates).toEqual([]);

      const toolsResponsePromise = readJsonLine(child);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 73, method: 'tools/list' })}\n`);
      const toolsResponse = await toolsResponsePromise as {
        result: { tools: Array<{ name: string }> };
      };
      expect(toolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'nanoflow_overlay_query' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));

      const logEntries = parseJsonLines(logPath);
      expect(logEntries).toContainEqual(expect.objectContaining({
        event: 'resources.list.empty',
        failureClass: 'success',
        requestKind: 'resources/list',
      }));
      expect(logEntries).toContainEqual(expect.objectContaining({
        event: 'resources.templates.list.empty',
        failureClass: 'success',
        requestKind: 'resources/templates/list',
      }));
      expect(logEntries).not.toContainEqual(expect.objectContaining({
        failureClass: 'child-error-response',
      }));
    } finally {
      child.kill();
    }
  }, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS);

  it('keeps a fresh wrapper process alive across context pack, AGENTS overlay query, and tools/list', async () => {
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

    try {
      const firstToolsResponsePromise = readJsonLine(child);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 81, method: 'tools/list' })}\n`);
      const firstToolsResponse = await firstToolsResponsePromise as {
        result: { tools: Array<{ name: string }> };
      };
      expect(firstToolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'nanoflow_overlay_query' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));

      const contextResponsePromise = readJsonLine(child, WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 82,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'ProjectShellComponent', overlayLimit: 1 },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const contextText = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      expect(contextText).toMatch(/(?:## Exploration: ProjectShellComponent|\*\*Exploration: ProjectShellComponent\*\*)/);
      expect(contextText).toContain('base codegraph context');

      const syncRuleResponsePromise = readJsonLine(child, WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 83,
        method: 'tools/call',
        params: {
          name: 'nanoflow_overlay_query',
          arguments: { query: 'sync-rule-keyword', limit: 40, json: true },
        },
      })}\n`);

      const syncRuleResponse = await syncRuleResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const syncRuleText = syncRuleResponse.result.content[0].text;
      const syncRuleOverlay = JSON.parse(syncRuleText) as {
        relatedFiles?: string[];
        matches?: Array<{ item?: {
          id?: string;
          name?: string;
          filePath?: string;
          startLine?: number;
          signature?: string;
          metadata?: { relation?: string; ownerHeading?: string; rule?: string };
        } }>;
      };
      const updatedAtKeyword = syncRuleOverlay.matches?.find(match => match.item?.name === 'updated_at')?.item;

      expect(syncRuleResponse.result.isError).toBe(false);
      expect(syncRuleText.trim().startsWith('{')).toBe(true);
      expect(syncRuleOverlay.relatedFiles).toEqual(['AGENTS.md']);
      expect(updatedAtKeyword).toEqual(expect.objectContaining({
        id: expect.stringContaining('variable:AGENTS.md:sync-rule-keyword:'),
        filePath: 'AGENTS.md',
        startLine: expect.any(Number),
        signature: 'sync-rule keyword updated_at',
        metadata: expect.objectContaining({
          relation: 'sync-rule-keyword',
          ownerHeading: '5.2 Offline-first 数据流',
          rule: '读路径',
        }),
      }));

      const secondToolsResponsePromise = readJsonLine(child);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 84, method: 'tools/list' })}\n`);
      const secondToolsResponse = await secondToolsResponsePromise as {
        result: { tools: Array<{ name: string }> };
      };
      expect(secondToolsResponse.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'nanoflow_overlay_query' }),
        expect.objectContaining({ name: 'nanoflow_context_pack' }),
      ]));

      const logEntries = parseJsonLines(logPath);
      const syncRuleStartEntry = logEntries.find(entry =>
        entry.event === 'overlay.query.start' && entry.query === 'sync-rule-keyword');
      expect(syncRuleStartEntry).toEqual(expect.objectContaining({
        outputMode: 'json',
        args: expect.arrayContaining(['--skip-refresh']),
      }));
      expect(logEntries).toContainEqual(expect.objectContaining({
        event: 'overlay.query.exit',
        query: 'sync-rule-keyword',
        status: 0,
        timedOut: false,
        profileMeta: expect.objectContaining({
          skipRefresh: true,
        }),
      }));
    } finally {
      child.kill();
    }
  }, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS);

}
