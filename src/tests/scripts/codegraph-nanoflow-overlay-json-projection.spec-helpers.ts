import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import { registerCodegraphOverlayJsonProjectionBudgetSpecs } from './codegraph-nanoflow-overlay-json-projection-budget.spec-helpers';
import { registerCodegraphOverlayJsonProjectionNativeSpecs } from './codegraph-nanoflow-overlay-json-projection-native.spec-helpers';
import { registerCodegraphOverlayJsonProjectionTestMappingSpecs } from './codegraph-nanoflow-overlay-json-projection-test-mapping.spec-helpers';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayJsonProjectionSpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, writeFile, queryOverlay, expectSpawnSuccess, tempRoots } = context;
  registerCodegraphOverlayJsonProjectionNativeSpecs(context);

  it('keeps strict native JSON top-level field order stable', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'SampleService', ['--limit', '20', '--native-json']);

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
  });

  it('keeps strict native JSON sub-object field order stable while stripping NanoFlow extensions', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'SampleEntity Trace', ['--limit', '80', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const orderedNodeKeys = [
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
    ];
    const orderedEdgeKeys = ['source', 'target', 'kind', 'line', 'column'];
    const orderedCodeBlockKeys = [
      'filePath',
      'startLine',
      'endLine',
      'language',
      'content',
      'nodeName',
      'nodeKind',
    ];
    const extensionKeys = [
      'metadata',
      'provenance',
      'sourceName',
      'targetName',
      'displayName',
      'file',
      'relation',
    ];

    const assertOrderedSubset = (actualKeys: string[], expectedOrder: string[]) => {
      expect(actualKeys).toEqual(expectedOrder.filter(key => actualKeys.includes(key)));
    };

    const sampleEntityNode = [...response.entryPoints, ...response.nodes]
      .find((node: Record<string, unknown>) => node.name === 'SampleEntity') as Record<string, unknown> | undefined;
    const decoratesEdge = (response.edges as Array<Record<string, unknown>>)
      .find(edge => edge.kind === 'decorates');
    const sampleCodeBlock = (response.codeBlocks as Array<Record<string, unknown>>)
      .find(block => block.nodeName === 'SampleEntity');

    expect(sampleEntityNode).toBeTruthy();
    expect(decoratesEdge).toBeTruthy();
    expect(sampleCodeBlock).toBeTruthy();
    assertOrderedSubset(Object.keys(sampleEntityNode ?? {}), orderedNodeKeys);
    assertOrderedSubset(Object.keys(decoratesEdge ?? {}), orderedEdgeKeys);
    assertOrderedSubset(Object.keys(sampleCodeBlock ?? {}), orderedCodeBlockKeys);

    for (const object of [
      ...response.entryPoints,
      ...response.nodes,
      ...response.edges,
      ...response.codeBlocks,
    ] as Array<Record<string, unknown>>) {
      for (const extensionKey of extensionKeys) {
        expect(object).not.toHaveProperty(extensionKey);
      }
    }
  });

  it('keeps strict native JSON stats consistent with serialized output', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'policy-command', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const relatedFiles = new Set(response.relatedFiles as string[]);
    const nodeIds = new Set(response.nodes.map((node: { id: string }) => node.id));
    const codeBlocks = response.codeBlocks as Array<{ content: string; filePath: string }>;

    expect(response.edges.every((edge: { source: string; target: string }) => (
      nodeIds.has(edge.source) && nodeIds.has(edge.target)
    ))).toBe(true);
    expect(codeBlocks.every(block => relatedFiles.has(block.filePath))).toBe(true);
    expect(response.stats).toEqual({
      nodeCount: response.nodes.length,
      edgeCount: response.edges.length,
      fileCount: response.relatedFiles.length,
      codeBlockCount: codeBlocks.length,
      totalCodeSize: codeBlocks.reduce((total, block) => total + block.content.length, 0),
    });
  });

  it('includes every strict native code block file in relatedFiles', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'template-component', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const relatedFiles = new Set(response.relatedFiles as string[]);
    const codeBlockFiles = response.codeBlocks.map((block: { filePath: string }) => block.filePath);
    const orderedCodeBlockFiles = [...new Set(codeBlockFiles)];

    expect(codeBlockFiles.some((file: string) => file.endsWith('.html'))).toBe(true);
    expect(codeBlockFiles.every((file: string) => relatedFiles.has(file))).toBe(true);
    expect(response.relatedFiles.slice(0, orderedCodeBlockFiles.length)).toEqual(orderedCodeBlockFiles);
  });

  it('orders generated file matches after hand-written files in strict native JSON', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-generated-json-'));
    tempRoots.push(root);
    writeFile(
      root,
      'src/app/contracts/handwritten.ts',
      [
        'export function contractMatch(): string {',
        "  return 'handwritten';",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/contracts/contract.generated.ts',
      [
        'export function contractMatch(): string {',
        "  return 'generated';",
        '}',
        '',
        'export function generatedHelper(): string {',
        '  return contractMatch();',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/contracts/contract.pb.ts',
      [
        'export function contractMatch(): string {',
        "  return 'pb';",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/contracts/contract_pb.ts',
      [
        'export function contractMatch(): string {',
        "  return 'pb2';",
        '}',
        '',
      ].join('\n'),
    );
    const handwrittenNode = {
      id: 'function:src/app/contracts/handwritten.ts:contractMatch',
      kind: 'function',
      name: 'contractMatch',
      qualifiedName: 'contractMatch',
      filePath: 'src/app/contracts/handwritten.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 3,
      startColumn: 0,
      endColumn: 1,
      isExported: true,
    };
    const generatedNode = {
      id: 'function:src/app/contracts/contract.generated.ts:contractMatch',
      kind: 'function',
      name: 'contractMatch',
      qualifiedName: 'contractMatch',
      filePath: 'src/app/contracts/contract.generated.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 3,
      startColumn: 0,
      endColumn: 1,
      isExported: true,
    };
    const generatedPbNode = {
      ...generatedNode,
      id: 'function:src/app/contracts/contract.pb.ts:contractMatch',
      filePath: 'src/app/contracts/contract.pb.ts',
    };
    const generatedPbUnderscoreNode = {
      ...generatedNode,
      id: 'function:src/app/contracts/contract_pb.ts:contractMatch',
      filePath: 'src/app/contracts/contract_pb.ts',
    };
    const generatedHelperNode = {
      id: 'function:src/app/contracts/contract.generated.ts:generatedHelper',
      kind: 'function',
      name: 'generatedHelper',
      qualifiedName: 'generatedHelper',
      filePath: 'src/app/contracts/contract.generated.ts',
      language: 'typescript',
      startLine: 5,
      endLine: 7,
      startColumn: 0,
      endColumn: 1,
      isExported: true,
    };
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [
          'src/app/contracts/contract.generated.ts',
          'src/app/contracts/handwritten.ts',
        ],
        classes: [],
        functions: [generatedNode, handwrittenNode, generatedPbNode, generatedPbUnderscoreNode, generatedHelperNode],
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
        nodes: [generatedNode, handwrittenNode, generatedPbNode, generatedPbUnderscoreNode, generatedHelperNode],
        edges: [],
      },
    };
    writeFile(root, '.codegraph/nanoflow-overlay.json', JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'contract', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const entryPointFiles = response.entryPoints.map((node: { filePath: string }) => node.filePath);
    const codeBlockFiles = response.codeBlocks.map((block: { filePath: string }) => block.filePath);
    expect(entryPointFiles[0]).toBe('src/app/contracts/handwritten.ts');
    expect(codeBlockFiles[0]).toBe('src/app/contracts/handwritten.ts');
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'generatedHelper',
        filePath: 'src/app/contracts/contract.generated.ts',
      }),
    ]));
    const nodeFiles = response.nodes.map((node: { filePath: string }) => node.filePath);
    expect(nodeFiles[0]).toBe('src/app/contracts/handwritten.ts');
    expect(nodeFiles.indexOf('src/app/contracts/contract.generated.ts')).toBeGreaterThan(0);
    expect(nodeFiles.indexOf('src/app/contracts/contract.pb.ts')).toBeGreaterThan(0);
    expect(nodeFiles.indexOf('src/app/contracts/contract_pb.ts')).toBeGreaterThan(0);
    expect(response.stats.nodeCount).toBe(response.nodes.length);
    expect(response.summary).toBe('Found 9 relevant code symbols across 4 files.');
    expect(response.relatedFiles[0]).toBe('src/app/contracts/handwritten.ts');
    expect(response.relatedFiles.indexOf('src/app/contracts/contract.generated.ts')).toBeGreaterThan(0);
    expect(response.relatedFiles.indexOf('src/app/contracts/contract.pb.ts')).toBeGreaterThan(0);
    expect(response.relatedFiles.indexOf('src/app/contracts/contract_pb.ts')).toBeGreaterThan(0);
  });

  it('keeps strict native JSON edge endpoints closed over returned nodes', () => {
    const root = makeFixture();

    const fileSymbolResult = queryOverlay(root, 'file-symbol', ['--limit', '40', '--native-json']);
    const localDeclarationResult = queryOverlay(root, 'local-declaration', ['--limit', '40', '--native-json']);
    const policyCommandResult = queryOverlay(root, 'policy-command', ['--limit', '20', '--native-json']);
    const triggerResult = queryOverlay(root, 'trigger', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(fileSymbolResult);
    expectSpawnSuccess(localDeclarationResult);
    expectSpawnSuccess(policyCommandResult);
    expectSpawnSuccess(triggerResult);
    for (const response of [
      JSON.parse(fileSymbolResult.stdout),
      JSON.parse(localDeclarationResult.stdout),
      JSON.parse(policyCommandResult.stdout),
      JSON.parse(triggerResult.stdout),
    ]) {
      const nodeIds = new Set(response.nodes.map((node: { id: string }) => node.id));
      expect(response.edges.every((edge: { source: string; target: string }) => (
        nodeIds.has(edge.source) && nodeIds.has(edge.target)
      ))).toBe(true);
    }
    expect(JSON.parse(localDeclarationResult.stdout).edges.length).toBeGreaterThan(0);
    const policyCommandResponse = JSON.parse(policyCommandResult.stdout);
    expect(policyCommandResponse.edges.length).toBeGreaterThan(0);
    const policyCodeBlock = policyCommandResponse.codeBlocks.find((block: { content?: string; nodeKind?: string }) => (
      block.nodeKind === 'variable' && block.content?.includes('create policy')
    ));
    expect(policyCodeBlock).toEqual(expect.objectContaining({
      nodeKind: 'variable',
      content: expect.stringContaining('create policy'),
    }));
    expect(policyCodeBlock.startLine).toBeGreaterThan(1);
    const triggerResponse = JSON.parse(triggerResult.stdout);
    expect(triggerResponse.edges.length).toBeGreaterThan(0);
    const triggerCodeBlock = triggerResponse.codeBlocks.find((block: { content?: string; nodeKind?: string }) => (
      block.nodeKind === 'variable' && block.content?.includes('create trigger')
    ));
    expect(triggerCodeBlock).toEqual(expect.objectContaining({
      nodeKind: 'variable',
      content: expect.stringContaining('create trigger'),
    }));
    expect(triggerCodeBlock.startLine).toBeGreaterThan(1);
  });

  it('keeps same-named exact relation endpoints in strict native JSON', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'sync-config-keyword', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBeGreaterThan(0);
    const nodeById = new Map(response.nodes.map((node: { id: string }) => [node.id, node]));
    const syncConfigEdge = response.edges.find((edge: { source: string; target: string }) => (
      edge.source !== edge.target
      && (nodeById.get(edge.source) as { name?: string } | undefined)?.name === 'SYNC_CONFIG.DEBOUNCE_DELAY'
      && (nodeById.get(edge.target) as { name?: string } | undefined)?.name === 'SYNC_CONFIG.DEBOUNCE_DELAY'
    ));
    expect(syncConfigEdge).toEqual(expect.objectContaining({
      kind: 'references',
    }));
    const nodeIds = new Set(nodeById.keys());
    expect(nodeIds.has(syncConfigEdge.source)).toBe(true);
    expect(nodeIds.has(syncConfigEdge.target)).toBe(true);
  });

  registerCodegraphOverlayJsonProjectionTestMappingSpecs(context);

  it('preserves official abstract node markers in strict native JSON', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-abstract-json-'));
    tempRoots.push(root);
    writeFile(
      root,
      'src/abstract-sample.ts',
      [
        'export abstract class AbstractSample {',
        '  abstract run(): void;',
        '}',
        '',
      ].join('\n'),
    );
    const node = {
      id: 'class:src/abstract-sample.ts:AbstractSample',
      kind: 'class',
      name: 'AbstractSample',
      qualifiedName: 'AbstractSample',
      filePath: 'src/abstract-sample.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 3,
      isExported: true,
      isAbstract: true,
    };
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/abstract-sample.ts'],
        classes: [node],
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
        nodes: [node],
        edges: [],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'AbstractSample', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'class',
        name: 'AbstractSample',
        isAbstract: true,
      }),
    ]));
  });

  it('includes exact relation endpoint code blocks for non-entry symbol kinds in strict native JSON', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-relation-endpoint-json-'));
    tempRoots.push(root);
    writeFile(
      root,
      'src/config/focus.config.ts',
      [
        'export const FOCUS_CONFIG = {',
        '  GATE: {',
        '    MAX_SNOOZE_PER_DAY: 3,',
        '  },',
        '} as const;',
        '',
      ].join('\n'),
    );
    const ruleNode = {
      id: 'variable:AGENTS.md:sync-rule:FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
      kind: 'variable',
      name: 'FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
      qualifiedName: 'FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
      filePath: 'AGENTS.md',
      language: 'markdown',
      startLine: 1,
      endLine: 1,
    };
    const propertyNode = {
      id: 'property:src/config/focus.config.ts:FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
      kind: 'property',
      name: 'MAX_SNOOZE_PER_DAY',
      qualifiedName: 'FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
      filePath: 'src/config/focus.config.ts',
      language: 'typescript',
      startLine: 3,
      endLine: 3,
    };
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/config/focus.config.ts'],
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
        nodes: [ruleNode, propertyNode],
        edges: [{
          source: ruleNode.id,
          target: propertyNode.id,
          kind: 'references',
          line: 3,
          column: 4,
          metadata: {
            relation: 'config-source',
            configKey: 'FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
          },
        }],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'config-source', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'variable:AGENTS.md:FOCUS_CONFIG.GATE.MAX_SNOOZE_PER_DAY',
        target: propertyNode.id,
        kind: 'references',
      }),
    ]));
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/config/focus.config.ts',
        nodeKind: 'property',
        nodeName: 'MAX_SNOOZE_PER_DAY',
        content: expect.stringContaining('MAX_SNOOZE_PER_DAY: 3'),
      }),
    ]));
  });

  it('prioritizes exact relation target code blocks when native JSON code block budget is tight', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-relation-target-budget-'));
    tempRoots.push(root);
    const keys = [
      'MAX_SNOOZE_PER_DAY',
      'DAILY_QUOTA',
      'SESSION_CHECK_TIMEOUT',
      'QUICK_TIMEOUT',
      'STANDARD_TIMEOUT',
      'HEAVY_TIMEOUT',
    ];
    writeFile(
      root,
      'AGENTS.md',
      keys.map(key => `| \`FOCUS_CONFIG.GATE.${key}\` | \`required\` |`).join('\n'),
    );
    writeFile(
      root,
      'src/config/focus.config.ts',
      [
        'export const FOCUS_CONFIG = {',
        '  GATE: {',
        ...keys.map((key, index) => `    ${key}: ${index + 1},`),
        '  },',
        '} as const;',
        '',
      ].join('\n'),
    );
    const ruleNodes = keys.map((key, index) => ({
      id: `variable:AGENTS.md:sync-rule:FOCUS_CONFIG.GATE.${key}`,
      kind: 'variable',
      name: `FOCUS_CONFIG.GATE.${key}`,
      qualifiedName: `FOCUS_CONFIG.GATE.${key}`,
      filePath: 'AGENTS.md',
      language: 'markdown',
      startLine: index + 1,
      endLine: index + 1,
    }));
    const propertyNodes = keys.map((key, index) => ({
      id: `property:src/config/focus.config.ts:FOCUS_CONFIG.GATE.${key}`,
      kind: 'property',
      name: key,
      qualifiedName: `FOCUS_CONFIG.GATE.${key}`,
      filePath: 'src/config/focus.config.ts',
      language: 'typescript',
      startLine: index + 3,
      endLine: index + 3,
    }));
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/config/focus.config.ts'],
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
        nodes: keys.flatMap((_, index) => [ruleNodes[index], propertyNodes[index]]),
        edges: keys.map((key, index) => ({
          source: ruleNodes[index].id,
          target: propertyNodes[index].id,
          kind: 'references',
          line: index + 3,
          column: 4,
          metadata: {
            relation: 'config-source',
            configKey: `FOCUS_CONFIG.GATE.${key}`,
          },
        })),
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'config-source', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/config/focus.config.ts',
        nodeKind: 'property',
        nodeName: 'MAX_SNOOZE_PER_DAY',
        content: expect.stringContaining('MAX_SNOOZE_PER_DAY: 1'),
      }),
    ]));
  });

  registerCodegraphOverlayJsonProjectionBudgetSpecs(context);
}
