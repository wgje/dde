import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

type ContextSourceOrderingLogEvent = {
  sourceOrdering?: {
    firstSourceFiles?: string[];
    rankedOverlayFileDetails?: Array<{
      filePath?: string;
      lowValuePenalty?: number;
      rawLowValuePenalty?: number;
    }>;
  };
};

export function registerCodegraphOverlayMcpContextSourceOrderingResourceSpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    readJsonLine,
    waitForLogEvent,
  } = context;

  it('keeps explicit overlay files first inside native-shaped base context packs', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-native-shape-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'vitest.services.config.mts',
      [
        "import { defineConfig } from 'vitest/config';",
        '',
        'export default defineConfig({',
        '  test: {',
        '    isolate: true,',
        "    setupFiles: ['./src/test-setup.services.ts'],",
        '  },',
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/generic-cleanup.service.ts',
      [
        'export class GenericCleanupService {',
        '  cleanup(): void {',
        '    const setupFiles = true;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'const response = {',
        "  query: 'vitest.services.config.mts setupFiles test isolation workers cleanup config',",
        '  matches: [{ kind: "constant", name: "default", file: "vitest.services.config.mts" }],',
        '  nodes: [{',
        '    id: "file:vitest.services.config.mts",',
        '    kind: "file",',
        '    name: "vitest.services.config.mts",',
        '    qualifiedName: "vitest.services.config.mts",',
        '    filePath: "vitest.services.config.mts",',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 8',
        '  }, {',
        '    id: "constant:vitest.services.config.mts:default",',
        '    kind: "constant",',
        '    name: "default",',
        '    qualifiedName: "default",',
        '    filePath: "vitest.services.config.mts",',
        '    language: "typescript",',
        '    startLine: 3,',
        '    endLine: 8',
        '  }],',
        '  relationshipGroups: { contains: [{ source: "vitest.services.config.mts", target: "default" }] },',
        '  coverage: { typescriptFiles: 2, graphNodes: 2, graphEdges: 1 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-shape-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-shape-log-')), 'wrapper.log');
    tempRoots.push(path.dirname(logPath));
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  if (!line.trim()) return;",
        "  const message = JSON.parse(line);",
        "  if (message.method !== 'tools/call' || message.params?.name !== 'codegraph_explore') {",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
        "    return;",
        "  }",
        "  const query = message.params.arguments.query;",
        "  const text = [",
        "    '## Code Context',",
        "    '',",
        "    '### Entry Points',",
        "    '',",
        "    '- GenericCleanupService: src/generic-cleanup.service.ts:1',",
        "    '',",
        "    '### Related Symbols',",
        "    '',",
        "    '- src/generic-cleanup.service.ts: cleanup:2',",
        "    '',",
        "    '### Code',",
        "    '',",
        "    '#### GenericCleanupService (src/generic-cleanup.service.ts:1)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class GenericCleanupService {',",
        "    '2\\t  cleanup(): void {',",
        "    '3\\t    const setupFiles = true;',",
        "    '4\\t  }',",
        "    '5\\t}',",
        "    '```',",
        "    '',",
        "    '### Not shown above',",
        "    '',",
        "    '- More cleanup/config symbols were omitted by the base budget.',",
        "    '',",
        "    '---',",
        "    '> **Complete source available:** use codegraph_node for full bodies.',",
        "    '> **Explore budget:** base CodeGraph used the configured source budget.',",
        "  ].join('\\n');",
        "  console.log(JSON.stringify({",
        "    jsonrpc: '2.0',",
        "    id: message.id,",
        "    result: { content: [{ type: 'text', text }] },",
        "  }));",
        "});",
        '',
      ].join('\n'),
    );

    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', projectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    try {
      const contextResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 48,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'vitest.services.config.mts setupFiles test isolation workers cleanup config',
            overlayLimit: 1,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      const sourceSectionCount = [...text.matchAll(/^### (?:Source Code|Code)\b/gm)].length;
      const sourceHeaders = [...text.matchAll(/^####\s+(.+)$/gm)].map((match) => match[1]);
      expect(contextResponse.result.isError).toBe(false);
      expect(sourceSectionCount).toBe(1);
      expect(sourceHeaders[0]).toContain('vitest.services.config.mts');
      expect(sourceHeaders[1]).toContain('GenericCleanupService (src/generic-cleanup.service.ts:1)');
      expect(text.indexOf('#### vitest.services.config.mts')).toBeGreaterThan(text.indexOf('### Code'));
      expect(text.indexOf('#### vitest.services.config.mts')).toBeLessThan(text.indexOf('### Not shown above'));
      expect(text).toContain("6\t    setupFiles: ['./src/test-setup.services.ts'],");
      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 48,
      );
      expect(responseEvent).toEqual(expect.objectContaining({
        sourceOrdering: expect.objectContaining({
          sourceSectionCount: 1,
          duplicateSourceSectionCount: 0,
          firstSourceFiles: [
            'vitest.services.config.mts',
            'src/generic-cleanup.service.ts',
          ],
          rankedOverlayFiles: ['vitest.services.config.mts'],
          topRankedOverlayFileVisibleIndex: 0,
          firstSourceBlockIsTopRankedOverlayFile: true,
          topRankedOverlayFileMissing: false,
        }),
      }));
    } finally {
      child.kill();
    }
  }, 12_000);

  it('keeps Angular resource and explicit file-stem context packs focused ahead of noisy source blocks', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-resource-noise-'));
    tempRoots.push(projectRoot);
    writeFile(projectRoot, 'src/app.component.ts', 'export class AppComponent {}\n');
    writeFile(projectRoot, 'scripts/generate-codegraph-nanoflow-overlay.mjs', 'export function templateUrl(value) { return value; }\n');
    writeFile(projectRoot, 'src/tests/scripts/validate-codegraph-overlay-docs.spec-helpers.ts', 'export const styleUrlEdgesInDocs = 1;\n');
    writeFile(projectRoot, 'src/app/core/shell/project-shell.component.ts', 'export class ProjectShellComponent {}\n');
    writeFile(projectRoot, 'src/app/core/shell/project-shell.component.css', ':host { display: block; }\n');
    writeFile(projectRoot, 'src/app/core/shell/project-shell.component.html', '<main class="project-shell"></main>\n');
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        "const queryIndex = process.argv.indexOf('--query');",
        "const query = queryIndex >= 0 ? process.argv[queryIndex + 1] : '';",
        'const resourceNodes = [{',
        '  id: "file:src/app/core/shell/project-shell.component.css",',
        '  kind: "file",',
        '  name: "src/app/core/shell/project-shell.component.css",',
        '  qualifiedName: "src/app/core/shell/project-shell.component.css",',
        '  filePath: "src/app/core/shell/project-shell.component.css",',
        '  language: "unknown",',
        '  startLine: 1,',
        '  endLine: 1,',
        '  metadata: { relation: "style-url", legacyRelation: "styleUrl" }',
        '}, {',
        '  id: "file:src/app/core/shell/project-shell.component.html",',
        '  kind: "file",',
        '  name: "src/app/core/shell/project-shell.component.html",',
        '  qualifiedName: "src/app/core/shell/project-shell.component.html",',
        '  filePath: "src/app/core/shell/project-shell.component.html",',
        '  language: "unknown",',
        '  startLine: 1,',
        '  endLine: 1,',
        '  metadata: { relation: "template-url" }',
        '}, {',
        '  id: "class:src/app/core/shell/project-shell.component.ts:ProjectShellComponent",',
        '  kind: "class",',
        '  name: "ProjectShellComponent",',
        '  qualifiedName: "ProjectShellComponent",',
        '  filePath: "src/app/core/shell/project-shell.component.ts",',
        '  language: "typescript",',
        '  startLine: 1,',
        '  endLine: 1',
        '}];',
        'const appMatches = [{',
        '  kind: "parameter",',
        '  name: "templateUrl",',
        '  file: "scripts/generate-codegraph-nanoflow-overlay.mjs",',
        '  score: 900,',
        '  item: {',
        '    id: "parameter:scripts/generate-codegraph-nanoflow-overlay.mjs:templateUrl",',
        '    kind: "parameter",',
        '    name: "templateUrl",',
        '    qualifiedName: "templateUrl",',
        '    filePath: "scripts/generate-codegraph-nanoflow-overlay.mjs",',
        '    language: "javascript",',
        '    startLine: 1,',
        '    endLine: 1',
        '  }',
        '}, {',
        '  kind: "variable",',
        '  name: "styleUrlEdgesInDocs",',
        '  file: "src/tests/scripts/validate-codegraph-overlay-docs.spec-helpers.ts",',
        '  score: 413,',
        '  item: {',
        '    id: "variable:src/tests/scripts/validate-codegraph-overlay-docs.spec-helpers.ts:styleUrlEdgesInDocs",',
        '    kind: "variable",',
        '    name: "styleUrlEdgesInDocs",',
        '    qualifiedName: "styleUrlEdgesInDocs",',
        '    filePath: "src/tests/scripts/validate-codegraph-overlay-docs.spec-helpers.ts",',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 1',
        '  }',
        '}, {',
        '  kind: "file",',
        '  name: "src/app.component.ts",',
        '  file: "src/app.component.ts",',
        '  score: 5,',
        '  item: {',
        '    id: "file:src/app.component.ts",',
        '    kind: "file",',
        '    name: "src/app.component.ts",',
        '    qualifiedName: "src/app.component.ts",',
        '    filePath: "src/app.component.ts",',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 1',
        '  }',
        '}, {',
        '  kind: "file",',
        '  name: "src/app/core/shell/project-shell.component.css",',
        '  file: "src/app/core/shell/project-shell.component.css",',
        '  score: 3,',
        '  item: resourceNodes[0]',
        '}, {',
        '  kind: "file",',
        '  name: "src/app/core/shell/project-shell.component.html",',
        '  file: "src/app/core/shell/project-shell.component.html",',
        '  score: 3,',
        '  item: resourceNodes[1]',
        '}];',
        'const response = query.includes("app.component")',
        '  ? { query, matches: appMatches, nodes: [], relationshipGroups: {}, coverage: { typescriptFiles: 2, graphNodes: 3, graphEdges: 1 } }',
        '  : { query, matches: [], nodes: resourceNodes, relationshipGroups: {}, coverage: { typescriptFiles: 1, graphNodes: 3, graphEdges: 2 } };',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-resource-noise-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-resource-noise-log-')), 'wrapper.log');
    tempRoots.push(path.dirname(logPath));
    fs.writeFileSync(fakeCodegraph, createContextSourceFakeCodegraphScript());

    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', projectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    try {
      const resourceResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 49,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'template-url/style-url', overlayLimit: 20 },
        },
      })}\n`);
      const resourceResponse = await resourceResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const resourceHeaders = extractContextSourceHeaders(resourceResponse.result.content[0].text);
      expect(resourceResponse.result.isError).toBe(false);
      expect(resourceHeaders[0]).toContain('src/app/core/shell/project-shell.component.css');
      expect(resourceHeaders[1]).toContain('src/app/core/shell/project-shell.component.html');
      expect(resourceHeaders.findIndex(header => header.includes('project-shell.component.ts'))).toBeGreaterThan(1);

      const appResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 50,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'app.component styleUrl style-url', overlayLimit: 20 },
        },
      })}\n`);
      const appResponse = await appResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const appHeaders = extractContextSourceHeaders(appResponse.result.content[0].text);
      expect(appResponse.result.isError).toBe(false);
      expect(appHeaders[0]).toContain('src/app.component.ts');
      expect(appHeaders[0]).not.toContain('validate-codegraph-overlay-docs.spec-helpers.ts');
      expect(appHeaders.join('\n')).not.toContain('scripts/generate-codegraph-nanoflow-overlay.mjs');
      expect(appHeaders.join('\n')).not.toContain('validate-codegraph-overlay-docs.spec-helpers.ts');
      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 50,
      ) as ContextSourceOrderingLogEvent;
      const details = responseEvent.sourceOrdering?.rankedOverlayFileDetails ?? [];
      const lowValueHelperDetail = details.find(entry => entry.filePath === 'src/tests/scripts/validate-codegraph-overlay-docs.spec-helpers.ts');
      expect(lowValueHelperDetail)
        .toEqual(expect.objectContaining({ lowValuePenalty: expect.any(Number) }));
      expect(responseEvent.sourceOrdering).toEqual(expect.objectContaining({
        rawTopRankedOverlayFile: 'src/app.component.ts',
        topRankedOverlayFile: 'src/app.component.ts',
        topRankedOverlayFileVisibleIndex: 0,
        topRankedOverlayFileSkippedLowValue: false,
        topRankedOverlayFileMissing: false,
      }));

      const appTemplateResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 51,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'app.component templateUrl template-url', overlayLimit: 20 },
        },
      })}\n`);
      const appTemplateResponse = await appTemplateResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const appTemplateHeaders = extractContextSourceHeaders(appTemplateResponse.result.content[0].text);
      expect(appTemplateResponse.result.isError).toBe(false);
      expect(appTemplateHeaders[0]).toContain('src/app.component.ts');
      expect(appTemplateHeaders.join('\n')).toContain('src/app/core/shell/project-shell.component.html');
      expect(appTemplateHeaders.join('\n')).not.toContain('scripts/generate-codegraph-nanoflow-overlay.mjs');
      expect(appTemplateHeaders.join('\n')).not.toContain('validate-codegraph-overlay-docs.spec-helpers.ts');
    } finally {
      child.kill();
    }
  }, 12_000);

  it('filters same-stem spec source blocks from implementation symbol context packs', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-symbol-spec-noise-'));
    tempRoots.push(projectRoot);
    const componentFile = 'src/app/shared/components/sync-status.component.ts';
    const shellFile = 'src/workspace-shell.component.ts';
    const specFile = 'src/app/shared/components/sync-status.component.spec.ts';
    writeFile(
      projectRoot,
      componentFile,
      [
        'export class SyncStatusComponent {',
        "  readonly state = 'online';",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      shellFile,
      [
        'import { SyncStatusComponent } from "./app/shared/components/sync-status.component";',
        'export class WorkspaceShellComponent {',
        '  readonly syncStatus = SyncStatusComponent;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      specFile,
      [
        'import { SyncStatusComponent } from "./sync-status.component";',
        "describe('SyncStatusComponent', () => {",
        "  it('renders sync status', () => {",
        '    expect(SyncStatusComponent).toBeDefined();',
        '  });',
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'const componentFile = "src/app/shared/components/sync-status.component.ts";',
        'const shellFile = "src/workspace-shell.component.ts";',
        'const specFile = "src/app/shared/components/sync-status.component.spec.ts";',
        'const response = {',
        "  query: 'SyncStatusComponent',",
        '  matches: [{',
        '    kind: "class",',
        '    name: "SyncStatusComponent",',
        '    file: componentFile,',
        '    score: 1200,',
        '    item: { id: `class:${componentFile}:SyncStatusComponent`, kind: "class", name: "SyncStatusComponent", qualifiedName: "SyncStatusComponent", filePath: componentFile, language: "typescript", startLine: 1, endLine: 3 }',
        '  }, {',
        '    kind: "class",',
        '    name: "SyncStatusComponent",',
        '    file: specFile,',
        '    score: 1100,',
        '    item: { id: `class:${specFile}:SyncStatusComponent`, kind: "class", name: "SyncStatusComponent", qualifiedName: "SyncStatusComponent", filePath: specFile, language: "typescript", startLine: 1, endLine: 6 }',
        '  }, {',
        '    kind: "class",',
        '    name: "WorkspaceShellComponent",',
        '    file: shellFile,',
        '    score: 900,',
        '    item: { id: `class:${shellFile}:WorkspaceShellComponent`, kind: "class", name: "WorkspaceShellComponent", qualifiedName: "WorkspaceShellComponent", filePath: shellFile, language: "typescript", startLine: 2, endLine: 4 }',
        '  }],',
        '  nodes: [{',
        '    id: `class:${componentFile}:SyncStatusComponent`,',
        '    kind: "class",',
        '    name: "SyncStatusComponent",',
        '    qualifiedName: "SyncStatusComponent",',
        '    filePath: componentFile,',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 3',
        '  }, {',
        '    id: `class:${specFile}:SyncStatusComponent`,',
        '    kind: "class",',
        '    name: "SyncStatusComponent",',
        '    qualifiedName: "SyncStatusComponent",',
        '    filePath: specFile,',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 6',
        '  }, {',
        '    id: `class:${shellFile}:WorkspaceShellComponent`,',
        '    kind: "class",',
        '    name: "WorkspaceShellComponent",',
        '    qualifiedName: "WorkspaceShellComponent",',
        '    filePath: shellFile,',
        '    language: "typescript",',
        '    startLine: 2,',
        '    endLine: 4',
        '  }],',
        '  relationshipGroups: { references: [{ source: shellFile, target: componentFile }] },',
        '  coverage: { typescriptFiles: 3, graphNodes: 3, graphEdges: 1 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-symbol-spec-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-symbol-spec-log-')), 'wrapper.log');
    tempRoots.push(path.dirname(logPath));
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "function baseText(query) {",
        "  return [",
        "    '## Exploration: ' + query,",
        "    '',",
        "    'Found 3 symbols across 3 files.',",
        "    '',",
        "    '### Source Code',",
        "    '',",
        `    '#### ${componentFile} — SyncStatusComponent(class)',`,
        "    '',",
        "    '```typescript',",
        "    '1\\texport class SyncStatusComponent {',",
        "    \"2\\t  readonly state = 'online';\",",
        "    '3\\t}',",
        "    '```',",
        "    '',",
        `    '#### ${shellFile} — WorkspaceShellComponent(class)',`,
        "    '',",
        "    '```typescript',",
        "    '1\\timport { SyncStatusComponent } from \"./app/shared/components/sync-status.component\";',",
        "    '2\\texport class WorkspaceShellComponent {',",
        "    '3\\t  readonly syncStatus = SyncStatusComponent;',",
        "    '4\\t}',",
        "    '```',",
        "    '',",
        `    '#### ${specFile} — SyncStatusComponent(class)',`,
        "    '',",
        "    '```typescript',",
        "    '1\\timport { SyncStatusComponent } from \"./sync-status.component\";',",
        "    \"2\\tdescribe('SyncStatusComponent', () => {\",",
        "    \"3\\t  it('renders sync status', () => {\",",
        "    '4\\t    expect(SyncStatusComponent).toBeDefined();',",
        "    '5\\t  });',",
        "    '6\\t});',",
        "    '```',",
        "  ].join('\\n');",
        "}",
        "rl.on('line', line => {",
        "  if (!line.trim()) return;",
        "  const message = JSON.parse(line);",
        "  if (message.method !== 'tools/call' || message.params?.name !== 'codegraph_explore') {",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
        "    return;",
        "  }",
        "  const query = message.params.arguments.query;",
        "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: baseText(query) }] } }));",
        "});",
        '',
      ].join('\n'),
    );

    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', projectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    try {
      const implementationResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 52,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'SyncStatusComponent', overlayLimit: 8 },
        },
      })}\n`);
      const implementationResponse = await implementationResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const implementationHeaders = extractContextSourceHeaders(implementationResponse.result.content[0].text);
      expect(implementationResponse.result.isError).toBe(false);
      expect(implementationHeaders.join('\n')).toContain(componentFile);
      expect(implementationHeaders.join('\n')).toContain(shellFile);
      expect(implementationHeaders.join('\n')).not.toContain(specFile);
      const implementationEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 52,
      ) as ContextSourceOrderingLogEvent;
      const implementationDetails = implementationEvent.sourceOrdering?.rankedOverlayFileDetails ?? [];
      const implementationSpecDetail = implementationDetails.find(entry => entry.filePath === specFile);
      expect(implementationSpecDetail).toEqual(expect.objectContaining({
        lowValuePenalty: expect.any(Number),
        rawLowValuePenalty: expect.any(Number),
      }));
      expect(implementationSpecDetail?.lowValuePenalty).toBeGreaterThan(0);
      expect(implementationEvent.sourceOrdering).toEqual(expect.objectContaining({
        firstSourceFiles: [componentFile, shellFile],
      }));

      const testResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 53,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: 'SyncStatusComponent tests', overlayLimit: 8 },
        },
      })}\n`);
      const testResponse = await testResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const testHeaders = extractContextSourceHeaders(testResponse.result.content[0].text);
      expect(testResponse.result.isError).toBe(false);
      expect(testHeaders.join('\n')).toContain(componentFile);
      expect(testHeaders.join('\n')).toContain(specFile);
    } finally {
      child.kill();
    }
  }, 12_000);
}

function extractContextSourceHeaders(text: string): string[] {
  return [
    ...[...text.matchAll(/^####\s+(.+)$/gm)].map((match) => ({
      index: match.index ?? Number.MAX_SAFE_INTEGER,
      header: match[1],
    })),
    ...[...text.matchAll(/^\*\*`([^`]+)`\*\*(?:\s+[—-]\s*(.*))?$/gm)].map((match) => ({
      index: match.index ?? Number.MAX_SAFE_INTEGER,
      header: match[2] ? `${match[1]} — ${match[2]}` : match[1],
    })),
  ]
    .sort((a, b) => a.index - b.index)
    .map(entry => entry.header);
}

function createContextSourceFakeCodegraphScript(): string {
  return [
    "'use strict';",
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "rl.on('line', line => {",
    "  if (!line.trim()) return;",
    "  const message = JSON.parse(line);",
    "  if (message.method !== 'tools/call' || message.params?.name !== 'codegraph_explore') {",
    "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
    "    return;",
    "  }",
    "  const query = message.params.arguments.query;",
    "  const appSource = [",
    "    '**`scripts/generate-codegraph-nanoflow-overlay.mjs`** — templateUrl(parameter)',",
    "    '',",
    "    '```javascript',",
    "    '1\\texport function templateUrl(value) { return value; }',",
    "    '```',",
    "    '',",
    "    '**`src/tests/scripts/validate-codegraph-overlay-docs.spec-helpers.ts`** — styleUrlEdgesInDocs(variable)',",
    "    '',",
    "    '```typescript',",
    "    '1\\texport const styleUrlEdgesInDocs = 1;',",
    "    '```',",
    "    '',",
    "    '**`src/app.component.ts`** — AppComponent(class)',",
    "    '',",
    "    '```typescript',",
    "    '1\\texport class AppComponent {}',",
    "    '```',",
    "    '',",
    "    '#### src/app/core/shell/project-shell.component.css',",
    "    '',",
    "    '```unknown',",
    "    '1\\t:host { display: block; }',",
    "    '```',",
    "    '',",
    "    '#### src/app/core/shell/project-shell.component.html',",
    "    '',",
    "    '```unknown',",
    "    '1\\t<main class=\"project-shell\"></main>',",
    "    '```',",
    "  ];",
    "  const resourceSource = [",
    "    '#### src/app/core/shell/project-shell.component.ts — ProjectShellComponent(class)',",
    "    '',",
    "    '```typescript',",
    "    '1\\texport class ProjectShellComponent {}',",
    "    '```',",
    "    '',",
    "    '#### src/app/core/shell/project-shell.component.css',",
    "    '',",
    "    '```unknown',",
    "    '1\\t:host { display: block; }',",
    "    '```',",
    "    '',",
    "    '#### src/app/core/shell/project-shell.component.html',",
    "    '',",
    "    '```unknown',",
    "    '1\\t<main class=\"project-shell\"></main>',",
    "    '```',",
    "  ];",
    "  const source = query.includes('app.component') ? appSource : resourceSource;",
    "  const text = ['## Exploration: ' + query, '', 'Found 3 symbols across 3 files.', '', '### Source Code', '', ...source].join('\\n');",
    "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } }));",
    "});",
    '',
  ].join('\n');
}
