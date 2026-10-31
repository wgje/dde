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
import { registerCodegraphOverlayMcpContextQualityToolingOutputSpecs } from './codegraph-nanoflow-overlay-mcp-context-quality-tooling-output.spec-helpers';
import { registerCodegraphOverlayMcpContextQualityToolingDocsSpecs } from './codegraph-nanoflow-overlay-mcp-context-quality-tooling-docs.spec-helpers';
import { registerCodegraphOverlayMcpContextQualityToolingIssueRegistrySpecs } from './codegraph-nanoflow-overlay-mcp-context-quality-tooling-issue-registry.spec-helpers';
import { writeFakeCodegraphExploreScript } from './codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers';
import {
  registerCodegraphOverlayMcpContextForwardWrapperSourceSpec,
} from './codegraph-nanoflow-overlay-mcp-context-forward-wrapper-source.spec-helpers';
import {
  registerCodegraphOverlayMcpContextQualityToolingFocusSpecs,
} from './codegraph-nanoflow-overlay-mcp-context-quality-tooling-focus.spec-helpers';
import {
  registerCodegraphOverlayMcpContextQualityToolingDiagnosticsSpecs,
} from './codegraph-nanoflow-overlay-mcp-context-quality-tooling-diagnostics.spec-helpers';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpContextQualityToolingSpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    readJsonLine,
  } = context;

  registerCodegraphOverlayMcpContextQualityToolingOutputSpecs(context);
  registerCodegraphOverlayMcpContextQualityToolingDocsSpecs(context);

  it('preserves exact relation tokens when focusing context-pack overlay queries', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-relation-token-focus-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'supabase/functions/transcribe/index.ts',
      [
        'Deno.serve(async (req) => {',
        "  const { text } = await req.json();",
        '  return Response.json({ transcript: text });',
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/utils/supabase-functions-error.ts',
      [
        'export async function extractSupabaseFunctionErrorMessage(error: unknown): Promise<string> {',
        "  return error instanceof Error ? error.message : 'Function failed';",
        '}',
        '',
      ].join('\n'),
    );

    const focusedResponse = {
      query: 'supabase functions transcribe edge-function-invoke route-reference',
      matches: [
        {
          kind: 'function',
          name: 'transcribe',
          file: 'supabase/functions/transcribe/index.ts',
          score: 900,
        },
      ],
      nodes: [
        {
          id: 'function:supabase/functions/transcribe/index.ts:transcribe',
          kind: 'function',
          name: 'transcribe',
          qualifiedName: 'transcribe',
          filePath: 'supabase/functions/transcribe/index.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 4,
        },
      ],
      relationshipGroups: {},
      coverage: { edgeFunctions: 1, graphNodes: 1, graphEdges: 0 },
    };
    const fallbackResponse = {
      query: 'supabase functions transcribe edge function invoke route reference',
      matches: [
        {
          kind: 'function',
          name: 'extractSupabaseFunctionErrorMessage',
          file: 'src/utils/supabase-functions-error.ts',
          score: 900,
        },
      ],
      nodes: [
        {
          id: 'function:src/utils/supabase-functions-error.ts:extractSupabaseFunctionErrorMessage',
          kind: 'function',
          name: 'extractSupabaseFunctionErrorMessage',
          qualifiedName: 'extractSupabaseFunctionErrorMessage',
          filePath: 'src/utils/supabase-functions-error.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {},
      coverage: { edgeFunctions: 1, graphNodes: 1, graphEdges: 0 },
    };
    writeQueryAwareOverlayResponseScript(
      projectRoot,
      'supabase functions transcribe edge-function-invoke route-reference',
      focusedResponse,
      fallbackResponse,
    );

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-relation-token-focus-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      sourceBlocks: [
        {
          header: 'src/utils/supabase-functions-error.ts — extractSupabaseFunctionErrorMessage(function)',
          language: 'typescript',
          lines: [
            '1\texport async function extractSupabaseFunctionErrorMessage(error: unknown): Promise<string> {',
            "2\t  return error instanceof Error ? error.message : 'Function failed';",
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
      query: 'supabase functions transcribe edge-function-invoke route-reference source ordering',
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(sourceHeaders[0]).toContain('supabase/functions/transcribe/index.ts');
    expect(sourceHeaders[0]).not.toContain('supabase-functions-error.ts');
  }, 12_000);

  it('uses context-json code blocks to replace shallow base Edge Function snippets', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-code-block-source-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'supabase/functions/transcribe/index.ts',
      [
        '// supabase/functions/transcribe/index.ts',
        'const corsHeaders = {',
        "  'Access-Control-Allow-Origin': '*',",
        '};',
        '',
        'serve(async (req: Request) => {',
        '  const { text } = await req.json();',
        '  return Response.json({ transcript: text, corsHeaders });',
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/utils/supabase-functions-error.ts',
      [
        'export async function extractSupabaseFunctionErrorMessage(error: unknown): Promise<string> {',
        "  return error instanceof Error ? error.message : 'Function failed';",
        '}',
        '',
      ].join('\n'),
    );

    writeOverlayResponseScript(projectRoot, {
      query: 'supabase functions transcribe edge-function-invoke route-reference',
      matches: [
        {
          kind: 'function',
          name: 'transcribe',
          file: 'supabase/functions/transcribe/index.ts',
          score: 900,
        },
      ],
      nodes: [
        {
          id: 'function:supabase/functions/transcribe/index.ts:transcribe',
          kind: 'function',
          name: 'transcribe',
          qualifiedName: 'transcribe',
          filePath: 'supabase/functions/transcribe/index.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 1,
        },
      ],
      codeBlocks: [
        {
          filePath: 'supabase/functions/transcribe/index.ts',
          startLine: 6,
          endLine: 9,
          language: 'typescript',
          content: [
            'serve(async (req: Request) => {',
            '  const { text } = await req.json();',
            '  return Response.json({ transcript: text, corsHeaders });',
            '});',
          ].join('\n'),
          nodeName: 'transcribe',
          nodeKind: 'function',
        },
      ],
      relationshipGroups: {},
      coverage: { edgeFunctions: 1, graphNodes: 1, graphEdges: 0 },
    });

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-code-block-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      sourceBlocks: [
        {
          header: 'src/utils/supabase-functions-error.ts — extractSupabaseFunctionErrorMessage(function)',
          language: 'typescript',
          lines: [
            '1\texport async function extractSupabaseFunctionErrorMessage(error: unknown): Promise<string> {',
            "2\t  return error instanceof Error ? error.message : 'Function failed';",
            '3\t}',
          ],
        },
        {
          header: 'supabase/functions/transcribe/index.ts — transcribe(function)',
          language: 'typescript',
          lines: [
            '1\t// supabase/functions/transcribe/index.ts',
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
      query: 'supabase functions transcribe edge-function-invoke route-reference source ordering',
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(sourceHeaders[0]).toContain('supabase/functions/transcribe/index.ts');
    expect(sourceHeaders[0]).not.toContain('supabase-functions-error.ts');
    expect(text).toContain('6\tserve(async (req: Request) => {');
    expect(text.indexOf('6\tserve(async')).toBeLessThan(text.indexOf('extractSupabaseFunctionErrorMessage'));
  }, 12_000);

  registerCodegraphOverlayMcpContextQualityToolingIssueRegistrySpecs(context);

  registerCodegraphOverlayMcpContextQualityToolingDiagnosticsSpecs(context);
  registerCodegraphOverlayMcpContextQualityToolingFocusSpecs(context);
  registerCodegraphOverlayMcpContextForwardWrapperSourceSpec(context);
}
