import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function writeOverlayResponseScript(projectRoot: string, response: unknown): void {
  const scriptPath = path.join(projectRoot, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env node',
      `process.stdout.write(${JSON.stringify(JSON.stringify(response))});`,
      '',
    ].join('\n'),
  );
}

export function writeQueryAwareOverlayResponseScript(
  projectRoot: string,
  focusedQuery: string,
  focusedResponse: unknown,
  fallbackResponse: unknown,
): void {
  const scriptPath = path.join(projectRoot, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env node',
      "const queryIndex = process.argv.indexOf('--query');",
      "const query = queryIndex >= 0 ? process.argv[queryIndex + 1] : '';",
      `const focusedQuery = ${JSON.stringify(focusedQuery)};`,
      `const focusedResponse = ${JSON.stringify(focusedResponse)};`,
      `const fallbackResponse = ${JSON.stringify(fallbackResponse)};`,
      'process.stdout.write(JSON.stringify(query === focusedQuery ? focusedResponse : fallbackResponse));',
      '',
    ].join('\n'),
  );
}

export async function callContextPack(options: {
  repoRoot: string;
  wrapperScriptPath: string;
  projectRoot: string;
  fakeCodegraph: string;
  query: string;
  readJsonLine: CodegraphOverlaySpecContext['readJsonLine'];
}): Promise<string> {
  const child = spawn(
    process.execPath,
    [options.wrapperScriptPath, options.fakeCodegraph, 'serve', '--mcp', '--path', options.projectRoot],
    {
      cwd: options.repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '5000',
        NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '5000',
      },
    },
  );

  try {
    const contextResponsePromise = options.readJsonLine(child, 8_000);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 43,
      method: 'tools/call',
      params: {
        name: 'nanoflow_context_pack',
        arguments: {
          query: options.query,
          overlayLimit: 20,
        },
      },
    })}\n`);

    const response = await contextResponsePromise as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(response.result.isError).toBe(false);
    return response.result.content[0].text;
  } finally {
    child.kill();
  }
}

export function extractContextSourceHeaders(text: string): string[] {
  return [...text.matchAll(/^####\s+(.+)$/gm)].map((match) => match[1]);
}
