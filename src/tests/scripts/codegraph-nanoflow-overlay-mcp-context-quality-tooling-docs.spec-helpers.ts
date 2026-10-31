import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import {
  callContextPack,
  extractContextSourceHeaders,
  writeOverlayResponseScript,
  writeQueryAwareOverlayResponseScript,
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

  it('focuses Context7 retrieval source-map maintenance queries on route documentation', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context7-maintenance-focus-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'docs/context7/catalog.json',
      JSON.stringify({ retrieval: [{ query: 'sync', primary: 'docs/context7/contracts/sync-contract.md' }] }, null, 2),
    );
    writeFile(
      projectRoot,
      'docs/context7/source-map.md',
      [
        '| Question | Doc | Source |',
        '| --- | --- | --- |',
        '| How does sync work? | docs/context7/contracts/sync-contract.md | src/config/sync.config.ts |',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/utils/result.ts',
      [
        'export function map(value) {',
        '  return value;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt',
      [
        'enum class NanoFlowEntrySource {',
        '  ROUTE,',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/app/core/external-sources/external-source.model.ts',
      [
        "export type ExternalSourceRole = 'context' | 'reference';",
        'export interface ExternalSourceLink { role?: ExternalSourceRole; }',
        '',
      ].join('\n'),
    );

    const noisyQuery = 'NanoFlow CodeGraph context7 retrieval source map docs route standard current adaptation quality';
    const focusedQuery = [
      'docs/context7/catalog.json',
      'docs/context7/source-map.md',
      'context7-retrieval-route',
      'context7-source-map-route',
      'context7-retrieval-primary',
      'context7-source-map-source',
    ].join(' ');
    const noisyResponse = {
      query: noisyQuery,
      matches: [
        { kind: 'function', name: 'map', file: 'src/utils/result.ts' },
        { kind: 'enum', name: 'NanoFlowEntrySource', file: 'android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt' },
      ],
      nodes: [
        {
          id: 'function:src/utils/result.ts:map',
          kind: 'function',
          name: 'map',
          qualifiedName: 'map',
          filePath: 'src/utils/result.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'enum:android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt:NanoFlowEntrySource',
          kind: 'enum',
          name: 'NanoFlowEntrySource',
          qualifiedName: 'NanoFlowEntrySource',
          filePath: 'android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt',
          language: 'kotlin',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 2, graphEdges: 0 },
    };
    const focusedResponse = {
      query: focusedQuery,
      matches: [
        { kind: 'file', name: 'catalog.json', file: 'docs/context7/catalog.json' },
        { kind: 'file', name: 'source-map.md', file: 'docs/context7/source-map.md' },
      ],
      nodes: [
        {
          id: 'file:docs/context7/catalog.json',
          kind: 'file',
          name: 'catalog.json',
          qualifiedName: 'docs/context7/catalog.json',
          filePath: 'docs/context7/catalog.json',
          language: 'json',
          startLine: 1,
          endLine: 7,
        },
        {
          id: 'file:docs/context7/source-map.md',
          kind: 'file',
          name: 'source-map.md',
          qualifiedName: 'docs/context7/source-map.md',
          filePath: 'docs/context7/source-map.md',
          language: 'markdown',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {
        references: [
          { source: 'sync', target: 'sync-contract.md', relation: 'context7-retrieval-primary' },
          { source: 'How does sync work?', target: 'src/config/sync.config.ts', relation: 'context7-source-map-source' },
        ],
      },
      coverage: { context7Docs: 2, context7RetrievalRoutes: 1, context7SourceMapRoutes: 1, graphNodes: 2, graphEdges: 2 },
    };
    writeQueryAwareOverlayResponseScript(projectRoot, focusedQuery, focusedResponse, noisyResponse);

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context7-maintenance-focus-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      focusedQuery,
      focused: {
        includeMaxFiles: true,
        preludeLines: [
          'Found 2 symbols across 1 file.',
          '',
          '**Blast radius — what depends on these (update/verify before editing)**',
          '',
          '- `ExternalSourceLink` (src/app/core/external-sources/external-source.model.ts:2) — 1 caller',
          '',
          '**Relationships**',
          '',
          '**references:**',
          '- ExternalSourceLink → ExternalSourceRole',
        ],
        sourceBlocks: [
          {
            header: 'src/app/core/external-sources/external-source.model.ts — ExternalSourceLink(interface), ExternalSourceRole(type_alias)',
            language: 'typescript',
            lines: [
              "1\texport type ExternalSourceRole = 'context' | 'reference';",
              '2\texport interface ExternalSourceLink { role?: ExternalSourceRole; }',
            ],
          },
        ],
      },
      fallback: {
        includeMaxFiles: true,
        sourceBlocks: [
          {
            header: 'src/utils/result.ts — map(function)',
            language: 'typescript',
            lines: ['1\texport function map(value) {', '2\t  return value;', '3\t}'],
          },
          {
            header: 'android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt — NanoFlowEntrySource(enum)',
            language: 'kotlin',
            lines: ['1\tenum class NanoFlowEntrySource {', '2\t  ROUTE,', '3\t}'],
          },
        ],
      },
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph,
      readJsonLine,
      query: noisyQuery,
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(text).toContain(`baseQuery=${focusedQuery}`);
    expect(sourceHeaders[0]).toContain('docs/context7/source-map.md');
    expect(text).toContain('context7-retrieval-primary');
    expect(text).toContain('context7-source-map-source');
    expect(text).not.toContain('src/utils/result.ts');
    expect(text).not.toContain('NanoflowBootstrapContract.kt');
    expect(text).not.toContain('external-source.model.ts');
    expect(text).not.toContain('ExternalSourceLink');
  }, 12_000);
}
