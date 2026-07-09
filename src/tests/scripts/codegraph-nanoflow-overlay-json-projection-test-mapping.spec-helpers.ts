import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayJsonProjectionTestMappingSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { makeFixture, writeFile, queryOverlay, expectSpawnSuccess, tempRoots, repoRoot, queryScriptPath } = context;

  it('includes test file endpoint code blocks for strict native JSON test mapping queries', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'same-basename', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBeGreaterThan(0);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'file',
        filePath: 'src/app/features/sample/sample.component.spec.ts',
      }),
    ]));
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/app/features/sample/sample.component.spec.ts',
        language: 'typescript',
        content: expect.stringContaining('describe("SampleComponent"'),
        nodeKind: 'file',
      }),
    ]));
  });

  it('includes test file endpoint code blocks for strict native Markdown test mapping queries', () => {
    const root = makeFixture();

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'same-basename',
      '--limit',
      '20',
      '--native-markdown',
      '--skip-refresh',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('## Code Context');
    expect(result.stdout).toContain('### Entry Points');
    expect(result.stdout).toContain('### Code');
    expect(result.stdout).toContain('### Relationships');
    expect(result.stdout).toContain('#### src/app/features/sample/sample.component.spec.ts (src/app/features/sample/sample.component.spec.ts:1)');
    expect(result.stdout).toContain('describe("SampleComponent"');
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
  });

  it('prioritizes test file endpoint code blocks when test mapping results exceed the native code block budget', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-test-endpoint-budget-'));
    tempRoots.push(root);
    const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];
    const nodes = [];
    const edges = [];

    for (const name of names) {
      const componentFile = `src/app/${name.toLowerCase()}.component.ts`;
      const specFile = `src/app/${name.toLowerCase()}.component.spec.ts`;
      writeFile(
        root,
        componentFile,
        [
          `export class ${name}Component {`,
          '  render(): void {}',
          '}',
          '',
        ].join('\n'),
      );
      writeFile(
        root,
        specFile,
        [
          `describe("${name}Component", () => {`,
          `  it("covers ${name}", () => expect(${JSON.stringify(name)}).toBeTruthy());`,
          '});',
          '',
        ].join('\n'),
      );
      const componentNode = {
        id: `component:${componentFile}:${name}Component`,
        kind: 'component',
        name: `${name}Component`,
        qualifiedName: `${name}Component`,
        filePath: componentFile,
        language: 'typescript',
        startLine: 1,
        endLine: 3,
      };
      const specFileNode = {
        id: `file:${specFile}`,
        kind: 'file',
        name: specFile,
        qualifiedName: specFile,
        filePath: specFile,
        language: 'typescript',
        startLine: 1,
        endLine: 3,
      };
      nodes.push(componentNode, specFileNode);
      edges.push({
        source: componentNode.id,
        target: specFileNode.id,
        kind: 'references',
        line: 1,
        column: 0,
        metadata: {
          relation: 'test',
          testMapping: 'same-basename',
        },
      });
    }

    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: names.flatMap(name => [
          `src/app/${name.toLowerCase()}.component.ts`,
          `src/app/${name.toLowerCase()}.component.spec.ts`,
        ]),
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
        nodes,
        edges,
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'same-basename', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const specCodeBlocks = response.codeBlocks.filter((block: { nodeKind?: string }) => block.nodeKind === 'file');
    expect(specCodeBlocks.length).toBeGreaterThan(0);
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/app/alpha.component.spec.ts',
        nodeKind: 'file',
        content: expect.stringContaining('describe("AlphaComponent"'),
      }),
    ]));
  });
}
