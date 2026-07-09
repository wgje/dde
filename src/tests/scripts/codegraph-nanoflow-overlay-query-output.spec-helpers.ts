import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayQueryOutputSpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, writeFile, queryOverlay, expectSpawnSuccess, tempRoots, repoRoot, queryScriptPath } = context;

  it('does not read source blocks outside the project root from crafted overlay paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-overlay-root-'));
    const outsideRoot = `${root}-evil`;
    tempRoots.push(root, outsideRoot);
    fs.mkdirSync(outsideRoot, { recursive: true });

    const leakedSourceMarker = 'SHOULD_NOT_LEAK_OUTSIDE_PROJECT';
    fs.writeFileSync(
      path.join(outsideRoot, 'leak.ts'),
      `export function outsideSecret() { return '${leakedSourceMarker}'; }\n`,
    );

    const outsideRelativePath = path.join('..', path.basename(outsideRoot), 'leak.ts').replace(/\\/g, '/');
    writeFile(root, '.codegraph/nanoflow-overlay.json', JSON.stringify({
      schemaVersion: 1,
      project: { root },
      graph: {
        nodes: [{
          id: 'function:outside-secret',
          kind: 'function',
          name: 'outsideSecret',
          qualifiedName: 'outsideSecret',
          filePath: outsideRelativePath,
          language: 'typescript',
          startLine: 1,
          endLine: 1,
        }],
        edges: [],
      },
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
    }));

    const result = queryOverlay(root, 'outsideSecret');

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'outsideSecret', filePath: outsideRelativePath }),
    ]));
    expect(response.codeBlocks).toEqual([]);
    expect(response.markdown).not.toContain('export function outsideSecret');
    expect(result.stdout).not.toContain(leakedSourceMarker);
  }, 10_000);

  it('prints native CodeGraph-style Markdown for overlay query output', () => {
    const root = makeFixture();

    const result = spawnSync(process.execPath, [queryScriptPath, '--root', root, '--query', 'touch'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('## Exploration: touch');
    expect(result.stdout).toMatch(/Found \d+ symbols across \d+ files\./);
    expect(result.stdout).toContain('SampleService:4');
    expect(result.stdout).not.toContain('### Relationships');
    expect(result.stdout).not.toContain('**contains:**');
    expect(result.stdout).toContain('### Blast radius — what depends on these (update/verify before editing)');
    expect(result.stdout).toContain('### Related Symbols');
    expect(result.stdout).toContain('### Source Code');
    expect(result.stdout).toContain('The code below is the **verbatim, current on-disk source**');
    expect(result.stdout).toMatch(/#### src\/app\/features\/sample\/sample\.service\.ts — .*SampleService\(class\)/);
    expect(result.stdout).toContain('```typescript');
    expect(result.stdout).toContain('4\t@Injectable');
    expect(result.stdout).toContain('5\texport class SampleService');
    expect(result.stdout).toContain('- androidKotlinFunctions: 0');
    expect(result.stdout).toContain('- androidKotlinFunctionEdges: 0');
    expect(result.stdout).not.toContain('Complete source for');
    expect(result.stdout).not.toContain('Explore budget:');
    expect(result.stdout.indexOf('### Source Code')).toBeLessThan(result.stdout.indexOf('### NanoFlow Coverage'));
  });

  it('rejects ambiguous JSON and native Markdown output modes', () => {
    const root = makeFixture();

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'SampleService',
      '--json',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--native-markdown cannot be combined with --json');
  });

  it('prints strict native Markdown sections in official order without NanoFlow-only sections', () => {
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
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(result);

    const output = result.stdout;
    const codeContextIndex = output.indexOf('## Code Context');
    const entryPointsIndex = output.indexOf('### Entry Points');
    const relatedSymbolsIndex = output.indexOf('### Related Symbols');
    const codeIndex = output.indexOf('### Code');

    expect(codeContextIndex).toBeGreaterThanOrEqual(0);
    expect(entryPointsIndex).toBeGreaterThan(codeContextIndex);
    expect(relatedSymbolsIndex).toBeGreaterThan(entryPointsIndex);
    expect(codeIndex).toBeGreaterThan(relatedSymbolsIndex);

    expect(output.trimStart()).not.toMatch(/^\{/);
    expect(output).not.toContain('## Exploration:');
    expect(output).not.toContain('### Source Code');
    expect(output).not.toContain('### NanoFlow Coverage');
    expect(output).not.toContain('### Not shown above');
    expect(output).not.toContain('Complete source for');
    expect(output).not.toContain('Explore budget:');
  });

  it('rejects ambiguous compact context JSON and native JSON output modes', () => {
    const root = makeFixture();

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'SampleService',
      '--context-json',
      '--native-json',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--context-json cannot be combined with --native-json');
  });

  it('rejects overlay query limits that are not complete decimal integers', () => {
    const root = makeFixture();

    for (const invalidLimit of ['1.5', '10abc']) {
      const result = spawnSync(process.execPath, [
        queryScriptPath,
        '--root',
        root,
        '--query',
        'SampleService',
        '--limit',
        invalidLimit,
        '--json',
      ], {
        cwd: repoRoot,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
      });

      expect(result.status, `limit ${invalidLimit} should be rejected`).not.toBe(0);
      expect(result.stderr).toContain('--limit must be a positive integer.');
    }
  });

  it('prints compact context JSON without formatter-only payloads for MCP context packs', () => {
    const root = makeFixture();

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'SampleService',
      '--limit',
      '1',
      '--context-json',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response).toEqual(expect.objectContaining({
      query: 'SampleService',
      matches: expect.any(Array),
      nodes: expect.any(Array),
      relationshipGroups: expect.any(Object),
      coverage: expect.any(Object),
    }));
    expect(response).not.toHaveProperty('markdown');
    expect(response).not.toHaveProperty('displayEdges');
    expect(response).not.toHaveProperty('codeBlocks');
    expect(response).not.toHaveProperty('edges');
    expect(response.coverage).toEqual(expect.objectContaining({
      androidKotlinFunctions: 0,
      androidKotlinFunctionEdges: 0,
    }));
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'SampleService' }),
    ]));
  });

  it('prioritizes segmented file-name matches across compact and native output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-file-segment-priority-'));
    tempRoots.push(root);
    const targetFile = 'vitest.services.config.mts';
    const genericVitestFile = 'vitest.config.mts';
    const noisyServiceFile = 'src/app/shared/components/knowledge-anchor/knowledge-anchor-popover.service.ts';
    writeFile(
      root,
      targetFile,
      [
        "import { defineConfig } from 'vitest/config';",
        '',
        'export const servicesVitestConfig = defineConfig({',
        "  test: {",
        "    setupFiles: ['fake-indexeddb/auto'],",
        "    pool: 'threads',",
        '    isolate: true,',
        '  },',
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      genericVitestFile,
      [
        "import { defineConfig } from 'vitest/config';",
        '',
        'export const genericVitestConfig = defineConfig({',
        "  test: { pool: 'forks' },",
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      noisyServiceFile,
      [
        'export function scheduleCleanupTimers(): void {',
        "  setTimeout(() => console.info('cleanup service timers'), 10);",
        '}',
        '',
      ].join('\n'),
    );
    const nodes = [
      {
        id: 'function:src/app/shared/components/knowledge-anchor/knowledge-anchor-popover.service.ts:scheduleCleanupTimers',
        kind: 'function',
        name: 'scheduleCleanupTimers',
        qualifiedName: 'scheduleCleanupTimers',
        filePath: noisyServiceFile,
        language: 'typescript',
        startLine: 1,
        endLine: 3,
      },
      {
        id: 'constant:vitest.config.mts:genericVitestConfig',
        kind: 'constant',
        name: 'genericVitestConfig',
        qualifiedName: 'genericVitestConfig',
        filePath: genericVitestFile,
        language: 'typescript',
        startLine: 3,
        endLine: 5,
      },
      {
        id: 'constant:vitest.services.config.mts:servicesVitestConfig',
        kind: 'constant',
        name: 'servicesVitestConfig',
        qualifiedName: 'servicesVitestConfig',
        filePath: targetFile,
        language: 'typescript',
        startLine: 3,
        endLine: 9,
      },
    ];
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [targetFile, genericVitestFile, noisyServiceFile],
        classes: [],
        functions: nodes.filter(node => node.kind === 'function'),
        interfaces: [],
        types: [],
        variables: nodes.filter(node => node.kind === 'constant'),
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
    writeFile(root, '.codegraph/nanoflow-overlay.json', JSON.stringify(overlay, null, 2));

    const query = 'vitest services config mts setupFiles cleanup timers service tests config';
    const defaultResult = queryOverlay(root, query, ['--limit', '20']);
    const nativeJsonResult = queryOverlay(root, query, ['--limit', '20', '--native-json']);
    const nativeMarkdownResult = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      query,
      '--limit',
      '20',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const contextJsonResult = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      query,
      '--limit',
      '20',
      '--context-json',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(defaultResult);
    expectSpawnSuccess(nativeJsonResult);
    expectSpawnSuccess(nativeMarkdownResult);
    expectSpawnSuccess(contextJsonResult);
    const defaultResponse = JSON.parse(defaultResult.stdout);
    const nativeJsonResponse = JSON.parse(nativeJsonResult.stdout);
    const contextJsonResponse = JSON.parse(contextJsonResult.stdout);

    expect(defaultResponse.relatedFiles[0]).toBe(targetFile);
    expect(defaultResponse.entryPoints[0]).toEqual(expect.objectContaining({ filePath: targetFile }));
    expect(defaultResponse.codeBlocks[0]).toEqual(expect.objectContaining({ filePath: targetFile }));
    expect(defaultResponse.markdown.indexOf(`#### ${targetFile}`)).toBeGreaterThanOrEqual(0);
    expect(defaultResponse.markdown.indexOf(`#### ${targetFile}`)).toBeLessThan(
      defaultResponse.markdown.indexOf(`#### ${genericVitestFile}`),
    );

    expect(nativeJsonResponse.relatedFiles[0]).toBe(targetFile);
    expect(nativeJsonResponse.entryPoints[0]).toEqual(expect.objectContaining({ filePath: targetFile }));
    expect(nativeJsonResponse.codeBlocks[0]).toEqual(expect.objectContaining({ filePath: targetFile }));

    expect(nativeMarkdownResult.stdout.indexOf(`- **servicesVitestConfig** (constant) - ${targetFile}:3`)).toBeGreaterThanOrEqual(0);
    expect(nativeMarkdownResult.stdout.indexOf(`- **servicesVitestConfig** (constant) - ${targetFile}:3`)).toBeLessThan(
      nativeMarkdownResult.stdout.indexOf(`- **genericVitestConfig** (constant) - ${genericVitestFile}:3`),
    );
    expect(nativeMarkdownResult.stdout.indexOf(`#### servicesVitestConfig (${targetFile}:3)`)).toBeGreaterThanOrEqual(0);
    expect(nativeMarkdownResult.stdout.indexOf(`#### servicesVitestConfig (${targetFile}:3)`)).toBeLessThan(
      nativeMarkdownResult.stdout.indexOf(`#### genericVitestConfig (${genericVitestFile}:3)`),
    );

    expect(contextJsonResponse.relatedFiles[0]).toBe(targetFile);
    expect(contextJsonResponse.matches[0]).toEqual(expect.objectContaining({ file: targetFile }));
    expect(contextJsonResponse.nodes[0]).toEqual(expect.objectContaining({ filePath: targetFile }));
  });

  it('keeps core symbol source ahead of metadata-only noise in broad queries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-core-source-rank-'));
    tempRoots.push(root);
    const targetFile = 'src/z-owner.ts';
    const noisyFile = 'src/a-metadata-noise.ts';
    writeFile(
      root,
      targetFile,
      [
        'export class RenderProblemOwner {',
        '  investigate(): void {',
        "    console.info('render problem owner');",
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      noisyFile,
      [
        'export class MetadataOnlyNoise {',
        '  noop(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    const targetClass = {
      id: `class:${targetFile}:RenderProblemOwner`,
      kind: 'class',
      name: 'RenderProblemOwner',
      qualifiedName: 'RenderProblemOwner',
      filePath: targetFile,
      language: 'typescript',
      startLine: 1,
      endLine: 5,
    };
    const targetMethod = {
      id: `method:${targetFile}:RenderProblemOwner.investigate`,
      kind: 'method',
      name: 'investigate',
      qualifiedName: 'RenderProblemOwner::investigate',
      filePath: targetFile,
      language: 'typescript',
      startLine: 2,
      endLine: 4,
    };
    const noisyClass = {
      id: `class:${noisyFile}:MetadataOnlyNoise`,
      kind: 'class',
      name: 'MetadataOnlyNoise',
      qualifiedName: 'MetadataOnlyNoise',
      filePath: noisyFile,
      language: 'typescript',
      startLine: 1,
      endLine: 3,
      docstring: 'render problem investigate',
      metadata: {
        note: 'render problem investigate',
      },
    };
    writeFile(root, '.codegraph/nanoflow-overlay.json', JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-26T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [targetFile, noisyFile],
        classes: [targetClass, noisyClass],
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
        nodes: [targetClass, targetMethod, noisyClass],
        edges: [{
          source: targetClass.id,
          target: targetMethod.id,
          kind: 'contains',
        }],
      },
    }, null, 2));

    const result = queryOverlay(root, 'render problem investigate', ['--limit', '10']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes[0]).toEqual(expect.objectContaining({ filePath: targetFile }));
    expect(response.relatedFiles[0]).toBe(targetFile);
    expect(response.markdown.indexOf(`#### ${targetFile}`)).toBeGreaterThanOrEqual(0);
    expect(response.markdown.indexOf(`#### ${targetFile}`)).toBeLessThan(
      response.markdown.indexOf(`#### ${noisyFile}`),
    );
    expect(response.markdown).toContain("console.info('render problem owner');");
  });
}
