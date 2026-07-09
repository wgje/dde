import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayTypeParameterSpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, queryOverlay, expectSpawnSuccess } = context;

  it('emits native edge kinds for TypeScript type parameter constraints and defaults', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'type-parameter-constraint', ['--limit', '80']);
    const defaultResult = queryOverlay(root, 'type-parameter-default', ['--limit', '80']);

    expect(result.status).toBe(0);
    expect(defaultResult.status).toBe(0);
    const response = JSON.parse(result.stdout);
    const defaultResponse = JSON.parse(defaultResult.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'interface',
        name: 'GenericSamplePort',
      }),
      expect.objectContaining({
        kind: 'type_alias',
        name: 'GenericSampleAlias',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'createGenericSample',
      }),
      expect.objectContaining({
        kind: 'class',
        name: 'GenericSampleEntity',
      }),
      expect.objectContaining({
        kind: 'interface',
        name: 'SamplePort',
      }),
    ]));
    expect(defaultResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'interface',
        name: 'GenericSamplePort',
      }),
      expect.objectContaining({
        kind: 'type_alias',
        name: 'GenericSampleAlias',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'createGenericSample',
      }),
      expect.objectContaining({
        kind: 'class',
        name: 'GenericSampleEntity',
      }),
      expect.objectContaining({
        kind: 'interface',
        name: 'SampleCallablePort',
      }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'GenericSamplePort',
        targetName: 'SamplePort',
        metadata: expect.objectContaining({
          relation: 'type-parameter-constraint',
          typeParameter: 'TPort',
        }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'GenericSampleAlias',
        targetName: 'SamplePort',
        metadata: expect.objectContaining({
          relation: 'type-parameter-constraint',
          typeParameter: 'TPort',
        }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'createGenericSample',
        targetName: 'SamplePort',
        metadata: expect.objectContaining({
          relation: 'type-parameter-constraint',
          typeParameter: 'TPort',
        }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'createGenericSample',
        targetName: 'SamplePort',
        metadata: expect.objectContaining({
          relation: 'type-parameter-constraint',
          typeParameter: 'TPort',
        }),
      }),
    ]));
    expect(defaultResponse.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'GenericSamplePort',
        targetName: 'SampleCallablePort',
        metadata: expect.objectContaining({
          relation: 'type-parameter-default',
          typeParameter: 'TPort',
        }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'GenericSampleAlias',
        targetName: 'SampleCallablePort',
        metadata: expect.objectContaining({
          relation: 'type-parameter-default',
          typeParameter: 'TPort',
        }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'createGenericSample',
        targetName: 'SampleCallablePort',
        metadata: expect.objectContaining({
          relation: 'type-parameter-default',
          typeParameter: 'TPort',
        }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'GenericSampleEntity',
        targetName: 'SampleCallablePort',
        metadata: expect.objectContaining({
          relation: 'type-parameter-default',
          typeParameter: 'TPort',
        }),
      }),
    ]));
    expect(response.markdown).toContain('### Relationships');
    expect(response.markdown).toContain('typeParameter: TPort');
    expect(defaultResponse.markdown).toContain('type-parameter-default');
  });

  it('filters local TypeScript type parameters from project symbol references', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'GenericSampleAlias createGenericSample GenericSampleEntity TPort', ['--limit', '120']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'type_alias', name: 'GenericSampleAlias' }),
      expect.objectContaining({ kind: 'function', name: 'createGenericSample' }),
      expect.objectContaining({ kind: 'class', name: 'GenericSampleEntity' }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'TPort' }),
    ]));
    expect(response.displayEdges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'type_of', targetName: 'TPort' }),
    ]));
    expect(response.displayEdges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'returns', targetName: 'TPort' }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'GenericSampleAlias',
        targetName: 'SamplePort',
        metadata: expect.objectContaining({
          relation: 'type-parameter-constraint',
          typeParameter: 'TPort',
        }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'GenericSampleEntity',
        targetName: 'SampleCallablePort',
        metadata: expect.objectContaining({
          relation: 'type-parameter-default',
          typeParameter: 'TPort',
        }),
      }),
    ]));
  });

  it('filters nested TypeScript type parameters inside object type literal members', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'NestedGenericContainer runner run map T TData', ['--limit', '120']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'interface', name: 'NestedGenericContainer' }),
      expect.objectContaining({ kind: 'property', name: 'runner' }),
      expect.objectContaining({ kind: 'interface', name: 'SamplePort' }),
      expect.objectContaining({ kind: 'class', name: 'SampleEntity' }),
    ]));
    for (const typeParameter of ['T', 'TData']) {
      expect(response.nodes).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: typeParameter }),
      ]));
      expect(response.displayEdges).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ targetName: typeParameter }),
      ]));
    }
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'runner',
        targetName: 'SamplePort',
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'runner',
        targetName: 'SampleEntity',
      }),
    ]));
  });

  it('extracts project type references from satisfies/as/type-assertion expressions like native TypeScript', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'sampleConfig assertedSampleConfig legacyAssertedSampleConfig literalSampleConfig', ['--limit', '120']);

    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'interface', name: 'SampleConfig' }),
      expect.objectContaining({ kind: 'constant', name: 'sampleConfig' }),
      expect.objectContaining({ kind: 'constant', name: 'assertedSampleConfig' }),
      expect.objectContaining({ kind: 'constant', name: 'legacyAssertedSampleConfig' }),
      expect.objectContaining({ kind: 'constant', name: 'literalSampleConfig' }),
    ]));
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'sampleConfig',
        targetName: 'SampleConfig',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        sourceName: 'assertedSampleConfig',
        targetName: 'SampleConfig',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
      expect.objectContaining({
        kind: 'type_of',        sourceName: 'legacyAssertedSampleConfig',
        targetName: 'SampleConfig',
        metadata: expect.objectContaining({ relation: 'type-reference' }),
      }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'const' }),
    ]));
  });


}
