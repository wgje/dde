import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpContextPackSpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    wrapperScriptPath,
    WRAPPER_REPO_OVERLAY_ENV,
    WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS,
    WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS,
    tempRoots,
    makeFakeCodegraph,
    parseJsonLines,
    readJsonLine,
  } = context;

  it('returns a combined NanoFlow context pack from base codegraph and overlay results', async () => {
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
      const responsePromise = readJsonLine(child, WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'ProjectShellComponent', overlayLimit: 1 },
        },
      })}\n`);
      const response = (await responsePromise) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const packText = response.result.content[0].text;

      expect(response.result.isError).toBe(false);
      expect(packText).toMatch(/(?:## Exploration: ProjectShellComponent|\*\*Exploration: ProjectShellComponent\*\*)/);
      expect(packText).toContain('base codegraph context');
      expect(packText).toContain('### Relationships');
      expect(packText).toContain('### Related Symbols');
      expect(packText).toContain('Use codegraph_node or targeted file reads only for files named in this context pack.');
      expect(packText.trim().startsWith('{')).toBe(false);
      expect(() => JSON.parse(packText)).toThrow();

      const logEntries = parseJsonLines(logPath);
      expect(logEntries).toContainEqual(expect.objectContaining({
        event: 'overlay.query.start',
        json: true,
        contextJson: true,
        outputMode: 'context-json',
      }));
      const overlayStartEntry = logEntries.find((entry) => entry.event === 'nanoflow.context.overlay.start');
      expect(overlayStartEntry).toEqual(expect.objectContaining({
        event: 'nanoflow.context.overlay.start',
        contextId: expect.any(String),
        baseElapsedMs: expect.any(Number),
        deadlineRemainingMs: expect.any(Number),
      }));
      const contextResponseEntry = logEntries.find((entry) => entry.event === 'nanoflow.context.response');
      expect(contextResponseEntry).toEqual(expect.objectContaining({
        outputMode: 'markdown',
        textStartsWithJson: false,
        contextId: overlayStartEntry?.contextId,
        baseElapsedMs: expect.any(Number),
        overlayElapsedMs: expect.any(Number),
        totalElapsedMs: expect.any(Number),
        overlayQueryId: expect.any(String),
        overlayMatchCount: expect.any(Number),
        overlayNodeCount: expect.any(Number),
        overlayEdgeCount: expect.any(Number),
        overlayRelationshipGroupCount: expect.any(Number),
      }));
    } finally {
      child.kill();
    }
  }, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS);

  it('logs base response warnings when CodeGraph returns an auto-sync disabled banner', async () => {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-warning-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph-warning.cjs');
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
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] } }));",
        "    return;",
        "  }",
        "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
        "    const warning = 'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen.\\nReason: CodeGraph file lock held by another process past the retry budget; auto-sync disabled.';",
        "    const sourceTail = 'source-code-tail-without-warning '.repeat(120);",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: warning + '\\n\\n## Exploration: ' + message.params.arguments.query + '\\nbase codegraph context\\n' + sourceTail }] } }));",
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
      const responsePromise = readJsonLine(child, WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 33,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'ProjectShellComponent', overlayLimit: 1 },
        },
      })}\n`);
      const response = (await responsePromise) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };

      expect(response.result.isError).toBe(false);
      expect(response.result.content[0].text).toContain('CodeGraph auto-sync is DISABLED');

      const logEntries = parseJsonLines(logPath);
      const contextResponseEntry = logEntries.find((entry) => entry.event === 'nanoflow.context.response');
      expect(contextResponseEntry).toEqual(expect.objectContaining({
        baseResponseWarnings: expect.objectContaining({
          codegraphAutoSyncDisabled: true,
          failureClass: 'codegraph-autosync-disabled',
          textTail: expect.stringContaining('index is frozen'),
        }),
        responseWarnings: expect.objectContaining({
          codegraphAutoSyncDisabled: true,
          failureClass: 'codegraph-autosync-disabled',
        }),
      }));
    } finally {
      child.kill();
    }
  }, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS);
}
