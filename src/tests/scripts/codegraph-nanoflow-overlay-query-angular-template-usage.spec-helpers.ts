import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayAngularTemplateUsageQuerySpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { makeFixture, queryOverlay, expectSpawnSuccess } = context;

  it('queries Angular template component/directive/pipe usage as focused native relationships', () => {
    const root = makeFixture();

    const componentResult = queryOverlay(root, 'template-component', ['--limit', '20']);
    const directiveResult = queryOverlay(root, 'template-directive', ['--limit', '40']);
    const appSampleDirectiveResult = queryOverlay(root, 'appSample template-directive', ['--limit', '20']);
    const prefixedDirectiveResult = queryOverlay(root, 'samplePrefixed template-directive', ['--limit', '20']);
    const pipeResult = queryOverlay(root, 'template-pipe', ['--limit', '20']);

    expectSpawnSuccess(componentResult);
    expectSpawnSuccess(directiveResult);
    expectSpawnSuccess(appSampleDirectiveResult);
    expectSpawnSuccess(prefixedDirectiveResult);
    expectSpawnSuccess(pipeResult);
    const componentResponse = JSON.parse(componentResult.stdout);
    const directiveResponse = JSON.parse(directiveResult.stdout);
    const appSampleDirectiveResponse = JSON.parse(appSampleDirectiveResult.stdout);
    const prefixedDirectiveResponse = JSON.parse(prefixedDirectiveResult.stdout);
    const pipeResponse = JSON.parse(pipeResult.stdout);

    expect(componentResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'class', name: 'SampleComponent' }),
    ]));
    expect(componentResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        line: 13,
        metadata: expect.objectContaining({
          relation: 'template-component',
          selector: 'app-sample',
          templateFile: 'src/app/features/sample/sample.component.html',
          matchedNeedle: 'app-sample',
        }),
      }),
    ]));
    expect(componentResponse.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'SampleComponent',
        target: 'SampleComponent',
        relation: 'template-component',
      }),
    ]));
    expect(componentResponse.markdown).toContain('SampleComponent → SampleComponent');
    expect(componentResponse.markdown).toContain('relation: template-component');

    expect(directiveResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'class', name: 'SampleComponent' }),
      expect.objectContaining({ kind: 'class', name: 'SampleDirective' }),
      expect.objectContaining({ kind: 'class', name: 'SampleMarkerDirective' }),
      expect.objectContaining({ kind: 'class', name: 'SampleModeDirective' }),
      expect.objectContaining({ kind: 'class', name: 'SampleListDirective' }),
      expect.objectContaining({ kind: 'class', name: 'SampleDropzoneDirective' }),
      expect.objectContaining({ kind: 'class', name: 'SampleGuardDirective' }),
      expect.objectContaining({ kind: 'class', name: 'SampleDecoratedDirective' }),
      expect.objectContaining({ kind: 'class', name: 'SampleTokenDirective' }),
    ]));
    expect(directiveResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'class:src/app/features/sample/sample.directive.ts:SampleDirective',
        line: 13,
        metadata: expect.objectContaining({
          relation: 'template-directive',
          selector: '[appSample]',
          attribute: 'appSample',
          templateFile: 'src/app/features/sample/sample.component.html',
          matchedNeedle: 'appSample',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'class:src/app/features/sample/sample-host.directive.ts:SampleMarkerDirective',
        metadata: expect.objectContaining({
          relation: 'template-directive',
          selector: '.sampleMarker',
          className: 'sampleMarker',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'class:src/app/features/sample/sample-host.directive.ts:SampleModeDirective',
        metadata: expect.objectContaining({
          relation: 'template-directive',
          selector: 'button[sampleMode="active"]',
          element: 'button',
          attribute: 'sampleMode',
          attributeValue: 'active',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'class:src/app/features/sample/sample-host.directive.ts:SampleListDirective',
        metadata: expect.objectContaining({
          relation: 'template-directive',
          selector: 'section, [sampleListAlias]',
          attribute: 'sampleListAlias',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'class:src/app/features/sample/sample-host.directive.ts:SampleDropzoneDirective',
        metadata: expect.objectContaining({
          relation: 'template-directive',
          selector: '[sampleDropzone]:not(textarea)',
          element: 'div',
          attribute: 'sampleDropzone',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'class:src/app/features/sample/sample-host.directive.ts:SampleGuardDirective',
        line: 22,
        metadata: expect.objectContaining({
          relation: 'template-directive',
          selector: '[sampleGuard]:not([sampleDisabled])',
          element: 'div',
          attribute: 'sampleGuard',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'class:src/app/features/sample/sample-host.directive.ts:SampleDecoratedDirective',
        line: 23,
        metadata: expect.objectContaining({
          relation: 'template-directive',
          selector: '[sampleDecorated=".sampleMarker"]',
          attribute: 'sampleDecorated',
          attributeValue: '.sampleMarker',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'class:src/app/features/sample/sample-host.directive.ts:SampleTokenDirective',
        line: 24,
        metadata: expect.objectContaining({
          relation: 'template-directive',
          selector: '[sampleToken="a,b"]',
          attribute: 'sampleToken',
          attributeValue: 'a,b',
        }),
      }),
    ]));
    expect(directiveResponse.edges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'class:src/app/features/sample/sample-host.directive.ts:SampleModeDirective',
        metadata: expect.objectContaining({
          attributeValue: 'inactive',
        }),
      }),
      expect.objectContaining({
        target: 'class:src/app/features/sample/sample-host.directive.ts:SampleDropzoneDirective',
        metadata: expect.objectContaining({
          element: 'textarea',
        }),
      }),
      expect.objectContaining({
        target: 'class:src/app/features/sample/sample-host.directive.ts:SampleGuardDirective',
        line: 21,
      }),
    ]));
    expect(directiveResponse.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'SampleComponent',
        target: 'SampleDirective',
        relation: 'template-directive',
      }),
      expect.objectContaining({
        source: 'SampleComponent',
        target: 'SampleMarkerDirective',
        relation: 'template-directive',
      }),
      expect.objectContaining({
        source: 'SampleComponent',
        target: 'SampleModeDirective',
        relation: 'template-directive',
      }),
      expect.objectContaining({
        source: 'SampleComponent',
        target: 'SampleListDirective',
        relation: 'template-directive',
      }),
      expect.objectContaining({
        source: 'SampleComponent',
        target: 'SampleDropzoneDirective',
        relation: 'template-directive',
      }),
      expect.objectContaining({
        source: 'SampleComponent',
        target: 'SampleGuardDirective',
        relation: 'template-directive',
      }),
      expect.objectContaining({
        source: 'SampleComponent',
        target: 'SampleDecoratedDirective',
        relation: 'template-directive',
      }),
      expect.objectContaining({
        source: 'SampleComponent',
        target: 'SampleTokenDirective',
        relation: 'template-directive',
      }),
    ]));
    expect(directiveResponse.markdown).toContain('relation: template-directive');
    expect(appSampleDirectiveResponse.markdown).toContain('SampleComponent → SampleDirective');
    expect(appSampleDirectiveResponse.markdown).toContain('relation: template-directive');

    expect(prefixedDirectiveResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'class', name: 'SampleComponent' }),
      expect.objectContaining({ kind: 'class', name: 'SamplePrefixedDirective' }),
    ]));
    expect(prefixedDirectiveResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'class:src/app/features/sample/sample-host.directive.ts:SamplePrefixedDirective',
        line: 25,
        metadata: expect.objectContaining({
          relation: 'template-directive',
          selector: '[samplePrefixed]',
          attribute: 'samplePrefixed',
          templateFile: 'src/app/features/sample/sample.component.html',
          matchedNeedle: 'samplePrefixed',
        }),
      }),
    ]));
    expect(prefixedDirectiveResponse.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'SampleComponent',
        target: 'SamplePrefixedDirective',
        relation: 'template-directive',
      }),
    ]));

    expect(pipeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'class', name: 'SampleComponent' }),
      expect.objectContaining({ kind: 'class', name: 'SampleTitlePipe' }),
    ]));
    expect(pipeResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'class:src/app/features/sample/sample-title.pipe.ts:SampleTitlePipe',
        line: 13,
        metadata: expect.objectContaining({
          relation: 'template-pipe',
          pipeName: 'sampleTitle',
          templateFile: 'src/app/features/sample/sample.component.html',
          matchedNeedle: 'sampleTitle',
        }),
      }),
    ]));
    expect(pipeResponse.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'SampleComponent',
        target: 'SampleTitlePipe',
        relation: 'template-pipe',
      }),
    ]));
    expect(pipeResponse.markdown).toContain('SampleComponent → SampleTitlePipe');
    expect(pipeResponse.markdown).toContain('relation: template-pipe');
  });

  it('uses template usage lines for strict native directive relationship code blocks', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'template-directive', ['--limit', '20', '--native-json']);
    const appSampleResult = queryOverlay(root, 'appSample template-directive', ['--limit', '20', '--native-json']);
    const modeResult = queryOverlay(root, 'sampleMode template-directive', ['--limit', '20', '--native-json']);
    const guardResult = queryOverlay(root, 'sampleGuard template-directive', ['--limit', '20', '--native-json']);
    const prefixedResult = queryOverlay(root, 'samplePrefixed template-directive', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    expectSpawnSuccess(appSampleResult);
    expectSpawnSuccess(modeResult);
    expectSpawnSuccess(guardResult);
    expectSpawnSuccess(prefixedResult);
    const response = JSON.parse(result.stdout);
    const appSampleResponse = JSON.parse(appSampleResult.stdout);
    const modeResponse = JSON.parse(modeResult.stdout);
    const guardResponse = JSON.parse(guardResult.stdout);
    const prefixedResponse = JSON.parse(prefixedResult.stdout);
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/app/features/sample/sample.component.html',
        startLine: 18,
        endLine: 18,
        content: expect.stringContaining('<div sampleDropzone>'),
      }),
    ]));
    expect(appSampleResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/features/sample/sample.component.html',
      startLine: 13,
      endLine: 13,
      nodeKind: 'file',
      content: expect.stringContaining('<app-sample appSample>'),
    }));
    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/app/features/sample/sample.component.html',
        startLine: 19,
        content: expect.stringContaining('<textarea sampleDropzone>'),
      }),
      expect.objectContaining({
        filePath: 'src/app/features/sample/sample-host.directive.ts',
      }),
    ]));
    expect(modeResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/features/sample/sample.component.html',
      startLine: 15,
      endLine: 15,
      nodeKind: 'file',
      content: expect.stringContaining('<button sampleMode="active">'),
    }));
    expect(guardResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/features/sample/sample.component.html',
      startLine: 22,
      endLine: 22,
      nodeKind: 'file',
      content: expect.stringContaining('<div sampleGuard>'),
    }));
    expect(guardResponse.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/app/features/sample/sample.component.html',
        startLine: 21,
        content: expect.stringContaining('sampleDisabled'),
      }),
    ]));
    expect(prefixedResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/features/sample/sample.component.html',
      startLine: 25,
      endLine: 25,
      nodeKind: 'file',
      content: expect.stringContaining('bind-samplePrefixed="prefixed"'),
    }));
  });
}
