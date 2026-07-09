import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayAngularRouteGuardSourceBudgetSpecs } from './codegraph-nanoflow-overlay-query-angular-route-guard-source-budget.spec-helpers';

export function registerCodegraphOverlayAngularRouteQuerySpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const {
    makeFixture,
    writeFile,
    queryOverlay,
    expectSpawnSuccess,
    tempRoots,
    repoRoot,
    queryScriptPath,
  } = context;
  const queryNativeMarkdown = (root: string, query: string) => spawnSync(process.execPath, [
    queryScriptPath,
    '--root',
    root,
    '--query',
    query,
    '--limit',
    '20',
    '--native-markdown',
    '--skip-refresh',
  ], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });

  it('queries Angular route guards and resolvers as focused native relationships', () => {
    const root = makeFixture();

    const guardResult = queryOverlay(root, 'angular-route-guard', ['--limit', '20']);
    const resolverResult = queryOverlay(root, 'angular-route-resolver', ['--limit', '20']);

    expectSpawnSuccess(guardResult);
    expectSpawnSuccess(resolverResult);
    const guardResponse = JSON.parse(guardResult.stdout);
    const resolverResponse = JSON.parse(resolverResult.stdout);
    const sampleRouteId = 'route:src/app/app.routes.ts:sample';
    const childRouteId = 'route:src/app/app.routes.ts:child';
    const authGuardId = 'function:src/app/app.routes.ts:authGuard';
    const featureGuardId = 'function:src/app/app.routes.ts:featureGuard';
    const sampleResolverId = 'function:src/app/app.routes.ts:sampleResolver';

    expect(guardResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sampleRouteId, kind: 'route', name: 'sample' }),
      expect.objectContaining({ id: childRouteId, kind: 'route', name: 'child' }),
      expect.objectContaining({ id: authGuardId, kind: 'function', name: 'authGuard' }),
      expect.objectContaining({ id: featureGuardId, kind: 'function', name: 'featureGuard' }),
    ]));
    expect(guardResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: sampleRouteId,
        target: authGuardId,
        metadata: expect.objectContaining({
          relation: 'angular-route-guard',
          guardKind: 'canActivate',
          path: 'sample',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: childRouteId,
        target: featureGuardId,
        metadata: expect.objectContaining({
          relation: 'angular-route-guard',
          guardKind: 'canMatch',
          path: 'child',
        }),
      }),
    ]));
    expect(guardResponse.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'sample',
        target: 'authGuard',
        relation: 'angular-route-guard',
        guardKind: 'canActivate',
      }),
    ]));

    expect(resolverResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sampleRouteId, kind: 'route', name: 'sample' }),
      expect.objectContaining({ id: sampleResolverId, kind: 'function', name: 'sampleResolver' }),
    ]));
    expect(resolverResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: sampleRouteId,
        target: sampleResolverId,
        metadata: expect.objectContaining({
          relation: 'angular-route-resolver',
          resolverKey: 'sample',
          path: 'sample',
        }),
      }),
    ]));
    expect(resolverResponse.markdown).toContain('relation: angular-route-resolver');
  });

  it('keeps unresolved lazy route exports closed on the lazy module file endpoint', () => {
    const root = makeFixture();
    const routeId = 'route:src/app/app.routes.ts:unresolved-child';
    const lazyModuleFileId = 'file:src/app/features/sample/lazy-child.routes.ts:src/app/features/sample/lazy-child.routes.ts';

    const result = queryOverlay(root, 'unresolved-child missingRoutes lazy-child.routes', ['--limit', '20']);
    const nativeResult = queryOverlay(root, 'unresolved-child missingRoutes lazy-child.routes', [
      '--limit',
      '20',
      '--native-json',
      '--skip-refresh',
    ]);

    expectSpawnSuccess(result);
    expectSpawnSuccess(nativeResult);
    const response = JSON.parse(result.stdout);
    const nativeResponse = JSON.parse(nativeResult.stdout);

    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: routeId, kind: 'route', name: 'unresolved-child' }),
      expect.objectContaining({
        id: lazyModuleFileId,
        kind: 'file',
        name: 'src/app/features/sample/lazy-child.routes.ts',
        metadata: expect.objectContaining({
          relation: 'route-target',
          exportName: 'missingRoutes',
        }),
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: routeId,
        target: lazyModuleFileId,
        metadata: expect.objectContaining({
          relation: 'route',
          path: 'unresolved-child',
          exportName: 'missingRoutes',
        }),
      }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'variable', name: 'missingRoutes' }),
    ]));

    expect(nativeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: routeId, kind: 'route', name: 'unresolved-child' }),
      expect.objectContaining({
        id: lazyModuleFileId,
        kind: 'file',
        name: 'src/app/features/sample/lazy-child.routes.ts',
      }),
    ]));
    expect(nativeResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: routeId,
        target: lazyModuleFileId,
      }),
    ]));
    expect(nativeResponse.nodes.find((node: { id?: string }) => node.id === lazyModuleFileId))
      .not.toHaveProperty('metadata');
  });

  registerCodegraphOverlayAngularRouteGuardSourceBudgetSpecs({
    writeFile,
    queryOverlay,
    expectSpawnSuccess,
    tempRoots,
    queryNativeMarkdown,
  });

  it('expands route endpoint code blocks for strict native Angular route guard queries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-route-codeblock-'));
    tempRoots.push(root);
    const routeFile = 'src/app/app.routes.ts';
    writeFile(
      root,
      routeFile,
      [
        'export function authGuard(): boolean { return true; }',
        'export class SampleComponent {}',
        'export const routes = [',
        '  {',
        "    path: 'sample',",
        '    component: SampleComponent,',
        '    canActivate: [authGuard],',
        '  },',
        '];',
        '',
      ].join('\n'),
    );
    const routeNode = {
      id: `route:${routeFile}:sample`,
      kind: 'route',
      name: 'sample',
      qualifiedName: 'sample',
      filePath: routeFile,
      language: 'typescript',
      startLine: 4,
      endLine: 4,
    };
    const guardNode = {
      id: `function:${routeFile}:authGuard`,
      kind: 'function',
      name: 'authGuard',
      qualifiedName: 'authGuard',
      filePath: routeFile,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
      signature: 'authGuard(): boolean',
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [{ file: routeFile, language: 'typescript' }],
        classes: [],
        functions: [guardNode],
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
        nodes: [routeNode, guardNode],
        edges: [
          {
            source: routeNode.id,
            target: guardNode.id,
            kind: 'references',
            line: 7,
            column: 18,
            metadata: {
              relation: 'angular-route-guard',
              guardKind: 'canActivate',
              path: 'sample',
            },
          },
        ],
      },
    }, null, 2));

    const result = queryOverlay(root, 'angular-route-guard', ['--limit', '20', '--native-json', '--skip-refresh']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeKind: 'route',
        nodeName: 'sample',
        content: expect.stringContaining("path: 'sample'"),
      }),
    ]));
    const routeBlock = response.codeBlocks.find((block: { nodeKind?: string }) => block.nodeKind === 'route');
    expect(routeBlock?.content).toContain('canActivate: [authGuard]');
  });

  it('prioritizes route object code blocks for strict native Angular route resolver and provider budgets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-route-resolver-provider-budget-'));
    tempRoots.push(root);
    const routeFile = 'src/app/app.routes.ts';
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    const lines: string[] = [];
    const nodes = [];
    const edges = [];

    for (const name of names) {
      const pascalName = `${name[0].toUpperCase()}${name.slice(1)}`;
      lines.push(`export function resolve${pascalName}(): string { return '${name}'; }`);
      lines.push(`export class ${pascalName}RouteProvider {}`);
    }

    lines.push('export const routes = [');
    for (const [index, name] of names.entries()) {
      const pascalName = `${name[0].toUpperCase()}${name.slice(1)}`;
      const routeLine = lines.length + 1;
      lines.push(
        '  {',
        `    path: '${name}',`,
        `    resolve: { data: resolve${pascalName} },`,
        `    providers: [${pascalName}RouteProvider],`,
        '  },',
      );

      const routeNode = {
        id: `route:${routeFile}:${name}`,
        kind: 'route',
        name,
        qualifiedName: name,
        filePath: routeFile,
        language: 'typescript',
        startLine: routeLine,
        endLine: routeLine,
      };
      const resolverNode = {
        id: `function:${routeFile}:resolve${pascalName}`,
        kind: 'function',
        name: `resolve${pascalName}`,
        qualifiedName: `resolve${pascalName}`,
        filePath: routeFile,
        language: 'typescript',
        startLine: index * 2 + 1,
        endLine: index * 2 + 1,
      };
      const providerNode = {
        id: `class:${routeFile}:${pascalName}RouteProvider`,
        kind: 'class',
        name: `${pascalName}RouteProvider`,
        qualifiedName: `${pascalName}RouteProvider`,
        filePath: routeFile,
        language: 'typescript',
        startLine: index * 2 + 2,
        endLine: index * 2 + 2,
      };
      nodes.push(routeNode, resolverNode, providerNode);
      edges.push(
        {
          source: routeNode.id,
          target: resolverNode.id,
          kind: 'references',
          line: routeLine + 2,
          column: 22,
          metadata: {
            relation: 'angular-route-resolver',
            resolverKey: 'data',
            path: name,
          },
        },
        {
          source: routeNode.id,
          target: providerNode.id,
          kind: 'references',
          line: routeLine + 3,
          column: 16,
          metadata: {
            relation: 'angular-route-provider',
            provider: `${pascalName}RouteProvider`,
            path: name,
          },
        },
      );
    }
    lines.push('];', '');
    writeFile(root, routeFile, lines.join('\n'));

    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [{ file: routeFile, language: 'typescript' }],
        classes: nodes.filter((node: { kind: string }) => node.kind === 'class'),
        functions: nodes.filter((node: { kind: string }) => node.kind === 'function'),
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
    }, null, 2));

    const resolverResult = queryOverlay(root, 'angular-route-resolver', ['--limit', '20', '--native-json', '--skip-refresh']);
    const providerResult = queryOverlay(root, 'angular-route-provider', ['--limit', '20', '--native-json', '--skip-refresh']);

    expectSpawnSuccess(resolverResult);
    expectSpawnSuccess(providerResult);
    const resolverResponse = JSON.parse(resolverResult.stdout);
    const providerResponse = JSON.parse(providerResult.stdout);
    expect(resolverResponse.codeBlocks.slice(0, 5).every((block: { nodeKind?: string }) => block.nodeKind === 'route')).toBe(true);
    expect(providerResponse.codeBlocks.slice(0, 5).every((block: { nodeKind?: string }) => block.nodeKind === 'route')).toBe(true);
    expect(resolverResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      nodeKind: 'route',
      nodeName: 'alpha',
      content: expect.stringContaining('resolve: { data: resolveAlpha }'),
    }));
    expect(providerResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      nodeKind: 'route',
      nodeName: 'alpha',
      content: expect.stringContaining('providers: [AlphaRouteProvider]'),
    }));
  });

  it('queries Angular route redirects as focused native route relationships', () => {
    const root = makeFixture();
    writeFile(
      root,
      'src/tests/scripts/generated-route-fixture.spec-helpers.ts',
      [
        'export const routeAssertionFixture = {',
        "  path: '',",
        "  redirectTo: 'fixture-panel',",
        "  pathMatch: 'full',",
        '};',
        'export const panelAssertionFixture = {',
        "  path: 'fixture-panel',",
        "  component: 'FixturePanelComponent',",
        '};',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(root, 'angular-route-redirect', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const rootRouteId = 'route:src/app/app.routes.ts:(root)';
    const panelRouteId = 'route:src/app/app.routes.ts:panel';

    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: rootRouteId, kind: 'route', name: '(root)' }),
      expect.objectContaining({ id: panelRouteId, kind: 'route', name: 'panel' }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: rootRouteId,
        target: panelRouteId,
        metadata: expect.objectContaining({
          relation: 'angular-route-redirect',
          path: '',
          redirectTo: 'panel',
          pathMatch: 'full',
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: '(root)',
        target: 'panel',
        relation: 'angular-route-redirect',
        redirectTo: 'panel',
      }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/tests/scripts/generated-route-fixture.spec-helpers.ts',
      }),
    ]));
    expect(response.relatedFiles).not.toContain('src/tests/scripts/generated-route-fixture.spec-helpers.ts');
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      nodeKind: 'route',
      content: expect.stringContaining("redirectTo: 'panel'"),
    }));
    expect(response.markdown).toContain('relation: angular-route-redirect');
  });

  it('uses route object code blocks for strict native Angular route redirect Markdown', () => {
    const root = makeFixture();

    const result = queryNativeMarkdown(root, 'angular-route-redirect');

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('## Code Context');
    expect(result.stdout).toContain('### Entry Points');
    expect(result.stdout).toContain('### Relationships');
    expect(result.stdout).toContain('**references:**');
    expect(result.stdout).toContain('- (root) -> panel (line 10)');
    expect(result.stdout).toContain('### Related Symbols');
    expect(result.stdout).toContain('### Code');
    expect(result.stdout).toContain('#### (root) (src/app/app.routes.ts:10)');
    expect(result.stdout).toContain("{ path: '', redirectTo: 'panel', pathMatch: 'full' }");
    expect(result.stdout).toContain('#### panel (src/app/app.routes.ts:12)');
    expect(result.stdout).toContain("{ path: 'panel', component: LazyPanelComponent }");
    expect(result.stdout).not.toContain('src/tests/scripts/generated-route-fixture.spec-helpers.ts');
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
    expect(result.stdout).not.toContain('relation: angular-route-redirect');
    expect(result.stdout).not.toContain('metadata');
    expect(result.stdout).not.toContain('provenance');
  });

  it('queries Angular route providers as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'angular-route-provider', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const sampleRouteId = 'route:src/app/app.routes.ts:sample';
    const providerId = 'class:src/app/app.routes.ts:SampleRouteProvider';

    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sampleRouteId, kind: 'route', name: 'sample' }),
      expect.objectContaining({ id: providerId, kind: 'class', name: 'SampleRouteProvider' }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: sampleRouteId,
        target: providerId,
        metadata: expect.objectContaining({
          relation: 'angular-route-provider',
          path: 'sample',
          provider: 'SampleRouteProvider',
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'sample',
        target: 'SampleRouteProvider',
        relation: 'angular-route-provider',
      }),
    ]));
    expect(response.markdown).toContain('relation: angular-route-provider');
  });

  it('uses route object code blocks for strict native Angular route provider Markdown', () => {
    const root = makeFixture();

    const result = queryNativeMarkdown(root, 'angular-route-provider');

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('## Code Context');
    expect(result.stdout).toContain('### Entry Points');
    expect(result.stdout).toContain('### Relationships');
    expect(result.stdout).toContain('**references:**');
    expect(result.stdout).toContain('- sample -> SampleRouteProvider');
    expect(result.stdout).toContain('### Related Symbols');
    expect(result.stdout).toContain('### Code');
    expect(result.stdout).toContain('#### sample (src/app/app.routes.ts:11)');
    expect(result.stdout).toContain('providers: [SampleRouteProvider]');
    const routeCodeIndex = result.stdout.indexOf('#### sample (src/app/app.routes.ts:11)');
    const providerCodeIndex = result.stdout.indexOf('#### SampleRouteProvider (src/app/app.routes.ts:7)');
    expect(routeCodeIndex).toBeGreaterThanOrEqual(0);
    expect(providerCodeIndex).toBeGreaterThan(routeCodeIndex);
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
    expect(result.stdout).not.toContain('relation: angular-route-provider');
    expect(result.stdout).not.toContain('metadata');
    expect(result.stdout).not.toContain('provenance');
  });
}
