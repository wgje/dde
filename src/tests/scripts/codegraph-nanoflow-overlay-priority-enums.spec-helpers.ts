import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayPriorityAndEnumSpecs(context: CodegraphOverlaySpecContext): void {
  const { writeFile, queryOverlay, expectSpawnSuccess, tempRoots, officialCodeGraphLanguages, officialCodeGraphNodeKinds } = context;
  it('prioritizes high-information native nodes when import matches would otherwise fill the query limit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-high-value-priority-'));
    tempRoots.push(root);
    const importNodes = Array.from({ length: 8 }, (_, index) => ({
      id: `import:src/import-${index}.ts:Injectable:@angular/core:Injectable:1`,
      kind: 'import',
      name: 'Injectable',
      qualifiedName: 'Injectable',
      filePath: `src/import-${index}.ts`,
      language: 'typescript',
      startLine: 1,
      endLine: 1,      startColumn: 0,
      endColumn: 0,
      signature: 'import Injectable from @angular/core',
      updatedAt: 1781055245312,
    }));
    for (const node of importNodes) {
      writeFile(root, node.filePath, "import { Injectable } from '@angular/core';\n");
    }
    writeFile(
      root,
      'src/sample.service.ts',
      [
        '@Injectable({ providedIn: "root" })',
        'export class SampleService {',
        '  touch(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    const classNode = {
      id: 'class:src/sample.service.ts:SampleService',
      kind: 'class',
      name: 'SampleService',
      qualifiedName: 'SampleService',
      filePath: 'src/sample.service.ts',
      language: 'typescript',
      startLine: 2,
      endLine: 4,
      startColumn: 0,
      endColumn: 1,
      signature: 'class SampleService',
      decorators: ['Injectable'],
      updatedAt: 1781055245312,
    };
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/sample.service.ts', ...importNodes.map(node => node.filePath)],
        classes: [],
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
        components: [],
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
        nodes: [...importNodes, classNode],
        edges: [],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'Injectable', ['--limit', '3']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'class', name: 'SampleService' }),
    ]));
    expect(response.matches[0]).toEqual(expect.objectContaining({
      kind: 'class',
      name: 'SampleService',
      file: 'src/sample.service.ts',
    }));
    expect(response.entryPoints).toEqual([
      expect.objectContaining({ kind: 'class', name: 'SampleService' }),
    ]);
  });

  it('keeps incidental substring matches out of native JSON entry points when an exact symbol matches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-exact-entrypoint-priority-'));
    tempRoots.push(root);
    writeFile(
      root,
      'src/utils/result.ts',
      [
        'export function map(value: string): string {',
        '  return value.toUpperCase();',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/flow-minimap.component.ts',
      [
        'export class FlowMinimapComponent {',
        '  render(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/flow-minimap.component.spec.ts',
      [
        'export function createFlowMinimapHarness(): void {',
        '  return;',
        '}',
        '',
      ].join('\n'),
    );

    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [
          'src/utils/result.ts',
          'src/app/flow-minimap.component.ts',
          'src/app/flow-minimap.component.spec.ts',
        ],
        classes: [],
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
        components: [],
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
        nodes: [
          {
            id: 'function:src/utils/result.ts:map',
            kind: 'function',
            name: 'map',
            qualifiedName: 'map',
            filePath: 'src/utils/result.ts',
            language: 'typescript',
            startLine: 1,
            endLine: 3,
            startColumn: 0,
            endColumn: 1,
            signature: 'function map(value: string): string',
            isExported: true,
            updatedAt: 1781055245312,
          },
          {
            id: 'class:src/app/flow-minimap.component.ts:FlowMinimapComponent',
            kind: 'class',
            name: 'FlowMinimapComponent',
            qualifiedName: 'FlowMinimapComponent',
            filePath: 'src/app/flow-minimap.component.ts',
            language: 'typescript',
            startLine: 1,
            endLine: 3,
            startColumn: 0,
            endColumn: 1,
            signature: 'class FlowMinimapComponent',
            isExported: true,
            updatedAt: 1781055245312,
          },
          {
            id: 'function:src/app/flow-minimap.component.spec.ts:createFlowMinimapHarness',
            kind: 'function',
            name: 'createFlowMinimapHarness',
            qualifiedName: 'createFlowMinimapHarness',
            filePath: 'src/app/flow-minimap.component.spec.ts',
            language: 'typescript',
            startLine: 1,
            endLine: 3,
            startColumn: 0,
            endColumn: 1,
            signature: 'function createFlowMinimapHarness(): void',
            isExported: true,
            updatedAt: 1781055245312,
          },
        ],
        edges: [],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'map', ['--limit', '10', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.entryPoints).toEqual([
      expect.objectContaining({ kind: 'function', name: 'map', filePath: 'src/utils/result.ts' }),
    ]);
    expect(response.codeBlocks.map((block: { nodeName?: string }) => block.nodeName)).toEqual(['map']);
  });


  it('does not treat unresolved external-reference placeholders as native JSON entry points', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-external-reference-priority-'));
    tempRoots.push(root);
    writeFile(
      root,
      'src/sample.service.ts',
      [
        "import { Injectable } from '@angular/core';",
        '',
        '@Injectable({ providedIn: "root" })',
        'export class InjectableService {',
        '  touch(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    const externalReference = {
      id: 'variable:src/sample.service.ts:Injectable',
      kind: 'variable',
      name: 'Injectable',
      qualifiedName: 'Injectable',
      filePath: 'src/sample.service.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      metadata: { relation: 'external-reference' },
      updatedAt: 1781055245312,
    };
    const classNode = {
      id: 'class:src/sample.service.ts:InjectableService',
      kind: 'class',
      name: 'InjectableService',
      qualifiedName: 'InjectableService',
      filePath: 'src/sample.service.ts',
      language: 'typescript',
      startLine: 4,
      endLine: 6,
      startColumn: 0,
      endColumn: 1,
      signature: 'class InjectableService',
      decorators: ['Injectable'],
      updatedAt: 1781055245312,
    };
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/sample.service.ts'],
        classes: [],
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
        components: [],
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
        nodes: [externalReference, classNode],
        edges: [],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'Injectable', ['--limit', '1']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual([
      expect.objectContaining({ kind: 'class', name: 'InjectableService' }),
    ]);
    expect(response.entryPoints).toEqual([
      expect.objectContaining({ kind: 'class', name: 'InjectableService' }),
    ]);
  });

  it('does not let unresolved decorator placeholder variables outrank native declarations', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-decorator-placeholder-priority-'));
    tempRoots.push(root);
    writeFile(
      root,
      'src/sample.service.ts',
      [
        "import { Injectable } from '@angular/core';",
        '',
        '@Injectable({ providedIn: "root" })',
        'export class InjectableService {',
        '  touch(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    const decoratorPlaceholder = {
      id: 'variable:src/sample.service.ts:Injectable',
      kind: 'variable',
      name: 'Injectable',
      qualifiedName: 'Injectable',
      filePath: 'src/sample.service.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      metadata: { relation: 'decorator' },
      updatedAt: 1781055245312,
    };
    const classNode = {
      id: 'class:src/sample.service.ts:InjectableService',
      kind: 'class',
      name: 'InjectableService',
      qualifiedName: 'InjectableService',
      filePath: 'src/sample.service.ts',
      language: 'typescript',
      startLine: 4,
      endLine: 6,
      startColumn: 0,
      endColumn: 1,
      signature: 'class InjectableService',
      decorators: ['Injectable'],
      updatedAt: 1781055245312,
    };
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/sample.service.ts'],
        classes: [],
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
        components: [],
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
        nodes: [decoratorPlaceholder, classNode],
        edges: [],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'Injectable', ['--limit', '1']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual([
      expect.objectContaining({ kind: 'class', name: 'InjectableService' }),
    ]);
    expect(response.entryPoints).toEqual([
      expect.objectContaining({ kind: 'class', name: 'InjectableService' }),
    ]);
  });

  it('uses only official CodeGraph Language enum values in JSON code blocks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-codeblock-language-'));
    tempRoots.push(root);
    writeFile(root, 'AGENTS.md', '# NanoFlow\n## 5. Hard Rules\n### ID Strategy\n');
    writeFile(root, 'src/template.html', '<button>{{ title() }}</button>\n');
    writeFile(root, 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql', 'alter table tasks alter column id drop default;\n');
    const nodes = [
      {
        id: 'variable:AGENTS.md:ID Strategy',
        kind: 'variable',
        name: 'ID Strategy',
        qualifiedName: 'ID Strategy',
        filePath: 'AGENTS.md',
        language: 'unknown',
        startLine: 3,
        endLine: 3,
        startColumn: 0,
        endColumn: 0,
        updatedAt: 1781055245312,
      },
      {
        id: 'variable:src/template.html:TemplateAnchor',
        kind: 'variable',
        name: 'TemplateAnchor',
        qualifiedName: 'TemplateAnchor',
        filePath: 'src/template.html',
        language: 'unknown',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: 1781055245312,
      },
      {
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:IdDefaultRisk',
        kind: 'variable',
        name: 'IdDefaultRisk',
        qualifiedName: 'IdDefaultRisk',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        language: 'unknown',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: 1781055245312,
      },
    ];
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [],
        classes: [],
        functions: [],
        interfaces: [],
        types: [],
        variables: [],        enums: [],
        namespaces: [],
        imports: [],
        exports: [],
        parameters: [],
      },
      angular: {
        components: [],
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
        nodes,
        edges: [],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'TemplateAnchor IdDefaultRisk ID Strategy', ['--limit', '10']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks.length).toBeGreaterThan(0);
    expect(response.codeBlocks.every((block: { language: string }) => (
      officialCodeGraphLanguages.has(block.language)
    ))).toBe(true);
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/template.html',
        language: 'html',
      }),
      expect.objectContaining({
        filePath: 'AGENTS.md',
        language: 'markdown',
      }),
      expect.objectContaining({
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        language: 'sql',
      }),
    ]));
    expect(response.markdown).toContain('```html');
    expect(response.markdown).toContain('```sql');
    expect(response.markdown).toContain('```markdown');
  });


}
