import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMarkdownNativeGeneratedPatternSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { writeFile, expectSpawnSuccess, tempRoots, repoRoot, queryScriptPath } = context;

  it('demotes official generated filename patterns after hand-written files in strict native Markdown', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-md-generated-patterns-'));
    tempRoots.push(root);
    writeFile(root, 'src/real.ts', 'export function GeneratedPatternTarget(): string { return "real"; }\n');
    writeFile(root, 'src/generated.pb.ts', 'export function GeneratedPatternTarget(): string { return "pb"; }\n');
    writeFile(root, 'src/model_pb.ts', 'export function GeneratedPatternTarget(): string { return "model"; }\n');
    writeFile(root, 'src/state.freezed.dart', 'String GeneratedPatternTarget() => "freezed";\n');
    const realNode = {
      id: 'function:src/real.ts:GeneratedPatternTarget',
      kind: 'function',
      name: 'GeneratedPatternTarget',
      qualifiedName: 'GeneratedPatternTarget',
      filePath: 'src/real.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      signature: '(): string',
      isExported: true,
    };
    const generatedNodes = [
      {
        ...realNode,
        id: 'function:src/generated.pb.ts:GeneratedPatternTarget',
        filePath: 'src/generated.pb.ts',
      },
      {
        ...realNode,
        id: 'function:src/model_pb.ts:GeneratedPatternTarget',
        filePath: 'src/model_pb.ts',
      },
      {
        ...realNode,
        id: 'function:src/state.freezed.dart:GeneratedPatternTarget',
        filePath: 'src/state.freezed.dart',
        language: 'dart',
      },
    ];
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/real.ts', 'src/generated.pb.ts', 'src/model_pb.ts', 'src/state.freezed.dart'],
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
        nodes: [realNode, ...generatedNodes],
        edges: [],
      },
    }, null, 2));

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'GeneratedPatternTarget',
      '--limit',
      '4',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    const realIndex = result.stdout.indexOf('src/real.ts:1');
    expect(realIndex).toBeGreaterThanOrEqual(0);
    for (const filePath of ['src/generated.pb.ts:1', 'src/model_pb.ts:1', 'src/state.freezed.dart:1']) {
      const generatedIndex = result.stdout.indexOf(filePath);
      expect(generatedIndex, `${filePath} should be shown`).toBeGreaterThanOrEqual(0);
      expect(generatedIndex, `${filePath} should be demoted after hand-written entry points`).toBeGreaterThan(realIndex);
    }
  });

  it('orders official generated filename patterns after hand-written entry points in strict native Markdown', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-generated-sort-'));
    tempRoots.push(root);
    writeFile(root, 'src/generated.gen.ts', 'export function GeneratedTarget(): string { return "generated"; }\n');
    writeFile(root, 'src/real.ts', 'export function GeneratedTarget(): string { return "real"; }\n');
    const generatedNode = {
      id: 'function:src/generated.gen.ts:GeneratedTarget',
      kind: 'function',
      name: 'GeneratedTarget',
      qualifiedName: 'GeneratedTarget',
      filePath: 'src/generated.gen.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      signature: '(): string',
      isExported: true,
    };
    const realNode = {
      ...generatedNode,
      id: 'function:src/real.ts:GeneratedTarget',
      filePath: 'src/real.ts',
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/generated.gen.ts', 'src/real.ts'],
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
        nodes: [generatedNode, realNode],
        edges: [],
      },
    }, null, 2));

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'GeneratedTarget',
      '--limit',
      '2',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    expect(result.stdout.indexOf('src/real.ts:1')).toBeLessThan(result.stdout.indexOf('src/generated.gen.ts:1'));
  });

  it('filters official generated filename patterns from related symbols in strict native Markdown', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-generated-related-sort-'));
    tempRoots.push(root);
    writeFile(root, 'src/anchor.ts', 'export function RelatedSortAnchor(): void {}\n');
    writeFile(root, 'src/generated.gen.ts', 'export function GeneratedRelated(): void {}\n');
    writeFile(root, 'src/real.ts', 'export function RealRelated(): void {}\n');
    const anchorNode = {
      id: 'function:src/anchor.ts:RelatedSortAnchor',
      kind: 'function',
      name: 'RelatedSortAnchor',
      qualifiedName: 'RelatedSortAnchor',
      filePath: 'src/anchor.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      signature: '(): void',
      isExported: true,
    };
    const generatedNode = {
      id: 'function:src/generated.gen.ts:GeneratedRelated',
      kind: 'function',
      name: 'GeneratedRelated',
      qualifiedName: 'GeneratedRelated',
      filePath: 'src/generated.gen.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      signature: '(): void',
      isExported: true,
    };
    const realNode = {
      id: 'function:src/real.ts:RealRelated',
      kind: 'function',
      name: 'RealRelated',
      qualifiedName: 'RealRelated',
      filePath: 'src/real.ts',
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
        files: ['src/anchor.ts', 'src/generated.gen.ts', 'src/real.ts'],
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
        nodes: [anchorNode, generatedNode, realNode],
        edges: [
          {
            source: anchorNode.id,
            target: generatedNode.id,
            kind: 'references',
            metadata: { relation: 'related-sort-fixture' },
          },
          {
            source: anchorNode.id,
            target: realNode.id,
            kind: 'references',
            metadata: { relation: 'related-sort-fixture' },
          },
        ],
      },
    }, null, 2));

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'related-sort-fixture',
      '--limit',
      '20',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('- src/real.ts: RealRelated:1');
    expect(result.stdout).not.toContain('- src/generated.gen.ts: GeneratedRelated:1');
    expect(result.stdout).toContain('#### GeneratedRelated (src/generated.gen.ts:1)');
  });

  it('lets explicit generated path relevance outrank generated-file demotion in strict native Markdown', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-md-generated-query-order-'));
    tempRoots.push(root);
    writeFile(root, 'src/real.ts', 'export function GeneratedQueryOrderTarget(): string { return "real"; }\n');
    writeFile(root, 'src/generated.pb.ts', 'export function GeneratedQueryOrderTarget(): string { return "pb"; }\n');
    const realNode = {
      id: 'function:src/real.ts:GeneratedQueryOrderTarget',
      kind: 'function',
      name: 'GeneratedQueryOrderTarget',
      qualifiedName: 'GeneratedQueryOrderTarget',
      filePath: 'src/real.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      signature: '(): string',
      isExported: true,
    };
    const generatedNode = {
      ...realNode,
      id: 'function:src/generated.pb.ts:GeneratedQueryOrderTarget',
      filePath: 'src/generated.pb.ts',
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/real.ts', 'src/generated.pb.ts'],
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
        nodes: [realNode, generatedNode],
        edges: [],
      },
    }, null, 2));

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'GeneratedQueryOrderTarget pb',
      '--limit',
      '2',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    const generatedIndex = result.stdout.indexOf('src/generated.pb.ts:1');
    const realIndex = result.stdout.indexOf('src/real.ts:1');
    expect(generatedIndex).toBeGreaterThanOrEqual(0);
    expect(realIndex).toBeGreaterThanOrEqual(0);
    expect(generatedIndex).toBeLessThan(realIndex);
  });
}
