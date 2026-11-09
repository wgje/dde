import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayContext7Specs(context: CodegraphOverlaySpecContext): void {
  const {
    makeFixture,
    writeFile,
    runOverlay,
    queryOverlay,
    expectSpawnSuccess,
    queryScriptPath,
    repoRoot,
  } = context;

  it('emits Context7 catalog and source-map semantics as native-shaped graph relations', () => {
    const root = makeFixture();
    writeFile(
      root,
      'docs/context7/source-map.md',
      [
        '# Source Map',
        '',
        '## Retrieval Routing',
        '',
        '| Question | Read this doc first | Then inspect these paths |',
        '| --- | --- | --- |',
        '| How does Supabase sync work? | [sync-contract.md](contracts/sync-contract.md), [sync-offline.md](sync-offline.md) | `src/app/core/services/sync/`, `src/config/sync.config.ts` |',
        '| How should an AI agent modify the repo? | [index.md](index.md) | `AGENTS.md`, `docs/context7/catalog.json` |',
        '',
      ].join('\n'),
    );

    const result = runOverlay(root);

    expectSpawnSuccess(result);
    const overlay = JSON.parse(result.stdout);
    expect(overlay.coverageTargets).toEqual(expect.arrayContaining([
      'Context7 canonical docs catalog, retrieval routes, and source-map ownership links',
    ]));
    expect(overlay.context7.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: 'docs/context7/contracts/sync-contract.md',
        title: 'Sync Contract',
        categories: expect.arrayContaining(['contracts']),
        routeQueries: expect.arrayContaining(['sync, offline, LWW, retry queue, tombstones']),
      }),
      expect.objectContaining({
        file: 'docs/context7/source-map.md',
        title: 'Source Map',
      }),
    ]));
    expect(overlay.context7.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'contracts',
        docs: ['docs/context7/contracts/sync-contract.md'],
      }),
    ]));
    expect(overlay.context7.retrievalRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        query: 'sync, offline, LWW, retry queue, tombstones',
        primary: 'docs/context7/contracts/sync-contract.md',
        secondary: expect.arrayContaining([
          'docs/context7/sync-offline.md',
          'docs/context7/source-map.md',
        ]),
      }),
    ]));
    expect(overlay.context7.sourceMapRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        question: 'How does Supabase sync work?',
        doc: 'docs/context7/contracts/sync-contract.md',
        docs: [
          'docs/context7/contracts/sync-contract.md',
          'docs/context7/sync-offline.md',
        ],
        sourcePaths: expect.arrayContaining([
          'src/app/core/services/sync/',
          'src/config/sync.config.ts',
        ]),
      }),
    ]));

    expect(overlay.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'file',
        name: 'Sync Contract',
        filePath: 'docs/context7/contracts/sync-contract.md',
        metadata: expect.objectContaining({ relation: 'context7-doc' }),
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'sync, offline, LWW, retry queue, tombstones',
        filePath: 'docs/context7/catalog.json',
        metadata: expect.objectContaining({ relation: 'context7-retrieval-route' }),
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'How does Supabase sync work?',
        filePath: 'docs/context7/source-map.md',
        metadata: expect.objectContaining({ relation: 'context7-source-map-route' }),
      }),
    ]));
    expect(overlay.graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'context7-retrieval-primary',
          docPath: 'docs/context7/contracts/sync-contract.md',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'context7-source-map-source',
          sourcePath: 'src/config/sync.config.ts',
        }),
      }),
    ]));
    const sourceMapDocEdges = overlay.graph.edges.filter((edge: {
      metadata?: { relation?: string; question?: string; docPath?: string };
    }) => (
      edge.metadata?.relation === 'context7-source-map-doc'
      && edge.metadata?.question === 'How does Supabase sync work?'
    ));
    expect(sourceMapDocEdges.map((edge: { metadata: { docPath: string } }) => edge.metadata.docPath))
      .toEqual([
        'docs/context7/contracts/sync-contract.md',
        'docs/context7/sync-offline.md',
      ]);
  });

  it('queries Context7 retrieval routes with native JSON and Markdown source evidence', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'sync offline LWW retry queue tombstones', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'file',
        name: 'Sync Contract',
        filePath: 'docs/context7/contracts/sync-contract.md',
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'sync, offline, LWW, retry queue, tombstones',
        filePath: 'docs/context7/catalog.json',
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({ relation: 'context7-retrieval-primary' }),
      }),
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({ relation: 'context7-retrieval-secondary' }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'sync, offline, LWW, retry queue, tombstones',
        target: 'Sync Contract',
        relation: 'context7-retrieval-primary',
      }),
    ]));
    expect(response.coverage).toEqual(expect.objectContaining({
      context7Docs: expect.any(Number),
      context7RetrievalRoutes: 2,
      context7SourceMapRoutes: 2,
    }));
    expect(response.markdown).toContain('### Source Code');
    expect(response.markdown).toContain('The sync contract covers LWW');

    const nativeJsonResult = queryOverlay(root, 'context7-retrieval-primary', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(nativeJsonResult);
    const nativeResponse = JSON.parse(nativeJsonResult.stdout);
    expect(Object.keys(nativeResponse)).toEqual([
      'query',
      'summary',
      'entryPoints',
      'nodes',
      'edges',
      'codeBlocks',
      'relatedFiles',
      'stats',
    ]);
    expect(nativeResponse.edges[0]).not.toHaveProperty('metadata');
    expect(nativeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'Sync Contract',
        filePath: 'docs/context7/contracts/sync-contract.md',
      }),
    ]));
    expect(nativeResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'docs/context7/contracts/sync-contract.md',
        nodeName: 'Sync Contract',
        content: expect.stringContaining('The sync contract covers LWW'),
      }),
    ]));
  });

  it('keeps the Context7 retrieval route and primary doc under candidate pressure', () => {
    const root = makeFixture();
    for (let index = 0; index < 24; index += 1) {
      writeFile(
        root,
        `supabase/migrations/20260714${String(index).padStart(2, '0')}_sync_offline_lww_retry_queue_tombstones_noise.sql`,
        `create table if not exists public.context7_retrieval_noise_${index} (id uuid primary key);\n`,
      );
    }

    const result = queryOverlay(root, 'sync offline LWW retry queue tombstones', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const primaryDoc = response.nodes.find((node: { name?: string }) => node.name === 'Sync Contract');
    const retrievalRoute = response.nodes.find((node: { metadata?: { relation?: string } }) => (
      node.metadata?.relation === 'context7-retrieval-route'
    ));
    expect(response.nodes).toHaveLength(20);
    expect(primaryDoc).toEqual(expect.objectContaining({
      filePath: 'docs/context7/contracts/sync-contract.md',
    }));
    expect(retrievalRoute).toEqual(expect.objectContaining({
      name: 'sync, offline, LWW, retry queue, tombstones',
    }));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: retrievalRoute.id,
        target: primaryDoc.id,
        metadata: expect.objectContaining({ relation: 'context7-retrieval-primary' }),
      }),
    ]));
    const nodeIds = new Set(response.nodes.map((node: { id: string }) => node.id));
    expect(response.edges.every((edge: { source: string; target: string }) => (
      nodeIds.has(edge.source) && nodeIds.has(edge.target)
    ))).toBe(true);
  });

  it('keeps an exact code symbol ahead of Context7 routing for a single-term query', () => {
    const root = makeFixture();
    writeFile(root, 'src/sync.ts', 'export function sync(): void {}\n');

    const result = queryOverlay(root, 'sync', ['--limit', '1', '--native-json']);

    expectSpawnSuccess(result);
    expect(JSON.parse(result.stdout).nodes).toEqual([
      expect.objectContaining({ kind: 'function', name: 'sync', filePath: 'src/sync.ts' }),
    ]);
  });

  it('reports Context7 relation edge counts in NanoFlow Coverage', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'context7-source-map-doc', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.coverage).toEqual(expect.objectContaining({
      context7CategoryDocEdges: expect.any(Number),
      context7RetrievalPrimaryEdges: 2,
      context7RetrievalSecondaryEdges: expect.any(Number),
      context7SourceMapDocEdges: 2,
      context7SourceMapSourceEdges: 4,
    }));
  });

  it('prints Context7 source-map relationships in strict native Markdown order', () => {
    const root = makeFixture();

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'context7-source-map-source',
      '--native-markdown',
      '--limit',
      '20',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(result);
    const output = result.stdout;
    const codeContextIndex = output.indexOf('## Code Context');
    const entryPointsIndex = output.indexOf('### Entry Points');
    const relatedSymbolsIndex = output.indexOf('### Related Symbols');
    const codeIndex = output.indexOf('### Code');

    expect(codeContextIndex).toBeGreaterThanOrEqual(0);
    expect(entryPointsIndex).toBeGreaterThan(codeContextIndex);
    expect(relatedSymbolsIndex).toBeGreaterThan(entryPointsIndex);
    expect(codeIndex).toBeGreaterThan(relatedSymbolsIndex);
    expect(output).toContain('How does Supabase sync work?');
    expect(output).toContain('src/config/sync.config.ts');
    expect(output).toContain('| How does Supabase sync work? |');
    const firstCodeBlockMatch = /### Code[\s\S]*?#### ([^\n]+)\n\n```markdown\n([\s\S]*?)\n```/.exec(output);
    expect(firstCodeBlockMatch?.[1]).toContain('context7-source-map-source');
    expect(firstCodeBlockMatch?.[2].trim()).toMatch(/^\| .+ \| .+ \| .+ \|$/);
    expect(output).not.toContain('#### src/app/core/services/sync/ (docs/context7/source-map.md:1)');
    expect(output).not.toContain('```markdown\n---\n```');
    expect(output).not.toContain('### NanoFlow Coverage');
  });
}
