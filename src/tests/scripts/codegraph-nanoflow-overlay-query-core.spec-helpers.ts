import { expect, it } from 'vitest';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayQueryCoreSpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, writeFile, queryOverlay, expectSpawnSuccess } = context;

  it('queries overlay relationships by NanoFlow-specific dependency names', () => {
    const root = makeFixture();
    const result = queryOverlay(root, 'SampleService');
    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.query).toBe('SampleService');
    expect(response.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'angular-component',
        name: 'SampleComponent',
        file: 'src/app/features/sample/sample.component.ts',
      }),
      expect.objectContaining({
        kind: 'class',
        name: 'SampleService',
        file: 'src/app/features/sample/sample.service.ts',
      }),
    ]));
    const componentMatch = response.matches.find((match: { kind: string }) => match.kind === 'angular-component');
    expect(componentMatch.item.dependencies).toEqual(['SampleService', 'SampleRepository']);
    expect(response.relationshipGroups).toEqual(expect.objectContaining({
      imports: expect.arrayContaining([
        expect.objectContaining({ source: 'SampleComponent', target: 'src/app/features/sample/sample.component.html' }),
      ]),
      references: expect.arrayContaining([
        expect.objectContaining({ source: 'SampleComponent template', target: 'disabled' }),
      ]),
      type_of: expect.arrayContaining([
        expect.objectContaining({ source: 'SampleComponent', target: 'SampleService' }),
      ]),
    }));
    expect(response.relationshipGroups.routes).toBeUndefined();
    expect(response.relationshipGroups.tests).toBeUndefined();
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'component', name: 'SampleComponent' }),
      expect.objectContaining({ kind: 'class', name: 'SampleService' }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'type_of' }),
      expect.objectContaining({ kind: 'references' }),
    ]));
    expect(response.markdown).toContain('## Exploration: SampleService');
    expect(response.markdown).toMatch(/Found \d+ symbols across \d+ files\./);
    expect(response.markdown).toContain('SampleService:4');
    expect(response.markdown).not.toContain('### Relationships');
    expect(response.markdown).toContain('### Related Symbols');
  });

  it('queries Angular signal and plural query APIs as semantic edges', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'signal viewChildren contentChildren', ['--limit', '40']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'class',
        name: 'SampleComponent',
        filePath: 'src/app/features/sample/sample.component.ts',
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        metadata: expect.objectContaining({ relation: 'query', api: 'viewChildren' }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        metadata: expect.objectContaining({ relation: 'query', api: 'contentChildren' }),
      }),
      expect.objectContaining({
        kind: 'calls',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        metadata: expect.objectContaining({ relation: 'signal', api: 'signal' }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'SampleComponent', api: 'viewChildren' }),
      expect.objectContaining({ source: 'SampleComponent', api: 'contentChildren' }),
    ]));
    expect(response.relationshipGroups.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'SampleComponent', target: 'dirty', api: 'signal' }),
    ]));
    expect(response.entryPoints[0]).toEqual(expect.objectContaining({
      name: 'SampleComponent',
      filePath: 'src/app/features/sample/sample.component.ts',
    }));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      nodeName: 'SampleComponent',
      filePath: 'src/app/features/sample/sample.component.ts',
    }));
  });

  it('uses Angular standalone import and local provider metadata lines for exact relation queries', () => {
    const root = makeFixture();
    const componentPath = 'src/app/features/sample/sample.component.ts';

    const standaloneResult = queryOverlay(
      root,
      'standalone-import SampleComponent LazyPanelComponent',
      ['--limit', '20', '--native-json'],
    );

    expectSpawnSuccess(standaloneResult);
    const standaloneResponse = JSON.parse(standaloneResult.stdout);
    expect(standaloneResponse.edges.length).toBeGreaterThan(0);
    expect(standaloneResponse.edges.every((edge: { kind?: string }) => edge.kind === 'imports')).toBe(true);
    expect(standaloneResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: componentPath,
        content: expect.stringContaining('imports: [LazyPanelComponent]'),
      }),
    ]));

    const providerResult = queryOverlay(
      root,
      'provider SampleComponent SampleService',
      ['--limit', '20', '--native-json'],
    );

    expectSpawnSuccess(providerResult);
    const providerResponse = JSON.parse(providerResult.stdout);
    expect(providerResponse.edges.length).toBeGreaterThan(0);
    expect(providerResponse.edges.every((edge: { kind?: string }) => edge.kind === 'references')).toBe(true);
    expect(providerResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: componentPath,
        content: expect.stringContaining('providers: [SampleService]'),
      }),
    ]));
  });

  it('keeps inject and constructor dependency provenance scoped to the declaring Angular class', () => {
    const root = makeFixture();
    const sourcePath = 'src/app/features/sample/dependency-provenance.service.ts';
    writeFile(
      root,
      sourcePath,
      [
        "import { Injectable, inject } from '@angular/core';",
        '',
        'export class FirstService {}',
        'export class SecondService {}',
        '',
        '@Injectable()',
        'export class InjectConsumer {',
        '  private readonly first = inject(FirstService);',
        '}',
        '',
        '@Injectable()',
        'export class ConstructorConsumer {',
        '  constructor(private readonly second: SecondService) {}',
        '}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      'dependency InjectConsumer ConstructorConsumer FirstService SecondService',
      ['--limit', '40'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const injectConsumerId = `class:${sourcePath}:InjectConsumer`;
    const constructorConsumerId = `class:${sourcePath}:ConstructorConsumer`;
    const firstServiceId = `class:${sourcePath}:FirstService`;
    const secondServiceId = `class:${sourcePath}:SecondService`;
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_of',
        source: injectConsumerId,
        target: firstServiceId,
        metadata: expect.objectContaining({
          relation: 'dependency',
          injectionKind: 'inject',
        }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        source: constructorConsumerId,
        target: secondServiceId,
        metadata: expect.objectContaining({
          relation: 'dependency',
          injectionKind: 'constructor',
        }),
      }),
    ]));
    expect(response.edges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ source: injectConsumerId, target: secondServiceId }),
      expect.objectContaining({ source: constructorConsumerId, target: firstServiceId }),
    ]));

    const nativeResult = queryOverlay(
      root,
      'dependency InjectConsumer ConstructorConsumer FirstService SecondService',
      ['--limit', '40', '--native-json'],
    );

    expectSpawnSuccess(nativeResult);
    const nativeResponse = JSON.parse(nativeResult.stdout);
    expect(nativeResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: sourcePath,
        content: expect.stringContaining('inject(FirstService)'),
      }),
      expect.objectContaining({
        filePath: sourcePath,
        content: expect.stringContaining('constructor(private readonly second: SecondService)'),
      }),
    ]));
  });

  it('queries Angular application bootstrap providers as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'angular-app-provider', ['--limit', '40']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'file',
        name: 'main.ts',
        filePath: 'main.ts',
      }),
      expect.objectContaining({ name: 'APP_INITIALIZER' }),
      expect.objectContaining({ name: 'provideRouter' }),
      expect.objectContaining({ name: 'provideServiceWorker' }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'file:main.ts:main.ts',
        metadata: expect.objectContaining({
          relation: 'angular-app-provider',
          provider: 'APP_INITIALIZER',
          deps: ['SampleService'],
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'file:main.ts:main.ts',
        metadata: expect.objectContaining({
          relation: 'angular-app-provider',
          provider: 'provideRouter',
          arguments: expect.arrayContaining(['routes', 'withHashLocation']),
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'file:main.ts:main.ts',
        metadata: expect.objectContaining({
          relation: 'angular-app-provider',
          provider: 'provideServiceWorker',
          arguments: expect.arrayContaining(['ngsw-worker.js']),
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'main.ts', target: 'APP_INITIALIZER', relation: 'angular-app-provider' }),
      expect.objectContaining({ source: 'main.ts', target: 'provideRouter', relation: 'angular-app-provider' }),
      expect.objectContaining({ source: 'main.ts', target: 'provideServiceWorker', relation: 'angular-app-provider' }),
    ]));
    expect(response.entryPoints[0]).toEqual(expect.objectContaining({
      kind: 'file',
      filePath: 'main.ts',
    }));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'main.ts',
      content: expect.stringContaining('bootstrapApplication(AppComponent'),
    }));

    const nativeResult = queryOverlay(root, 'angular-app-provider', ['--limit', '40', '--native-json']);

    expectSpawnSuccess(nativeResult);
    const nativeResponse = JSON.parse(nativeResult.stdout);
    expect(nativeResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'main.ts',
      nodeName: 'main.ts',
      nodeKind: 'file',
      content: expect.stringContaining('bootstrapApplication(AppComponent'),
    }));
    expect(nativeResponse.codeBlocks.some((block: { content?: string }) => (
      block.content?.includes('deps: [SampleService]')
    ))).toBe(true);
    const nativeBlockRanges = nativeResponse.codeBlocks.map((block: {
      filePath?: string;
      startLine?: number;
      endLine?: number;
      nodeKind?: string;
    }) => ({
      filePath: block.filePath,
      startLine: block.startLine,
      endLine: block.endLine,
      nodeKind: block.nodeKind,
    }));
    expect(nativeBlockRanges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'main.ts',
        startLine: 1,
        endLine: 1,
        nodeKind: 'variable',
      }),
    ]));
    for (let outerIndex = 0; outerIndex < nativeBlockRanges.length; outerIndex += 1) {
      for (let innerIndex = 0; innerIndex < nativeBlockRanges.length; innerIndex += 1) {
        if (outerIndex === innerIndex) continue;
        const outer = nativeBlockRanges[outerIndex];
        const inner = nativeBlockRanges[innerIndex];
        if (outer.filePath !== inner.filePath) continue;
        expect(
          typeof outer.startLine === 'number'
          && typeof outer.endLine === 'number'
          && typeof inner.startLine === 'number'
          && typeof inner.endLine === 'number'
          && outer.startLine <= inner.startLine
          && outer.endLine >= inner.endLine,
        ).toBe(false);
      }
    }
  });
}
