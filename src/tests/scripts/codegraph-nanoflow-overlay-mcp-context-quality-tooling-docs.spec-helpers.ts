import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import {
  callContextPack,
  extractContextSourceHeaders,
  writeOverlayResponseScript,
} from './codegraph-nanoflow-overlay-mcp-context-quality.helpers';
import { writeFakeCodegraphExploreScript } from './codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpContextQualityToolingDocsSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    readJsonLine,
  } = context;

  it('demotes docs/context7 source blocks for implementation-focused Supabase function queries', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-docs-context7-pollution-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'docs/context7/03-api-reference/edge-functions.md',
      [
        '---',
        'title: Edge Functions API Reference',
        '---',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'docs/context7/api-edge-functions.md',
      [
        '---',
        'title: API and Edge Functions',
        '---',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'supabase/functions/transcribe/index.ts',
      [
        'Deno.serve(async (req) => {',
        "  const { text } = await req.json();",
        "  return Response.json({ transcript: text });",
        '});',
        '',
      ].join('\n'),
    );

    writeOverlayResponseScript(projectRoot, {
      query: 'supabase functions transcribe edge-function-invoke route-reference source ordering',
      matches: [
        {
          kind: 'file',
          name: 'Edge Functions API Reference',
          file: 'docs/context7/03-api-reference/edge-functions.md',
          score: 900,
        },
        {
          kind: 'function',
          name: 'transcribe',
          file: 'supabase/functions/transcribe/index.ts',
          score: 500,
        },
        {
          kind: 'file',
          name: 'API and Edge Functions',
          file: 'docs/context7/api-edge-functions.md',
          score: 450,
        },
      ],
      nodes: [
        {
          id: 'file:docs/context7/03-api-reference/edge-functions.md',
          kind: 'file',
          name: 'Edge Functions API Reference',
          qualifiedName: 'docs/context7/03-api-reference/edge-functions.md',
          filePath: 'docs/context7/03-api-reference/edge-functions.md',
          language: 'markdown',
          startLine: 2,
          endLine: 2,
        },
        {
          id: 'function:supabase/functions/transcribe/index.ts:transcribe',
          kind: 'function',
          name: 'transcribe',
          qualifiedName: 'transcribe',
          filePath: 'supabase/functions/transcribe/index.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 4,
        },
        {
          id: 'file:docs/context7/api-edge-functions.md',
          kind: 'file',
          name: 'API and Edge Functions',
          qualifiedName: 'docs/context7/api-edge-functions.md',
          filePath: 'docs/context7/api-edge-functions.md',
          language: 'markdown',
          startLine: 2,
          endLine: 2,
        },
      ],
      relationshipGroups: {},
      coverage: { context7Docs: 2, edgeFunctions: 1, graphNodes: 3, graphEdges: 0 },
    });

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-docs-context7-pollution-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      sourceBlocks: [
        {
          header: 'docs/context7/03-api-reference/edge-functions.md',
          language: 'unknown',
          lines: ['2\ttitle: Edge Functions API Reference'],
        },
        {
          header: 'supabase/functions/transcribe/index.ts — transcribe(function)',
          language: 'typescript',
          lines: [
            '1\tDeno.serve(async (req) => {',
            '2\t  const { text } = await req.json();',
            '3\t  return Response.json({ transcript: text });',
            '4\t});',
          ],
        },
        {
          header: 'docs/context7/api-edge-functions.md',
          language: 'unknown',
          lines: ['2\ttitle: API and Edge Functions'],
        },
      ],
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph,
      readJsonLine,
      query: 'supabase functions transcribe edge-function-invoke route-reference source ordering',
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(sourceHeaders[0]).toContain('supabase/functions/transcribe/index.ts');
    expect(sourceHeaders[0]).not.toContain('docs/context7');
    expect(text).toContain('Deno.serve(async (req) => {');
  }, 12_000);
}
