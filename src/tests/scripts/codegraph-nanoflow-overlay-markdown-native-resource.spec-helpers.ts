import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMarkdownNativeResourceSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { writeFile, expectSpawnSuccess, tempRoots, repoRoot, queryScriptPath } = context;

  it('prioritizes Angular external resource source blocks in strict native projections', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-angular-resource-codeblocks-'));
    tempRoots.push(root);
    writeFile(
      root,
      'src/app/sample-card.component.ts',
      [
        "import { Component } from '@angular/core';",
        '',
        '@Component({',
        "  selector: 'app-sample-card',",
        "  templateUrl: './sample-card.component.html',",
        "  styleUrl: './sample-card.component.css',",
        '})',
        'export class SampleCardComponent {',
        "  readonly title = 'Sample';",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/sample-card.component.html',
      [
        '<section class="sample-card">',
        '  <h2>{{ title }}</h2>',
        '</section>',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/sample-card.component.css',
      [
        '.sample-card {',
        '  display: grid;',
        '}',
        '',
      ].join('\n'),
    );

    const componentNode = {
      id: 'class:src/app/sample-card.component.ts:SampleCardComponent',
      kind: 'class',
      name: 'SampleCardComponent',
      qualifiedName: 'SampleCardComponent',
      filePath: 'src/app/sample-card.component.ts',
      language: 'typescript',
      startLine: 8,
      endLine: 10,
      signature: 'class SampleCardComponent',
      isExported: true,
    };
    const templateNode = {
      id: 'file:src/app/sample-card.component.html:src/app/sample-card.component.html',
      kind: 'file',
      name: 'src/app/sample-card.component.html',
      qualifiedName: 'src/app/sample-card.component.html',
      filePath: 'src/app/sample-card.component.html',
      language: 'html',
      startLine: 1,
      endLine: 3,
    };
    const styleNode = {
      id: 'file:src/app/sample-card.component.css:src/app/sample-card.component.css',
      kind: 'file',
      name: 'src/app/sample-card.component.css',
      qualifiedName: 'src/app/sample-card.component.css',
      filePath: 'src/app/sample-card.component.css',
      language: 'css',
      startLine: 1,
      endLine: 3,
    };
    writeFile(root, '.codegraph/nanoflow-overlay.json', JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/app/sample-card.component.ts'],
        classes: [componentNode],
        functions: [],
        interfaces: [],
        types: [],
        variables: [],
        enums: [],
        namespaces: [],
        imports: [],
        exports: [],
        parameters: [],
      },
      angular: {
        components: [componentNode],
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
      },
      graph: {
        nodes: [componentNode, templateNode, styleNode],
        edges: [
          {
            source: componentNode.id,
            target: templateNode.id,
            kind: 'imports',
            line: 5,
            column: 15,
            metadata: { relation: 'template-url' },
          },
          {
            source: componentNode.id,
            target: styleNode.id,
            kind: 'imports',
            line: 6,
            column: 12,
            metadata: { relation: 'style-url' },
          },
        ],
      },
    }, null, 2));

    const nativeJsonResult = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'template-url',
      '--limit',
      '20',
      '--json',
      '--native-json',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const nativeMarkdownResult = spawnSync(process.execPath, [
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

    expectSpawnSuccess(nativeJsonResult);
    expectSpawnSuccess(nativeMarkdownResult);

    const nativeJsonResponse = JSON.parse(nativeJsonResult.stdout);
    expect(nativeJsonResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/sample-card.component.html',
      language: 'html',
      nodeKind: 'file',
      content: expect.stringContaining('<section class="sample-card">'),
    }));
    expect(nativeJsonResponse.codeBlocks[0].filePath).not.toBe(componentNode.filePath);

    const styleBlockIndex = nativeMarkdownResult.stdout.indexOf('#### src/app/sample-card.component.css (src/app/sample-card.component.css:1)');
    const componentBlockIndex = nativeMarkdownResult.stdout.indexOf('#### SampleCardComponent (src/app/sample-card.component.ts:8)');
    expect(styleBlockIndex).toBeGreaterThanOrEqual(0);
    expect(componentBlockIndex).toBeGreaterThanOrEqual(0);
    expect(styleBlockIndex).toBeLessThan(componentBlockIndex);
    expect(nativeMarkdownResult.stdout).toContain('```css');
    expect(nativeMarkdownResult.stdout).not.toContain('```unknown');
    expect(nativeMarkdownResult.stdout).toContain('.sample-card {');
  });
}
