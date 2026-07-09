import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

function assertOrderedSubset(actualKeys: string[], expectedOrder: string[]): void {
  expect(actualKeys).toEqual(expectedOrder.filter(key => actualKeys.includes(key)));
}

export function registerCodegraphOverlayQueryStrictNativeSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { makeFixture, writeFile, queryOverlay, expectSpawnSuccess } = context;

  it('projects strict native JSON with official field order and without NanoFlow extension fields', () => {
    const root = makeFixture();
    const result = queryOverlay(root, 'SampleService', ['--native-json', '--limit', '8']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(Object.keys(response)).toEqual([
      'query',
      'summary',
      'entryPoints',
      'nodes',
      'edges',
      'codeBlocks',
      'relatedFiles',
      'stats',
    ]);
    expect(Object.keys(response.stats)).toEqual([
      'nodeCount',
      'edgeCount',
      'fileCount',
      'codeBlockCount',
      'totalCodeSize',
    ]);

    const node = response.nodes.find((candidate: { name?: string }) => candidate.name === 'SampleService')
      ?? response.nodes[0];
    assertOrderedSubset(Object.keys(node), [
      'id',
      'kind',
      'name',
      'qualifiedName',
      'filePath',
      'language',
      'startLine',
      'endLine',
      'signature',
      'visibility',
      'isExported',
      'isAsync',
      'isStatic',
      'isAbstract',
    ]);
    assertOrderedSubset(Object.keys(response.entryPoints[0]), [
      'id',
      'kind',
      'name',
      'qualifiedName',
      'filePath',
      'language',
      'startLine',
      'endLine',
      'signature',
      'visibility',
      'isExported',
      'isAsync',
      'isStatic',
      'isAbstract',
    ]);
    expect(node).not.toHaveProperty('metadata');
    expect(node).not.toHaveProperty('provenance');

    const edge = response.edges.find((candidate: { line?: number; column?: number }) => (
      typeof candidate.line === 'number' && typeof candidate.column === 'number'
    )) ?? response.edges[0];
    assertOrderedSubset(Object.keys(edge), ['source', 'target', 'kind', 'line', 'column']);
    expect(edge).not.toHaveProperty('metadata');
    expect(edge).not.toHaveProperty('provenance');
    expect(edge).not.toHaveProperty('sourceName');
    expect(edge).not.toHaveProperty('targetName');

    const codeBlock = response.codeBlocks[0];
    assertOrderedSubset(Object.keys(codeBlock), [
      'filePath',
      'startLine',
      'endLine',
      'language',
      'content',
      'nodeName',
      'nodeKind',
    ]);
    expect(codeBlock).not.toHaveProperty('metadata');
  });

  it('keeps explicit TypeScript path native JSON scoped despite cross-file type edges', () => {
    const root = makeFixture();
    const targetPath = 'src/app/core/services/sync/realtime-polling.service.ts';
    const noisyPath = 'src/services/default-client-policy.service.ts';
    writeFile(
      root,
      targetPath,
      [
        'export class RealtimePollingService {',
        '  cleanup(): void {',
        '    this.client.removeChannel(this.channel);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      noisyPath,
      [
        'export class DefaultClientPolicyService {}',
        '',
      ].join('\n'),
    );
    const overlay = {
      typescript: {
        files: [{ file: targetPath }, { file: noisyPath }],
        classes: [],
        functions: [],
        interfaces: [],
        types: [],
        variables: [],
        enums: [],
        namespaces: [],
        imports: [],
        exports: [],
      },
      angular: {
        components: [],
        directives: [],
        pipes: [],
        injectables: [],
        injectors: [],
        dynamicImports: [],
        routes: [],
      },
      supabase: {
        edgeFunctions: [],
        migrations: [],
      },
      agentRules: {
        hardRules: [],
        syncRules: [],
      },
      graph: {
        nodes: [
          {
            id: `file:${targetPath}:${targetPath}`,
            kind: 'file',
            name: targetPath,
            qualifiedName: targetPath,
            filePath: targetPath,
            language: 'typescript',
            startLine: 1,
            endLine: 1,
          },
          {
            id: `class:${targetPath}:RealtimePollingService`,
            kind: 'class',
            name: 'RealtimePollingService',
            qualifiedName: 'RealtimePollingService',
            filePath: targetPath,
            language: 'typescript',
            startLine: 1,
            endLine: 5,
            signature: 'class RealtimePollingService',
          },
          {
            id: `method:${targetPath}:RealtimePollingService.cleanup`,
            kind: 'method',
            name: 'cleanup',
            qualifiedName: 'RealtimePollingService::cleanup',
            filePath: targetPath,
            language: 'typescript',
            startLine: 2,
            endLine: 4,
            signature: '(): void',
          },
          {
            id: `class:${noisyPath}:DefaultClientPolicyService`,
            kind: 'class',
            name: 'DefaultClientPolicyService',
            qualifiedName: 'DefaultClientPolicyService',
            filePath: noisyPath,
            language: 'typescript',
            startLine: 1,
            endLine: 1,
            signature: 'class DefaultClientPolicyService',
          },
        ],
        edges: [
          {
            source: `file:${targetPath}:${targetPath}`,
            target: `class:${targetPath}:RealtimePollingService`,
            kind: 'contains',
          },
          {
            source: `class:${targetPath}:RealtimePollingService`,
            target: `method:${targetPath}:RealtimePollingService.cleanup`,
            kind: 'contains',
          },
          {
            source: `method:${targetPath}:RealtimePollingService.cleanup`,
            target: `class:${noisyPath}:DefaultClientPolicyService`,
            kind: 'type_of',
            metadata: { relation: 'type-reference' },
          },
        ],
      },
    };
    writeFile(root, '.codegraph/explicit-path-scope-overlay.json', `${JSON.stringify(overlay, null, 2)}\n`);

    const result = queryOverlay(
      root,
      String.raw`src\app\core\services\sync\realtime-polling.service.ts:733 cleanup default client policy service`,
      ['--overlay', '.codegraph/explicit-path-scope-overlay.json', '--skip-refresh', '--native-json', '--limit', '8'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.entryPoints[0]).toEqual(expect.objectContaining({
      filePath: targetPath,
    }));
    expect(response.relatedFiles).toEqual([targetPath]);
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: noisyPath }),
    ]));
    expect(response.codeBlocks.map((block: { filePath: string }) => block.filePath)).not.toContain(noisyPath);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: targetPath,
      nodeKind: 'method',
      nodeName: 'cleanup',
    }));
    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: targetPath,
        nodeKind: 'file',
      }),
    ]));
    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: targetPath,
        nodeKind: 'class',
      }),
    ]));
  });
}
