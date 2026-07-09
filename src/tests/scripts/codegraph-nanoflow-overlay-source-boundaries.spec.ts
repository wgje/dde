import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const generatorPath = path.join(repoRoot, 'scripts', 'generate-codegraph-nanoflow-overlay.mjs');
const queryPath = path.join(repoRoot, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');

function readGeneratorSource(): string {
  return fs.readFileSync(generatorPath, 'utf8');
}

function readQuerySource(): string {
  return fs.readFileSync(queryPath, 'utf8');
}

function extractFunctionBody(source: string, functionName: string): string {
  const functionStart = source.indexOf(`function ${functionName}(`);
  expect(functionStart, `${functionName} should be declared`).toBeGreaterThanOrEqual(0);

  const bodyStart = source.indexOf('{', functionStart);
  expect(bodyStart, `${functionName} should have a body`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }

  throw new Error(`${functionName} body was not closed`);
}

describe('CodeGraph NanoFlow overlay source boundaries', () => {
  it('separates native TypeScript callable edges from Supabase semantic callable edges', () => {
    const source = readGeneratorSource();

    expect(source).toContain('function addTypeScriptNativeCallableEdges(');
    expect(source).toContain('function addSupabaseCallableSemanticEdges(');

    const dispatcherBody = extractFunctionBody(source, 'addTypeScriptCallableEdges');
    expect(dispatcherBody).toContain('addTypeScriptNativeCallableEdges(');
    expect(dispatcherBody).toContain('addSupabaseCallableSemanticEdges(');
    expect(dispatcherBody).not.toMatch(/\bitem\.(returns|calls|instantiates)\b/);
    expect(dispatcherBody).not.toMatch(/\bitem\.supabase[A-Z]/);

    const nativeBody = extractFunctionBody(source, 'addTypeScriptNativeCallableEdges');
    expect(nativeBody).toMatch(/\bitem\.returns\b/);
    expect(nativeBody).toMatch(/\bitem\.calls\b/);
    expect(nativeBody).toMatch(/\bitem\.instantiates\b/);
    expect(nativeBody).not.toMatch(/\bitem\.supabase[A-Z]/);

    const supabaseBody = extractFunctionBody(source, 'addSupabaseCallableSemanticEdges');
    expect(supabaseBody).toMatch(/\bitem\.supabase[A-Z]/);
    expect(supabaseBody).not.toMatch(/\bitem\.(returns|calls|instantiates)\b/);
  });

  it('keeps overlay query and ranking as NanoFlow semantic helpers instead of a second generic CodeGraph search engine', () => {
    const source = readQuerySource();

    expect(source).toContain('function buildNanoFlowOverlayCandidates(');
    expect(source).toContain('function scoreNanoFlowSemanticCandidate(');
    expect(source).toContain('function selectNanoFlowRelationGraphResults(');

    const queryBody = extractFunctionBody(source, 'queryOverlay');
    expect(queryBody).toContain('buildNanoFlowOverlayCandidates(');
    expect(queryBody).toContain('scoreNanoFlowSemanticCandidate(');
    expect(queryBody).not.toMatch(/\boverlay\.(angular|supabase|agentRules|typescript)\b/);

    const candidateBody = extractFunctionBody(source, 'buildNanoFlowOverlayCandidates');
    expect(candidateBody).toMatch(/\boverlay\.(angular|supabase|agentRules)\b/);
    expect(candidateBody).toMatch(/\bmetadata\.relation\b|\bgraphNodeCandidateKind\b/);

    const semanticScoreBody = extractFunctionBody(source, 'scoreNanoFlowSemanticCandidate');
    expect(semanticScoreBody).toMatch(/\bcandidateSearchText\b/);
    expect(semanticScoreBody).toMatch(/\bscorePathTermMatch\b/);
    expect(semanticScoreBody).not.toMatch(/\b(callers|callees|impact|autoSync|daemon|watcher|indexing)\b/i);

    const selectionBody = extractFunctionBody(source, 'selectGraphResults');
    expect(selectionBody).toContain('selectNanoFlowRelationGraphResults(');
    expect(selectionBody).toContain('seedExplicitPathScopedGraphNodeIds(');
    expect(selectionBody).not.toMatch(/\b(edgeMatchesExactMetadataQuery|selectExactRelationResults)\b/);
    expect(selectionBody).not.toMatch(/for \(const node of graph\.nodes\)/);
    expect(selectionBody).not.toMatch(/for \(const edge of graph\.edges\)/);
    expect(selectionBody).not.toMatch(/\b(scoreGraphEdge|shouldScoreGraphEdges)\b/);

    const explicitPathBody = extractFunctionBody(source, 'seedExplicitPathScopedGraphNodeIds');
    expect(explicitPathBody).toContain('explicitPathScope.size === 0');
    expect(explicitPathBody).toContain('isInExplicitPathScope(');
  });

  it('keeps strict native projections free of NanoFlow extension sections', () => {
    const source = readQuerySource();

    expect(source).toContain('function formatNanoFlowAugmentedMarkdown(');

    const augmentedBody = extractFunctionBody(source, 'formatNanoFlowAugmentedMarkdown');
    expect(augmentedBody).toContain('### NanoFlow Coverage');

    const nativeMarkdownBody = extractFunctionBody(source, 'formatStrictNativeMarkdown');
    expect(nativeMarkdownBody).not.toMatch(/NanoFlow Coverage|sourceSelection|provenance|metadata\.relation/);

    const nativeJsonBody = extractFunctionBody(source, 'toNativeJsonFormatterResponse');
    expect(nativeJsonBody).not.toMatch(/NanoFlow Coverage|sourceSelection|provenance|metadata\.relation/);
  });
});
