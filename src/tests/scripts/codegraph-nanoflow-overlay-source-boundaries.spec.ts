import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const generatorPath = path.join(repoRoot, 'scripts', 'generate-codegraph-nanoflow-overlay.mjs');
const queryPath = path.join(repoRoot, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
const sidecarPath = path.join(repoRoot, 'scripts', 'lib', 'codegraph-native-graph-sidecar.cjs');
const candidateIndexPath = path.join(repoRoot, 'scripts', 'lib', 'codegraph-overlay-candidate-index.mjs');
const semanticSelectionPath = path.join(repoRoot, 'scripts', 'lib', 'codegraph-overlay-semantic-selection.mjs');
const outputProjectionPath = path.join(repoRoot, 'scripts', 'lib', 'codegraph-overlay-output-projection.mjs');

function readGeneratorSource(): string {
  return fs.readFileSync(generatorPath, 'utf8');
}

function readQuerySource(): string {
  return fs.readFileSync(queryPath, 'utf8');
}

function readSidecarSource(): string {
  return fs.readFileSync(sidecarPath, 'utf8');
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
  it('uses SourcePolicy for publication inputs and the shared reader for query authentication', () => {
    const generatorSource = readGeneratorSource();
    const querySource = readQuerySource();
    const captureManifestBody = extractFunctionBody(generatorSource, 'captureSourceManifest');

    expect(generatorSource).toContain("import sourcePolicy from './lib/codegraph-source-policy.cjs';");
    expect(captureManifestBody).toContain('buildSourceManifest(projectRoot)');
    expect(captureManifestBody).not.toMatch(/fs\.readFileSync|createHash|\bwalk\(/);
    expect(generatorSource).not.toContain('const EXCLUDED_DIRS = new Set([');

    expect(querySource).toContain("import currentReceiptReader from './lib/codegraph-overlay-current-receipt.cjs';");
    expect(querySource).toContain('readOverlayCurrentReceipt(root)');
    expect(querySource).not.toContain("import sourcePolicy from './lib/codegraph-source-policy.cjs';");
    expect(querySource).not.toContain('hasNewerOverlayRelevantFile');
  });

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
    const source = fs.readFileSync(candidateIndexPath, 'utf8');
    const selectionSource = fs.readFileSync(semanticSelectionPath, 'utf8');

    expect(source).toContain('function buildNanoFlowOverlayCandidates(');
    expect(source).toContain('function scoreNanoFlowSemanticCandidate(');
    expect(selectionSource).toContain('function selectNanoFlowRelationGraphResults(');

    const queryBody = extractFunctionBody(source, 'queryOverlay');
    expect(queryBody).toContain('buildNanoFlowOverlayCandidates(');
    expect(queryBody).toContain('runtime.scoreCandidate(');
    expect(queryBody).not.toMatch(/\boverlay\.(angular|supabase|agentRules|typescript)\b/);

    const candidateBody = extractFunctionBody(source, 'buildNanoFlowOverlayCandidates');
    expect(candidateBody).toMatch(/\boverlay\.(angular|supabase|agentRules)\b/);
    expect(candidateBody).toMatch(/\bmetadata\.relation\b|\bgraphNodeCandidateKind\b/);

    const semanticScoreBody = extractFunctionBody(source, 'scoreNanoFlowSemanticCandidate');
    const scoreCandidateBody = extractFunctionBody(source, 'scoreCandidate');
    expect(scoreCandidateBody).toContain('scoreNanoFlowSemanticCandidate(');
    expect(semanticScoreBody).toMatch(/\bcandidateSearchText\b/);
    expect(semanticScoreBody).toMatch(/\bscorePathTermMatch\b/);
    expect(semanticScoreBody).not.toMatch(/\b(callers|callees|impact|autoSync|daemon|watcher|indexing)\b/i);

    const selectionBody = extractFunctionBody(selectionSource, 'selectGraphResults');
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
    const source = fs.readFileSync(outputProjectionPath, 'utf8');

    expect(source).toContain('function formatNanoFlowAugmentedMarkdown(');

    const augmentedBody = extractFunctionBody(source, 'formatNanoFlowAugmentedMarkdown');
    expect(augmentedBody).toContain('### NanoFlow Coverage');

    const nativeMarkdownBody = extractFunctionBody(source, 'formatStrictNativeMarkdown');
    expect(nativeMarkdownBody).not.toMatch(/NanoFlow Coverage|sourceSelection|provenance|metadata\.relation/);

    const nativeJsonBody = extractFunctionBody(source, 'toNativeJsonFormatterResponse');
    expect(nativeJsonBody).not.toMatch(/NanoFlow Coverage|sourceSelection|provenance|metadata\.relation/);
  });

  it('keeps native Android import rollout explicit, reversible, and fail-closed', () => {
    const source = readGeneratorSource();
    const parseArgsBody = extractFunctionBody(source, 'parseArgs');
    const sourceResolverBody = extractFunctionBody(source, 'resolveAndroidImportSource');
    const importDispatcherBody = extractFunctionBody(source, 'readAndroidKotlinImports');
    const localInventoryBody = extractFunctionBody(source, 'readAndroidKotlinImportsFromSource');
    const nativeProjectionBody = extractFunctionBody(source, 'readAndroidKotlinImportsFromNativeEndpoints');
    const querySource = readQuerySource();
    const queryParseArgsBody = extractFunctionBody(querySource, 'parseArgs');

    expect(source).toContain("const DEFAULT_ANDROID_IMPORT_SOURCE = 'local';");
    expect(sourceResolverBody).toMatch(/explicitSource\s*\?\?/);
    expect(sourceResolverBody).toContain('process.env[ANDROID_IMPORT_SOURCE_DEFAULT_ENV]');
    expect(sourceResolverBody).toContain('DEFAULT_ANDROID_IMPORT_SOURCE');
    expect(parseArgsBody).toContain("arg === '--android-import-source'");
    expect(parseArgsBody).toContain('resolveAndroidImportSource(');
    expect(queryParseArgsBody).toContain("arg === '--android-import-source'");
    expect(queryParseArgsBody).toContain('is generation ownership and is unavailable to query');
    expect(querySource).not.toContain('function ensureOverlay');
    expect(importDispatcherBody).toContain("androidImportSource === 'native'");
    expect(importDispatcherBody).toContain('readNativeAndroidKotlinImportEndpoints(');
    expect(importDispatcherBody).not.toMatch(/catch|fallback/i);
    expect(localInventoryBody).toContain('maskAndroidKotlinNonCode(');
    expect(nativeProjectionBody).toContain('readAndroidKotlinImportFromLine(');
    expect(nativeProjectionBody).toContain('assertNativeAndroidKotlinImportCompleteness(');
    expect(nativeProjectionBody).toMatch(/contentHash|content_hash/);
    expect(nativeProjectionBody).not.toMatch(/qualified_name|signature|endLine|endColumn/);

    const buildNativeGraphStart = source.indexOf('function buildNativeGraph(');
    const nativeImportLoop = source.indexOf('for (const kotlinImport of overlay.android?.kotlinImports ?? [])', buildNativeGraphStart);
    expect(buildNativeGraphStart).toBeGreaterThanOrEqual(0);
    expect(nativeImportLoop).toBeGreaterThan(buildNativeGraphStart);
    expect(source.slice(buildNativeGraphStart, nativeImportLoop)).not.toMatch(
      /readNativeAndroidKotlinImportEndpoints|androidImportSource/,
    );
  });

  it('keeps native Android Kotlin function rollout explicit, reversible, and fail-closed', () => {
    const source = readGeneratorSource();
    const sidecarSource = readSidecarSource();
    const parseArgsBody = extractFunctionBody(source, 'parseArgs');
    const sourceResolverBody = extractFunctionBody(source, 'resolveAndroidFunctionSource');
    const functionDispatcherBody = extractFunctionBody(source, 'readAndroidKotlinFunctions');
    const localInventoryBody = extractFunctionBody(source, 'readAndroidKotlinFunctionsFromSource');
    const nativeProjectionBody = extractFunctionBody(source, 'readAndroidKotlinFunctionsFromNativeEndpoints');
    const completenessBody = extractFunctionBody(source, 'assertNativeAndroidKotlinFunctionCompleteness');
    const querySource = readQuerySource();

    expect(localInventoryBody).toContain('maskAndroidKotlinNonCode(');
    expect(source).toContain("const DEFAULT_ANDROID_FUNCTION_SOURCE = 'native';");
    expect(source).toContain("const ANDROID_FUNCTION_SOURCE_DEFAULT_ENV = 'NANOFLOW_CODEGRAPH_ANDROID_FUNCTION_SOURCE_DEFAULT';");
    expect(sourceResolverBody).toMatch(/explicitSource\s*\?\?/);
    expect(sourceResolverBody).toContain('process.env[ANDROID_FUNCTION_SOURCE_DEFAULT_ENV]');
    expect(sourceResolverBody).toContain('DEFAULT_ANDROID_FUNCTION_SOURCE');
    expect(sourceResolverBody).toContain("? ANDROID_FUNCTION_SOURCE_DEFAULT_ENV");
    expect(parseArgsBody).toContain("arg === '--android-function-source'");
    expect(parseArgsBody).toContain('resolveAndroidFunctionSource(');
    expect(functionDispatcherBody).toContain("androidFunctionSource === 'native'");
    expect(functionDispatcherBody).toContain('readNativeAndroidKotlinFunctionEndpoints(');
    expect(functionDispatcherBody).not.toMatch(/catch|fallback/i);
    expect(nativeProjectionBody).toContain('readAndroidKotlinFunctionsFromSource(');
    expect(nativeProjectionBody).toContain('assertNativeAndroidKotlinFunctionCompleteness(');
    expect(nativeProjectionBody).toMatch(/contentHash|content_hash/);
    expect(nativeProjectionBody).not.toMatch(/qualified_name|signature|endLine|endColumn/);
    expect(completenessBody).toMatch(/nativeNodeId|nativeName|startLine/);
    expect(querySource).not.toContain('--android-function-source');

    const buildNativeGraphStart = source.indexOf('function buildNativeGraph(');
    const nativeFunctionLoop = source.indexOf('for (const kotlinFunction of overlay.android?.kotlinFunctions ?? [])', buildNativeGraphStart);
    expect(buildNativeGraphStart).toBeGreaterThanOrEqual(0);
    expect(nativeFunctionLoop).toBeGreaterThan(buildNativeGraphStart);
    expect(source.slice(buildNativeGraphStart, nativeFunctionLoop)).not.toMatch(
      /readNativeAndroidKotlinFunctionEndpoints|androidFunctionSource|resolveAndroidFunctionSource/,
    );
    expect(sidecarSource).toMatch(/module\.exports\s*=\s*\{[\s\S]*readNativeAndroidKotlinFunctionEndpoints[\s\S]*\}/);
  });
});
