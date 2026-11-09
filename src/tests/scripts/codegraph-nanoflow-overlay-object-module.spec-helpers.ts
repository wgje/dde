import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayObjectModuleSpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, queryOverlay, expectSpawnSuccess } = context;

  it('does not resolve lowercase Angular template names to differently-cased project symbols', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'SampleComponent', ['--limit', '120']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'component', name: 'SampleComponent' }),
      expect.objectContaining({ kind: 'class', name: 'SampleComponent' }),
    ]));
    expect(response.displayEdges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        sourceName: 'SampleComponent template',
        targetName: 'Node',
        metadata: expect.objectContaining({ relation: 'template-binding' }),
      }),
    ]));
  });

  it('indexes native-shaped import, export, parameter, registry, and JSX reference graph nodes', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'SampleView LazyPanelComponent sampleRegistry createSample value', ['--limit', '100']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'import',
        name: 'SampleView',
        filePath: 'src/app/features/sample/sample-domain.ts',
        metadata: expect.objectContaining({
          importedName: 'SampleView',
        }),
      }),
      expect.objectContaining({
        kind: 'export',
        name: 'SampleView',
        filePath: 'src/app/features/sample/sample-view.tsx',
        metadata: expect.objectContaining({
          exportName: 'SampleView',
        }),
      }),
      expect.objectContaining({
        kind: 'parameter',
        name: 'value',
        qualifiedName: 'createSample::value',
      }),
      expect.objectContaining({
        kind: 'constant',
        name: 'sampleRegistry',
      }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'createSample',
        targetName: 'value',
        metadata: expect.objectContaining({ relation: 'parameter' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'value',
        targetName: 'SampleAlias',
        metadata: expect.objectContaining({ relation: 'parameter-type' }),
      }),
      expect.objectContaining({
        kind: 'references',
        sourceName: 'sampleRegistry',
        targetName: 'SampleEntity',
        metadata: expect.objectContaining({ relation: 'initializer-reference' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        sourceName: 'SampleView',
        targetName: 'LazyPanelComponent',
        metadata: expect.objectContaining({ relation: 'jsx-component' }),
      }),
    ]));
    expect(response.markdown).not.toContain('### Relationships');
    expect(response.coverage.typescriptImports).toBeGreaterThan(0);
    expect(response.coverage.typescriptExports).toBeGreaterThan(0);
    expect(response.coverage.typescriptParameters).toBeGreaterThan(0);
  });

  it('extracts exported object-literal and factory-returned function properties as native function nodes', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'sampleActions build queue sampleStore hydrate sampleNestedStore rebuild flush', ['--limit', '120']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'constant',
        name: 'sampleActions',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'build',
        qualifiedName: 'sampleActions::build',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'queue',
        qualifiedName: 'sampleActions::queue',
      }),
      expect.objectContaining({
        kind: 'constant',
        name: 'sampleStore',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'hydrate',
        qualifiedName: 'sampleStore::hydrate',
      }),
      expect.objectContaining({
        kind: 'constant',
        name: 'sampleNestedStore',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'rebuild',
        qualifiedName: 'sampleNestedStore::rebuild',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'flush',
        qualifiedName: 'sampleNestedStore::flush',
      }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'sampleActions',
        targetName: 'build',
        metadata: expect.objectContaining({ relation: 'object-function' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'sampleActions',
        targetName: 'queue',
        metadata: expect.objectContaining({ relation: 'object-function' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'sampleStore',
        targetName: 'hydrate',
        metadata: expect.objectContaining({ relation: 'object-function' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'sampleNestedStore',
        targetName: 'rebuild',
        metadata: expect.objectContaining({ relation: 'object-function' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'sampleNestedStore',
        targetName: 'flush',
        metadata: expect.objectContaining({ relation: 'object-function' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        sourceName: 'build',
        targetName: 'createSample',
      }),
      expect.objectContaining({
        kind: 'calls',
        sourceName: 'hydrate',
        targetName: 'createSample',
      }),
      expect.objectContaining({
        kind: 'calls',
        sourceName: 'rebuild',
        targetName: 'createSample',
      }),
      expect.objectContaining({
        kind: 'returns',
        sourceName: 'queue',
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

  it('extracts default-exported object-literal function properties and resolves default import member calls', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'defaultActions runDefaultAction run queue', ['--limit', '160']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'constant',
        id: 'constant:src/app/features/sample/default-actions.ts:default',
        name: 'default',
      }),
      expect.objectContaining({
        kind: 'function',
        id: 'function:src/app/features/sample/default-actions.ts:default::run',
        name: 'run',
        qualifiedName: 'default::run',
      }),
      expect.objectContaining({
        kind: 'function',
        id: 'function:src/app/features/sample/default-actions.ts:default::queue',
        name: 'queue',
        qualifiedName: 'default::queue',
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        source: 'constant:src/app/features/sample/default-actions.ts:default',
        target: 'function:src/app/features/sample/default-actions.ts:default::run',
        metadata: expect.objectContaining({ relation: 'object-function' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        source: 'function:src/app/features/sample/default-actions-consumer.ts:runDefaultAction',
        target: 'function:src/app/features/sample/default-actions.ts:default::run',
        metadata: expect.objectContaining({ relation: 'call' }),
      }),
    ]));
  });

  it('resolves default-exported object identifiers to object-literal function members', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'namedDefaultActions runNamedDefaultAction runNamed queueNamed', ['--limit', '160']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'constant',
        id: 'constant:src/app/features/sample/default-named-actions.ts:namedDefaultActions',
        name: 'namedDefaultActions',
      }),
      expect.objectContaining({
        kind: 'function',
        id: 'function:src/app/features/sample/default-named-actions.ts:namedDefaultActions::runNamed',
        name: 'runNamed',
        qualifiedName: 'namedDefaultActions::runNamed',
      }),
      expect.objectContaining({
        kind: 'function',
        id: 'function:src/app/features/sample/default-named-actions.ts:namedDefaultActions::queueNamed',
        name: 'queueNamed',
        qualifiedName: 'namedDefaultActions::queueNamed',
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'exports',
        source: 'constant:src/app/features/sample/default-named-actions.ts:namedDefaultActions',
        metadata: expect.objectContaining({ relation: 'export', exportName: 'default' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        source: 'constant:src/app/features/sample/default-named-actions.ts:namedDefaultActions',
        target: 'function:src/app/features/sample/default-named-actions.ts:namedDefaultActions::runNamed',
        metadata: expect.objectContaining({ relation: 'object-function' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        source: 'function:src/app/features/sample/default-named-actions-consumer.ts:runNamedDefaultAction',
        target: 'function:src/app/features/sample/default-named-actions.ts:namedDefaultActions::runNamed',
        metadata: expect.objectContaining({ relation: 'call' }),
      }),
    ]));
  });

  it('resolves named export object identifiers to object-literal function members', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'exportedActions runNamedExportAction runExported queueExported', ['--limit', '160']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'constant',
        id: 'constant:src/app/features/sample/named-export-actions.ts:localNamedExportActions',
        name: 'localNamedExportActions',
      }),
      expect.objectContaining({
        kind: 'function',
        id: 'function:src/app/features/sample/named-export-actions.ts:localNamedExportActions::runExported',
        name: 'runExported',
        qualifiedName: 'localNamedExportActions::runExported',
      }),
      expect.objectContaining({
        kind: 'function',
        id: 'function:src/app/features/sample/named-export-actions.ts:localNamedExportActions::queueExported',
        name: 'queueExported',
        qualifiedName: 'localNamedExportActions::queueExported',
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'exports',
        source: 'constant:src/app/features/sample/named-export-actions.ts:localNamedExportActions',
        metadata: expect.objectContaining({ relation: 'export', exportName: 'exportedActions' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        source: 'constant:src/app/features/sample/named-export-actions.ts:localNamedExportActions',
        target: 'function:src/app/features/sample/named-export-actions.ts:localNamedExportActions::runExported',
        metadata: expect.objectContaining({ relation: 'object-function' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        source: 'function:src/app/features/sample/named-export-actions-consumer.ts:runNamedExportAction',
        target: 'function:src/app/features/sample/named-export-actions.ts:localNamedExportActions::runExported',
        metadata: expect.objectContaining({ relation: 'call' }),
      }),
    ]));
  });

  it('resolves export-declared default object identifiers to object-literal function members', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'defaultExportActions runDefaultExportedAction runDefaultExported', ['--limit', '160']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'constant',
        id: 'constant:src/app/features/sample/named-export-actions.ts:localDefaultExportActions',
        name: 'localDefaultExportActions',
      }),
      expect.objectContaining({
        kind: 'function',
        id: 'function:src/app/features/sample/named-export-actions.ts:localDefaultExportActions::runDefaultExported',
        name: 'runDefaultExported',
        qualifiedName: 'localDefaultExportActions::runDefaultExported',
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'exports',
        source: 'constant:src/app/features/sample/named-export-actions.ts:localDefaultExportActions',
        metadata: expect.objectContaining({ relation: 'export', exportName: 'default' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        source: 'function:src/app/features/sample/named-export-actions-consumer.ts:runDefaultExportedAction',
        target: 'function:src/app/features/sample/named-export-actions.ts:localDefaultExportActions::runDefaultExported',
        metadata: expect.objectContaining({ relation: 'call' }),
      }),
    ]));
  });

  it('extracts CommonJS export object function properties as native exports and function nodes', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'sample-commonjs module.exports hydrate queue runCommonJs', ['--limit', '160']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'constant',
        id: 'constant:src/app/features/sample/sample-commonjs.cjs:module.exports',
        name: 'module.exports',
      }),
      expect.objectContaining({
        kind: 'function',
        id: 'function:src/app/features/sample/sample-commonjs.cjs:module.exports::hydrate',
        name: 'hydrate',
        qualifiedName: 'module.exports::hydrate',
      }),
      expect.objectContaining({
        kind: 'function',
        id: 'function:src/app/features/sample/sample-commonjs.cjs:module.exports::queue',
        name: 'queue',
        qualifiedName: 'module.exports::queue',
      }),
      expect.objectContaining({
        kind: 'function',
        id: 'function:src/app/features/sample/sample-commonjs.cjs:runCommonJs',
        name: 'runCommonJs',
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'exports',
        source: 'function:src/app/features/sample/sample-commonjs.cjs:module.exports::hydrate',
        target: 'file:src/app/features/sample/sample-commonjs.cjs:src/app/features/sample/sample-commonjs.cjs',
        metadata: expect.objectContaining({ relation: 'commonjs-export', exportName: 'hydrate' }),
      }),
      expect.objectContaining({
        kind: 'exports',
        source: 'function:src/app/features/sample/sample-commonjs.cjs:runCommonJs',
        target: 'file:src/app/features/sample/sample-commonjs.cjs:src/app/features/sample/sample-commonjs.cjs',
        metadata: expect.objectContaining({ relation: 'commonjs-export', exportName: 'runCommonJs' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        source: 'constant:src/app/features/sample/sample-commonjs.cjs:module.exports',
        target: 'function:src/app/features/sample/sample-commonjs.cjs:module.exports::hydrate',
        metadata: expect.objectContaining({ relation: 'object-function' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        source: 'function:src/app/features/sample/sample-commonjs.cjs:module.exports::hydrate',
        target: 'function:src/app/features/sample/sample-commonjs.cjs:createCommonJsEntity',
        metadata: expect.objectContaining({ relation: 'call' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        source: 'function:src/app/features/sample/sample-commonjs.cjs:runCommonJs',
        target: 'function:src/app/features/sample/sample-commonjs.cjs:loadCommonJs',
        metadata: expect.objectContaining({ relation: 'call' }),
      }),
    ]));
  });

  it('resolves CommonJS require aliases to exported function members', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'useCommonJsRequire', ['--limit', '120']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'function',
        name: 'useCommonJsRequire',
        filePath: 'src/app/features/sample/sample-commonjs-consumer.cjs',
      }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'calls',
        sourceName: 'useCommonJsRequire',
        targetName: 'hydrate',
        target: 'function:src/app/features/sample/sample-commonjs.cjs:module.exports::hydrate',
        metadata: expect.objectContaining({ relation: 'call' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        sourceName: 'useCommonJsRequire',
        targetName: 'runCommonJs',
        target: 'function:src/app/features/sample/sample-commonjs.cjs:runCommonJs',
        metadata: expect.objectContaining({ relation: 'call' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        sourceName: 'useCommonJsRequire',
        targetName: 'queue',
        target: 'function:src/app/features/sample/sample-commonjs.cjs:module.exports::queue',
        metadata: expect.objectContaining({ relation: 'call' }),
      }),
    ]));
  });

  it('does not promote non-exported object-literal function properties into native function nodes', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'internalActions internalOnlyAction', ['--limit', '120']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'constant',
        name: 'internalActions',
      }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'function',
        name: 'internalOnlyAction',
        qualifiedName: 'internalActions::internalOnlyAction',
      }),
    ]));
    expect(response.displayEdges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'internalActions',
        targetName: 'internalOnlyAction',
        metadata: expect.objectContaining({ relation: 'object-function' }),
      }),
    ]));
  });

  it('extracts type literal and signature members as native member graph nodes', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'SampleTypeLiteral SampleCallablePort resolve handler constructor key id value', ['--limit', '220']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_alias',
        name: 'SampleTypeLiteral',
      }),
      expect.objectContaining({
        kind: 'interface',
        name: 'SampleCallablePort',
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
      expect.objectContaining({
        kind: 'method',
        name: 'handler',
        qualifiedName: 'SampleTypeLiteral::handler',
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'call',
        qualifiedName: 'SampleTypeLiteral::call',
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'constructor',
        qualifiedName: 'SampleTypeLiteral::constructor',
      }),
      expect.objectContaining({
        kind: 'property',
        name: '[key: string]',
        qualifiedName: 'SampleTypeLiteral::[key: string]',
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'call',
        qualifiedName: 'SampleCallablePort::call',
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'constructor',
        qualifiedName: 'SampleCallablePort::constructor',
      }),
      expect.objectContaining({
        kind: 'property',
        name: '[key: string]',
        qualifiedName: 'SampleCallablePort::[key: string]',
      }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'property',
        name: 'handler',
        qualifiedName: 'SampleTypeLiteral::handler',
      }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'SampleTypeLiteral',
        targetName: 'resolve',
        metadata: expect.objectContaining({ relation: 'type-literal-member' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'SampleTypeLiteral',
        targetName: 'handler',
        metadata: expect.objectContaining({ relation: 'type-literal-member' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'SampleTypeLiteral',
        targetName: 'id',
        metadata: expect.objectContaining({ relation: 'type-literal-member' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'SampleCallablePort',
        targetName: 'call',
        metadata: expect.objectContaining({ relation: 'interface-member' }),
      }),
      expect.objectContaining({
        kind: 'returns',
        sourceName: 'resolve',
        targetName: 'SampleEntity',
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'id',
        targetName: 'SampleAlias',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'resolve',
        targetName: 'value',
        metadata: expect.objectContaining({ relation: 'parameter' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'value',
        targetName: 'SampleAlias',
        metadata: expect.objectContaining({ relation: 'parameter-type' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: '[key: string]',
        targetName: 'SampleEntity',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
    ]));
    expect(response.markdown).toContain('SampleTypeLiteral');
    expect(response.markdown).toContain('SampleCallablePort');
  });

  it('does not extract union object type members as native TypeScript type alias members', () => {    const root = makeFixture();

    const result = queryOverlay(root, 'SampleUnionLiteral unionOnly archived', ['--limit', '120']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_alias',
        name: 'SampleUnionLiteral',
      }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'method',
        name: 'unionOnly',
        qualifiedName: 'SampleUnionLiteral::unionOnly',
      }),
      expect.objectContaining({
        kind: 'property',
        name: 'archived',
        qualifiedName: 'SampleUnionLiteral::archived',
      }),
    ]));
    expect(response.displayEdges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'SampleUnionLiteral',
        targetName: 'unionOnly',
        metadata: expect.objectContaining({ relation: 'type-literal-member' }),
      }),
      expect.objectContaining({
        kind: 'contains',
        sourceName: 'SampleUnionLiteral',
        targetName: 'archived',
        metadata: expect.objectContaining({ relation: 'type-literal-member' }),
      }),
    ]));
  });


}
