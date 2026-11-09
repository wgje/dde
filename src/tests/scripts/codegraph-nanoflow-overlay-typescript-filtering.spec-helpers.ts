import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayTypeScriptFilteringSpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, runOverlay, queryOverlay, expectSpawnSuccess, writeFile } = context;


  it('uses native CodeGraph node kind names for TypeScript aliases and constants', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'SampleList');

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_alias',
        name: 'SampleList',
      }),
      expect.objectContaining({
        kind: 'class',
        name: 'SampleEntity',
      }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type',
        name: 'SampleList',
      }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'SampleList',
        targetName: 'SampleEntity',
      }),
    ]));
  });

  it('filters TypeScript built-in utility types while preserving generic project references', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'SampleList SampleRecord SamplePromise SamplePartial SamplePick SampleAwaited loadSampleRecord SamplePartialPort SampleRecordPort sampleMathValue Math', ['--limit', '180']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    const builtinNames = [
      'ReadonlyArray',
      'Record',
      'Promise',
      'Partial',
      'Pick',
      'Awaited',
      'Math',
    ];

    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'type_alias', name: 'SampleList' }),
      expect.objectContaining({ kind: 'type_alias', name: 'SampleRecord' }),
      expect.objectContaining({ kind: 'type_alias', name: 'SamplePromise' }),
      expect.objectContaining({ kind: 'type_alias', name: 'SamplePartial' }),
      expect.objectContaining({ kind: 'type_alias', name: 'SamplePick' }),
      expect.objectContaining({ kind: 'type_alias', name: 'SampleAwaited' }),
      expect.objectContaining({ kind: 'interface', name: 'SamplePartialPort' }),
      expect.objectContaining({ kind: 'interface', name: 'SampleRecordPort' }),
      expect.objectContaining({ kind: 'function', name: 'loadSampleRecord' }),
      expect.objectContaining({ kind: 'constant', name: 'sampleMathValue' }),
      expect.objectContaining({ kind: 'class', name: 'SampleEntity' }),
      expect.objectContaining({ kind: 'type_alias', name: 'SampleAlias' }),
    ]));
    for (const builtinName of builtinNames) {
      expect(response.nodes).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: builtinName }),
      ]));
      expect(response.displayEdges).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'type_of', targetName: builtinName }),
      ]));
      expect(response.displayEdges).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'returns', targetName: builtinName }),
      ]));
      expect(response.displayEdges).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'extends', targetName: builtinName }),
      ]));
      expect(response.displayEdges).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'instantiates', targetName: builtinName }),
      ]));
      expect(response.displayEdges).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'references', targetName: builtinName }),
      ]));
    }
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'SampleList',
        targetName: 'SampleEntity',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'SampleRecord',
        targetName: 'SampleAlias',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'SampleRecord',
        targetName: 'SampleEntity',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'SamplePromise',
        targetName: 'SampleEntity',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'SamplePartial',
        targetName: 'SampleEntity',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'SamplePick',
        targetName: 'SampleEntity',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'SampleAwaited',
        targetName: 'SamplePromise',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'loadSampleRecord',
        targetName: 'SampleAlias',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'loadSampleRecord',
        targetName: 'SampleEntity',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'SamplePartialPort',
        targetName: 'SamplePort',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'SampleRecordPort',
        targetName: 'SampleEntity',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
    ]));
  });

  it('filters TypeScript standard library declaration names without dropping project generic arguments', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'readSampleFromStore IDBObjectStore IDBRequest NodeFilter SampleEntity', ['--limit', '120']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'function', name: 'readSampleFromStore' }),
      expect.objectContaining({ kind: 'class', name: 'SampleEntity' }),
    ]));
    for (const standardLibraryName of ['IDBObjectStore', 'IDBRequest', 'NodeFilter']) {
      expect(response.nodes).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: standardLibraryName }),
      ]));
      expect(response.displayEdges).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ targetName: standardLibraryName }),
      ]));
    }
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'returns',
        sourceName: 'readSampleFromStore',
        targetName: 'SampleEntity',
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'readSampleFromStore',
        targetName: 'SampleEntity',
      }),
    ]));
  });

  it('keeps TypeScript symbol resolution case-sensitive like native extraction', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'echoLowercaseNode', ['--limit', '80']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'function', name: 'echoLowercaseNode' }),
      expect.objectContaining({ kind: 'parameter', name: 'node' }),
      expect.objectContaining({ kind: 'class', name: 'SampleEntity' }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'returns',
        sourceName: 'echoLowercaseNode',
        targetName: 'SampleEntity',
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'node',
        targetName: 'SampleEntity',
      }),
    ]));
    expect(response.displayEdges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        sourceName: 'echoLowercaseNode',
        targetName: 'Node',
      }),
    ]));
  });

  it('does not resolve unqualified member calls to unrelated same-name symbols in other files', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'resolveScopedCalls importedHelper push some', ['--limit', '120']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    const sourceId = 'function:src/app/features/sample/call-consumer.ts:resolveScopedCalls';
    const importedTargetId = 'function:src/app/features/sample/call-targets.ts:importedHelper';
    const unrelatedPushTargetId = 'function:src/app/features/sample/call-targets.ts:push';
    const unrelatedSomeTargetId = 'function:src/app/features/sample/call-targets.ts:some';
    const unresolvedPushNodeId = 'variable:src/app/features/sample/call-consumer.ts:push';
    const unresolvedSomeNodeId = 'variable:src/app/features/sample/call-consumer.ts:some';
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'calls',
        source: sourceId,
        target: importedTargetId,
        metadata: expect.objectContaining({ relation: 'call' }),
      }),
    ]));
    expect(response.edges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'calls',
        source: sourceId,
        target: unrelatedPushTargetId,
      }),
      expect.objectContaining({
        kind: 'calls',
        source: sourceId,
        target: unrelatedSomeTargetId,
      }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: unresolvedPushNodeId,
      }),
      expect.objectContaining({
        id: unresolvedSomeNodeId,
      }),
    ]));
    expect(response.edges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'calls',
        source: sourceId,
        target: unresolvedPushNodeId,
      }),
      expect.objectContaining({
        kind: 'calls',
        source: sourceId,
        target: unresolvedSomeNodeId,
      }),
    ]));
  });

  it('does not resolve initializer references to unrelated same-name symbols in other files', () => {
    const root = makeFixture();
    writeFile(
      root,
      'src/app/features/sample/a-initializer-source.ts',
      [
        "export const sharedValue = 'source';",
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/features/sample/z-initializer-consumer.ts',
      [
        'export function useUnresolvedInitializer() {',
        '  return { sharedValue };',
        '}',
        '',
      ].join('\n'),
    );

    const result = runOverlay(root);

    expectSpawnSuccess(result);
    const overlay = JSON.parse(result.stdout);
    const sourceId = 'function:src/app/features/sample/z-initializer-consumer.ts:useUnresolvedInitializer';
    const unrelatedTargetId = 'constant:src/app/features/sample/a-initializer-source.ts:sharedValue';
    const scopedUnresolvedTargetId = 'variable:src/app/features/sample/z-initializer-consumer.ts:sharedValue';
    const initializerEdges = overlay.graph.edges.filter((edge: { metadata?: { relation?: string }; source?: string }) =>
      edge.source === sourceId && edge.metadata?.relation === 'initializer-reference',
    );

    expect(initializerEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: sourceId,
        target: scopedUnresolvedTargetId,
      }),
    ]));
    expect(initializerEdges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: unrelatedTargetId,
      }),
    ]));
    expect(overlay.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: scopedUnresolvedTargetId,
        kind: 'variable',
        name: 'sharedValue',
        filePath: 'src/app/features/sample/z-initializer-consumer.ts',
      }),
    ]));
  });

  it('resolves namespace member calls using receiver-qualified names like native CodeGraph', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'resolveScopedCalls namespacedHelper', ['--limit', '120']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'calls',
        source: 'function:src/app/features/sample/call-consumer.ts:resolveScopedCalls',
        target: 'function:src/app/features/sample/call-targets.ts:namespacedHelper',
        metadata: expect.objectContaining({ relation: 'call' }),
      }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'variable:src/app/features/sample/call-consumer.ts:namespacedHelper',
      }),
    ]));
  });
}
