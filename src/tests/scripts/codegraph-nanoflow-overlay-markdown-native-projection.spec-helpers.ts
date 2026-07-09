import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayMarkdownNativeGeneratedPatternSpecs } from './codegraph-nanoflow-overlay-markdown-native-generated-patterns.spec-helpers';
import { registerCodegraphOverlayMarkdownNativeResourceSpecs } from './codegraph-nanoflow-overlay-markdown-native-resource.spec-helpers';

export function registerCodegraphOverlayMarkdownNativeProjectionSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { writeFile, expectSpawnSuccess, tempRoots, repoRoot, queryScriptPath } = context;

  it('keeps strict native Markdown section order stable without NanoFlow extension sections', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-md-section-order-'));
    tempRoots.push(root);
    writeFile(root, 'src/anchor.ts', [
      'export function NativeSectionAnchor(): void {',
      '  NativeSectionRelated();',
      '}',
      '',
    ].join('\n'));
    writeFile(root, 'src/related.ts', [
      'export function NativeSectionRelated(): void {}',
      '',
    ].join('\n'));
    const anchorNode = {
      id: 'function:src/anchor.ts:NativeSectionAnchor',
      kind: 'function',
      name: 'NativeSectionAnchor',
      qualifiedName: 'NativeSectionAnchor',
      filePath: 'src/anchor.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 3,
      signature: '(): void',
      isExported: true,
    };
    const relatedNode = {
      id: 'function:src/related.ts:NativeSectionRelated',
      kind: 'function',
      name: 'NativeSectionRelated',
      qualifiedName: 'NativeSectionRelated',
      filePath: 'src/related.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      signature: '(): void',
      isExported: true,
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/anchor.ts', 'src/related.ts'],
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
        nodes: [anchorNode, relatedNode],
        edges: [{
          source: anchorNode.id,
          target: relatedNode.id,
          kind: 'references',
          line: 2,
          column: 3,
          metadata: {
            relation: 'native-section-order-fixture',
            diagnostic: 'strict-native-metadata-leak-sentinel',
          },
          provenance: { source: 'strict-native-provenance-leak-sentinel' },
        }],
      },
    }, null, 2));

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'native-section-order-fixture',
      '--limit',
      '20',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    const sectionIndexes = [
      '## Code Context',
      '### Entry Points',
      '### Relationships',
      '### Related Symbols',
      '### Code',
    ].map(section => result.stdout.indexOf(section));
    expect(sectionIndexes.every(index => index >= 0)).toBe(true);
    expect(sectionIndexes).toEqual([...sectionIndexes].sort((left, right) => left - right));
    expect(result.stdout).toContain('**references:**');
    expect(result.stdout).toContain('- NativeSectionAnchor -> NativeSectionRelated (line 2, column 3)');
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
    expect(result.stdout).not.toContain('### Not shown above');
    expect(result.stdout).not.toContain('(relation:');
    expect(result.stdout).not.toContain('metadata');
    expect(result.stdout).not.toContain('provenance');
    expect(result.stdout).not.toContain('strict-native-metadata-leak-sentinel');
    expect(result.stdout).not.toContain('strict-native-provenance-leak-sentinel');
  });

  registerCodegraphOverlayMarkdownNativeGeneratedPatternSpecs(context);

  it('omits undefined line suffixes from strict native Markdown related symbols', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-md-related-lines-'));
    tempRoots.push(root);
    writeFile(root, 'src/anchor.ts', 'export function RelatedLineAnchor(): void {}\n');
    writeFile(root, 'src/related.ts', 'export const relatedWithoutLine = true;\n');
    const anchorNode = {
      id: 'function:src/anchor.ts:RelatedLineAnchor',
      kind: 'function',
      name: 'RelatedLineAnchor',
      qualifiedName: 'RelatedLineAnchor',
      filePath: 'src/anchor.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      signature: '(): void',
      isExported: true,
    };
    const relatedNode = {
      id: 'constant:src/related.ts:relatedWithoutLine',
      kind: 'constant',
      name: 'relatedWithoutLine',
      qualifiedName: 'relatedWithoutLine',
      filePath: 'src/related.ts',
      language: 'typescript',
      signature: 'const relatedWithoutLine: boolean',
      isExported: true,
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/anchor.ts', 'src/related.ts'],
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
        nodes: [anchorNode, relatedNode],
        edges: [{
          source: anchorNode.id,
          target: relatedNode.id,
          kind: 'references',
          metadata: { relation: 'related-line-fixture' },
        }],
      },
    }, null, 2));

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'related-line-fixture',
      '--limit',
      '20',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('- src/related.ts: relatedWithoutLine');
    expect(result.stdout).not.toContain('relatedWithoutLine:undefined');
  });

  it('infers markdown language for strict native Markdown code blocks with unknown node language', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-md-language-'));
    tempRoots.push(root);
    writeFile(root, 'docs/quality.md', [
      '# MarkdownLanguageProbe',
      '',
      'This document should render with a markdown fence.',
      '',
    ].join('\n'));
    const markdownNode = {
      id: 'file:docs/quality.md',
      kind: 'file',
      name: 'MarkdownLanguageProbe',
      qualifiedName: 'MarkdownLanguageProbe',
      filePath: 'docs/quality.md',
      language: 'unknown',
      startLine: 1,
      endLine: 3,
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify({
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
        nodes: [markdownNode],
        edges: [],
      },
    }, null, 2));

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'MarkdownLanguageProbe',
      '--limit',
      '5',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('```markdown');
    expect(result.stdout).not.toContain('```unknown');
  });

  it('prints strict native Markdown empty-state rows for zero-result queries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-md-empty-'));
    tempRoots.push(root);
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify({
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
        nodes: [],
        edges: [],
      },
    }, null, 2));

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'zzzz-native-empty-output-probe',
      '--limit',
      '5',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('- No entry points found.');
    expect(result.stdout).toContain('- No relationships found.');
    expect(result.stdout).toContain('- No related symbols found.');
    expect(result.stdout).toContain('- No code blocks found.');
  });

  it('marks strict native Markdown related-symbol truncation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-md-related-budget-'));
    tempRoots.push(root);
    writeFile(root, 'src/anchor.ts', [
      'export function NativeRelatedBudgetAnchor(): void {}',
      '',
    ].join('\n'));
    writeFile(root, 'src/related.ts', [
      ...Array.from({ length: 12 }, (_, index) => `export function NativeRelatedBudgetRelated${String(index + 1).padStart(2, '0')}(): void {}`),
      '',
    ].join('\n'));
    const anchorNode = {
      id: 'function:src/anchor.ts:NativeRelatedBudgetAnchor',
      kind: 'function',
      name: 'NativeRelatedBudgetAnchor',
      qualifiedName: 'NativeRelatedBudgetAnchor',
      filePath: 'src/anchor.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      isExported: true,
    };
    const relatedNodes = Array.from({ length: 12 }, (_, index) => ({
      id: `function:src/related.ts:NativeRelatedBudgetRelated${String(index + 1).padStart(2, '0')}`,
      kind: 'function',
      name: `NativeRelatedBudgetRelated${String(index + 1).padStart(2, '0')}`,
      qualifiedName: `NativeRelatedBudgetRelated${String(index + 1).padStart(2, '0')}`,
      filePath: 'src/related.ts',
      language: 'typescript',
      startLine: index + 1,
      endLine: index + 1,
      isExported: true,
    }));
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/anchor.ts', 'src/related.ts'],
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
        nodes: [anchorNode, ...relatedNodes],
        edges: relatedNodes.map(node => ({
          source: anchorNode.id,
          target: node.id,
          kind: 'references',
          metadata: { relation: 'native-related-budget-fixture' },
        })),
      },
    }, null, 2));

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'native-related-budget-fixture',
      '--limit',
      '20',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('- +2 more related symbols omitted by native Markdown budget.');
  });

  it('marks strict native Markdown code-block budget truncation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-md-code-budget-'));
    tempRoots.push(root);
    writeFile(root, 'src/code-budget.ts', [
      ...Array.from({ length: 7 }, (_, index) => `export function NativeCodeBudget${String(index + 1).padStart(2, '0')}(): void {}`),
      '',
    ].join('\n'));
    const nodes = Array.from({ length: 7 }, (_, index) => ({
      id: `function:src/code-budget.ts:NativeCodeBudget${String(index + 1).padStart(2, '0')}`,
      kind: 'function',
      name: `NativeCodeBudget${String(index + 1).padStart(2, '0')}`,
      qualifiedName: `NativeCodeBudget${String(index + 1).padStart(2, '0')}`,
      filePath: 'src/code-budget.ts',
      language: 'typescript',
      startLine: index + 1,
      endLine: index + 1,
      isExported: true,
    }));
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/code-budget.ts'],
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
        edges: [],
      },
    }, null, 2));

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'NativeCodeBudget',
      '--limit',
      '20',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('- Code block budget reached; additional matching nodes may have omitted source.');
  });

  it('omits undefined file names from strict native Markdown entry point symbols', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-md-related-files-'));
    tempRoots.push(root);
    writeFile(root, 'src/anchor.ts', 'export function RelatedFileAnchor(): void {}\n');
    const anchorNode = {
      id: 'function:src/anchor.ts:RelatedFileAnchor',
      kind: 'function',
      name: 'RelatedFileAnchor',
      qualifiedName: 'RelatedFileAnchor',
      filePath: 'src/anchor.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      signature: '(): void',
      isExported: true,
    };
    const relatedNode = {
      id: 'variable:virtual:relatedWithoutFile',
      kind: 'variable',
      name: 'relatedWithoutFile',
      qualifiedName: 'relatedWithoutFile',
      language: 'unknown',
      startLine: 1,
      endLine: 1,
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/code-line-anchor.ts'],
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
        nodes: [anchorNode, relatedNode],
        edges: [{
          source: anchorNode.id,
          target: relatedNode.id,
          kind: 'references',
          metadata: { relation: 'related-file-fixture' },
        }],
      },
    }, null, 2));

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'related-file-fixture',
      '--limit',
      '20',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('- **relatedWithoutFile** (variable) - (unknown):1');
    expect(result.stdout).not.toContain('- **relatedWithoutFile** (variable) - undefined:1');
  });

  registerCodegraphOverlayMarkdownNativeResourceSpecs(context);
}
