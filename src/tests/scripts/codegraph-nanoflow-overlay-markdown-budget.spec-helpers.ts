import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayMarkdownNativeProjectionSpecs } from './codegraph-nanoflow-overlay-markdown-native-projection.spec-helpers';
import { registerCodegraphOverlayMarkdownSourceSelectionSpecs } from './codegraph-nanoflow-overlay-markdown-source-selection.spec-helpers';

export function registerCodegraphOverlayMarkdownBudgetSpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, writeFile, runOverlay, queryOverlay, expectSpawnSuccess, tempRoots, repoRoot, queryScriptPath } = context;
  it('can emit the strict native CodeGraph Markdown formatter projection without NanoFlow extension sections', () => {
    const root = makeFixture();

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'SampleService',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('## Code Context');
    expect(result.stdout).toContain('**Query:** SampleService');
    expect(result.stdout).toContain('### Entry Points');
    expect(result.stdout).toContain('- **SampleService** (class) - src/app/features/sample/sample.service.ts:4');
    expect(result.stdout).toContain('### Code');
    expect(result.stdout).toContain('#### SampleService (src/app/features/sample/sample.service.ts:4)');
    expect(result.stdout).toContain('```typescript');
    expect(result.stdout).toContain('export class SampleService');
    expect(result.stdout).not.toContain('## Exploration: SampleService');
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
  }, 10_000);

  it('uses the full native class declaration for same-file component code blocks', () => {
    const root = makeFixture();

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'SampleComponent',
      '--limit',
      '1',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    const blockStart = result.stdout.indexOf('#### SampleComponent (src/app/features/sample/sample.component.ts:');
    const fenceStart = result.stdout.indexOf('```typescript', blockStart);
    const fenceEnd = result.stdout.indexOf('```\n', fenceStart + '```typescript'.length);
    const classLine = result.stdout.indexOf('export class SampleComponent', blockStart);

    expect(blockStart).toBeGreaterThanOrEqual(0);
    expect(fenceStart).toBeGreaterThan(blockStart);
    expect(fenceEnd).toBeGreaterThan(fenceStart);
    expect(classLine).toBeGreaterThan(fenceStart);
    expect(classLine).toBeLessThan(fenceEnd);
  }, 10_000);

  registerCodegraphOverlayMarkdownNativeProjectionSpecs(context);

  it('indexes spec and test TypeScript files as native graph symbols', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-test-symbols-'));
    tempRoots.push(root);
    writeFile(root, 'src/subject.ts', 'export function subject(): string { return "subject"; }\n');
    writeFile(
      root,
      'src/subject.spec.ts',
      [
        "import { subject } from './subject';",
        '',
        'export interface SubjectSpecHarness {',
        '  run(): string;',
        '}',
        '',
        'export function createSubjectSpecHarness(): SubjectSpecHarness {',
        '  return { run: subject };',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/standalone.test.ts',
      [
        'export type StandaloneTestCase = {',
        '  name: string;',
        '};',
        '',
        'export const standaloneTestCase: StandaloneTestCase = { name: "case" };',
        '',
      ].join('\n'),
    );

    const result = runOverlay(root);

    expectSpawnSuccess(result);
    const overlay = JSON.parse(result.stdout);
    expect(overlay.typescript.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'src/subject.spec.ts', language: 'typescript' }),
      expect.objectContaining({ file: 'src/standalone.test.ts', language: 'typescript' }),
    ]));
    expect(overlay.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'interface',
        name: 'SubjectSpecHarness',
        filePath: 'src/subject.spec.ts',
      }),
      expect.objectContaining({
        kind: 'function',
        name: 'createSubjectSpecHarness',
        filePath: 'src/subject.spec.ts',
      }),
      expect.objectContaining({
        kind: 'type_alias',
        name: 'StandaloneTestCase',
        filePath: 'src/standalone.test.ts',
      }),
      expect.objectContaining({
        kind: 'constant',
        name: 'standaloneTestCase',
        filePath: 'src/standalone.test.ts',
      }),
    ]));
  });

  it('caps Markdown relationship groups with the native CodeGraph medium-repo budget without dropping JSON edges', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-budget-'));
    tempRoots.push(root);
    const sourceFile = 'src/relationship-budget.ts';
    writeFile(
      root,
      sourceFile,
      [
        'export interface RelationshipBudgetAnchor {}',
        ...Array.from({ length: 12 }, (_, index) => `export interface BudgetDependency${index + 1} {}`),
        '',
      ].join('\n'),
    );
    const anchor = {
      id: `interface:${sourceFile}:RelationshipBudgetAnchor`,
      kind: 'interface',
      name: 'RelationshipBudgetAnchor',
      qualifiedName: 'RelationshipBudgetAnchor',
      filePath: sourceFile,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const dependencies = Array.from({ length: 12 }, (_, index) => ({
      id: `interface:${sourceFile}:BudgetDependency${index + 1}`,
      kind: 'interface',
      name: `BudgetDependency${index + 1}`,
      qualifiedName: `BudgetDependency${index + 1}`,
      filePath: sourceFile,
      language: 'typescript',
      startLine: index + 2,
      endLine: index + 2,
    }));
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: Array.from({ length: 642 }, (_, index) => `src/file-${index}.ts`),
        classes: [],
        functions: [],
        interfaces: [anchor, ...dependencies],
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
        nodes: [anchor, ...dependencies],
        edges: dependencies.map(dependency => ({
          kind: 'type_of',
          source: anchor.id,
          target: dependency.id,
          metadata: { relation: 'type-reference' },
        })),
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const jsonResult = queryOverlay(root, 'RelationshipBudgetAnchor', ['--limit', '40']);
    expectSpawnSuccess(jsonResult);
    const response = JSON.parse(jsonResult.stdout);
    expect(response.relationshipGroups.type_of).toHaveLength(12);

    const markdownResult = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'RelationshipBudgetAnchor',
      '--limit',
      '40',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(markdownResult);
    const typeOfSection = markdownResult.stdout.match(/\*\*type_of:\*\*\n([\s\S]*?)(?:\n\n|$)/)?.[1] ?? '';
    const shownEdges = typeOfSection.split('\n').filter(line => line.startsWith('- RelationshipBudgetAnchor → BudgetDependency'));
    expect(shownEdges).toHaveLength(10);
    expect(typeOfSection).toContain('- ... and 2 more');
  });

  it('uses the native CodeGraph medium-repo source block budget for Markdown and not-shown entries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-source-budget-'));
    tempRoots.push(root);
    const nodes = Array.from({ length: 9 }, (_, index) => {
      const number = index + 1;
      const filePath = `src/source-budget-${number}.ts`;
      writeFile(root, filePath, `export interface SourceBudget${number} { value: number; }\n`);
      return {
        id: `interface:${filePath}:SourceBudget${number}`,
        kind: 'interface',
        name: `SourceBudget${number}`,
        qualifiedName: `SourceBudget${number}`,
        filePath,
        language: 'typescript',
        startLine: 1,
        endLine: 1,
      };
    });
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: Array.from({ length: 642 }, (_, index) => `src/file-${index}.ts`),
        classes: [],
        functions: [],
        interfaces: nodes,
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

    const result = queryOverlay(root, 'SourceBudget', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const sourceHeaders = response.markdown.match(/^#### src\/source-budget-\d+\.ts/mg) ?? [];
    expect(sourceHeaders).toHaveLength(8);
    expect(response.markdown).toContain('#### src/source-budget-8.ts');
    expect(response.markdown).not.toContain('#### src/source-budget-9.ts');
    expect(response.notShown).toEqual([
      expect.objectContaining({
        filePath: 'src/source-budget-9.ts',
        symbols: ['SourceBudget9:1'],
      }),
    ]);
  });

  it('caps source block header symbols with the native CodeGraph small-repo budget', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-header-budget-'));
    tempRoots.push(root);
    const sourceFile = 'src/header-budget.ts';
    writeFile(
      root,
      sourceFile,
      Array.from({ length: 7 }, (_, index) => `export function HeaderBudgetSymbol${index + 1}(): void {}`).join('\n'),
    );
    const nodes = Array.from({ length: 7 }, (_, index) => ({
      id: `function:${sourceFile}:HeaderBudgetSymbol${index + 1}`,
      kind: 'function',
      name: `HeaderBudgetSymbol${index + 1}`,
      qualifiedName: `HeaderBudgetSymbol${index + 1}`,
      filePath: sourceFile,
      language: 'typescript',
      startLine: index + 1,
      endLine: index + 1,
    }));
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

    const result = queryOverlay(root, 'HeaderBudgetSymbol', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const header = response.markdown.match(/^#### src\/header-budget\.ts — .+$/m)?.[0] ?? '';
    expect(header).toContain('HeaderBudgetSymbol1(function)');
    expect(header).toContain('HeaderBudgetSymbol5(function)');
    expect(header).toContain('+2 more');
    expect(header).not.toContain('HeaderBudgetSymbol6(function)');
  });

  it('merges source windows with the native CodeGraph medium-repo gap threshold', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-gap-budget-'));
    tempRoots.push(root);
    const sourceFile = 'src/gap-budget.ts';
    writeFile(
      root,
      sourceFile,
      [
        'export function GapBudgetAnchor(): void {}',
        ...Array.from({ length: 18 }, (_, index) => `const filler${index + 1} = ${index + 1};`),
        'export function GapBudgetNeighbor(): void {}',
      ].join('\n'),
    );
    const nodes = [
      {
        id: `function:${sourceFile}:GapBudgetAnchor`,
        kind: 'function',
        name: 'GapBudgetAnchor',
        qualifiedName: 'GapBudgetAnchor',
        filePath: sourceFile,
        language: 'typescript',
        startLine: 1,
        endLine: 1,
      },
      {
        id: `function:${sourceFile}:GapBudgetNeighbor`,
        kind: 'function',
        name: 'GapBudgetNeighbor',
        qualifiedName: 'GapBudgetNeighbor',
        filePath: sourceFile,
        language: 'typescript',
        startLine: 20,
        endLine: 20,
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

    const result = queryOverlay(root, 'GapBudget', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.markdown).toContain('1\texport function GapBudgetAnchor(): void {}');
    expect(response.markdown).toContain('20\texport function GapBudgetNeighbor(): void {}');
    expect(response.markdown).not.toContain('... (gap) ...');
  });

  it('applies native CodeGraph small-repo Markdown budget flags without dropping JSON context', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-small-budget-'));
    tempRoots.push(root);
    const nodes = Array.from({ length: 5 }, (_, index) => {
      const number = index + 1;
      const filePath = `src/small-budget-${number}.ts`;
      writeFile(root, filePath, `export interface SmallBudget${number} { value: number; }\n`);
      return {
        id: `interface:${filePath}:SmallBudget${number}`,
        kind: 'interface',
        name: `SmallBudget${number}`,
        qualifiedName: `SmallBudget${number}`,
        filePath,
        language: 'typescript',
        startLine: 1,
        endLine: 1,
      };
    });
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: Array.from({ length: 120 }, (_, index) => `src/file-${index}.ts`),
        classes: [],
        functions: [],
        interfaces: nodes,
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
        edges: nodes.slice(1).map(node => ({
          kind: 'type_of',
          source: nodes[0].id,
          target: node.id,
          metadata: { relation: 'type-reference' },
        })),
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'SmallBudget', ['--limit', '10']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.relationshipGroups.type_of).toHaveLength(4);
    expect(response.notShown).toEqual([
      expect.objectContaining({
        filePath: 'src/small-budget-5.ts',
        symbols: ['SmallBudget5:1'],
      }),
    ]);
    const sourceHeaders = response.markdown.match(/^#### src\/small-budget-\d+\.ts/mg) ?? [];
    expect(sourceHeaders).toHaveLength(4);
    expect(response.markdown).not.toContain('### Relationships');
    expect(response.markdown).not.toContain('### Not shown above');
    expect(response.markdown).not.toContain('Complete source for');
    expect(response.markdown).not.toContain('Explore budget:');
  });

  registerCodegraphOverlayMarkdownSourceSelectionSpecs(context);
}
