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

export function registerCodegraphOverlayMcpContextQualityToolingIssueRegistrySpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    readJsonLine,
    makeFakeCodegraph,
  } = context;

  it('focuses issue registry status queries on adaptation issue docs instead of app open methods', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-issue-registry-focus-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'docs/codegraph-nanoflow-adaptation-issues.md',
      [
        '# NanoFlow CodeGraph Adaptation Issue Registry',
        '',
        '## CG-NF-20260627-901: Registry query fixture',
        '',
        '- status: open',
        '- feature_scope: context-pack issue registry query focus',
        '- query_surface: nanoflow_context_pack | adapter-context-cli',
        '- query: `codegraph nanoflow adaptation issues open fixed remaining gaps`',
        '- expected: context-pack source blocks show this registry entry.',
        '- actual: business open() methods should not consume the visible source budget.',
        '',
        '## CG-NF-20260627-902: Fixed registry query fixture',
        '',
        '- status: fixed',
        '- feature_scope: context-pack issue registry query focus',
        '- query_surface: nanoflow_context_pack | adapter-context-cli',
        '- query: `codegraph nanoflow adaptation issues fixed`',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
      [
        "const adaptationDocPath = 'docs/codegraph-nanoflow-adaptation.md';",
        'export function makeFakeCodegraph(): string {',
        "  return 'fake-codegraph';",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/app/features/flow/services/flow-link-connection-editor.controller.ts',
      [
        'export class FlowLinkConnectionEditorController {',
        '  open(): void {',
        "    console.log('business open method');",
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const noisyQuery = 'codegraph nanoflow adaptation issues open fixed remaining gaps issue registry docs context-pack quality source ordering';
    const focusedQuery = 'docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues';
    const noisyResponse = {
      query: noisyQuery,
      matches: [
        {
          kind: 'method',
          name: 'open',
          file: 'src/app/features/flow/services/flow-link-connection-editor.controller.ts',
        },
      ],
      nodes: [
        {
          id: 'method:src/app/features/flow/services/flow-link-connection-editor.controller.ts:FlowLinkConnectionEditorController::open',
          kind: 'method',
          name: 'open',
          qualifiedName: 'FlowLinkConnectionEditorController::open',
          filePath: 'src/app/features/flow/services/flow-link-connection-editor.controller.ts',
          language: 'typescript',
          startLine: 2,
          endLine: 4,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 1, graphEdges: 0 },
    };
    const focusedResponse = {
      query: focusedQuery,
      matches: [
        {
          kind: 'file',
          name: 'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
          file: 'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
        },
      ],
      nodes: [
        {
          id: 'file:src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
          kind: 'file',
          name: 'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
          qualifiedName: 'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
          filePath: 'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 4,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 1, graphEdges: 0 },
    };
    writeQueryAwareOverlayResponseScript(projectRoot, focusedQuery, focusedResponse, noisyResponse);

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-issue-registry-focus-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      focusedQuery,
      focused: {
        sourceBlocks: [
          {
            header: 'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts — src/tests/scripts/codegraph-nanoflow-overlay.spec.ts(file)',
            language: 'typescript',
            lines: [
              "1\tconst adaptationDocPath = 'docs/codegraph-nanoflow-adaptation.md';",
              '2\texport function makeFakeCodegraph(): string {',
              "3\t  return 'fake-codegraph';",
              '4\t}',
            ],
          },
        ],
      },
      fallback: {
        sourceBlocks: [
          {
            header: 'src/app/features/flow/services/flow-link-connection-editor.controller.ts — open(method)',
            language: 'typescript',
            lines: [
              '1\texport class FlowLinkConnectionEditorController {',
              '2\t  open(): void {',
              "3\t    console.log('business open method');",
              '4\t  }',
              '5\t}',
            ],
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
    expect(text).toContain(`baseQuery=${focusedQuery}`);
    expect(sourceHeaders[0]).toContain('docs/codegraph-nanoflow-adaptation-issues.md');
    expect(text).toContain('CG-NF-20260627-901');
    expect(text).toContain('- status: open');
    expect(text).toContain('- status: fixed');
    expect(text).not.toContain('business open method');
    expect(sourceHeaders.join('\n')).not.toContain('flow-link-connection-editor.controller.ts');
  }, 12_000);

  it('focuses Chinese issue registry queries on adaptation issue docs instead of app noise', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-issue-registry-cjk-focus-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'docs/codegraph-nanoflow-adaptation-issues.md',
      [
        '# NanoFlow CodeGraph Adaptation Issue Registry',
        '',
        '## CG-NF-20260707-901: Chinese registry query fixture',
        '',
        '- status: open',
        '- feature_scope: context-pack issue registry query focus',
        '- query_surface: nanoflow_context_pack | adapter-context-cli',
        '- query: `NanoFlow适配错误问题记录文档`',
        '- expected: Chinese issue registry queries show this registry entry.',
        '- actual: app and Android symbols should not consume the visible source budget.',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetActionFactory.kt',
      [
        'class NanoflowWidgetActionFactory {',
        '  fun recordIssue(): String = "app noise"',
        '}',
        '',
      ].join('\n'),
    );

    const noisyQuery = 'NanoFlow适配错误问题记录文档';
    const focusedQuery = 'docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues';
    const noisyResponse = {
      query: noisyQuery,
      matches: [
        {
          kind: 'class',
          name: 'NanoflowWidgetActionFactory',
          file: 'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetActionFactory.kt',
        },
      ],
      nodes: [
        {
          id: 'class:android/app/src/main/java/app/nanoflow/host/NanoflowWidgetActionFactory.kt:NanoflowWidgetActionFactory',
          kind: 'class',
          name: 'NanoflowWidgetActionFactory',
          qualifiedName: 'NanoflowWidgetActionFactory',
          filePath: 'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetActionFactory.kt',
          language: 'kotlin',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 1, graphEdges: 0 },
    };
    const focusedResponse = {
      query: focusedQuery,
      matches: [
        {
          kind: 'file',
          name: 'docs/codegraph-nanoflow-adaptation-issues.md',
          file: 'docs/codegraph-nanoflow-adaptation-issues.md',
        },
      ],
      nodes: [
        {
          id: 'file:docs/codegraph-nanoflow-adaptation-issues.md',
          kind: 'file',
          name: 'docs/codegraph-nanoflow-adaptation-issues.md',
          qualifiedName: 'docs/codegraph-nanoflow-adaptation-issues.md',
          filePath: 'docs/codegraph-nanoflow-adaptation-issues.md',
          language: 'markdown',
          startLine: 1,
          endLine: 10,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 1, graphEdges: 0 },
    };
    writeQueryAwareOverlayResponseScript(projectRoot, focusedQuery, focusedResponse, noisyResponse);

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-issue-registry-cjk-focus-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      focusedQuery,
      focused: {
        sourceBlocks: [
          {
            header: 'docs/codegraph-nanoflow-adaptation-issues.md',
            language: 'markdown',
            lines: [
              '1\t# NanoFlow CodeGraph Adaptation Issue Registry',
              '3\t## CG-NF-20260707-901: Chinese registry query fixture',
              '5\t- status: open',
            ],
          },
        ],
      },
      fallback: {
        sourceBlocks: [
          {
            header: 'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetActionFactory.kt — NanoflowWidgetActionFactory(class)',
            language: 'kotlin',
            lines: [
              '1\tclass NanoflowWidgetActionFactory {',
              '2\t  fun recordIssue(): String = "app noise"',
              '3\t}',
            ],
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
    expect(text).toContain(`baseQuery=${focusedQuery}`);
    expect(sourceHeaders[0]).toContain('docs/codegraph-nanoflow-adaptation-issues.md');
    expect(text).toContain('CG-NF-20260707-901');
    expect(text).toContain('- status: open');
    expect(text).not.toContain('app noise');
    expect(sourceHeaders.join('\n')).not.toContain('NanoflowWidgetActionFactory.kt');
  }, 12_000);

  it('keeps issue registry source first for tooling-heavy registry queries', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-issue-registry-tooling-filter-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'docs/codegraph-nanoflow-adaptation-issues.md',
      [
        '# NanoFlow CodeGraph Adaptation Issue Registry',
        '',
        '## Open Issues',
        '',
        '## CG-NF-20260629-901: Registry tooling filter fixture',
        '',
        '- status: open',
        '- feature_scope: context-pack issue registry source ordering',
        '- query_surface: nanoflow_context_pack | adapter-context-cli',
        '- query: `strict native edge-function-header nativeJson query-codegraph-nanoflow-overlay`',
        '- expected: registry source blocks remain visible.',
        '- actual: tooling source blocks should not replace registry evidence.',
        '',
        '## Fixed Issues',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/codegraph-nanoflow-mcp-stdio.cjs',
      [
        'function formatNanoFlowContextPackAsMarkdown(pack) {',
        '  return pack.query;',
        '}',
        '',
      ].join('\n'),
    );

    const noisyQuery = 'docs/codegraph-nanoflow-adaptation-issues.md strict native edge-function-header nativeJson column nativeMarkdown Authorization content-length Origin buildNativeCodeBlocks buildExactRelationEdgeCodeBlocks buildProvenanceEdgeLineCodeBlocks readEdgeLineCodeBlock query-codegraph-nanoflow-overlay';
    const focusedQuery = 'docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues';
    const focusedResponse = {
      query: focusedQuery,
      matches: [
        {
          kind: 'function',
          name: 'formatNanoFlowContextPackAsMarkdown',
          file: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
        },
      ],
      nodes: [
        {
          id: 'function:scripts/codegraph-nanoflow-mcp-stdio.cjs:formatNanoFlowContextPackAsMarkdown',
          kind: 'function',
          name: 'formatNanoFlowContextPackAsMarkdown',
          qualifiedName: 'formatNanoFlowContextPackAsMarkdown',
          filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          language: 'javascript',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 1, graphEdges: 0 },
    };
    writeQueryAwareOverlayResponseScript(projectRoot, focusedQuery, focusedResponse, focusedResponse);

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-issue-registry-tooling-filter-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      focusedQuery,
      focused: {
        sourceBlocks: [
          {
            header: 'scripts/codegraph-nanoflow-mcp-stdio.cjs — formatNanoFlowContextPackAsMarkdown(function)',
            language: 'javascript',
            lines: [
              '1\tfunction formatNanoFlowContextPackAsMarkdown(pack) {',
              '2\t  return pack.query;',
              '3\t}',
            ],
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
    expect(text).toContain(`baseQuery=${focusedQuery}`);
    expect(sourceHeaders[0]).toContain('docs/codegraph-nanoflow-adaptation-issues.md');
    expect(text).toContain('CG-NF-20260629-901');
    expect(sourceHeaders.join('\n')).toContain('scripts/codegraph-nanoflow-mcp-stdio.cjs');
  }, 12_000);

  it('keeps top-ranked docs source ahead of generic tooling source blocks', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-docs-tooling-filter-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'docs/context7/07-examples/add-edge-function.md',
      [
        '# Example - Add an Edge Function',
        '',
        'Create `supabase/functions/<function-name>/`.',
        'Validate input at function boundary.',
        'Check auth before reading user data.',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        'function buildNativeCodeBlocks() {',
        '  return "native";',
        '}',
        '',
      ].join('\n'),
    );

    const query = 'strict native edge-function-header nativeJson column nativeMarkdown Authorization content-length Origin buildNativeCodeBlocks buildExactRelationEdgeCodeBlocks buildProvenanceEdgeLineCodeBlocks readEdgeLineCodeBlock query-codegraph-nanoflow-overlay';
    writeOverlayResponseScript(projectRoot, {
      query,
      matches: [
        {
          kind: 'file',
          name: 'Example - Add an Edge Function',
          file: 'docs/context7/07-examples/add-edge-function.md',
        },
        {
          kind: 'function',
          name: 'buildNativeCodeBlocks',
          file: 'scripts/query-codegraph-nanoflow-overlay.mjs',
        },
      ],
      nodes: [
        {
          id: 'file:docs/context7/07-examples/add-edge-function.md',
          kind: 'file',
          name: 'Example - Add an Edge Function',
          qualifiedName: 'docs/context7/07-examples/add-edge-function.md',
          filePath: 'docs/context7/07-examples/add-edge-function.md',
          language: 'markdown',
          startLine: 1,
          endLine: 5,
        },
        {
          id: 'function:scripts/query-codegraph-nanoflow-overlay.mjs:buildNativeCodeBlocks',
          kind: 'function',
          name: 'buildNativeCodeBlocks',
          qualifiedName: 'buildNativeCodeBlocks',
          filePath: 'scripts/query-codegraph-nanoflow-overlay.mjs',
          language: 'javascript',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 2, graphEdges: 0 },
    });

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-docs-tooling-filter-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      sourceBlocks: [
        {
          header: 'scripts/query-codegraph-nanoflow-overlay.mjs — buildNativeCodeBlocks(function)',
          language: 'javascript',
          lines: [
            '1\tfunction buildNativeCodeBlocks() {',
            '2\t  return "native";',
            '3\t}',
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
      query,
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(sourceHeaders[0]).toContain('docs/context7/07-examples/add-edge-function.md');
    expect(text).toContain('Example - Add an Edge Function');
    expect(sourceHeaders.join('\n')).toContain('scripts/query-codegraph-nanoflow-overlay.mjs');
  }, 12_000);

  it('shows the open issue section when issue registry open queries have no active issues', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-issue-registry-open-section-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'docs/codegraph-nanoflow-adaptation-issues.md',
      [
        '# NanoFlow CodeGraph Adaptation Issue Registry',
        '',
        '## Open Issues',
        '',
        'No active issues are recorded yet.',
        '',
        '## Fixed Issues',
        '',
        '## CG-NF-20260628-901: Fixed-only registry fixture',
        '',
        '- status: fixed',
        '- feature_scope: context-pack issue registry query focus',
        '- query_surface: nanoflow_context_pack | adapter-context-cli',
        '- query: `codegraph nanoflow adaptation issues fixed`',
        '- expected: fixed issue source is available when fixed issues are requested.',
        '- actual: open issue queries should not use this fixed issue as the answer.',
        '',
        '## Entry Template',
        '',
        '```markdown',
        '## CG-NF-YYYYMMDD-001: Short query failure title',
        '',
        '- status: open',
        '```',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
      [
        "const adaptationDocPath = 'docs/codegraph-nanoflow-adaptation.md';",
        'export function makeFakeCodegraph(): string {',
        "  return 'fake-codegraph';",
        '}',
        '',
      ].join('\n'),
    );

    const noisyQuery = 'codegraph nanoflow adaptation issues open remaining gaps issue registry docs';
    const focusedQuery = 'docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues';
    const focusedResponse = {
      query: focusedQuery,
      matches: [
        {
          kind: 'file',
          name: 'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
          file: 'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
        },
      ],
      nodes: [
        {
          id: 'file:src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
          kind: 'file',
          name: 'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
          qualifiedName: 'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
          filePath: 'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 4,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 1, graphEdges: 0 },
    };
    writeQueryAwareOverlayResponseScript(projectRoot, focusedQuery, focusedResponse, focusedResponse);

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-issue-registry-open-section-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      sourceBlocks: [
        {
          header: 'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts — src/tests/scripts/codegraph-nanoflow-overlay.spec.ts(file)',
          language: 'typescript',
          lines: [
            "1\tconst adaptationDocPath = 'docs/codegraph-nanoflow-adaptation.md';",
            '2\texport function makeFakeCodegraph(): string {',
            "3\t  return 'fake-codegraph';",
            '4\t}',
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
      query: noisyQuery,
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(text).toContain(`baseQuery=${focusedQuery}`);
    expect(sourceHeaders[0]).toContain('docs/codegraph-nanoflow-adaptation-issues.md');
    expect(text).toContain('## Open Issues');
    expect(text).toContain('No active issues are recorded yet.');
    expect(text).not.toContain('CG-NF-20260628-901');
    expect(text).not.toContain('CG-NF-YYYYMMDD-001');
    expect(text).not.toContain('- status: open');
  }, 12_000);
}
