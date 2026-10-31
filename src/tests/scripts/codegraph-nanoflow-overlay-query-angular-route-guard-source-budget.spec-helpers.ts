import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext, OverlaySpawnResult } from './codegraph-nanoflow-overlay.spec-context';

interface CodegraphOverlayAngularRouteGuardSourceBudgetSpecContext {
  writeFile: CodegraphOverlaySpecContext['writeFile'];
  queryOverlay: CodegraphOverlaySpecContext['queryOverlay'];
  expectSpawnSuccess: CodegraphOverlaySpecContext['expectSpawnSuccess'];
  tempRoots: string[];
  queryNativeMarkdown(root: string, query: string): OverlaySpawnResult;
}

export function registerCodegraphOverlayAngularRouteGuardSourceBudgetSpecs(
  context: CodegraphOverlayAngularRouteGuardSourceBudgetSpecContext,
): void {
  const {
    writeFile,
    queryOverlay,
    expectSpawnSuccess,
    tempRoots,
    queryNativeMarkdown,
  } = context;

  it('keeps route guard graph evidence when explicit route and spec paths are mixed into the query', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-route-guard-mixed-query-'));
    tempRoots.push(root);
    const routeFile = 'src/app.routes.ts';
    const specFile = 'src/app.routes.spec.ts';
    writeFile(
      root,
      routeFile,
      [
        'export function requireAuthGuardLazy(): boolean { return true; }',
        'export class WorkspaceShellComponent {}',
        'export const routes = [',
        '  {',
        "    path: 'projects',",
        '    canActivate: [requireAuthGuardLazy],',
        '    component: WorkspaceShellComponent,',
        '  },',
        '];',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      specFile,
      [
        "import { requireAuthGuardLazy, routes } from './app.routes';",
        'const requireAuthGuardMock = vi.fn();',
        "it('keeps route guard wrappers wired to the route config', () => {",
        '  expect(routes).toBeTruthy();',
        '  expect(requireAuthGuardLazy()).toBe(true);',
        '  expect(requireAuthGuardMock).toBeDefined();',
        '});',
        '',
      ].join('\n'),
    );
    const routeNode = {
      id: `route:${routeFile}:projects`,
      kind: 'route',
      name: 'projects',
      qualifiedName: 'projects',
      filePath: routeFile,
      language: 'typescript',
      startLine: 4,
      endLine: 8,
      metadata: {
        framework: 'angular',
        path: 'projects',
      },
    };
    const guardNode = {
      id: `function:${routeFile}:requireAuthGuardLazy`,
      kind: 'function',
      name: 'requireAuthGuardLazy',
      qualifiedName: 'requireAuthGuardLazy',
      filePath: routeFile,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      signature: 'requireAuthGuardLazy(): boolean',
      isExported: true,
    };
    const specFileNode = {
      id: `file:${specFile}:${specFile}`,
      kind: 'file',
      name: specFile,
      qualifiedName: specFile,
      filePath: specFile,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      metadata: {
        relation: 'source-file',
      },
    };
    const specMockNode = {
      id: `constant:${specFile}:requireAuthGuardMock`,
      kind: 'constant',
      name: 'requireAuthGuardMock',
      qualifiedName: 'requireAuthGuardMock',
      filePath: specFile,
      language: 'typescript',
      startLine: 2,
      endLine: 2,
      signature: 'const requireAuthGuardMock',
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [
          { file: routeFile, language: 'typescript' },
          { file: specFile, language: 'typescript' },
        ],
        classes: [],
        functions: [guardNode],
        interfaces: [],
        types: [],
        variables: [specMockNode],
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
        routes: [
          {
            path: 'projects',
            file: routeFile,
            guards: [{ name: 'requireAuthGuardLazy', line: 6, column: 18, guardKind: 'canActivate' }],
            resolvers: [],
            providers: [],
            line: 4,
          },
        ],
      },
      supabase: {
        edgeFunctions: [],
        migrations: [],
      },
      agentRules: {
        hardRules: [],
      },
      graph: {
        nodes: [routeNode, guardNode, specFileNode, specMockNode],
        edges: [
          {
            source: routeNode.id,
            target: guardNode.id,
            kind: 'references',
            line: 6,
            column: 18,
            metadata: {
              relation: 'angular-route-guard',
              guardKind: 'canActivate',
              path: 'projects',
            },
          },
          {
            source: specFileNode.id,
            target: specMockNode.id,
            kind: 'contains',
            metadata: {
              relation: 'file-symbol',
            },
          },
        ],
      },
    }, null, 2));

    const query = 'app.routes.ts app.routes.spec.ts angular-route-guard test mapping';
    const result = queryOverlay(root, query, ['--limit', '20']);
    const nativeMarkdownResult = queryNativeMarkdown(root, query);

    expectSpawnSuccess(result);
    expectSpawnSuccess(nativeMarkdownResult);
    const response = JSON.parse(result.stdout);
    expect(response.summary).toBe('Found 5 relevant code symbols across 2 files.');
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: routeNode.id, kind: 'route', name: 'projects' }),
      expect.objectContaining({ id: guardNode.id, kind: 'function', name: 'requireAuthGuardLazy' }),
      expect.objectContaining({ id: specFileNode.id, kind: 'file', name: specFile }),
      expect.objectContaining({ id: specMockNode.id, kind: 'constant', name: 'requireAuthGuardMock' }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'projects',
        target: 'requireAuthGuardLazy',
        relation: 'angular-route-guard',
        guardKind: 'canActivate',
      }),
    ]));
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: routeFile,
        nodeKind: 'route',
        content: expect.stringContaining('canActivate: [requireAuthGuardLazy]'),
      }),
      expect.objectContaining({
        filePath: specFile,
        nodeKind: 'constant',
        content: expect.stringContaining('requireAuthGuardMock'),
      }),
    ]));
    expect(nativeMarkdownResult.stdout).toContain('### Entry Points');
    expect(nativeMarkdownResult.stdout).toContain('requireAuthGuardLazy');
    expect(nativeMarkdownResult.stdout).toContain('### Code');
    expect(nativeMarkdownResult.stdout).toContain('canActivate: [requireAuthGuardLazy]');
    expect(nativeMarkdownResult.stdout).toContain('requireAuthGuardMock');
  });

  it('keeps explicitly requested spec source when route guard endpoints fill the native code budget', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-route-guard-spec-budget-'));
    tempRoots.push(root);
    const routeFile = 'src/app.routes.ts';
    const specFile = 'src/app.routes.spec.ts';
    const routeLines: string[] = [];
    const nodes: Array<Record<string, unknown>> = [];
    const edges: Array<Record<string, unknown>> = [];

    for (let index = 0; index < 6; index += 1) {
      const guardName = `guard${index}`;
      const routeName = `route-${index}`;
      const guardLine = routeLines.length + 1;
      routeLines.push(`export function ${guardName}(): boolean { return true; }`);
      const routeLine = routeLines.length + 2;
      routeLines.push(
        'export const routes = [',
        `  { path: '${routeName}', canActivate: [${guardName}] },`,
        '];',
      );
      const routeNode = {
        id: `route:${routeFile}:${routeName}`,
        kind: 'route',
        name: routeName,
        qualifiedName: routeName,
        filePath: routeFile,
        language: 'typescript',
        startLine: routeLine,
        endLine: routeLine,
        metadata: {
          framework: 'angular',
          path: routeName,
        },
      };
      const guardNode = {
        id: `function:${routeFile}:${guardName}`,
        kind: 'function',
        name: guardName,
        qualifiedName: guardName,
        filePath: routeFile,
        language: 'typescript',
        startLine: guardLine,
        endLine: guardLine,
        signature: `${guardName}(): boolean`,
      };
      nodes.push(routeNode, guardNode);
      edges.push({
        source: routeNode.id,
        target: guardNode.id,
        kind: 'references',
        line: routeLine,
        column: 33,
        metadata: {
          relation: 'angular-route-guard',
          guardKind: 'canActivate',
          path: routeName,
        },
      });
    }

    writeFile(root, routeFile, `${routeLines.join('\n')}\n`);
    writeFile(
      root,
      specFile,
      [
        "import { guard0 } from './app.routes';",
        'const requireAuthGuardMock = vi.fn();',
        "it('covers route guards', () => {",
        '  expect(guard0()).toBe(true);',
        '  expect(requireAuthGuardMock).toBeDefined();',
        '});',
        '',
      ].join('\n'),
    );

    const specFileNode = {
      id: `file:${specFile}:${specFile}`,
      kind: 'file',
      name: specFile,
      qualifiedName: specFile,
      filePath: specFile,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const specMockNode = {
      id: `constant:${specFile}:requireAuthGuardMock`,
      kind: 'constant',
      name: 'requireAuthGuardMock',
      qualifiedName: 'requireAuthGuardMock',
      filePath: specFile,
      language: 'typescript',
      startLine: 2,
      endLine: 2,
      signature: 'const requireAuthGuardMock',
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [
          { file: routeFile, language: 'typescript' },
          { file: specFile, language: 'typescript' },
        ],
        classes: [],
        functions: nodes.filter(node => node.kind === 'function'),
        interfaces: [],
        types: [],
        variables: [specMockNode],
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
        nodes: [...nodes, specFileNode, specMockNode],
        edges,
      },
    }, null, 2));

    const result = queryNativeMarkdown(root, 'app.routes.ts app.routes.spec.ts angular-route-guard test mapping');

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('### Code');
    expect(result.stdout).toContain('#### requireAuthGuardMock (src/app.routes.spec.ts:2)');
    expect(result.stdout).toContain('const requireAuthGuardMock = vi.fn();');
  });
}
