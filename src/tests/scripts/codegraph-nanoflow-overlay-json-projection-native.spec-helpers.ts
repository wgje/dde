import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { writeEdgeFunctionFixtureOverlay } from './codegraph-nanoflow-overlay-query-edge-function-fixtures.spec-helpers';

export function registerCodegraphOverlayJsonProjectionNativeSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { repoRoot, queryScriptPath, makeFixture, writeFile, queryOverlay, expectSpawnSuccess, tempRoots } = context;

  it('queries native TypeScript graph symbols from overlay output', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'createSample');

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'function',
        name: 'createSample',
        file: 'src/app/features/sample/sample-domain.ts',
      }),
    ]));
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'function', name: 'createSample' }),
      expect.objectContaining({ kind: 'class', name: 'SampleEntity' }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'returns' }),
      expect.objectContaining({ kind: 'instantiates' }),
    ]));
    expect(response.markdown).toContain('## Exploration: createSample');
    expect(response.markdown).not.toContain('### Relationships');
  });

  it('returns official Edge-shaped edges beside display-enriched overlay edges', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'SampleEntity Trace', ['--limit', '80']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const allowedNativeEdgeKeys = new Set([
      'source',
      'target',
      'kind',
      'metadata',
      'line',
      'column',
      'provenance',
    ]);
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'decorates',
        source: 'class:src/app/features/sample/sample-domain.ts:SampleEntity',
        target: 'function:src/app/features/sample/sample-domain.ts:Trace',
        line: expect.any(Number),
        column: expect.any(Number),
        metadata: expect.objectContaining({ relation: 'decorator' }),
      }),
    ]));
    expect(response).not.toHaveProperty('nativeEdges');
    expect(response.displayEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'decorates',
        sourceName: 'SampleEntity',
        targetName: 'Trace',
      }),
    ]));
    for (const edge of response.edges as Array<Record<string, unknown>>) {
      expect(edge).not.toHaveProperty('sourceName');
      expect(edge).not.toHaveProperty('targetName');
      expect(Object.keys(edge).every(key => allowedNativeEdgeKeys.has(key))).toBe(true);
    }
  });

  it('returns native CodeGraph Node location fields for every selected graph node', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'SampleEntity Trace Injectable', ['--limit', '120']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    for (const node of response.nodes as Array<Record<string, unknown>>) {
      expect(node).toEqual(expect.objectContaining({
        startLine: expect.any(Number),
        endLine: expect.any(Number),
        startColumn: expect.any(Number),
        endColumn: expect.any(Number),
      }));
      expect(node.startLine).toBeGreaterThanOrEqual(1);
      expect(node.endLine).toBeGreaterThanOrEqual(node.startLine as number);
      expect(node.startColumn).toBeGreaterThanOrEqual(0);
      expect(node.endColumn).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns a native CodeGraph TaskContext-style JSON projection', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'SampleService');

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response).toEqual(expect.objectContaining({
      query: 'SampleService',
      summary: expect.any(String),
      entryPoints: expect.any(Array),
      nodes: expect.any(Array),
      edges: expect.any(Array),
      codeBlocks: expect.any(Array),
      relatedFiles: expect.any(Array),
      stats: expect.objectContaining({
        nodeCount: response.nodes.length,
        edgeCount: response.edges.length,
        fileCount: expect.any(Number),
        codeBlockCount: expect.any(Number),
        totalCodeSize: expect.any(Number),
      }),
    }));
    expect(response.summary).toMatch(/Found \d+ relevant code symbols across \d+ files\./);
    expect(response.entryPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'class',
        name: 'SampleService',
        filePath: 'src/app/features/sample/sample.service.ts',
      }),
    ]));
    expect(response.relatedFiles).toEqual(expect.arrayContaining([
      'src/app/features/sample/sample.service.ts',
    ]));
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/app/features/sample/sample.service.ts',
        startLine: expect.any(Number),
        endLine: expect.any(Number),
        language: 'typescript',
        content: expect.stringContaining('export class SampleService'),
        nodeName: 'SampleService',
        nodeKind: 'class',
      }),
    ]));
  });

  it('can emit the strict native CodeGraph JSON formatter projection without NanoFlow extension fields', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'SampleEntity Trace', ['--limit', '80', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(Object.keys(response)).toEqual([
      'query',
      'summary',
      'entryPoints',
      'nodes',
      'edges',
      'codeBlocks',
      'relatedFiles',
      'stats',
    ]);
    expect(response).not.toHaveProperty('markdown');
    expect(response).not.toHaveProperty('matches');
    expect(response).not.toHaveProperty('displayEdges');
    expect(response).not.toHaveProperty('relationshipGroups');
    expect(response).not.toHaveProperty('coverage');

    const officialJsonNodeKeys = new Set([
      'id',
      'kind',
      'name',
      'qualifiedName',
      'filePath',
      'language',
      'startLine',
      'endLine',
      'startColumn',
      'endColumn',
      'signature',
      'docstring',
      'visibility',
      'isExported',
      'isAsync',
      'isStatic',
      'isAbstract',
    ]);
    const officialJsonEdgeKeys = new Set(['source', 'target', 'kind', 'line', 'column']);
    const officialJsonCodeBlockKeys = new Set([
      'filePath',
      'startLine',
      'endLine',
      'language',
      'content',
      'nodeName',
      'nodeKind',
    ]);

    expect(response.entryPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'class', name: 'SampleEntity' }),
    ]));
    for (const node of [...response.entryPoints, ...response.nodes] as Array<Record<string, unknown>>) {
      expect(Object.keys(node).every(key => officialJsonNodeKeys.has(key))).toBe(true);
      expect(node).not.toHaveProperty('metadata');
      expect(node).not.toHaveProperty('decorators');
      expect(node).not.toHaveProperty('typeParameters');
      expect(node).not.toHaveProperty('updatedAt');
    }
    for (const edge of response.edges as Array<Record<string, unknown>>) {
      expect(Object.keys(edge).every(key => officialJsonEdgeKeys.has(key))).toBe(true);
      expect(edge).not.toHaveProperty('metadata');
      expect(edge).not.toHaveProperty('sourceName');
      expect(edge).not.toHaveProperty('targetName');
      expect(edge).not.toHaveProperty('provenance');
    }
    for (const block of response.codeBlocks as Array<Record<string, unknown>>) {
      expect(Object.keys(block).every(key => officialJsonCodeBlockKeys.has(key))).toBe(true);
      expect(block).toEqual(expect.objectContaining({
        language: expect.any(String),
        content: expect.any(String),
      }));
    }
  });

  it('preserves schema-valid falsy native node fields with source columns', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-json-falsy-node-'));
    tempRoots.push(root);
    const entry = 'src/sample.ts';
    writeFile(root, entry, 'function internalHelper() { return 1; }\n');
    writeEdgeFunctionFixtureOverlay(root, {
      files: [entry],
      nodes: [{
        id: `function:${entry}:internalHelper`,
        kind: 'function',
        name: 'internalHelper',
        qualifiedName: 'internalHelper',
        filePath: entry,
        language: 'typescript',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        isExported: false,
      }],
      edges: [],
    });

    const result = queryOverlay(root, 'internalHelper', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout) as {
      nodes: Array<Record<string, unknown>>;
    };
    expect(response.nodes.find(node => node.name === 'internalHelper')).toEqual(expect.objectContaining({
      startColumn: 0,
      endColumn: 0,
      isExported: false,
    }));
  });

  it('omits absent strict native JSON edge coordinates instead of zero-filling them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-edge-column-default-'));
    tempRoots.push(root);
    const entry = 'supabase/functions/transcribe/index.ts';
    writeFile(
      root,
      entry,
      [
        'function getBearerToken(req: Request): string | null {',
        "  return req.headers.get('Authorization');",
        '}',
        '',
      ].join('\n'),
    );
    const functionNode = {
      id: `function:${entry}:transcribe`,
      kind: 'function',
      name: 'transcribe',
      qualifiedName: 'transcribe',
      filePath: entry,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const headerNode = {
      id: `variable:${entry}:edge-function-header:transcribe:authorization:2`,
      kind: 'variable',
      name: 'Authorization',
      qualifiedName: 'transcribe::Authorization',
      filePath: entry,
      language: 'typescript',
      startLine: 2,
      endLine: 2,
    };
    const hostPropertyNode = {
      id: `property:${entry}:transcribe.display`,
      kind: 'property',
      name: 'display',
      qualifiedName: 'transcribe::display',
      filePath: entry,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const syncFieldNode = {
      id: `property:${entry}:transcribe.content`,
      kind: 'property',
      name: 'content',
      qualifiedName: 'transcribe::content',
      filePath: entry,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    writeEdgeFunctionFixtureOverlay(root, {
      files: [entry],
      nodes: [functionNode, headerNode, hostPropertyNode, syncFieldNode],
      edges: [{
        source: functionNode.id,
        target: headerNode.id,
        kind: 'references',
        line: 2,
        metadata: {
          relation: 'edge-function-header',
          header: 'Authorization',
          normalizedHeader: 'authorization',
          sourceFile: entry,
        },
      }, {
        source: functionNode.id,
        target: hostPropertyNode.id,
        kind: 'references',
        line: 1,
        metadata: {
          relation: 'host-binding',
        },
      }, {
        source: functionNode.id,
        target: syncFieldNode.id,
        kind: 'references',
        metadata: {
          relation: 'sync-required-field',
        },
      }],
    });

    const result = queryOverlay(root, 'Authorization edge-function-header', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges).toEqual([expect.objectContaining({
      source: functionNode.id,
      target: `variable:${entry}:transcribe.Authorization`,
      kind: 'references',
      line: 2,
    })]);
    for (const edge of response.edges as Array<Record<string, unknown>>) {
      expect(Object.keys(edge)).toEqual(['source', 'target', 'kind', 'line']);
      expect(edge).not.toHaveProperty('column');
    }

    const hostBindingResult = queryOverlay(root, 'host-binding', ['--limit', '20', '--native-json']);
    expectSpawnSuccess(hostBindingResult);
    const hostBindingResponse = JSON.parse(hostBindingResult.stdout);
    expect(hostBindingResponse.edges).toEqual([expect.objectContaining({
      source: functionNode.id,
      target: hostPropertyNode.id,
      kind: 'references',
      line: 1,
    })]);
    for (const edge of hostBindingResponse.edges as Array<Record<string, unknown>>) {
      expect(Object.keys(edge)).toEqual(['source', 'target', 'kind', 'line']);
      expect(edge).not.toHaveProperty('column');
    }

    const syncFieldResult = queryOverlay(root, 'sync-required-field', ['--limit', '20', '--native-json']);
    expectSpawnSuccess(syncFieldResult);
    const syncFieldResponse = JSON.parse(syncFieldResult.stdout);
    expect(syncFieldResponse.edges).toEqual([expect.objectContaining({
      source: functionNode.id,
      target: syncFieldNode.id,
      kind: 'references',
    })]);
    for (const edge of syncFieldResponse.edges as Array<Record<string, unknown>>) {
      expect(Object.keys(edge)).toEqual(['source', 'target', 'kind']);
      expect(edge).not.toHaveProperty('line');
      expect(edge).not.toHaveProperty('column');
    }
  });

  it('treats --native-json as a JSON output mode without requiring --json', () => {
    const root = makeFixture();

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'SampleEntity Trace',
      '--limit',
      '80',
      '--native-json',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(result);
    expect(result.stdout.trim().startsWith('{')).toBe(true);
    const response = JSON.parse(result.stdout);
    expect(Object.keys(response)).toEqual([
      'query',
      'summary',
      'entryPoints',
      'nodes',
      'edges',
      'codeBlocks',
      'relatedFiles',
      'stats',
    ]);
    expect(response).not.toHaveProperty('markdown');
    expect(response).not.toHaveProperty('displayEdges');
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'SampleEntity' }),
    ]));
  });

  it('keeps generated non-entry nodes in strict native JSON like the official formatter', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-json-generated-nodes-'));
    tempRoots.push(root);
    writeFile(root, 'src/anchor.ts', 'export function GeneratedJsonAnchor(): void {}\n');
    writeFile(root, 'src/generated.gen.ts', 'export function GeneratedJsonRelated(): void {}\n');
    const anchorNode = {
      id: 'function:src/anchor.ts:GeneratedJsonAnchor',
      kind: 'function',
      name: 'GeneratedJsonAnchor',
      qualifiedName: 'GeneratedJsonAnchor',
      filePath: 'src/anchor.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      signature: '(): void',
      isExported: true,
    };
    const generatedNode = {
      id: 'function:src/generated.gen.ts:GeneratedJsonRelated',
      kind: 'function',
      name: 'GeneratedJsonRelated',
      qualifiedName: 'GeneratedJsonRelated',
      filePath: 'src/generated.gen.ts',
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
        files: ['src/anchor.ts', 'src/generated.gen.ts'],
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
        nodes: [anchorNode, generatedNode],
        edges: [{
          source: anchorNode.id,
          target: generatedNode.id,
          kind: 'references',
          metadata: { relation: 'initializer-reference' },
        }],
      },
    }, null, 2));

    const result = queryOverlay(root, 'initializer-reference', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'GeneratedJsonRelated',
        filePath: 'src/generated.gen.ts',
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: anchorNode.id,
        target: generatedNode.id,
        kind: 'references',
      }),
    ]));
  });

  it('demotes low-information spec files in strict native JSON relatedFiles unless tests are requested', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-json-related-files-quality-'));
    tempRoots.push(root);
    writeFile(root, 'src/app/quality-order-target.ts', 'export function RelatedFilesQualityTarget(): string { return "real"; }\n');
    writeFile(root, 'src/app/quality-order-target.spec.ts', 'export function RelatedFilesQualityTarget(): string { return "spec"; }\n');
    const realNode = {
      id: 'function:src/app/quality-order-target.ts:RelatedFilesQualityTarget',
      kind: 'function',
      name: 'RelatedFilesQualityTarget',
      qualifiedName: 'RelatedFilesQualityTarget',
      filePath: 'src/app/quality-order-target.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      signature: '(): string',
      isExported: true,
    };
    const specNode = {
      ...realNode,
      id: 'function:src/app/quality-order-target.spec.ts:RelatedFilesQualityTarget',
      filePath: 'src/app/quality-order-target.spec.ts',
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/app/quality-order-target.ts', 'src/app/quality-order-target.spec.ts'],
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
        nodes: [specNode, realNode],
        edges: [],
      },
    }, null, 2));

    const result = queryOverlay(root, 'RelatedFilesQualityTarget', ['--limit', '10', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.entryPoints[0]).toEqual(expect.objectContaining({
      name: 'RelatedFilesQualityTarget',
      filePath: 'src/app/quality-order-target.ts',
    }));
    expect(response.nodes[0]).toEqual(expect.objectContaining({
      name: 'RelatedFilesQualityTarget',
      filePath: 'src/app/quality-order-target.ts',
    }));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      nodeName: 'RelatedFilesQualityTarget',
      filePath: 'src/app/quality-order-target.ts',
    }));
    expect(response.relatedFiles.slice(0, 2)).toEqual([
      'src/app/quality-order-target.ts',
      'src/app/quality-order-target.spec.ts',
    ]);

    const specResult = queryOverlay(root, 'RelatedFilesQualityTarget spec', ['--limit', '10', '--native-json']);

    expectSpawnSuccess(specResult);
    const specResponse = JSON.parse(specResult.stdout);
    expect(specResponse.entryPoints[0]).toEqual(expect.objectContaining({
      name: 'RelatedFilesQualityTarget',
      filePath: 'src/app/quality-order-target.spec.ts',
    }));
    expect(specResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      nodeName: 'RelatedFilesQualityTarget',
      filePath: 'src/app/quality-order-target.spec.ts',
    }));
    expect(specResponse.relatedFiles[0]).toBe('src/app/quality-order-target.spec.ts');
  });

  it('lets explicit generated path relevance outrank generated-file demotion in strict native JSON', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-json-generated-query-order-'));
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

    const result = queryOverlay(root, 'GeneratedQueryOrderTarget pb', ['--limit', '2', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.entryPoints[0]).toEqual(expect.objectContaining({
      name: 'GeneratedQueryOrderTarget',
      filePath: 'src/generated.pb.ts',
    }));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      nodeName: 'GeneratedQueryOrderTarget',
      filePath: 'src/generated.pb.ts',
    }));
    expect(response.relatedFiles[0]).toBe('src/generated.pb.ts');
  });
}
