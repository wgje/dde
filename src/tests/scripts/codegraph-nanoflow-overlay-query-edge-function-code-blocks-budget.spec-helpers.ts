import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { writeEdgeFunctionFixtureOverlay } from './codegraph-nanoflow-overlay-query-edge-function-fixtures.spec-helpers';

export function registerCodegraphOverlayEdgeFunctionCodeBlockBudgetSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { tempRoots, writeFile, queryOverlay, expectSpawnSuccess, repoRoot, queryScriptPath } = context;
  const fixtureQueryArgs = (...args: string[]): string[] => [
    '--overlay', '.codegraph/nanoflow-overlay.json', ...args,
  ];

  it('does not backfill Edge Function method and header budgets with synthetic variables', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-edge-method-header-no-variable-backfill-'));
    tempRoots.push(root);
    const names = ['alpha', 'beta'];
    const nodes = [];
    const edges = [];

    for (const [index, name] of names.entries()) {
      const entry = `supabase/functions/${name}/index.ts`;
      writeFile(
        root,
        entry,
        [
          "import { serve } from 'https://deno.land/std/http/server.ts';",
          'serve(async (req) => {',
          "  const authHeader = req.headers.get('Authorization');",
          "  if (req.method === 'POST') {",
          `    return new Response('${name}:' + (authHeader ?? 'missing'));`,
          '  }',
          '  return new Response("unsupported", { status: 405 });',
          '});',
          '',
        ].join('\n'),
      );
      const functionNode = {
        id: `function:${entry}:${name}`,
        kind: 'function',
        name,
        qualifiedName: name,
        filePath: entry,
        language: 'typescript',
        startLine: 1,
        endLine: 1,
      };
      const methodNode = {
        id: `variable:${entry}:edge-function-method:${name}:POST:${4 + index}`,
        kind: 'variable',
        name: 'POST',
        qualifiedName: `${name}::POST`,
        filePath: entry,
        language: 'typescript',
        startLine: 4,
        endLine: 4,
      };
      const headerNode = {
        id: `variable:${entry}:edge-function-header:${name}:authorization:${3 + index}`,
        kind: 'variable',
        name: 'Authorization',
        qualifiedName: `${name}::Authorization`,
        filePath: entry,
        language: 'typescript',
        startLine: 3,
        endLine: 3,
      };
      nodes.push(functionNode, methodNode, headerNode);
      edges.push(
        {
          source: functionNode.id,
          target: methodNode.id,
          kind: 'references',
          line: 4,
          column: 10,
          metadata: {
            relation: 'edge-function-method',
            method: 'POST',
            sourceFile: entry,
          },
        },
        {
          source: functionNode.id,
          target: headerNode.id,
          kind: 'references',
          line: 3,
          column: 25,
          metadata: {
            relation: 'edge-function-header',
            header: 'Authorization',
            normalizedHeader: 'authorization',
            sourceFile: entry,
          },
        },
      );
    }

    writeEdgeFunctionFixtureOverlay(root, {
      files: names.map(name => `supabase/functions/${name}/index.ts`),
      nodes,
      edges,
    });

    const methodResult = queryOverlay(root, 'edge-function-method', fixtureQueryArgs('--limit', '20', '--native-json'));
    const headerResult = queryOverlay(root, 'edge-function-header', fixtureQueryArgs('--limit', '20', '--native-json'));

    expectSpawnSuccess(methodResult);
    expectSpawnSuccess(headerResult);
    const methodResponse = JSON.parse(methodResult.stdout);
    const headerResponse = JSON.parse(headerResult.stdout);
    expect(methodResponse.codeBlocks).toHaveLength(names.length);
    expect(headerResponse.codeBlocks).toHaveLength(names.length);
    expect(methodResponse.codeBlocks.every((block: { nodeKind?: string }) => block.nodeKind === 'function')).toBe(true);
    expect(headerResponse.codeBlocks.every((block: { nodeKind?: string }) => block.nodeKind === 'function')).toBe(true);
    expect(methodResponse.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeKind: 'variable', nodeName: 'POST' }),
    ]));
    expect(headerResponse.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeKind: 'variable', nodeName: 'Authorization' }),
    ]));
  });

  it('prioritizes caller code blocks for strict native Edge Function invoke relations', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-edge-invoke-source-budget-'));
    tempRoots.push(root);
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    const serviceFile = 'src/services/edge-invoke-client.service.ts';
    writeFile(
      root,
      serviceFile,
      [
        'export class EdgeInvokeClientService {',
        ...names.flatMap(name => [
          `  async invoke${name[0].toUpperCase()}${name.slice(1)}(client: { functions: { invoke(name: string): Promise<unknown> } }): Promise<unknown> {`,
          `    return client.functions.invoke('${name}');`,
          '  }',
        ]),
        '}',
        '',
      ].join('\n'),
    );
    const nodes = [];
    const edges = [];

    for (const [index, name] of names.entries()) {
      const entry = `supabase/functions/${name}/index.ts`;
      const methodName = `invoke${name[0].toUpperCase()}${name.slice(1)}`;
      const startLine = 2 + (index * 3);
      writeFile(
        root,
        entry,
        [
          `// ${name} function banner`,
          'Deno.serve(async (req) => new Response(req.method));',
          '',
        ].join('\n'),
      );
      const methodNode = {
        id: `method:${serviceFile}:EdgeInvokeClientService::${methodName}`,
        kind: 'method',
        name: methodName,
        qualifiedName: `EdgeInvokeClientService::${methodName}`,
        filePath: serviceFile,
        language: 'typescript',
        startLine,
        endLine: startLine + 2,
      };
      const routeNode = {
        id: `route:${entry}:/functions/v1/${name}`,
        kind: 'route',
        name: `/functions/v1/${name}`,
        qualifiedName: `/functions/v1/${name}`,
        filePath: entry,
        language: 'typescript',
        startLine: 1,
        endLine: 1,
      };
      nodes.push(methodNode, routeNode);
      edges.push({
        source: methodNode.id,
        target: routeNode.id,
        kind: 'references',
        line: startLine + 1,
        column: 11,
        metadata: {
          relation: 'edge-function-invoke',
          invokeName: name,
          path: `/functions/v1/${name}`,
        },
      });
    }

    writeEdgeFunctionFixtureOverlay(root, {
      files: [serviceFile, ...names.map(name => `supabase/functions/${name}/index.ts`)],
      nodes,
      edges,
    });

    const result = queryOverlay(root, 'edge-function-invoke', fixtureQueryArgs('--limit', '20', '--native-json'));

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBe(names.length);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: serviceFile,
      nodeKind: 'method',
      nodeName: 'invokeAlpha',
      content: expect.stringContaining("client.functions.invoke('alpha')"),
    }));
    expect(response.codeBlocks.slice(0, 5).every((block: { nodeKind?: string }) => block.nodeKind === 'method')).toBe(true);

    const markdown = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'edge-function-invoke',
      '--limit',
      '20',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(markdown);
    expect(markdown.stdout).toContain('## Code Context');
    expect(markdown.stdout).toContain('### Code');
    expect(markdown.stdout).toContain("client.functions.invoke('alpha')");
    expect(markdown.stdout).not.toContain('### NanoFlow Coverage');
    const codeStart = markdown.stdout.indexOf('### Code');
    expect(markdown.stdout.indexOf(`#### invokeAlpha (${serviceFile}:2)`, codeStart))
      .toBe(markdown.stdout.indexOf('#### ', codeStart));
    expect(markdown.stdout).not.toContain('#### /functions/v1/alpha (supabase/functions/alpha/index.ts:1)');
  });

  it('keeps mixed Edge Function relation and symbol queries focused on relation endpoints', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-edge-invoke-mixed-query-'));
    tempRoots.push(root);
    const serviceFile = 'src/services/widget-direct-notify.service.ts';
    const functionFile = 'supabase/functions/widget-notify/index.ts';
    const noisyHarnessFile = 'src/tests/scripts/codegraph-nanoflow-overlay-edge-function-invoke-sendDirectWidgetBlackBoxNotify.spec-helpers.ts';
    writeFile(
      root,
      serviceFile,
      [
        'export class WidgetDirectNotifyService {',
        '  async sendDirectWidgetBlackBoxNotify(client: { functions: { invoke(name: string): Promise<unknown> } }): Promise<unknown> {',
        "    return client.functions.invoke('widget-notify');",
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      functionFile,
      [
        'Deno.serve(async (req) => new Response(req.method));',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      noisyHarnessFile,
      [
        'export function writeEdgeFunctionInvokeSendDirectWidgetBlackBoxNotifyFixture(): void {}',
        '',
      ].join('\n'),
    );

    const methodNode = {
      id: `method:${serviceFile}:WidgetDirectNotifyService.sendDirectWidgetBlackBoxNotify`,
      kind: 'method',
      name: 'sendDirectWidgetBlackBoxNotify',
      qualifiedName: 'WidgetDirectNotifyService::sendDirectWidgetBlackBoxNotify',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 2,
      endLine: 4,
    };
    const routeNode = {
      id: `route:${functionFile}:/functions/v1/widget-notify`,
      kind: 'route',
      name: '/functions/v1/widget-notify',
      qualifiedName: '/functions/v1/widget-notify',
      filePath: functionFile,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const noisyHarnessNode = {
      id: `function:${noisyHarnessFile}:writeEdgeFunctionInvokeSendDirectWidgetBlackBoxNotifyFixture`,
      kind: 'function',
      name: 'writeEdgeFunctionInvokeSendDirectWidgetBlackBoxNotifyFixture',
      qualifiedName: 'writeEdgeFunctionInvokeSendDirectWidgetBlackBoxNotifyFixture',
      filePath: noisyHarnessFile,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };

    writeEdgeFunctionFixtureOverlay(root, {
      files: [serviceFile, functionFile, noisyHarnessFile],
      nodes: [methodNode, routeNode, noisyHarnessNode],
      edges: [{
        source: methodNode.id,
        target: routeNode.id,
        kind: 'references',
        line: 3,
        column: 11,
        metadata: {
          relation: 'edge-function-invoke',
          invokeName: 'widget-notify',
          path: '/functions/v1/widget-notify',
        },
      }],
    });

    const result = queryOverlay(root, 'edge-function-invoke sendDirectWidgetBlackBoxNotify', fixtureQueryArgs('--limit', '20', '--native-json'));

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges).toEqual([expect.objectContaining({
      source: methodNode.id,
      target: routeNode.id,
    })]);
    expect(response.entryPoints[0]).toEqual(expect.objectContaining({
      name: 'sendDirectWidgetBlackBoxNotify',
      filePath: serviceFile,
    }));
    expect(response.relatedFiles).not.toContain(noisyHarnessFile);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: serviceFile,
      nodeKind: 'method',
      nodeName: 'sendDirectWidgetBlackBoxNotify',
      content: expect.stringContaining("client.functions.invoke('widget-notify')"),
    }));
  });

  it('uses delegated Edge Function handlers for method relation code block budgets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-edge-delegated-method-budget-'));
    tempRoots.push(root);
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    const nodes = [];
    const edges = [];

    for (const [index, name] of names.entries()) {
      const entry = `supabase/functions/${name}/index.ts`;
      const delegated = index >= 3;
      writeFile(
        root,
        entry,
        delegated
          ? [
            `async function handleRequest(req: Request): Promise<Response> {`,
            "  if (req.method === 'OPTIONS') {",
            "    return new Response('ok');",
            '  }',
            "  if (req.method !== 'POST') {",
            '    return new Response("unsupported", { status: 405 });',
            '  }',
            `  return new Response('${name}:handled');`,
            '}',
            '',
            'Deno.serve(async (req) => {',
            '  try {',
            '    return await handleRequest(req);',
            '  } catch (error) {',
            '    return new Response("unexpected", { status: 500 });',
            '  }',
            '});',
            '',
          ].join('\n')
          : [
            "import { serve } from 'https://deno.land/std/http/server.ts';",
            'serve(async (req) => {',
            "  if (req.method === 'POST') {",
            `    return new Response('${name}:direct');`,
            '  }',
            '  return new Response("unsupported", { status: 405 });',
            '});',
            '',
          ].join('\n'),
      );
      const functionNode = {
        id: `function:${entry}:${name}`,
        kind: 'function',
        name,
        qualifiedName: name,
        filePath: entry,
        language: 'typescript',
        startLine: 1,
        endLine: 1,
      };
      const methodLine = delegated ? 5 : 3;
      const methodNode = {
        id: `variable:${entry}:edge-function-method:${name}:POST:${methodLine}`,
        kind: 'variable',
        name: 'POST',
        qualifiedName: `${name}::POST`,
        filePath: entry,
        language: 'typescript',
        startLine: methodLine,
        endLine: methodLine,
      };
      nodes.push(functionNode, methodNode);
      edges.push({
        source: functionNode.id,
        target: methodNode.id,
        kind: 'references',
        line: methodLine,
        column: 10,
        metadata: {
          relation: 'edge-function-method',
          method: 'POST',
          sourceFile: entry,
        },
      });
    }

    writeEdgeFunctionFixtureOverlay(root, {
      files: names.map(name => `supabase/functions/${name}/index.ts`),
      nodes,
      edges,
    });

    const result = queryOverlay(root, 'edge-function-method', fixtureQueryArgs('--limit', '20', '--native-json'));

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks.slice(0, 5).every((block: { content?: string }) =>
      block.content?.includes('req.method'))).toBe(true);
    const deltaBlock = response.codeBlocks.find((block: { filePath?: string }) =>
      block.filePath === 'supabase/functions/delta/index.ts');
    expect(deltaBlock).toEqual(expect.objectContaining({
      nodeKind: 'function',
      nodeName: 'delta',
      startLine: 1,
      content: expect.stringContaining('async function handleRequest(req: Request): Promise<Response> {'),
    }));
    expect(deltaBlock?.content).toContain("req.method !== 'POST'");
    expect(deltaBlock?.content).not.toContain('Deno.serve(async (req) => {');
  });
}
