import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayTypeScriptCoreSpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, runOverlay, queryOverlay, expectSpawnSuccess, officialCodeGraphLanguages, officialCodeGraphNodeKinds } = context;

  it('uses only official CodeGraph Language enum values in graph nodes', () => {
    const root = makeFixture();

    const result = runOverlay(root);

    expectSpawnSuccess(result);
    const overlay = JSON.parse(result.stdout);
    const graphNodes = overlay.graph.nodes as Array<{ filePath: string; language: string }>;
    expect(graphNodes.every(node => officialCodeGraphLanguages.has(node.language))).toBe(true);
    expect(graphNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'file',
        filePath: 'AGENTS.md',
        language: 'unknown',
      }),
      expect.objectContaining({
        kind: 'file',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        language: 'unknown',
      }),
    ]));
  });

  it('uses only official CodeGraph NodeKind enum values in graph nodes', () => {
    const root = makeFixture();

    const result = runOverlay(root);

    expectSpawnSuccess(result);
    const overlay = JSON.parse(result.stdout);
    const graphNodes = overlay.graph.nodes as Array<{ kind: string }>;
    expect(graphNodes.length).toBeGreaterThan(0);
    expect(graphNodes.every(node => officialCodeGraphNodeKinds.has(node.kind))).toBe(true);
  });

  it('queries richer native TypeScript symbols and containment from overlay output', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'SampleStatus');

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'enum', name: 'SampleStatus' }),
      expect.objectContaining({ kind: 'enum_member', name: 'Ready' }),
      expect.objectContaining({ kind: 'property', name: 'status' }),
      expect.objectContaining({ kind: 'interface', name: 'SamplePort' }),
    ]));
    expect(response.relationshipGroups).toEqual(expect.objectContaining({
      contains: expect.arrayContaining([
        expect.objectContaining({ source: 'src/app/features/sample/sample-domain.ts', target: 'SampleStatus' }),
        expect.objectContaining({ source: 'SampleStatus', target: 'Ready' }),
      ]),
      type_of: expect.arrayContaining([
        expect.objectContaining({ source: 'status', target: 'SampleStatus' }),
      ]),
    }));
    expect(response.coverage.typescriptEnums).toBe(2);
    expect(response.coverage.typescriptFiles).toBeGreaterThan(0);
    expect(response.markdown).not.toContain('**contains:**');
    expect(response.markdown).toContain('SampleStatus');
  });

  it('resolves imported aliases and duplicate symbol names to the correct TypeScript node', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'createDuplicate');

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    const instantiates = response.displayEdges.filter((edge: { kind: string }) => edge.kind === 'instantiates');
    expect(instantiates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceName: 'createDuplicate',
        targetName: 'DuplicateName',
        target: 'class:src/app/features/sample/duplicate-b.ts:DuplicateName',
      }),
    ]));
    expect(instantiates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceName: 'createDuplicate',
        target: 'class:src/app/features/sample/duplicate-a.ts:DuplicateName',
      }),
    ]));
  });

  it('keeps re-export aliases in native TypeScript export edges', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'PublicSampleStatus');

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.relationshipGroups.exports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'SampleStatus',
        target: 'src/app/features/sample/sample-domain.ts',
        exportName: 'PublicSampleStatus',
        relation: 're-export',
      }),
    ]));
  });

  it('resolves default imports to the default-exported TypeScript node', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'createDefault');

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'instantiates',
        sourceName: 'createDefault',
        targetName: 'DefaultEntity',
        target: 'class:src/app/features/sample/default-export.ts:DefaultEntity',
      }),
    ]));
    expect(response.relationshipGroups.exports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'DefaultEntity',
        target: 'src/app/features/sample/default-export.ts',
        exportName: 'default',
      }),
    ]));
  }, 5_000);

  it('resolves namespace imports to their exported member symbols', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'SampleEntity');

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'instantiates',
        sourceName: 'SampleEntity',
        targetName: 'SampleRepository',
        target: 'class:src/app/features/sample/sample.repository.ts:SampleRepository',
      }),
    ]));
  });

  it('treats exported arrow and function-expression variables as TypeScript function nodes', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'createSampleArrow');

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'function',
        name: 'createSampleArrow',
      }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'calls',
        sourceName: 'createSampleArrow',
        targetName: 'createSample',
      }),
      expect.objectContaining({
        kind: 'returns',
        sourceName: 'createSampleArrow',
        targetName: 'SampleEntity',
      }),
      expect.objectContaining({
        kind: 'exports',
        sourceName: 'createSampleArrow',
        metadata: expect.objectContaining({
          exportName: 'createSampleArrow',
        }),
      }),
    ]));
  });

  it('indexes destructured const declarations as native TypeScript constant nodes', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'sampleReadyStatus');

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'constant',
        name: 'sampleReadyStatus',
      }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'exports',
        sourceName: 'sampleReadyStatus',
        metadata: expect.objectContaining({
          exportName: 'sampleReadyStatus',
        }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'sampleReadyStatus',
        targetName: 'SampleStatus',
      }),
    ]));
  });

  it('resolves qualified TypeScript names, class expressions, and field arrow methods with native-shaped edges', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'InlineEntity');

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'class',
        name: 'InlineEntity',
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'run',
        qualifiedName: 'InlineEntity::run',
      }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'extends',
        sourceName: 'InlineEntity',
        targetName: 'BaseEntity',
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'inlineStatus',
        targetName: 'SampleStatus',
      }),
      expect.objectContaining({
        kind: 'calls',
        sourceName: 'run',
        targetName: 'createSample',
      }),
    ]));
  });

  it('treats higher-order wrapped class-field arrow functions as native TypeScript methods', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'wrappedSave withBatch SampleEntity', ['--limit', '100']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'method',
        name: 'wrappedSave',
        qualifiedName: 'SampleEntity::wrappedSave',
        signature: expect.stringContaining('SampleEntity'),
      }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'property',
        name: 'wrappedSave',
      }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'SampleEntity',
        targetName: 'wrappedSave',
        metadata: expect.objectContaining({ relation: 'class-member' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        sourceName: 'wrappedSave',
        targetName: 'createSample',
      }),
      expect.objectContaining({
        kind: 'calls',
        sourceName: 'wrappedSave',
        targetName: 'withBatch',
      }),
      expect.objectContaining({
        kind: 'returns',
        sourceName: 'wrappedSave',
        targetName: 'SampleEntity',
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'value',
        targetName: 'SampleAlias',
        metadata: expect.objectContaining({ relation: 'parameter-type' }),
      }),
    ]));
  });

  it('extracts nested named functions in function bodies with native containment', () => {
    const root = makeFixture();    const result = queryOverlay(root, 'normalizeLabel normalizeLater normalizeWithFunction createSample SampleAlias', ['--limit', '120']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'function',
        name: 'normalizeLabel',
        qualifiedName: 'createSample::normalizeLabel',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'normalizeLater',
        qualifiedName: 'createSample::normalizeLater',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'normalizeWithFunction',
        qualifiedName: 'createSample::normalizeWithFunction',
      }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'constant',
        name: 'normalized',
      }),
      expect.objectContaining({
        kind: 'constant',
        name: 'normalizeLater',
      }),
      expect.objectContaining({
        kind: 'constant',
        name: 'normalizeWithFunction',
      }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'createSample',
        targetName: 'normalizeLabel',
        metadata: expect.objectContaining({ relation: 'nested-function' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'createSample',
        targetName: 'normalizeLater',
        metadata: expect.objectContaining({ relation: 'nested-function' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'createSample',
        targetName: 'normalizeWithFunction',
        metadata: expect.objectContaining({ relation: 'nested-function' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        sourceName: 'createSample',
        targetName: 'normalizeLabel',
      }),
      expect.objectContaining({
        kind: 'calls',
        sourceName: 'normalizeLater',
        targetName: 'normalizeLabel',
      }),
      expect.objectContaining({
        kind: 'calls',
        sourceName: 'normalizeWithFunction',
        targetName: 'normalizeLater',
      }),
      expect.objectContaining({
        kind: 'returns',
        sourceName: 'normalizeLabel',
        targetName: 'SampleAlias',
      }),
      expect.objectContaining({
        kind: 'returns',
        sourceName: 'normalizeLater',
        targetName: 'SampleAlias',
      }),
      expect.objectContaining({
        kind: 'returns',
        sourceName: 'normalizeWithFunction',
        targetName: 'SampleAlias',
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'createSample',
        targetName: 'SampleAlias',
        metadata: expect.objectContaining({ relation: 'local-variable-type' }),
      }),
    ]));
  });


}
