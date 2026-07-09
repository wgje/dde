import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayQueryTestMappingSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { makeFixture, writeFile, runOverlay, queryOverlay, expectSpawnSuccess } = context;

  it('queries Angular test mapping provenance as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'test', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'file:src/app/features/sample/sample.component.spec.ts:src/app/features/sample/sample.component.spec.ts',
        metadata: expect.objectContaining({
          relation: 'test',
          testMapping: 'same-basename',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.service.ts:SampleService',
        target: 'file:src/app/features/sample/sample.component.spec.ts:src/app/features/sample/sample.component.spec.ts',
        metadata: expect.objectContaining({
          relation: 'test',
          testMapping: 'class-reference',
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'SampleComponent',
        target: 'src/app/features/sample/sample.component.spec.ts',
        relation: 'test',
        testMapping: 'same-basename',
      }),
      expect.objectContaining({
        source: 'SampleService',
        target: 'src/app/features/sample/sample.component.spec.ts',
        relation: 'test',
        testMapping: 'class-reference',
      }),
    ]));
    expect(response.markdown).toContain('testMapping: same-basename');
    expect(response.markdown).toContain('testMapping: class-reference');
  });

  it('excludes overlay harness fixtures from class-reference test mapping provenance', () => {
    const root = makeFixture();
    writeFile(
      root,
      'src/app/core/services/noisy-target.service.ts',
      [
        "import { Injectable } from '@angular/core';",
        '',
        '@Injectable({ providedIn: "root" })',
        'export class HarnessExcludedService {',
        '  touch(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/core/services/noisy-target.service.spec.ts',
      [
        "import { HarnessExcludedService } from './noisy-target.service';",
        "it('covers the real service spec', () => {",
        '  expect(new HarnessExcludedService()).toBeTruthy();',
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/tests/scripts/codegraph-nanoflow-overlay-query.spec-helpers.ts',
      [
        "const fixtureOnlyClassName = 'HarnessExcludedService';",
        "it('mentions the class only as overlay fixture data', () => {",
        '  expect(fixtureOnlyClassName).toBeTruthy();',
        '});',
        '',
      ].join('\n'),
    );

    const overlayResult = runOverlay(root);
    const classReferenceResult = queryOverlay(root, 'class-reference', ['--limit', '20']);

    expectSpawnSuccess(overlayResult);
    expectSpawnSuccess(classReferenceResult);
    const overlay = JSON.parse(overlayResult.stdout);
    const classReferenceEdges = overlay.graph.edges.filter((edge: { metadata?: { testMapping?: string } }) => (
      edge.metadata?.testMapping === 'class-reference'
    ));
    expect(classReferenceEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'class:src/app/core/services/noisy-target.service.ts:HarnessExcludedService',
        target: 'file:src/app/core/services/noisy-target.service.spec.ts:src/app/core/services/noisy-target.service.spec.ts',
      }),
    ]));
    expect(classReferenceEdges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'file:src/tests/scripts/codegraph-nanoflow-overlay-query.spec-helpers.ts:src/tests/scripts/codegraph-nanoflow-overlay-query.spec-helpers.ts',
      }),
    ]));
    const classReferenceResponse = JSON.parse(classReferenceResult.stdout);
    expect(classReferenceResponse.relatedFiles).toContain('src/app/core/services/noisy-target.service.spec.ts');
    expect(classReferenceResponse.relatedFiles).not.toContain('src/tests/scripts/codegraph-nanoflow-overlay-query.spec-helpers.ts');
  });

  it('excludes script contract specs from Angular class-reference test mapping provenance', () => {
    const root = makeFixture();
    writeFile(
      root,
      'src/app/core/services/script-contract-noisy-target.service.ts',
      [
        "import { Injectable } from '@angular/core';",
        '',
        '@Injectable({ providedIn: "root" })',
        'export class ScriptContractExcludedService {',
        '  touch(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/core/services/script-contract-noisy-target.service.spec.ts',
      [
        "import { ScriptContractExcludedService } from './script-contract-noisy-target.service';",
        "it('covers the real service spec', () => {",
        '  expect(new ScriptContractExcludedService()).toBeTruthy();',
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/tests/scripts/validate-codegraph-overlay-docs.spec.ts',
      [
        "const fixtureOnlyClassName = 'ScriptContractExcludedService';",
        "it('mentions the service only as script contract fixture data', () => {",
        '  expect(fixtureOnlyClassName).toBeTruthy();',
        '});',
        '',
      ].join('\n'),
    );

    const overlayResult = runOverlay(root);
    const classReferenceResult = queryOverlay(root, 'class-reference ScriptContractExcludedService', ['--limit', '20']);

    expectSpawnSuccess(overlayResult);
    expectSpawnSuccess(classReferenceResult);
    const overlay = JSON.parse(overlayResult.stdout);
    const classReferenceEdges = overlay.graph.edges.filter((edge: { metadata?: { testMapping?: string } }) => (
      edge.metadata?.testMapping === 'class-reference'
    ));
    expect(classReferenceEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'class:src/app/core/services/script-contract-noisy-target.service.ts:ScriptContractExcludedService',
        target: 'file:src/app/core/services/script-contract-noisy-target.service.spec.ts:src/app/core/services/script-contract-noisy-target.service.spec.ts',
      }),
    ]));
    expect(classReferenceEdges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'file:src/tests/scripts/validate-codegraph-overlay-docs.spec.ts:src/tests/scripts/validate-codegraph-overlay-docs.spec.ts',
      }),
    ]));
    const classReferenceResponse = JSON.parse(classReferenceResult.stdout);
    expect(classReferenceResponse.relatedFiles).toContain('src/app/core/services/script-contract-noisy-target.service.spec.ts');
    expect(classReferenceResponse.relatedFiles).not.toContain('src/tests/scripts/validate-codegraph-overlay-docs.spec.ts');
  });

  it('does not treat dependency-only provider mocks as class-reference test mappings', () => {
    const root = makeFixture();
    writeFile(
      root,
      'src/app/features/provider-noise/dependency-only.service.ts',
      [
        "import { Injectable } from '@angular/core';",
        '',
        "@Injectable({ providedIn: 'root' })",
        'export class DependencyOnlyService {',
        '  touch(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/features/provider-noise/host.component.ts',
      [
        "import { Component, inject } from '@angular/core';",
        "import { DependencyOnlyService } from './dependency-only.service';",
        '',
        '@Component({',
        "  selector: 'app-provider-noise-host',",
        '  standalone: true,',
        "  template: '<span>host</span>',",
        '})',
        'export class ProviderNoiseHostComponent {',
        '  private readonly dependency = inject(DependencyOnlyService);',
        '  touch(): void { this.dependency.touch(); }',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/features/provider-noise/host.component.spec.ts',
      [
        "import { TestBed } from '@angular/core/testing';",
        "import { ProviderNoiseHostComponent } from './host.component';",
        "import { DependencyOnlyService } from './dependency-only.service';",
        '',
        "describe('ProviderNoiseHostComponent', () => {",
        "  it('creates the host component with a mocked dependency', () => {",
        '    TestBed.configureTestingModule({',
        '      imports: [ProviderNoiseHostComponent],',
        '      providers: [{ provide: DependencyOnlyService, useValue: { touch: () => undefined } }],',
        '    });',
        '    const fixture = TestBed.createComponent(ProviderNoiseHostComponent);',
        '    expect(fixture.componentInstance).toBeTruthy();',
        '  });',
        '});',
        '',
      ].join('\n'),
    );

    const overlayResult = runOverlay(root);
    const classReferenceResult = queryOverlay(root, 'class-reference DependencyOnlyService', ['--limit', '20']);

    expectSpawnSuccess(overlayResult);
    expectSpawnSuccess(classReferenceResult);
    const overlay = JSON.parse(overlayResult.stdout);
    const classReferenceEdges = overlay.graph.edges.filter((edge: { metadata?: { testMapping?: string } }) => (
      edge.metadata?.testMapping === 'class-reference'
    ));
    expect(classReferenceEdges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'class:src/app/features/provider-noise/dependency-only.service.ts:DependencyOnlyService',
        target: 'file:src/app/features/provider-noise/host.component.spec.ts:src/app/features/provider-noise/host.component.spec.ts',
      }),
    ]));
    const classReferenceResponse = JSON.parse(classReferenceResult.stdout);
    expect(classReferenceResponse.relatedFiles).not.toContain('src/app/features/provider-noise/host.component.spec.ts');
  });
}
