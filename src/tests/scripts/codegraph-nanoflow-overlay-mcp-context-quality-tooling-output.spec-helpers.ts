import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import {
  callContextPack,
  extractContextSourceHeaders,
  writeOverlayResponseScript,
  writeQueryAwareOverlayResponseScript,
} from './codegraph-nanoflow-overlay-mcp-context-quality.helpers';
import { writeFakeCodegraphExploreScript } from './codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpContextQualityToolingOutputSpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    readJsonLine,
  } = context;

  it('filters generic output wording from tooling context-pack overlay queries', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-tooling-output-noise-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/codegraph-nanoflow-mcp-stdio.cjs',
      [
        'function forwardNanoFlowContextPackRequest(message) {',
        "  return message.params?.name === 'nanoflow_context_pack';",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/app/features/flow/components/noisy-output.component.ts',
      [
        'export class NoisyOutputComponent {',
        '  output = 1;',
        '  results = 2;',
        '}',
        '',
      ].join('\n'),
    );

    const noisyQuery = 'codegraph wrapper mcp stdio output results truncation tokens';
    const focusedQuery = 'wrapper mcp stdio';
    const noisyResponse = {
      query: noisyQuery,
      matches: [
        { kind: 'property', name: 'output', file: 'src/app/features/flow/components/noisy-output.component.ts' },
      ],
      nodes: [
        {
          id: 'property:src/app/features/flow/components/noisy-output.component.ts:output',
          kind: 'property',
          name: 'output',
          qualifiedName: 'NoisyOutputComponent::output',
          filePath: 'src/app/features/flow/components/noisy-output.component.ts',
          language: 'typescript',
          startLine: 2,
          endLine: 2,
        },
      ],
      relationshipGroups: {},
      coverage: { typescriptFiles: 1, graphNodes: 1, graphEdges: 0 },
    };
    const focusedResponse = {
      query: focusedQuery,
      matches: [
        { kind: 'function', name: 'forwardNanoFlowContextPackRequest', file: 'scripts/codegraph-nanoflow-mcp-stdio.cjs' },
      ],
      nodes: [
        {
          id: 'function:scripts/codegraph-nanoflow-mcp-stdio.cjs:forwardNanoFlowContextPackRequest',
          kind: 'function',
          name: 'forwardNanoFlowContextPackRequest',
          qualifiedName: 'forwardNanoFlowContextPackRequest',
          filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          language: 'javascript',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {},
      coverage: { typescriptFiles: 0, graphNodes: 1, graphEdges: 0 },
    };
    writeQueryAwareOverlayResponseScript(projectRoot, focusedQuery, focusedResponse, noisyResponse);
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-tooling-output-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, { includeMaxFiles: true });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph,
      readJsonLine,
      query: noisyQuery,
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(text).toContain(`## Exploration: ${noisyQuery}`);
    expect(text).toContain('baseQuery=wrapper mcp stdio');
    expect(text).toContain('baseMaxFiles=1');
    expect(sourceHeaders.join('\n')).toContain('scripts/codegraph-nanoflow-mcp-stdio.cjs');
    expect(sourceHeaders.join('\n')).not.toContain('noisy-output.component.ts');
    expect(text).toContain('forwardNanoFlowContextPackRequest');
  }, 12_000);

  it('focuses NanoFlow CodeGraph output-quality queries on adapter tooling sources', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-output-quality-focus-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/codegraph-adapter-context.cjs',
      [
        'function requestContextPackWithRetries(client, nextId, options) {',
        '  return options.query;',
        '}',
        '',
        'function summarizeContextPackSourceOrdering(text) {',
        '  return { sourceSelection: text.length };',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/services/task-operation-adapter.service.ts',
      [
        'export class TaskOperationAdapterService {',
        '  sourceSelection = "business noise";',
        '  duplicateSections(): void {}',
        '}',
        '',
      ].join('\n'),
    );

    const noisyQuery = 'NanoFlow CodeGraph adapter output quality source ordering duplicate sections low value sourceSelection';
    const focusedQuery = 'codegraph adapter context wrapper log guard sourceOrdering sourceSelection';
    const noisyResponse = {
      query: noisyQuery,
      matches: [
        { kind: 'class', name: 'TaskOperationAdapterService', file: 'src/services/task-operation-adapter.service.ts' },
      ],
      nodes: [
        {
          id: 'class:src/services/task-operation-adapter.service.ts:TaskOperationAdapterService',
          kind: 'class',
          name: 'TaskOperationAdapterService',
          qualifiedName: 'TaskOperationAdapterService',
          filePath: 'src/services/task-operation-adapter.service.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 4,
        },
      ],
      relationshipGroups: {},
      coverage: { typescriptFiles: 1, graphNodes: 1, graphEdges: 0 },
    };
    const focusedResponse = {
      query: focusedQuery,
      matches: [
        { kind: 'function', name: 'requestContextPackWithRetries', file: 'scripts/codegraph-adapter-context.cjs' },
        { kind: 'function', name: 'summarizeContextPackSourceOrdering', file: 'scripts/codegraph-adapter-context.cjs' },
      ],
      nodes: [
        {
          id: 'function:scripts/codegraph-adapter-context.cjs:requestContextPackWithRetries',
          kind: 'function',
          name: 'requestContextPackWithRetries',
          qualifiedName: 'requestContextPackWithRetries',
          filePath: 'scripts/codegraph-adapter-context.cjs',
          language: 'javascript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'function:scripts/codegraph-adapter-context.cjs:summarizeContextPackSourceOrdering',
          kind: 'function',
          name: 'summarizeContextPackSourceOrdering',
          qualifiedName: 'summarizeContextPackSourceOrdering',
          filePath: 'scripts/codegraph-adapter-context.cjs',
          language: 'javascript',
          startLine: 5,
          endLine: 7,
        },
      ],
      relationshipGroups: {},
      coverage: { typescriptFiles: 0, graphNodes: 2, graphEdges: 0 },
    };
    writeQueryAwareOverlayResponseScript(projectRoot, focusedQuery, focusedResponse, noisyResponse);
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-quality-focus-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      focusedQuery,
      focused: { includeMaxFiles: true },
      fallback: {
        includeMaxFiles: true,
        sourceBlocks: [
          {
            header: 'src/services/task-operation-adapter.service.ts — TaskOperationAdapterService(class)',
            language: 'typescript',
            lines: ['1\texport class TaskOperationAdapterService {}'],
          },
        ],
      },
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph,
      readJsonLine,
      query: noisyQuery,
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(text).toContain(`## Exploration: ${noisyQuery}`);
    expect(text).toContain(`baseQuery=${focusedQuery}`);
    expect(text).toContain('baseMaxFiles=1');
    expect(sourceHeaders.join('\n')).toContain('scripts/codegraph-adapter-context.cjs');
    expect(sourceHeaders.join('\n')).not.toContain('task-operation-adapter.service.ts');
    expect(text).toContain('requestContextPackWithRetries');
  }, 12_000);

  it('keeps Codex MCP config diagnostics on CodeGraph tooling source instead of Json/config noise', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-codex-config-tooling-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/codegraph-codex-config.cjs',
      [
        'function getCodexConfigPath() {',
        "  return 'C:/Users/MI/.codex/config.toml';",
        '}',
        '',
        'function readCodexCodegraphMcpConfig(root) {',
        '  return { source: "codex", root };',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'knip.config.js',
      [
        'const config = {',
        '  project: ["src/**/*.ts"],',
        '};',
        '',
        'export default config;',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/types/supabase.ts',
      [
        'export type Json =',
        '  | string',
        '  | number',
        '  | boolean',
        '  | null;',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/models/supabase-types.ts',
      [
        'export type Json =',
        '  | string',
        '  | number',
        '  | boolean',
        '  | null;',
        '',
      ].join('\n'),
    );
    writeOverlayResponseScript(projectRoot, {
      query: 'Codex config doctor json',
      matches: [
        { kind: 'type_alias', name: 'Json', file: 'src/types/supabase.ts' },
        { kind: 'type_alias', name: 'Json', file: 'src/models/supabase-types.ts' },
        { kind: 'constant', name: 'config', file: 'knip.config.js' },
        { kind: 'function', name: 'readCodexCodegraphMcpConfig', file: 'scripts/codegraph-codex-config.cjs' },
        { kind: 'function', name: 'getCodexConfigPath', file: 'scripts/codegraph-codex-config.cjs' },
      ],
      nodes: [
        {
          id: 'type_alias:src/types/supabase.ts:Json',
          kind: 'type_alias',
          name: 'Json',
          qualifiedName: 'Json',
          filePath: 'src/types/supabase.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 5,
        },
        {
          id: 'type_alias:src/models/supabase-types.ts:Json',
          kind: 'type_alias',
          name: 'Json',
          qualifiedName: 'Json',
          filePath: 'src/models/supabase-types.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 5,
        },
        {
          id: 'constant:knip.config.js:config',
          kind: 'constant',
          name: 'config',
          qualifiedName: 'config',
          filePath: 'knip.config.js',
          language: 'javascript',
          startLine: 1,
          endLine: 5,
        },
        {
          id: 'function:scripts/codegraph-codex-config.cjs:readCodexCodegraphMcpConfig',
          kind: 'function',
          name: 'readCodexCodegraphMcpConfig',
          qualifiedName: 'readCodexCodegraphMcpConfig',
          filePath: 'scripts/codegraph-codex-config.cjs',
          language: 'javascript',
          startLine: 5,
          endLine: 7,
        },
        {
          id: 'function:scripts/codegraph-codex-config.cjs:getCodexConfigPath',
          kind: 'function',
          name: 'getCodexConfigPath',
          qualifiedName: 'getCodexConfigPath',
          filePath: 'scripts/codegraph-codex-config.cjs',
          language: 'javascript',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 5, graphEdges: 0 },
    });
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-codex-config-tooling-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      includeMaxFiles: true,
      sourceBlocks: [
        {
          header: 'knip.config.js — config(constant)',
          language: 'javascript',
          lines: [
            '1\tconst config = {',
            '2\t  project: ["src/**/*.ts"],',
            '3\t};',
            '4\texport default config;',
          ],
        },
        {
          header: 'src/types/supabase.ts — Json(type_alias)',
          language: 'typescript',
          lines: [
            '1\texport type Json =',
            '2\t  | string',
            '3\t  | number',
            '4\t  | boolean',
            '5\t  | null;',
          ],
        },
      ],
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph,
      readJsonLine,
      query: 'Codex config doctor json',
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(sourceHeaders[0]).toContain('scripts/codegraph-codex-config.cjs');
    expect(sourceHeaders[0]).toContain('readCodexCodegraphMcpConfig');
    expect(text).toContain('return { source: "codex", root };');
    expect(sourceHeaders.join('\n')).not.toContain('knip.config.js');
    expect(sourceHeaders.join('\n')).not.toContain('Json(type_alias)');
  }, 12_000);

}
