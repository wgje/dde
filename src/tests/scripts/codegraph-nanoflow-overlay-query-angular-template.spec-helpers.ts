import { spawnSync } from 'node:child_process';

import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayAngularTemplateUsageQuerySpecs } from './codegraph-nanoflow-overlay-query-angular-template-usage.spec-helpers';

export function registerCodegraphOverlayAngularTemplateQuerySpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { makeFixture, queryOverlay, expectSpawnSuccess, writeFile, repoRoot, queryScriptPath } = context;

  it('queries Angular template binding kinds by NanoFlow-specific metadata', () => {
    const root = makeFixture();

    const controlFlowResult = queryOverlay(root, 'control-flow');
    const structuralResult = queryOverlay(root, 'structural');
    const bindingResult = queryOverlay(root, 'template-binding', ['--limit', '20']);
    const bindingNativeResult = queryOverlay(root, 'template-binding', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(controlFlowResult);
    expectSpawnSuccess(structuralResult);
    expectSpawnSuccess(bindingResult);
    expectSpawnSuccess(bindingNativeResult);
    const controlFlowResponse = JSON.parse(controlFlowResult.stdout);
    const structuralResponse = JSON.parse(structuralResult.stdout);
    const bindingResponse = JSON.parse(bindingResult.stdout);
    const bindingNativeResponse = JSON.parse(bindingNativeResult.stdout);
    expect(controlFlowResponse.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'SampleComponent template', target: 'isVisible' }),
      expect.objectContaining({ source: 'SampleComponent template', target: 'shouldDeferPanel' }),
      expect.objectContaining({ source: 'SampleComponent template', target: 'shouldPrefetchPanel' }),
      expect.objectContaining({ source: 'SampleComponent template', target: 'caseLabel' }),
      expect.objectContaining({ source: 'SampleComponent template', target: 'items' }),
      expect.objectContaining({ source: 'SampleComponent template', target: 'trackItemId' }),
    ]));
    expect(controlFlowResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'template-binding',
          bindingKind: 'control-flow',
        }),
      }),
    ]));
    expect(structuralResponse.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'SampleComponent template', target: 'items' }),
      expect.objectContaining({ source: 'SampleComponent template', target: 'trackItemId' }),
    ]));
    expect(structuralResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'template-binding',
          bindingKind: 'structural',
        }),
      }),
    ]));
    expect(bindingResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'template-binding',
          bindingKind: 'property',
          templateFile: 'src/app/features/sample/sample.component.html',
          matchedNeedle: 'disabled',
        }),
      }),
    ]));
    expect(bindingNativeResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/app/features/sample/sample.component.html',
        nodeKind: 'file',
        content: expect.stringContaining('[disabled]="disabled()"'),
      }),
    ]));
  });

  registerCodegraphOverlayAngularTemplateUsageQuerySpecs(context);

  it('queries Angular external template and style resources as focused native file relationships', () => {
    const root = makeFixture();
    for (let index = 0; index < 6; index += 1) {
      writeFile(
        root,
        `src/app/features/external/external-${index}.component.html`,
        [
          `<section class="external-${index}">`,
          `  <button type="button">external template ${index}</button>`,
          '</section>',
          '',
        ].join('\n'),
      );
      writeFile(
        root,
        `src/app/features/external/external-${index}.component.css`,
        [
          `:host { display: block; }`,
          `.external-${index} { color: var(--external-${index}); }`,
          '',
        ].join('\n'),
      );
      writeFile(
        root,
        `src/app/features/external/external-${index}.component.ts`,
        [
          "import { Component } from '@angular/core';",
          '',
          '@Component({',
          `  selector: 'app-external-${index}',`,
          '  standalone: true,',
          `  templateUrl: './external-${index}.component.html',`,
          `  styleUrl: './external-${index}.component.css',`,
          '})',
          `export class External${index}Component {}`,
          '',
        ].join('\n'),
      );
    }

    const templateResult = queryOverlay(root, 'template-url', ['--limit', '20']);
    const styleResult = queryOverlay(root, 'style-url', ['--limit', '20']);
    const combinedResourceResult = queryOverlay(root, 'template-url/style-url', ['--limit', '20']);
    const templateNativeResult = queryOverlay(root, 'template-url', ['--limit', '20', '--native-json']);
    const styleNativeResult = queryOverlay(root, 'style-url', ['--limit', '20', '--native-json']);
    const combinedResourceNativeResult = queryOverlay(root, 'template-url/style-url', ['--limit', '20', '--native-json']);
    const templateNativeMarkdownResult = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'template-url',
      '--limit',
      '20',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const styleNativeMarkdownResult = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'style-url',
      '--limit',
      '20',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(templateResult);
    expectSpawnSuccess(styleResult);
    expectSpawnSuccess(combinedResourceResult);
    expectSpawnSuccess(templateNativeResult);
    expectSpawnSuccess(styleNativeResult);
    expectSpawnSuccess(combinedResourceNativeResult);
    expectSpawnSuccess(templateNativeMarkdownResult);
    expectSpawnSuccess(styleNativeMarkdownResult);
    const templateResponse = JSON.parse(templateResult.stdout);
    const styleResponse = JSON.parse(styleResult.stdout);
    const combinedResourceResponse = JSON.parse(combinedResourceResult.stdout);
    const templateNativeResponse = JSON.parse(templateNativeResult.stdout);
    const styleNativeResponse = JSON.parse(styleNativeResult.stdout);
    const combinedResourceNativeResponse = JSON.parse(combinedResourceNativeResult.stdout);

    expect(templateResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'class',
        name: 'SampleComponent',
        filePath: 'src/app/features/sample/sample.component.ts',
      }),
      expect.objectContaining({
        kind: 'file',
        name: 'src/app/features/sample/sample.component.html',
        filePath: 'src/app/features/sample/sample.component.html',
        metadata: expect.objectContaining({
          relation: 'template-url',
          angularProperty: 'templateUrl',
        }),
      }),
    ]));
    expect(templateResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'imports',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'file:src/app/features/sample/sample.component.html:src/app/features/sample/sample.component.html',
        metadata: expect.objectContaining({
          relation: 'template-url',
          angularProperty: 'templateUrl',
          framework: 'angular',
        }),
      }),
    ]));
    expect(templateNativeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'class',
        name: 'SampleComponent',
        filePath: 'src/app/features/sample/sample.component.ts',
      }),
      expect.objectContaining({
        kind: 'file',
        name: 'src/app/features/sample/sample.component.html',
        filePath: 'src/app/features/sample/sample.component.html',
      }),
    ]));
    expect(templateNativeResponse.relatedFiles[0]).toMatch(/\.component\.html$/);
    expect(templateNativeResponse.relatedFiles).toContain('src/app/features/sample/sample.component.html');
    expect(templateNativeResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: expect.stringMatching(/\.component\.html$/),
      nodeKind: 'file',
    }));
    expect(templateNativeResponse.codeBlocks).toHaveLength(5);
    expect(templateNativeResponse.codeBlocks).toEqual(templateNativeResponse.codeBlocks.map(() => expect.objectContaining({
      filePath: expect.stringMatching(/\.component\.html$/),
      nodeKind: 'file',
    })));
    expect(templateNativeMarkdownResult.stdout).toContain('### Code');
    const templateCodeSection = templateNativeMarkdownResult.stdout.slice(
      templateNativeMarkdownResult.stdout.indexOf('### Code'),
    );
    expect(templateCodeSection).toMatch(/^### Code\s+#### src\/app\/features\/.+\.component\.html \(src\/app\/features\/.+\.component\.html:1\)/);
    expect(templateCodeSection).toContain('<section');
    expect(templateCodeSection).not.toContain('.component.ts:');

    expect(styleResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'file',
        name: 'src/app/features/sample/sample.component.css',
        filePath: 'src/app/features/sample/sample.component.css',
        metadata: expect.objectContaining({
          relation: 'style-url',
          angularProperty: 'styleUrl',
        }),
      }),
    ]));
    expect(styleResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'imports',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'file:src/app/features/sample/sample.component.css:src/app/features/sample/sample.component.css',
        metadata: expect.objectContaining({
          relation: 'style-url',
          angularProperty: 'styleUrl',
          framework: 'angular',
        }),
      }),
    ]));
    expect(combinedResourceResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.objectContaining({ relation: 'template-url' }),
      }),
      expect.objectContaining({
        metadata: expect.objectContaining({ relation: 'style-url' }),
      }),
    ]));
    expect(combinedResourceResponse.relatedFiles).toEqual(expect.arrayContaining([
      expect.stringMatching(/\.component\.html$/),
      expect.stringMatching(/\.component\.css$/),
    ]));
    expect(combinedResourceNativeResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: expect.stringMatching(/\.component\.html$/),
        nodeKind: 'file',
      }),
      expect.objectContaining({
        filePath: expect.stringMatching(/\.component\.css$/),
        nodeKind: 'file',
        content: expect.stringContaining(':host'),
      }),
    ]));
    expect(styleNativeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'file',
        name: 'src/app/features/sample/sample.component.css',
        filePath: 'src/app/features/sample/sample.component.css',
      }),
    ]));
    expect(styleNativeResponse.relatedFiles[0]).toMatch(/\.component\.css$/);
    expect(styleNativeResponse.relatedFiles).toContain('src/app/features/sample/sample.component.css');
    expect(styleNativeResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: expect.stringMatching(/\.component\.css$/),
      nodeKind: 'file',
    }));
    expect(styleNativeResponse.codeBlocks).toHaveLength(5);
    expect(styleNativeResponse.codeBlocks).toEqual(styleNativeResponse.codeBlocks.map(() => expect.objectContaining({
      filePath: expect.stringMatching(/\.component\.css$/),
      nodeKind: 'file',
      content: expect.stringContaining(':host'),
    })));
    expect(styleNativeMarkdownResult.stdout).toContain('### Code');
    const styleCodeSection = styleNativeMarkdownResult.stdout.slice(
      styleNativeMarkdownResult.stdout.indexOf('### Code'),
    );
    expect(styleCodeSection).toMatch(/^### Code\s+#### src\/app\/features\/.+\.component\.css \(src\/app\/features\/.+\.component\.css:1\)/);
    expect(styleCodeSection).toContain(':host');
    expect(styleCodeSection).not.toContain('.component.ts:');
  });

  it('uses inline template usage lines for strict native template relationship code blocks', () => {
    const root = makeFixture();

    writeFile(
      root,
      'src/app/features/inline/inline-child.component.ts',
      [
        "import { Component } from '@angular/core';",
        '@Component({',
        "  selector: 'app-inline-child',",
        '  standalone: true,',
        "  template: '<span>child</span>',",
        '})',
        'export class InlineChildComponent {}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/features/inline/inline-title.pipe.ts',
      [
        "import { Pipe, PipeTransform } from '@angular/core';",
        '@Pipe({',
        "  name: 'inlineTitle',",
        '  standalone: true,',
        '})',
        'export class InlineTitlePipe implements PipeTransform {',
        '  transform(value: string): string { return value; }',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/features/inline/inline-host.component.ts',
      [
        "import { Component, input } from '@angular/core';",
        "import { InlineChildComponent } from './inline-child.component';",
        "import { InlineTitlePipe } from './inline-title.pipe';",
        '',
        '@Component({',
        "  selector: 'app-inline-host',",
        '  standalone: true,',
        '  imports: [InlineChildComponent, InlineTitlePipe],',
        '  template: `',
        '    <section>',
        '      <button type="button">before</button>',
        '      <app-inline-child>{{ title() | inlineTitle }}</app-inline-child>',
        '    </section>',
        '  `,',
        '})',
        'export class InlineHostComponent {',
        '  readonly title = input("ready");',
        '}',
        '',
      ].join('\n'),
    );

    const componentResult = queryOverlay(root, 'app-inline-child template-component', ['--limit', '20', '--native-json']);
    const pipeResult = queryOverlay(root, 'inlineTitle template-pipe', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(componentResult);
    expectSpawnSuccess(pipeResult);
    const componentResponse = JSON.parse(componentResult.stdout);
    const pipeResponse = JSON.parse(pipeResult.stdout);
    expect(componentResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/app/features/inline/inline-host.component.ts',
        nodeName: 'app-inline-child',
        content: expect.stringContaining('<app-inline-child>'),
      }),
    ]));
    expect(pipeResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/app/features/inline/inline-host.component.ts',
        nodeName: 'inlineTitle',
        content: expect.stringContaining('| inlineTitle'),
      }),
    ]));
  });

  it('preserves repeated Angular template component and pipe usage locations', () => {
    const root = makeFixture();
    writeFile(
      root,
      'src/app/features/repeated/repeated-child.component.ts',
      [
        "import { Component, input } from '@angular/core';",
        '',
        '@Component({',
        "  selector: 'app-repeated-child',",
        '  standalone: true,',
        "  template: '<span>{{ label() }}</span>',",
        '})',
        'export class RepeatedChildComponent {',
        "  readonly label = input('');",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/features/repeated/repeated-title.pipe.ts',
      [
        "import { Pipe, PipeTransform } from '@angular/core';",
        '',
        "@Pipe({ name: 'repeatedTitle', standalone: true })",
        'export class RepeatedTitlePipe implements PipeTransform {',
        '  transform(value: string): string { return value; }',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/features/repeated/repeated-host.component.html',
      [
        '<section>',
        '  <app-repeated-child [label]="first()"></app-repeated-child>',
        '  <app-repeated-child [label]="second()"></app-repeated-child>',
        '  <p>{{ first() | repeatedTitle }}</p>',
        '  <p>{{ second() | repeatedTitle }}</p>',
        '</section>',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/features/repeated/repeated-host.component.ts',
      [
        "import { Component, input } from '@angular/core';",
        "import { RepeatedChildComponent } from './repeated-child.component';",
        "import { RepeatedTitlePipe } from './repeated-title.pipe';",
        '',
        '@Component({',
        "  selector: 'app-repeated-host',",
        '  standalone: true,',
        '  imports: [RepeatedChildComponent, RepeatedTitlePipe],',
        "  templateUrl: './repeated-host.component.html',",
        '})',
        'export class RepeatedHostComponent {',
        "  readonly first = input('one');",
        "  readonly second = input('two');",
        '}',
        '',
      ].join('\n'),
    );

    const componentResult = queryOverlay(root, 'template-component', ['--limit', '80', '--native-json']);
    const pipeResult = queryOverlay(root, 'template-pipe', ['--limit', '80', '--native-json']);

    expectSpawnSuccess(componentResult);
    expectSpawnSuccess(pipeResult);
    const componentResponse = JSON.parse(componentResult.stdout);
    const pipeResponse = JSON.parse(pipeResult.stdout);
    const repeatedComponentEdges = componentResponse.edges.filter((edge: { source?: string; target?: string }) => (
      edge.source === 'class:src/app/features/repeated/repeated-host.component.ts:RepeatedHostComponent'
      && edge.target === 'class:src/app/features/repeated/repeated-child.component.ts:RepeatedChildComponent'
    ));
    const repeatedPipeEdges = pipeResponse.edges.filter((edge: { source?: string; target?: string }) => (
      edge.source === 'class:src/app/features/repeated/repeated-host.component.ts:RepeatedHostComponent'
      && edge.target === 'class:src/app/features/repeated/repeated-title.pipe.ts:RepeatedTitlePipe'
    ));

    expect(repeatedComponentEdges.map((edge: { line?: number }) => edge.line).sort()).toEqual([2, 3]);
    expect(repeatedPipeEdges.map((edge: { line?: number }) => edge.line).sort()).toEqual([4, 5]);
    expect(componentResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/app/features/repeated/repeated-host.component.html',
        startLine: 2,
        nodeName: 'app-repeated-child',
      }),
    ]));
  });
}
