import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayJsonProjectionTestReferenceBudgetSpecs(context: CodegraphOverlaySpecContext): void {
  const { writeFile, runOverlay, queryOverlay, expectSpawnSuccess, tempRoots, queryScriptPath, repoRoot } = context;
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
  const writeOverlayFixture = (root: string, overlay: unknown): void => {
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));
  };
  const nativeMarkdownCodeSection = (stdout: string): string => {
    const codeStart = stdout.indexOf('### Code');
    return codeStart === -1 ? stdout : stdout.slice(codeStart);
  };
  const makeFilenameReferenceFixture = (prefix: string) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempRoots.push(root);
    const contractFile = 'src/tests/contracts/migration-artifacts.contract.spec.ts';
    const firstMigration = '20260612010000_first_contract.sql';
    const secondMigration = '20260612020000_second_contract.sql';
    const contractLines = [
      "import { describe, expect, it } from 'vitest';",
      '',
      "describe('migration artifact contract', () => {",
      "  it('keeps required migrations covered by filename', () => {",
      `    expect(readMigration('${firstMigration}')).toContain('create table');`,
      "    expect('unrelated assertion').toBeTruthy();",
      `    expect(readMigration('${secondMigration}')).toContain('create policy');`,
      '  });',
      '});',
      '',
    ];
    writeFile(root, contractFile, contractLines.join('\n'));
    writeFile(root, `supabase/migrations/${firstMigration}`, [
      '-- first migration',
      'create table public.first_contracts (id uuid primary key);',
      '',
    ].join('\n'));
    writeFile(root, `supabase/migrations/${secondMigration}`, [
      '-- second migration',
      'create policy "second owner" on public.first_contracts for select using (true);',
      '',
    ].join('\n'));
    const contractNode = {
      id: `file:${contractFile}:${contractFile}`,
      kind: 'file',
      name: contractFile,
      qualifiedName: contractFile,
      filePath: contractFile,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const migrationNodes = [firstMigration, secondMigration].map((migrationName) => ({
      id: `file:supabase/migrations/${migrationName}:${migrationName}`,
      kind: 'file',
      name: migrationName,
      qualifiedName: migrationName,
      filePath: `supabase/migrations/${migrationName}`,
      language: 'unknown',
      startLine: 1,
      endLine: 1,
    }));
    writeOverlayFixture(root, {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [contractFile],
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
        nodes: [contractNode, ...migrationNodes],
        edges: migrationNodes.map((migrationNode) => ({
          source: migrationNode.id,
          target: contractNode.id,
          kind: 'references',
          metadata: {
            relation: 'test',
            testMapping: 'filename-reference',
            matchedNeedle: migrationNode.name,
          },
        })),
      },
    });

    return { root, contractFile, firstMigration, secondMigration, contractLines };
  };
  const makePathRouteReferenceFixture = (prefix: string) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempRoots.push(root);
    const contractFile = 'src/tests/contracts/transcribe-route.contract.spec.ts';
    const functionFile = 'supabase/functions/transcribe/index.ts';
    const contractLines = [
      "import { describe, expect, it } from 'vitest';",
      '',
      "describe('transcribe deployment references', () => {",
      "  it('covers path and deployed route references', () => {",
      `    expect(readSource('${functionFile}')).toContain('Deno.serve');`,
      "    expect('unrelated assertion').toBeTruthy();",
      "    expect(fetch('/functions/v1/transcribe')).resolves.toBeDefined();",
      '  });',
      '});',
      '',
    ];
    writeFile(root, contractFile, contractLines.join('\n'));
    writeFile(root, functionFile, [
      'Deno.serve(async req => {',
      "  return new Response(req.method);",
      '});',
      '',
    ].join('\n'));
    const contractNode = {
      id: `file:${contractFile}:${contractFile}`,
      kind: 'file',
      name: contractFile,
      qualifiedName: contractFile,
      filePath: contractFile,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const functionNode = {
      id: `function:${functionFile}:transcribe`,
      kind: 'function',
      name: 'transcribe',
      qualifiedName: 'transcribe',
      filePath: functionFile,
      language: 'typescript',
      startLine: 1,
      endLine: 3,
    };
    writeOverlayFixture(root, {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [contractFile, functionFile],
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
        nodes: [contractNode, functionNode],
        edges: [
          {
            source: functionNode.id,
            target: contractNode.id,
            kind: 'references',
            metadata: {
              relation: 'test',
              testMapping: 'path-reference',
              matchedNeedle: functionFile,
            },
          },
          {
            source: functionNode.id,
            target: contractNode.id,
            kind: 'references',
            metadata: {
              relation: 'test',
              testMapping: 'route-reference',
              matchedNeedle: '/functions/v1/transcribe',
            },
          },
        ],
      },
    });

    return { root, contractFile, functionFile, contractLines };
  };

  it('returns focused test reference code blocks for filename-reference relation queries', () => {
    const { root, contractFile, firstMigration, secondMigration, contractLines } = makeFilenameReferenceFixture(
      'nanoflow-codegraph-filename-reference-budget-',
    );

    const result = queryOverlay(root, 'filename-reference', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBeGreaterThanOrEqual(2);
    expect(response.codeBlocks.slice(0, 2)).toEqual([
      expect.objectContaining({
        filePath: contractFile,
        startLine: 5,
        endLine: 5,
        nodeKind: 'file',
        content: expect.stringContaining(firstMigration),
      }),
      expect.objectContaining({
        filePath: contractFile,
        startLine: 7,
        endLine: 7,
        nodeKind: 'file',
        content: expect.stringContaining(secondMigration),
      }),
    ]);
    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: contractFile,
        startLine: 1,
        endLine: contractLines.length,
      }),
    ]));
  });

  it('returns focused test reference code blocks for filename-reference native Markdown queries', () => {
    const { root, contractFile, firstMigration, secondMigration } = makeFilenameReferenceFixture(
      'nanoflow-codegraph-filename-reference-md-',
    );

    const result = queryNativeMarkdown(root, 'filename-reference');

    expectSpawnSuccess(result);
    const code = nativeMarkdownCodeSection(result.stdout);
    expect(code).toContain(`#### ${firstMigration} (${contractFile}:5)`);
    expect(code).toContain(`#### ${secondMigration} (${contractFile}:7)`);
    expect(code).toContain(firstMigration);
    expect(code).toContain(secondMigration);
    expect(code).not.toContain("describe('migration artifact contract");
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
  });

  it('returns focused test reference code blocks for path and route reference queries', () => {
    const { root, contractFile, functionFile, contractLines } = makePathRouteReferenceFixture(
      'nanoflow-codegraph-edge-function-test-reference-budget-',
    );

    const pathResult = queryOverlay(root, 'path-reference', ['--limit', '20', '--native-json']);
    const routeResult = queryOverlay(root, 'route-reference', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(pathResult);
    expectSpawnSuccess(routeResult);
    const pathResponse = JSON.parse(pathResult.stdout);
    const routeResponse = JSON.parse(routeResult.stdout);
    expect(pathResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: contractFile,
      startLine: 5,
      endLine: 5,
      nodeKind: 'file',
      content: expect.stringContaining(functionFile),
    }));
    expect(routeResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: contractFile,
      startLine: 7,
      endLine: 7,
      nodeKind: 'file',
      content: expect.stringContaining('/functions/v1/transcribe'),
    }));
    for (const response of [pathResponse, routeResponse]) {
      expect(response.edges.length).toBeGreaterThan(0);
      for (const edge of response.edges as Array<Record<string, unknown>>) {
        expect(Object.keys(edge).sort()).toEqual(['kind', 'source', 'target']);
        expect(edge).not.toHaveProperty('metadata');
        expect(edge).not.toHaveProperty('sourceName');
        expect(edge).not.toHaveProperty('targetName');
      }
      expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          filePath: contractFile,
          startLine: 1,
          endLine: contractLines.length,
        }),
      ]));
    }
  });

  it('returns focused test reference code blocks for path-reference native Markdown queries', () => {
    const { root, contractFile, functionFile } = makePathRouteReferenceFixture(
      'nanoflow-codegraph-edge-function-path-reference-md-',
    );

    const result = queryNativeMarkdown(root, 'path-reference');

    expectSpawnSuccess(result);
    const code = nativeMarkdownCodeSection(result.stdout);
    expect(code).toContain(`#### ${functionFile} (${contractFile}:5)`);
    expect(code).toContain(functionFile);
    expect(code).not.toContain("describe('transcribe deployment references");
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
  });

  it('returns focused test reference code blocks for route-reference native Markdown queries', () => {
    const { root, contractFile } = makePathRouteReferenceFixture(
      'nanoflow-codegraph-edge-function-route-reference-md-',
    );

    const result = queryNativeMarkdown(root, 'route-reference');

    expectSpawnSuccess(result);
    const code = nativeMarkdownCodeSection(result.stdout);
    expect(code).toContain(`#### /functions/v1/transcribe (${contractFile}:7)`);
    expect(code).toContain('/functions/v1/transcribe');
    expect(code).not.toContain("describe('transcribe deployment references");
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
  });

  it('returns focused test reference code blocks for invoke-reference relation queries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-edge-function-invoke-reference-budget-'));
    tempRoots.push(root);
    const contractFile = 'src/tests/contracts/transcribe-invoke.contract.spec.ts';
    const functionFile = 'supabase/functions/transcribe/index.ts';
    const contractLines = [
      "import { describe, expect, it } from 'vitest';",
      '',
      "describe('transcribe invoke references', () => {",
      "  const invokeName = 'transcribe';",
      "  it('covers deployed invoke references', async () => {",
      "    expect(invokeName).toBe('transcribe');",
      "    await supabase.functions.invoke('transcribe', { body: { audio: 'sample' } });",
      '  });',
      '});',
      '',
    ];
    writeFile(root, contractFile, contractLines.join('\n'));
    writeFile(root, functionFile, [
      'Deno.serve(async req => {',
      "  return new Response(req.method);",
      '});',
      '',
    ].join('\n'));

    const overlayResult = runOverlay(root);
    expectSpawnSuccess(overlayResult);
    writeFile(root, '.codegraph/nanoflow-overlay.json', overlayResult.stdout);

    const result = queryOverlay(root, 'invoke-reference', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: `function:${functionFile}:transcribe`,
        target: `file:${contractFile}:${contractFile}`,
      }),
    ]));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: contractFile,
      startLine: 7,
      endLine: 7,
      nodeKind: 'file',
      content: expect.stringContaining("functions.invoke('transcribe'"),
    }));
    for (const edge of response.edges as Array<Record<string, unknown>>) {
      expect(Object.keys(edge).sort()).toEqual(['kind', 'source', 'target']);
      expect(edge).not.toHaveProperty('metadata');
      expect(edge).not.toHaveProperty('sourceName');
      expect(edge).not.toHaveProperty('targetName');
    }
    expect(response.codeBlocks[0].content).not.toContain("describe('transcribe");
    expect(response.codeBlocks[0].content).not.toContain('invokeName');
  });

  it('returns focused test reference code blocks for invoke-reference native Markdown queries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-edge-function-invoke-reference-md-'));
    tempRoots.push(root);
    const contractFile = 'src/tests/contracts/transcribe-invoke.contract.spec.ts';
    const functionFile = 'supabase/functions/transcribe/index.ts';
    const contractLines = [
      "import { describe, expect, it } from 'vitest';",
      '',
      "describe('transcribe invoke references', () => {",
      "  const invokeName = 'transcribe';",
      "  it('covers deployed invoke references', async () => {",
      "    expect(invokeName).toBe('transcribe');",
      "    await supabase.functions.invoke('transcribe', { body: { audio: 'sample' } });",
      '  });',
      '});',
      '',
    ];
    writeFile(root, contractFile, contractLines.join('\n'));
    writeFile(root, functionFile, [
      'Deno.serve(async req => {',
      "  return new Response(req.method);",
      '});',
      '',
    ].join('\n'));

    const overlayResult = runOverlay(root);
    expectSpawnSuccess(overlayResult);
    writeFile(root, '.codegraph/nanoflow-overlay.json', overlayResult.stdout);

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'invoke-reference',
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
    const codeStart = result.stdout.indexOf('### Code');
    const code = result.stdout.slice(codeStart);
    expect(code).toContain(`#### functions.invoke('transcribe' (${contractFile}:7)`);
    expect(code).toContain("functions.invoke('transcribe'");
    expect(code).not.toContain("describe('transcribe");
    expect(code).not.toContain('invokeName');
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
  });

  it('maps bare invoke calls as Edge Function invoke-reference test evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-edge-function-bare-invoke-reference-'));
    tempRoots.push(root);
    const contractFile = 'src/tests/contracts/transcribe-bare-invoke.contract.spec.ts';
    const functionFile = 'supabase/functions/transcribe/index.ts';
    const contractLines = [
      "import { describe, expect, it } from 'vitest';",
      '',
      "describe('transcribe bare invoke references', () => {",
      "  const invokeName = 'transcribe';",
      "  it('covers a bound Edge Function invoke helper', async () => {",
      "    expect(invokeName).toBe('transcribe');",
      '    await invoke("transcribe", { body: { audio: "sample" } });',
      '  });',
      '});',
      '',
    ];
    writeFile(root, contractFile, contractLines.join('\n'));
    writeFile(root, functionFile, [
      'Deno.serve(async req => {',
      "  return new Response(req.method);",
      '});',
      '',
    ].join('\n'));

    const overlayResult = runOverlay(root);
    expectSpawnSuccess(overlayResult);
    writeFile(root, '.codegraph/nanoflow-overlay.json', overlayResult.stdout);

    const result = queryOverlay(root, 'invoke-reference', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: `function:${functionFile}:transcribe`,
        target: `file:${contractFile}:${contractFile}`,
      }),
    ]));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: contractFile,
      startLine: 7,
      endLine: 7,
      nodeKind: 'file',
      content: expect.stringContaining('invoke("transcribe"'),
    }));
    expect(response.codeBlocks[0].content).not.toContain("describe('transcribe");
    expect(response.codeBlocks[0].content).not.toContain('invokeName');
  });
}
