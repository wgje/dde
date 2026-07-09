import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayModuleRelationSpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, queryOverlay, expectSpawnSuccess } = context;

  it('selects graph nodes by exact edge relation queries', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'type-literal-member', ['--limit', '40']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_alias',
        name: 'SampleTypeLiteral',
      }),
      expect.objectContaining({
        kind: 'property',
        name: 'id',
        qualifiedName: 'SampleTypeLiteral::id',
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'resolve',
        qualifiedName: 'SampleTypeLiteral::resolve',
      }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'SampleTypeLiteral',
        targetName: 'id',
        metadata: expect.objectContaining({ relation: 'type-literal-member' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'SampleTypeLiteral',
        targetName: 'resolve',
        metadata: expect.objectContaining({ relation: 'type-literal-member' }),
      }),
    ]));
    expect(response.markdown).toContain('type-literal-member');
  });

  it('extracts TypeScript tuple contract string literal names as native type alias methods', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'SampleServiceList query_sample_record apply_confirm status internal', ['--limit', '120']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_alias',
        name: 'SampleServiceList',
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'query_sample_record',
        qualifiedName: 'SampleServiceList::query_sample_record',
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'apply_confirm',
        qualifiedName: 'SampleServiceList::apply_confirm',
      }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'method', name: 'status' }),
      expect.objectContaining({ kind: 'method', name: '/internal/path' }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'SampleServiceList',
        targetName: 'query_sample_record',
        metadata: expect.objectContaining({ relation: 'type-literal-member' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'SampleServiceList',
        targetName: 'apply_confirm',
        metadata: expect.objectContaining({ relation: 'type-literal-member' }),
      }),
    ]));
    expect(response.markdown).toContain('query_sample_record');
  });

  it('indexes TypeScript .mts and .cts module files with native TypeScript language metadata', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'loadMtsModule loadCtsModule sample-module.mts sample-common.cts', ['--limit', '80']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'export',
        name: 'loadMtsModule',
        filePath: 'src/app/features/sample/sample-module.mts',
        language: 'typescript',
      }),
      expect.objectContaining({
        kind: 'export',
        name: 'loadCtsModule',
        filePath: 'src/app/features/sample/sample-common.cts',
        language: 'typescript',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'loadMtsModule',
        filePath: 'src/app/features/sample/sample-module.mts',
        language: 'typescript',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'loadCtsModule',
        filePath: 'src/app/features/sample/sample-common.cts',
        language: 'typescript',
      }),
    ]));
  });

  it('indexes TypeScript declaration files as native graph symbols', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'AmbientPort createAmbientPort sample-contract.d.ts', ['--limit', '80']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'interface',
        name: 'AmbientPort',
        filePath: 'src/app/features/sample/sample-contract.d.ts',
        language: 'typescript',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'createAmbientPort',
        filePath: 'src/app/features/sample/sample-contract.d.ts',
        language: 'typescript',
      }),
      expect.objectContaining({
        kind: 'export',
        name: 'AmbientPort',
        filePath: 'src/app/features/sample/sample-contract.d.ts',
        language: 'typescript',
      }),
    ]));
    expect(response.relationshipGroups.returns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'createAmbientPort',
        target: 'AmbientPort',
        relation: 'return-type',
      }),
    ]));
  });

  it('indexes JavaScript-family module files with native language metadata', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'loadPlainJs DefaultEntity loadCommonJs SampleJsxView sample-view-jsx', ['--limit', '120']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'function',
        name: 'loadPlainJs',
        filePath: 'src/app/features/sample/sample-plain.js',
        language: 'javascript',
      }),
      expect.objectContaining({
        kind: 'class',
        name: 'DefaultEntity',
        filePath: 'src/app/features/sample/sample-js-target.mjs',
        language: 'javascript',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'loadCommonJs',
        filePath: 'src/app/features/sample/sample-commonjs.cjs',
        language: 'javascript',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'SampleJsxView',
        filePath: 'src/app/features/sample/sample-view-jsx.jsx',
        language: 'jsx',
      }),
    ]));
    expect(response.relationshipGroups.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'SampleJsxView',
        target: 'LazyPanelComponent',
        relation: 'jsx-component',
      }),
    ]));
  });

  it('keeps exact relation-only queries focused on matching relationship edges', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'local-declaration', ['--limit', '40']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges.length).toBeGreaterThan(0);
    expect(response.displayEdges.every((edge: { metadata?: { relation?: string } }) => (
      edge.metadata?.relation === 'local-declaration'
    ))).toBe(true);
    expect(response.relationshipGroups).toEqual({
      contains: expect.arrayContaining([
        expect.objectContaining({
          source: 'createSample',
          target: 'LocalSampleFactory',
          relation: 'local-declaration',
        }),
      ]),
    });
    expect(response.markdown).toContain('## Exploration: local-declaration');
    expect(response.markdown).toContain('**contains:**');
    expect(response.markdown).toContain('LocalSampleFactory');
  });

  it('keeps CommonJS export relation queries focused on matching export edges', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'commonjs-export', ['--limit', '40']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges.length).toBeGreaterThan(0);
    expect(response.displayEdges.every((edge: { metadata?: { relation?: string } }) => (
      edge.metadata?.relation === 'commonjs-export'
    ))).toBe(true);
    expect(response.relationshipGroups).toEqual({
      exports: expect.arrayContaining([
        expect.objectContaining({
          source: 'loadCommonJs',
          target: 'src/app/features/sample/sample-commonjs.cjs',
          relation: 'commonjs-export',
          exportName: 'loadCommonJs',
        }),
        expect.objectContaining({
          source: 'hydrate',
          target: 'src/app/features/sample/sample-commonjs.cjs',
          relation: 'commonjs-export',
          exportName: 'hydrate',
        }),
      ]),
    });
    expect(response.markdown).toContain('## Exploration: commonjs-export');
    expect(response.markdown).toContain('**exports:**');
    expect(response.markdown).toContain('commonjs-export');
  });

  it('keeps exact synthesized metadata queries focused on matching relationship edges', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'interface-impl', ['--limit', '40']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges.length).toBeGreaterThan(0);
    expect(response.displayEdges.every((edge: { metadata?: { synthesizedBy?: string } }) => (
      edge.metadata?.synthesizedBy === 'interface-impl'
    ))).toBe(true);
    expect(response.relationshipGroups).toEqual({
      calls: expect.arrayContaining([
        expect.objectContaining({
          source: 'save',
          target: 'save',
          synthesizedBy: 'interface-impl',
          via: 'save',
        }),
      ]),
    });
    expect(response.markdown).toContain('## Exploration: interface-impl');
    expect(response.markdown).toContain('**calls:**');
    expect(response.markdown).toContain('synthesizedBy: interface-impl');
  });

  it('extracts local structural declarations inside function and method bodies', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'createSample LocalSampleFactory LocalSamplePort LocalSampleShape LocalSampleMode SaveScope', ['--limit', '120']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'function',
        name: 'createSample',
      }),
      expect.objectContaining({
        kind: 'class',
        name: 'LocalSampleFactory',
        qualifiedName: 'createSample::LocalSampleFactory',
      }),
      expect.objectContaining({
        kind: 'interface',
        name: 'LocalSamplePort',
        qualifiedName: 'createSample::LocalSamplePort',
      }),
      expect.objectContaining({
        kind: 'type_alias',
        name: 'LocalSampleShape',
        qualifiedName: 'createSample::LocalSampleShape',
      }),
      expect.objectContaining({
        kind: 'enum',
        name: 'LocalSampleMode',
        qualifiedName: 'createSample::LocalSampleMode',
      }),
      expect.objectContaining({
        kind: 'class',
        name: 'SaveScope',
        qualifiedName: 'SampleEntity::save::SaveScope',
      }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'createSample',
        targetName: 'LocalSampleFactory',
        metadata: expect.objectContaining({ relation: 'local-declaration' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'createSample',
        targetName: 'LocalSamplePort',
        metadata: expect.objectContaining({ relation: 'local-declaration' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'createSample',
        targetName: 'LocalSampleShape',
        metadata: expect.objectContaining({ relation: 'local-declaration' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'createSample',
        targetName: 'LocalSampleMode',
        metadata: expect.objectContaining({ relation: 'local-declaration' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'save',
        targetName: 'SaveScope',
        metadata: expect.objectContaining({ relation: 'local-declaration' }),
      }),
      expect.objectContaining({
        kind: 'implements',
        sourceName: 'LocalSampleFactory',
        targetName: 'LocalSamplePort',
      }),
      expect.objectContaining({
        kind: 'instantiates',
        sourceName: 'createSample',
        targetName: 'LocalSampleFactory',
      }),
    ]));
    expect(response.markdown).toContain('LocalSampleFactory');
    expect(response.markdown).toContain('SaveScope');
  });

  it('matches native overlay symbols with tokenized multi-term queries', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'SampleList type_alias SAMPLE_LIMIT constant', ['--limit', '100']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_alias',
        name: 'SampleList',
      }),
      expect.objectContaining({
        kind: 'constant',
        name: 'SAMPLE_LIMIT',
      }),
    ]));
    expect(response.markdown).toContain('SampleList');
    expect(response.markdown).toContain('SAMPLE_LIMIT');
  });

  it('preserves type-only import and export semantics in native TypeScript edges', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'acceptTypeOnly');

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'acceptTypeOnly',
        targetName: 'TypeOnlyPort',
        target: 'interface:src/app/features/sample/type-only.ts:TypeOnlyPort',
      }),
      expect.objectContaining({
        kind: 'imports',
        metadata: expect.objectContaining({
          relation: 'import',
          isTypeOnly: true,
        }),
      }),
      expect.objectContaining({
        kind: 'exports',
        metadata: expect.objectContaining({
          relation: 're-export',
          exportName: 'PublicTypeOnlyPort',
          isTypeOnly: true,
        }),
      }),
    ]));
  });

  it('resolves import-equals require aliases through export-assignment targets', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'createLegacy');

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'instantiates',
        sourceName: 'createLegacy',
        targetName: 'LegacyExport',
        target: 'class:src/app/features/sample/legacy-export.ts:LegacyExport',
      }),
      expect.objectContaining({
        kind: 'exports',
        sourceName: 'LegacyExport',
        metadata: expect.objectContaining({
          relation: 'export-equals',
          exportName: 'export=',
        }),
      }),
    ]));
  });
}
