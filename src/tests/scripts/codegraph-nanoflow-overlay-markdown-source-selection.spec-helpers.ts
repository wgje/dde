import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMarkdownSourceSelectionSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { makeFixture, writeFile, queryOverlay, expectSpawnSuccess, tempRoots, repoRoot, queryScriptPath } = context;

  it('hard-drops low-value spec source blocks in small-repo Markdown unless the query asks for tests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-small-low-value-'));
    tempRoots.push(root);
    writeFile(
      root,
      'src/budget-subject.ts',
      [
        'export function BudgetSubject(): string {',
        "  return 'subject';",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/budget-subject.spec.ts',
      [
        "import { BudgetSubject } from './budget-subject';",
        '',
        'export function BudgetSubjectSpec(): string {',
        '  return BudgetSubject();',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/budget-helper.ts',
      [
        'export function BudgetSubjectHelper(): string {',
        "  return 'helper';",
        '}',
        '',
      ].join('\n'),
    );
    const nodes = [
      {
        id: 'function:src/budget-subject.ts:BudgetSubject',
        kind: 'function',
        name: 'BudgetSubject',
        qualifiedName: 'BudgetSubject',
        filePath: 'src/budget-subject.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 3,
      },
      {
        id: 'function:src/budget-subject.spec.ts:BudgetSubjectSpec',
        kind: 'function',
        name: 'BudgetSubjectSpec',
        qualifiedName: 'BudgetSubjectSpec',
        filePath: 'src/budget-subject.spec.ts',
        language: 'typescript',
        startLine: 3,
        endLine: 5,
      },
      {
        id: 'function:src/budget-helper.ts:BudgetSubjectHelper',
        kind: 'function',
        name: 'BudgetSubjectHelper',
        qualifiedName: 'BudgetSubjectHelper',
        filePath: 'src/budget-helper.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 3,
      },
    ];
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: Array.from({ length: 120 }, (_, index) => `src/file-${index}.ts`),
        classes: [],
        functions: nodes,
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
        edges: [],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const defaultResult = queryOverlay(root, 'BudgetSubject', ['--limit', '10']);
    const specQueryResult = queryOverlay(root, 'BudgetSubject spec', ['--limit', '10']);

    expectSpawnSuccess(defaultResult);
    expectSpawnSuccess(specQueryResult);
    const defaultResponse = JSON.parse(defaultResult.stdout);
    expect(defaultResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: 'src/budget-subject.spec.ts' }),
    ]));
    expect(defaultResponse.markdown).toContain('- src/budget-subject.spec.ts: BudgetSubjectSpec:3');
    expect(defaultResponse.markdown).toContain('#### src/budget-subject.ts');
    expect(defaultResponse.markdown).toContain('#### src/budget-helper.ts');
    expect(defaultResponse.markdown).not.toContain('#### src/budget-subject.spec.ts');

    const specQueryResponse = JSON.parse(specQueryResult.stdout);
    expect(specQueryResponse.markdown).toContain('#### src/budget-subject.spec.ts');
  });

  it('lists low-value files as not shown when medium-repo Markdown omits their source blocks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-low-value-not-shown-'));
    tempRoots.push(root);
    writeFile(
      root,
      'src/budget-alpha.ts',
      [
        'export function BudgetSubjectAlpha(): string {',
        "  return 'alpha';",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/budget-beta.ts',
      [
        'export function BudgetSubjectBeta(): string {',
        "  return 'beta';",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/budget-subject.spec.ts',
      [
        "import { BudgetSubjectAlpha } from './budget-alpha';",
        '',
        'export function BudgetSubjectSpec(): string {',
        '  return BudgetSubjectAlpha();',
        '}',
        '',
      ].join('\n'),
    );
    const nodes = [
      {
        id: 'function:src/budget-alpha.ts:BudgetSubjectAlpha',
        kind: 'function',
        name: 'BudgetSubjectAlpha',
        qualifiedName: 'BudgetSubjectAlpha',
        filePath: 'src/budget-alpha.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 3,
      },
      {
        id: 'function:src/budget-beta.ts:BudgetSubjectBeta',
        kind: 'function',
        name: 'BudgetSubjectBeta',
        qualifiedName: 'BudgetSubjectBeta',
        filePath: 'src/budget-beta.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 3,
      },
      {
        id: 'function:src/budget-subject.spec.ts:BudgetSubjectSpec',
        kind: 'function',
        name: 'BudgetSubjectSpec',
        qualifiedName: 'BudgetSubjectSpec',
        filePath: 'src/budget-subject.spec.ts',
        language: 'typescript',
        startLine: 3,
        endLine: 5,
      },
    ];
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: Array.from({ length: 642 }, (_, index) => `src/file-${index}.ts`),
        classes: [],
        functions: nodes,
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
        edges: [],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'BudgetSubject', ['--limit', '10']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.markdown).not.toContain('#### src/budget-subject.spec.ts');
    expect(response.notShown).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/budget-subject.spec.ts',
        symbols: ['BudgetSubjectSpec:3'],
      }),
    ]));
    expect(response.markdown).toContain('### Not shown above — explore these names for their source');
    expect(response.markdown).toContain('- src/budget-subject.spec.ts: BudgetSubjectSpec:3');
  });

  it('omits native CodeGraph not-shown and budget guidance for small overlay fixtures', () => {
    const root = makeFixture();

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'SampleComponent SampleDirective SampleTitlePipe LazyPanelComponent createDefault createLegacy createDuplicate',
      '--limit',
      '80',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    expect(result.stdout).not.toContain('### Not shown above — explore these names for their source');
    expect(result.stdout).not.toContain('Complete source for');
    expect(result.stdout).not.toContain('Explore budget:');
  });
}
