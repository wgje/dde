import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayEdgeFunctionCodeBlockBudgetSpecs } from './codegraph-nanoflow-overlay-query-edge-function-code-blocks-budget.spec-helpers';
import { writeEdgeFunctionFixtureOverlay } from './codegraph-nanoflow-overlay-query-edge-function-fixtures.spec-helpers';

export function registerCodegraphOverlayEdgeFunctionCodeBlockSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { makeFixture, queryOverlay, expectSpawnSuccess, tempRoots, writeFile, repoRoot, queryScriptPath } = context;

  it('uses Edge Function source blocks for strict native route relation code blocks', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'edge-function-route', ['--limit', '20', '--native-json']);
    const markdownResult = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'edge-function-route',
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
    expectSpawnSuccess(markdownResult);
    const response = JSON.parse(result.stdout);
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'function:supabase/functions/transcribe/index.ts:transcribe',
        target: 'route:supabase/functions/transcribe/index.ts:/functions/v1/transcribe',
      }),
    ]));
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'supabase/functions/transcribe/index.ts',
        nodeKind: 'function',
        nodeName: 'transcribe',
        content: expect.stringContaining('Deno.serve(async (req) => {'),
      }),
    ]));
    const transcribeBlock = response.codeBlocks.find((block: { nodeName?: string }) => block.nodeName === 'transcribe');
    expect(transcribeBlock?.content).toContain("req.headers.get('Authorization')");

    expect(markdownResult.stdout).toContain('## Code Context');
    expect(markdownResult.stdout).toContain('### Entry Points');
    expect(markdownResult.stdout).toContain('### Relationships');
    expect(markdownResult.stdout).toContain('**references:**');
    expect(markdownResult.stdout).toContain('- transcribe -> /functions/v1/transcribe');
    expect(markdownResult.stdout).toContain('- widget-focus-action -> /functions/v1/widget-focus-action');
    expect(markdownResult.stdout).toContain('### Related Symbols');
    expect(markdownResult.stdout).toContain('### Code');
    const codeStart = markdownResult.stdout.indexOf('### Code');
    const handlerBlockIndex = markdownResult.stdout.indexOf('#### transcribe (supabase/functions/transcribe/index.ts:4)', codeStart);
    const routeBlockIndex = markdownResult.stdout.indexOf('#### /functions/v1/transcribe (supabase/functions/transcribe/index.ts:4)', codeStart);
    expect(handlerBlockIndex).toBe(markdownResult.stdout.indexOf('#### ', codeStart));
    expect(routeBlockIndex === -1 || routeBlockIndex > handlerBlockIndex).toBe(true);
    expect(markdownResult.stdout).toContain('Deno.serve(async (req) => {');
    expect(markdownResult.stdout).toContain("req.headers.get('Authorization')");
    expect(markdownResult.stdout).not.toContain('### Source Code');
    expect(markdownResult.stdout).not.toContain('### NanoFlow Coverage');
    expect(markdownResult.stdout).not.toContain('relation: edge-function-route');
    expect(markdownResult.stdout).not.toContain('metadata');
    expect(markdownResult.stdout).not.toContain('provenance');
  });

  it('skips empty strict native route relation code blocks when a handler cannot be located', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-edge-route-empty-block-'));
    tempRoots.push(root);
    const missingHandlerEntry = 'supabase/functions/backup-alert/index.ts';
    const handledEntry = 'supabase/functions/transcribe/index.ts';
    writeFile(
      root,
      missingHandlerEntry,
      [
        '',
        "export const functionName = 'backup-alert';",
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      handledEntry,
      [
        "Deno.serve(async (req) => {",
        "  return new Response(req.method);",
        '});',
        '',
      ].join('\n'),
    );
    const missingFunctionNode = {
      id: `function:${missingHandlerEntry}:backup-alert`,
      kind: 'function',
      name: 'backup-alert',
      qualifiedName: 'backup-alert',
      filePath: missingHandlerEntry,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const missingRouteNode = {
      id: `route:${missingHandlerEntry}:/functions/v1/backup-alert`,
      kind: 'route',
      name: '/functions/v1/backup-alert',
      qualifiedName: '/functions/v1/backup-alert',
      filePath: missingHandlerEntry,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const handledFunctionNode = {
      id: `function:${handledEntry}:transcribe`,
      kind: 'function',
      name: 'transcribe',
      qualifiedName: 'transcribe',
      filePath: handledEntry,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const handledRouteNode = {
      id: `route:${handledEntry}:/functions/v1/transcribe`,
      kind: 'route',
      name: '/functions/v1/transcribe',
      qualifiedName: '/functions/v1/transcribe',
      filePath: handledEntry,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    writeEdgeFunctionFixtureOverlay(root, {
      files: [missingHandlerEntry, handledEntry],
      nodes: [missingFunctionNode, missingRouteNode, handledFunctionNode, handledRouteNode],
      edges: [
        {
          source: missingFunctionNode.id,
          target: missingRouteNode.id,
          kind: 'references',
          line: 1,
          column: 0,
          metadata: {
            relation: 'edge-function-route',
            path: '/functions/v1/backup-alert',
            invokeName: 'backup-alert',
          },
        },
        {
          source: handledFunctionNode.id,
          target: handledRouteNode.id,
          kind: 'references',
          line: 1,
          column: 0,
          metadata: {
            relation: 'edge-function-route',
            path: '/functions/v1/transcribe',
            invokeName: 'transcribe',
          },
        },
      ],
    });

    const result = queryOverlay(root, 'edge-function-route', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks.every((block: { content?: string }) => block.content?.trim())).toBe(true);
    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: missingHandlerEntry,
        content: '',
      }),
    ]));
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: handledEntry,
        nodeName: 'transcribe',
        content: expect.stringContaining('Deno.serve'),
      }),
    ]));
  });

  it('prioritizes Edge Function source blocks when route relation results exceed the native code block budget', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-edge-route-budget-'));
    tempRoots.push(root);
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    const nodes = [];
    const edges = [];

    for (const name of names) {
      const entry = `supabase/functions/${name}/index.ts`;
      writeFile(
        root,
        entry,
        [
          "import { serve } from 'https://deno.land/std/http/server.ts';",
          `const functionName = '${name}';`,
          'serve(async (req) => {',
          "  const authHeader = req.headers.get('Authorization');",
          '  return new Response(`${functionName}:${authHeader ?? \"none\"}`);',
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
      const routeNode = {
        id: `route:${entry}:/functions/v1/${name}`,
        kind: 'route',
        name: `/functions/v1/${name}`,
        qualifiedName: `/functions/v1/${name}`,
        filePath: entry,
        language: 'typescript',
        startLine: 2,
        endLine: 2,
      };
      nodes.push(functionNode, routeNode);
      edges.push({
        source: functionNode.id,
        target: routeNode.id,
        kind: 'references',
        line: 2,
        column: 0,
        metadata: {
          relation: 'edge-function-route',
          path: `/functions/v1/${name}`,
          invokeName: name,
        },
      });
    }

    writeEdgeFunctionFixtureOverlay(root, {
      files: names.map(name => `supabase/functions/${name}/index.ts`),
      nodes,
      edges,
    });

    const result = queryOverlay(root, 'edge-function-route', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const functionBlocks = response.codeBlocks.filter((block: { nodeKind?: string }) => block.nodeKind === 'function');
    expect(functionBlocks.length).toBeGreaterThan(0);
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'supabase/functions/alpha/index.ts',
        nodeKind: 'function',
        nodeName: 'alpha',
        content: expect.stringContaining("req.headers.get('Authorization')"),
      }),
    ]));
  });

  it('expands edge-function-header code blocks past TypeScript return type object braces', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-edge-header-ts-return-type-'));
    tempRoots.push(root);
    const entry = 'supabase/functions/virus-scan/index.ts';
    writeFile(
      root,
      entry,
      [
        'async function verifyAuth(req: Request): Promise<{ userId: string } | null> {',
        "  const authHeader = req.headers.get('Authorization');",
        '  if (!authHeader) return null;',
        "  return { userId: authHeader.replace('Bearer ', '') };",
        '}',
        '',
      ].join('\n'),
    );
    const functionNode = {
      id: `function:${entry}:virus-scan`,
      kind: 'function',
      name: 'virus-scan',
      qualifiedName: 'virus-scan',
      filePath: entry,
      language: 'typescript',
      startLine: 1,
      endLine: 5,
    };
    const headerNode = {
      id: `variable:${entry}:edge-function-header:virus-scan:authorization:2`,
      kind: 'variable',
      name: 'Authorization',
      qualifiedName: 'virus-scan::Authorization',
      filePath: entry,
      language: 'typescript',
      startLine: 2,
      endLine: 2,
    };
    writeEdgeFunctionFixtureOverlay(root, {
      files: [entry],
      nodes: [functionNode, headerNode],
      edges: [{
        source: functionNode.id,
        target: headerNode.id,
        kind: 'references',
        line: 2,
        column: 21,
        metadata: {
          relation: 'edge-function-header',
          header: 'Authorization',
          normalizedHeader: 'authorization',
          sourceFile: entry,
        },
      }],
    });

    const result = queryOverlay(root, 'edge-function-header', ['--limit', '20', '--native-json']);
    const markdown = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'edge-function-header',
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
    expectSpawnSuccess(markdown);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: entry,
      nodeKind: 'function',
      nodeName: 'verifyAuth',
      startLine: 1,
      endLine: 5,
      content: expect.stringContaining("req.headers.get('Authorization')"),
    }));
    expect(markdown.stdout).toContain('#### verifyAuth (supabase/functions/virus-scan/index.ts:1)');
    expect(markdown.stdout).toContain("req.headers.get('Authorization')");
  });

  it('prioritizes Edge Function handlers for method and header relation code block budgets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-edge-method-header-budget-'));
    tempRoots.push(root);
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
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

    const methodResult = queryOverlay(root, 'edge-function-method', ['--limit', '20', '--native-json']);
    const headerResult = queryOverlay(root, 'edge-function-header', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(methodResult);
    expectSpawnSuccess(headerResult);
    const methodResponse = JSON.parse(methodResult.stdout);
    const headerResponse = JSON.parse(headerResult.stdout);
    expect(methodResponse.edges.length).toBe(names.length);
    expect(headerResponse.edges.length).toBe(names.length);
    expect(methodResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'supabase/functions/alpha/index.ts',
      nodeKind: 'function',
      nodeName: 'alpha',
      content: expect.stringContaining("req.method === 'POST'"),
    }));
    expect(headerResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'supabase/functions/alpha/index.ts',
      nodeKind: 'function',
      nodeName: 'alpha',
      content: expect.stringContaining("req.headers.get('Authorization')"),
    }));
    expect(methodResponse.codeBlocks.slice(0, 5).every((block: { nodeKind?: string }) => block.nodeKind === 'function')).toBe(true);
    expect(headerResponse.codeBlocks.slice(0, 5).every((block: { nodeKind?: string }) => block.nodeKind === 'function')).toBe(true);

    const methodMarkdown = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'edge-function-method',
      '--limit',
      '20',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const headerMarkdown = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'edge-function-header',
      '--limit',
      '20',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(methodMarkdown);
    expectSpawnSuccess(headerMarkdown);
    expect(methodMarkdown.stdout).toContain('## Code Context');
    expect(methodMarkdown.stdout).toContain('### Code');
    expect(methodMarkdown.stdout).toContain("req.method === 'POST'");
    expect(methodMarkdown.stdout).not.toContain('### NanoFlow Coverage');
    const methodCodeStart = methodMarkdown.stdout.indexOf('### Code');
    expect(methodMarkdown.stdout.indexOf('#### alpha (supabase/functions/alpha/index.ts:2)', methodCodeStart))
      .toBe(methodMarkdown.stdout.indexOf('#### ', methodCodeStart));
    expect(methodMarkdown.stdout).not.toContain('#### POST (supabase/functions/alpha/index.ts:4)');
    expect(headerMarkdown.stdout).toContain("req.headers.get('Authorization')");
    expect(headerMarkdown.stdout).not.toContain('### NanoFlow Coverage');
    const headerCodeStart = headerMarkdown.stdout.indexOf('### Code');
    expect(headerMarkdown.stdout.indexOf('#### alpha (supabase/functions/alpha/index.ts:2)', headerCodeStart))
      .toBe(headerMarkdown.stdout.indexOf('#### ', headerCodeStart));
    expect(headerMarkdown.stdout).not.toContain('#### Authorization (supabase/functions/alpha/index.ts:3)');
  });

  it('uses helper header evidence for edge-function-header when req.headers.get is outside the handler', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-edge-header-helper-evidence-'));
    tempRoots.push(root);
    const entry = 'supabase/functions/helper-header/index.ts';
    writeFile(
      root,
      entry,
      [
        "import { serve } from 'https://deno.land/std/http/server.ts';",
        '',
        'async function verifyMaintenanceBearer(req: Request): Promise<Response | null> {',
        "  const authHeader = req.headers.get('Authorization');",
        "  if (!authHeader) return new Response('missing', { status: 401 });",
        '  return null;',
        '}',
        '',
        'serve(async (req) => {',
        '  const authError = await verifyMaintenanceBearer(req);',
        '  if (authError) return authError;',
        "  return new Response('ok');",
        '});',
        '',
      ].join('\n'),
    );
    const functionNode = {
      id: `function:${entry}:helper-header`,
      kind: 'function',
      name: 'helper-header',
      qualifiedName: 'helper-header',
      filePath: entry,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const headerNode = {
      id: `variable:${entry}:edge-function-header:helper-header:authorization:4`,
      kind: 'variable',
      name: 'Authorization',
      qualifiedName: 'helper-header::Authorization',
      filePath: entry,
      language: 'typescript',
      startLine: 4,
      endLine: 4,
    };
    writeEdgeFunctionFixtureOverlay(root, {
      files: [entry],
      nodes: [functionNode, headerNode],
      edges: [{
        source: functionNode.id,
        target: headerNode.id,
        kind: 'references',
        line: 4,
        column: 22,
        metadata: {
          relation: 'edge-function-header',
          header: 'Authorization',
          normalizedHeader: 'authorization',
          sourceFile: entry,
        },
      }],
    });

    const result = queryOverlay(root, 'edge-function-header', ['--limit', '20', '--native-json']);
    const markdownResult = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'edge-function-header',
      '--limit',
      '20',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(result);
    expectSpawnSuccess(markdownResult);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: entry,
      nodeKind: 'function',
      nodeName: 'verifyMaintenanceBearer',
      startLine: 3,
      content: expect.stringContaining("req.headers.get('Authorization')"),
    }));
    expect(response.codeBlocks[0].content).toContain('verifyMaintenanceBearer');
    expect(response.codeBlocks[0].content).not.toContain('serve(async (req)');
    expect(markdownResult.stdout).toContain('#### verifyMaintenanceBearer (supabase/functions/helper-header/index.ts:3)');
    expect(markdownResult.stdout).toContain("req.headers.get('Authorization')");
    expect(markdownResult.stdout).toContain('verifyMaintenanceBearer');
    expect(markdownResult.stdout).not.toContain('serve(async (req)');
  });

  it('uses shared helper header evidence when the edge source is the entry function', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-edge-header-shared-helper-source-'));
    tempRoots.push(root);
    const entry = 'supabase/functions/widget-focus-action/index.ts';
    const shared = 'supabase/functions/_shared/widget-common.ts';
    writeFile(
      root,
      entry,
      [
        "import { getBearerToken } from '../_shared/widget-common.ts';",
        '',
        'Deno.serve(async (req) => {',
        "  const corsHeaders = getCorsHeaders(req.headers.get('Origin'), 'POST, OPTIONS');",
        '  const token = getBearerToken(req);',
        "  return new Response(token ?? 'missing', { headers: corsHeaders });",
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      shared,
      [
        'export function getBearerToken(req: Request): string | null {',
        "  const authHeader = req.headers.get('Authorization');",
        '  if (!authHeader) return null;',
        "  return authHeader.replace('Bearer ', '');",
        '}',
        '',
      ].join('\n'),
    );
    const functionNode = {
      id: `function:${entry}:widget-focus-action`,
      kind: 'function',
      name: 'widget-focus-action',
      qualifiedName: 'widget-focus-action',
      filePath: entry,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const headerNode = {
      id: `variable:${shared}:edge-function-header:widget-focus-action:authorization:2`,
      kind: 'variable',
      name: 'Authorization',
      qualifiedName: 'widget-focus-action::Authorization',
      filePath: shared,
      language: 'typescript',
      startLine: 2,
      endLine: 2,
    };
    writeEdgeFunctionFixtureOverlay(root, {
      files: [entry, shared],
      nodes: [functionNode, headerNode],
      edges: [{
        source: functionNode.id,
        target: headerNode.id,
        kind: 'references',
        line: 2,
        metadata: {
          relation: 'edge-function-header',
          header: 'Authorization',
          normalizedHeader: 'authorization',
          sourceFile: shared,
        },
      }],
    });

    const result = queryOverlay(root, 'Authorization edge-function-header', ['--limit', '20', '--native-json']);
    const markdownResult = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'Authorization edge-function-header',
      '--limit',
      '20',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(result);
    expectSpawnSuccess(markdownResult);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: shared,
      nodeKind: 'function',
      nodeName: 'getBearerToken',
      startLine: 1,
      content: expect.stringContaining("req.headers.get('Authorization')"),
    }));
    expect(response.codeBlocks[0].content).toContain('getBearerToken');
    expect(response.codeBlocks[0].content).not.toContain("req.headers.get('Origin')");
    expect(markdownResult.stdout).toContain(`#### getBearerToken (${shared}:1)`);
    expect(markdownResult.stdout).toContain("req.headers.get('Authorization')");
    expect(markdownResult.stdout).not.toContain("req.headers.get('Origin')");
  });

  registerCodegraphOverlayEdgeFunctionCodeBlockBudgetSpecs(context);

}
