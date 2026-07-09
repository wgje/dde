import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupCodegraphOverlayDocsFixtures,
  makeFixture,
  runValidator,
} from './validate-codegraph-overlay-docs.spec-helpers';
import { registerValidateCodegraphOverlayDocsDriftCountSpecs } from './validate-codegraph-overlay-docs-drift-counts.spec-helpers';
import { registerValidateCodegraphOverlayDocsIssueRegistrySpecs } from './validate-codegraph-overlay-docs-issue-registry.spec-helpers';
import { registerValidateCodegraphOverlayDocsPackageSpecs } from './validate-codegraph-overlay-docs-package.spec-helpers';
import { registerValidateCodegraphOverlayDocsTailSpecs } from './validate-codegraph-overlay-docs-tail.spec-helpers';

function removeDedupCoveredChildSymbols(root: string, symbols: string[]): void {
  const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    hotspots: Array<{
      coveredChildSymbols?: string[];
    }>;
  };
  const toRemove = new Set(symbols);
  for (const hotspot of manifest.hotspots) {
    hotspot.coveredChildSymbols = (hotspot.coveredChildSymbols ?? [])
      .filter(symbol => !toRemove.has(symbol));
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

describe('validate-codegraph-overlay-docs', { timeout: 30_000 }, () => {
  afterEach(() => {
    cleanupCodegraphOverlayDocsFixtures();
  });

  registerValidateCodegraphOverlayDocsPackageSpecs();
  registerValidateCodegraphOverlayDocsIssueRegistrySpecs();

  it('passes when AGENTS and adaptation docs match the generated overlay baseline', () => {
    const root = makeFixture();

    const result = runValidator(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('CodeGraph overlay documentation validation passed');
    expect(result.stdout).toContain('graph shape passed');
  });

  it('fails when the overlay graph no longer has native-shaped nodes and closed edges', () => {
    const root = makeFixture();
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8')) as {
      graph: {
        nodes: Array<Record<string, unknown>>;
        edges: Array<Record<string, unknown>>;
      };
    };
    overlay.graph.nodes.push({ ...overlay.graph.nodes[0] });
    overlay.graph.nodes[0].filePath = '../outside.ts';
    overlay.graph.nodes[1].startLine = 0;
    overlay.graph.edges.push({
      source: 'missing:source',
      target: 'missing:target',
      kind: 'nanoflow-only-edge-kind',
      metadata: { relation: 'invalid-fixture-edge' },
    });
    overlay.graph.edges.push({
      source: 'class:src/a.ts:A',
      target: 'class:src/b.ts:B',
      kind: 'references',
      metadata: { relation: 'sql-function' },
    });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('overlay graph has duplicate node id class:src/a.ts:A');
    expect(result.stderr).toContain('overlay graph class:src/a.ts:A has non-project filePath ../outside.ts');
    expect(result.stderr).toContain('overlay graph class:src/b.ts:B has invalid startLine 0');
    expect(result.stderr).toContain('has non-native edge kind nanoflow-only-edge-kind');
    expect(result.stderr).toContain('has missing source endpoint missing:source');
    expect(result.stderr).toContain('relation sql-function must start from a migration file node, found class');
  });

  it('fails when project semantic relations or required metadata are not registered', () => {
    const root = makeFixture();
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8')) as {
      graph: {
        edges: Array<Record<string, unknown> & {
          metadata?: Record<string, unknown>;
        }>;
      };
    };
    overlay.graph.edges.push({
      source: 'class:src/a.ts:A',
      target: 'class:src/b.ts:B',
      kind: 'references',
      metadata: { relation: 'supabase-undocumented-fixture' },
    });
    const edgeFunctionHeader = overlay.graph.edges.find(edge => (
      edge.metadata?.relation === 'edge-function-header'
    ));
    if (edgeFunctionHeader?.metadata) {
      delete edgeFunctionHeader.metadata.header;
    }
    const testMappingEdge = overlay.graph.edges.find(edge => edge.metadata?.testMapping === 'path-reference');
    if (testMappingEdge?.metadata) {
      delete testMappingEdge.metadata.matchedNeedle;
    }
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/testEdgesWithMatchedNeedle=3/g, 'testEdgesWithMatchedNeedle=2')
          .replace(/3 path\/route\/filename-derived edges also render matchedNeedle/g, '2 path/route/filename-derived edges also render matchedNeedle'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('relation supabase-undocumented-fixture is not registered');
    expect(result.stderr).toContain('relation edge-function-header missing metadata.header');
    expect(result.stderr).toContain('testMapping path-reference missing metadata.matchedNeedle');
  });

  it('fails when required project semantic coverage drops to zero without a zero reason', () => {
    const root = makeFixture({ edgeFunctionHeaderEdgesInDocs: 0 });
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8')) as {
      graph: {
        edges: Array<Record<string, unknown> & {
          metadata?: Record<string, unknown>;
        }>;
      };
    };
    overlay.graph.edges = overlay.graph.edges.filter(edge => (
      edge.metadata?.relation !== 'edge-function-header'
    ));
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'project semantic coverage Supabase Edge Functions requires edgeFunctionHeaderEdges > 0',
    );
  });

  it('fails when context-pack source ordering diagnostics are not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/.*sourceOrdering.*\n?/g, ''),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing context-pack sourceOrdering diagnostics');
    expect(result.stderr).toContain('AGENTS.md missing context-pack sourceOrdering diagnostics');
  });

  it('fails when context-pack source section diagnostics are not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/sourceSectionCount/g, 'source-section-count')
          .replace(/duplicateSourceSectionCount/g, 'duplicate-source-section-count')
          .replace(/sourceBlockScore/g, 'source-block-score')
          .replace(/firstSourceBlockIsTopRankedOverlayFile/g, 'first-source-block-is-top-ranked-overlay-file'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing context-pack sourceOrdering diagnostics');
    expect(result.stderr).toContain('sourceSectionCount');
    expect(result.stderr).toContain('duplicateSourceSectionCount');
    expect(result.stderr).toContain('sourceBlockScore');
    expect(result.stderr).toContain('firstSourceBlockIsTopRankedOverlayFile');
    expect(result.stderr).toContain('AGENTS.md missing context-pack sourceOrdering diagnostics');
  });

  it('fails when MCP log guard source-ordering summary diagnostics are not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/.*MCP log guard diagnostics.*\n?/g, '')
          .replace(/.*Stale wrapper handling.*\n?/g, ''),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing MCP log guard diagnostics');
    expect(result.stderr).toContain('wrapperStarts');
    expect(result.stderr).toContain('currentWrapper');
    expect(result.stderr).toContain('currentWrapper.diskScriptSha256');
    expect(result.stderr).toContain('currentWrapper.matchesDisk');
    expect(result.stderr).toContain('currentWrapper.staleAgainstDisk');
    expect(result.stderr).toContain('currentDiskWrapper');
    expect(result.stderr).toContain('currentDiskWrapper.latestRequestKind');
    expect(result.stderr).toContain('currentContextWrapper');
    expect(result.stderr).toContain('currentContextWrapper.diskScriptSha256');
    expect(result.stderr).toContain('currentContextWrapper.matchesDisk');
    expect(result.stderr).toContain('currentContextWrapper.staleAgainstDisk');
    expect(result.stderr).toContain('currentDiskContextWrapper');
    expect(result.stderr).toContain('currentDiskContextWrapper.latestRequestKind');
    expect(result.stderr).toContain('currentContextSourceOrdering');
    expect(result.stderr).toContain('contextSourceOrdering');
    expect(result.stderr).toContain('lowValueVisibleSourceBlocks');
    expect(result.stderr).toContain('lowValueSourcePollution');
    expect(result.stderr).toContain('wrapper.script.stale.continue');
    expect(result.stderr).toContain('AGENTS.md missing MCP log guard diagnostics');
  });

  it('fails when query-path relevance output ordering is not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/.*query-path relevance.*\n?/g, ''),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing query-path relevance contract');
    expect(result.stderr).toContain('AGENTS.md missing query-path relevance contract');
  });

  it('fails when Codex MCP configuration ownership is not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/source=codex/g, 'source=vscode')
          .replace(/C:\\Users\\MI\\.codex\\config\.toml/g, '.vscode/mcp.json')
          .replace(/NANOFLOW_CODEGRAPH_CODEX_CONFIG/g, 'NANOFLOW_CODEGRAPH_VSCODE_CONFIG'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing Codex MCP config contract');
    expect(result.stderr).toContain('AGENTS.md missing Codex MCP config contract');
  });

  it('fails when Codex MCP configuration docs still allow VS Code fallback', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(
            'codegraph:adapter:context, codegraph:mcp:smoke, and codegraph:adapter:doctor do not read or fall back to .vscode/mcp.json',
            'only when no applicable Codex config exists may the adapter fall back to .vscode/mcp.json',
          ),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing Codex MCP config contract');
    expect(result.stderr).toContain('AGENTS.md missing Codex MCP config contract');
  });

  it('fails when Codex MCP configuration docs omit the active .codex repair boundary', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/.*active CodeGraph MCP.*\n?/g, '')
          .replace(/.*edited, repaired, or diagnosed.*\n?/g, ''),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing Codex MCP config contract');
    expect(result.stderr).toContain('AGENTS.md missing Codex MCP config contract');
  });

  it('fails when Codex MCP configuration docs omit required wrapper environment', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS/g, 'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MISSING'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing Codex MCP config contract');
    expect(result.stderr).toContain('AGENTS.md missing Codex MCP config contract');
    expect(result.stderr).toContain('NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS');
  });

  it('fails when upstream versioning and de-duplication boundaries are not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/upstream CodeGraph fixed version/g, 'upstream-codegraph-fixed-version')
          .replace(/@colbymchenry\/codegraph@1\.2\.0/g, '@colbymchenry/codegraph@1.1.1')
          .replace(/--codegraph-target @colbymchenry\/codegraph@<new-version>/g, '--codegraph-target @colbymchenry/codegraph@latest')
          .replace(/delegates generic TypeScript symbol\/import\/export\/call\/impact/g, 'duplicates generic TypeScript graph extraction')
          .replace(/must not reimplement native auto-sync, indexing, generic search ranking, or callers\/callees\/impact/g, 'may replace native indexing and search')
          .replace(/NanoFlow overlay owns only project-specific semantics, output-quality policy, Codex host reliability, and repository hard-rule anchors/g, 'NanoFlow overlay owns all CodeGraph behavior'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing upstream CodeGraph boundary contract');
    expect(result.stderr).toContain('@colbymchenry/codegraph@1.2.0');
    expect(result.stderr).toContain('--codegraph-target @colbymchenry/codegraph@<new-version>');
    expect(result.stderr).toContain('delegates generic TypeScript symbol/import/export/call/impact');
    expect(result.stderr).toContain('must not reimplement native auto-sync, indexing, generic search ranking, or callers/callees/impact');
    expect(result.stderr).toContain('AGENTS.md missing upstream CodeGraph boundary contract');
  });

  it('fails when de-duplication hotspot audit backlog is not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/De-duplication hotspot audit backlog/g, 'de-duplication audit omitted')
          .replace(/collectTypeScript\(\)/g, 'collectTypeScript')
          .replace(/buildNativeGraph\(\)/g, 'buildNativeGraph')
          .replace(/removal trigger/g, 'future note')
          .replace(/delegated upstream owner/g, 'unclear owner')
          .replace(/verification gate/g, 'manual check'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing upstream CodeGraph de-duplication audit contract');
    expect(result.stderr).toContain('De-duplication hotspot audit backlog');
    expect(result.stderr).toContain('collectTypeScript()');
    expect(result.stderr).toContain('buildNativeGraph()');
    expect(result.stderr).toContain('removal trigger');
    expect(result.stderr).toContain('AGENTS.md missing upstream CodeGraph de-duplication audit contract');
  });

  it('fails when the structured de-duplication contract manifest is missing', () => {
    const root = makeFixture();
    fs.unlinkSync(path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json'));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing structured de-duplication contract manifest');
  });

  it('fails when the structured de-duplication contract weakens a hotspot boundary', () => {
    const root = makeFixture();
    const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.hotspots[0].status = 'permanent';
    manifest.hotspots[0].forbiddenScope = 'may replace native search';
    manifest.hotspots[0].sourcePath = 'scripts/missing-codegraph-overlay.mjs';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json hotspot collectTypeScript() sourcePath must be scripts/generate-codegraph-nanoflow-overlay.mjs');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json hotspot collectTypeScript() status must be temporary-allowed');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json hotspot collectTypeScript() forbiddenScope missing must not reimplement');
  });

  it('fails when the top-level native delegation contract omits output-format ownership boundaries', () => {
    const root = makeFixture();
    const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      nativeDelegationContract: {
        delegatedGenericCapabilities: string[];
      };
    };
    manifest.nativeDelegationContract.delegatedGenericCapabilities = manifest
      .nativeDelegationContract
      .delegatedGenericCapabilities
      .filter(capability => ![
        'native Markdown/JSON formatter section order',
        'strict native output projection',
        'context exploration source ordering',
      ].includes(capability));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json nativeDelegationContract.delegatedGenericCapabilities missing native Markdown/JSON formatter section order');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json nativeDelegationContract.delegatedGenericCapabilities missing strict native output projection');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json nativeDelegationContract.delegatedGenericCapabilities missing context exploration source ordering');
  });

  it('fails when the structured de-duplication contract omits required machine fields', () => {
    const root = makeFixture();
    const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest.hotspots[0].sourceSymbols;
    manifest.hotspots[0].allowedRelations = [];
    manifest.hotspots[0].lastVerifiedGate = 'manual';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json hotspot collectTypeScript() missing required field sourceSymbols');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json hotspot collectTypeScript() sourceSymbols must be an array');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json hotspot collectTypeScript() allowedRelations must not be empty');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json hotspot collectTypeScript() lastVerifiedGate must be one of');
  });

  it('fails when query and formatter duplicate hotspots omit boundary machine fields', () => {
    const root = makeFixture();
    const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const queryHotspot = manifest.hotspots.find((entry: { name?: string }) => entry.name === 'queryOverlay()');
    delete queryHotspot.duplicateBoundaryRole;
    queryHotspot.outputSurface = ['unsupportedSurface'];
    queryHotspot.extensionFieldPolicy = 'mixed';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json hotspot queryOverlay() missing required field duplicateBoundaryRole');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json hotspot queryOverlay() outputSurface has unsupported value unsupportedSurface');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json hotspot queryOverlay() extensionFieldPolicy must be one of');
  });

  it('fails when query ranking and result selection boundaries allow generic CodeGraph replacement', () => {
    const root = makeFixture();
    const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      hotspots: Array<Record<string, unknown>>;
    };
    const scoreCandidate = manifest.hotspots.find(entry => entry.name === 'scoreCandidate()');
    const selectGraphResults = manifest.hotspots.find(entry => entry.name === 'selectGraphResults()');
    if (!scoreCandidate || !selectGraphResults) {
      throw new Error('fixture missing scoreCandidate/selectGraphResults hotspots');
    }
    scoreCandidate.duplicateBoundaryRole = 'query-parsing';
    scoreCandidate.allowedPurpose = 'attach NanoFlow metadata.relation while reordering generic native results for lexical ranking';
    scoreCandidate.outputSurface = ['contextJson', 'nativeJson', 'augmentedMarkdown'];
    selectGraphResults.duplicateBoundaryRole = 'candidate-ranking';
    selectGraphResults.allowedPurpose = 'attach NanoFlow metadata.relation while expanding generic impact traversal and generic result selection';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot scoreCandidate() query ranking hotspot must use duplicateBoundaryRole candidate-ranking',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot scoreCandidate() candidate-ranking allowedPurpose must not claim generic native ranking/reordering authority',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot scoreCandidate() candidate-ranking outputSurface must not include nativeJson',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot selectGraphResults() result-selection hotspot must use duplicateBoundaryRole result-selection',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot selectGraphResults() result-selection allowedPurpose must not claim generic impact/search selection authority',
    );
  });

  it('fails when strict native Markdown formatter ownership is anchored to an augmented formatter', () => {
    const root = makeFixture();
    const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      hotspots: Array<Record<string, unknown> & {
        coveredChildSymbols?: string[];
        outputSurface?: string[];
        sourceSymbols?: string[];
      }>;
    };
    manifest.hotspots = manifest.hotspots.filter(entry => entry.name !== 'formatStrictNativeMarkdown()');
    const augmentedFormatter = manifest.hotspots.find(entry => entry.name === 'formatNativeMarkdown()');
    if (!augmentedFormatter) {
      throw new Error('fixture missing formatNativeMarkdown() hotspot');
    }
    augmentedFormatter.duplicateBoundaryRole = 'native-markdown-formatter';
    augmentedFormatter.outputSurface = ['nativeMarkdown'];
    augmentedFormatter.extensionFieldPolicy = 'strict-native';
    augmentedFormatter.sourceSymbols = ['formatNativeMarkdown'];
    augmentedFormatter.coveredChildSymbols = [
      ...new Set([
        ...(augmentedFormatter.coveredChildSymbols ?? []),
        'formatStrictNativeMarkdown',
        'formatNanoFlowAugmentedMarkdown',
      ]),
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.appendFileSync(
      path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs'),
      'function formatStrictNativeMarkdown() {}\nfunction formatNanoFlowAugmentedMarkdown() {}\n',
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatNativeMarkdown() strict-native nativeMarkdown hotspot must be named formatStrictNativeMarkdown()',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatNativeMarkdown() strict-native nativeMarkdown sourceSymbols must include formatStrictNativeMarkdown',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatNativeMarkdown() strict-native nativeMarkdown sourceSymbols must not include augmented formatter formatNativeMarkdown',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatNativeMarkdown() strict-native nativeMarkdown coveredChildSymbols must not include augmented formatter formatNanoFlowAugmentedMarkdown',
    );
  });

  it('fails when augmented Markdown formatter ownership absorbs strict-native helpers', () => {
    const root = makeFixture();
    const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      hotspots: Array<Record<string, unknown> & {
        coveredChildSymbols?: string[];
        outputSurface?: string[];
      }>;
    };
    const augmentedFormatter = manifest.hotspots.find(entry => entry.name === 'formatNativeMarkdown()');
    if (!augmentedFormatter) {
      throw new Error('fixture missing formatNativeMarkdown() hotspot');
    }
    augmentedFormatter.outputSurface = ['nativeMarkdown', 'augmentedMarkdown'];
    augmentedFormatter.coveredChildSymbols = [
      ...new Set([
        ...(augmentedFormatter.coveredChildSymbols ?? []),
        'formatStrictNativeMarkdown',
        'strictNativeCodeBlockBudgetReached',
      ]),
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.appendFileSync(
      path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs'),
      'function formatStrictNativeMarkdown() {}\nfunction strictNativeCodeBlockBudgetReached() {}\n',
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatNativeMarkdown() nanoflow-augmented native-markdown formatter outputSurface must not include nativeMarkdown',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatNativeMarkdown() nanoflow-augmented native-markdown formatter must not include strict-native helper formatStrictNativeMarkdown',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatNativeMarkdown() nanoflow-augmented native-markdown formatter must not include strict-native helper strictNativeCodeBlockBudgetReached',
    );
  });

  it('fails when augmented Markdown formatter source body calls strict-native formatter logic', () => {
    const root = makeFixture();
    const overlayPath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    const sourceText = fs.readFileSync(overlayPath, 'utf8');
    fs.writeFileSync(
      overlayPath,
      sourceText.replace(
        'function formatNativeMarkdown() {}\n',
        [
          'function formatNativeMarkdown() {',
          '  const markdown = formatStrictNativeMarkdown({ nodes: [], edges: [] });',
          '  return `${markdown}\\n## Code Context\\n### Entry Points\\n### Code`;',
          '}',
          '',
        ].join('\n'),
      ),
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatNativeMarkdown() nanoflow-augmented native-markdown formatter source body must not reference strict-native formatter token formatStrictNativeMarkdown',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatNativeMarkdown() nanoflow-augmented native-markdown formatter source body must not render strict-native heading ## Code Context',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatNativeMarkdown() nanoflow-augmented native-markdown formatter source body must not render strict-native heading ### Entry Points',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatNativeMarkdown() nanoflow-augmented native-markdown formatter source body must not render strict-native heading ### Code',
    );
  });

  it('fails when strict native Markdown formatter source body renders NanoFlow metadata', () => {
    const root = makeFixture();
    const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      hotspots: Array<Record<string, unknown> & {
        coveredChildSymbols?: string[];
      }>;
    };
    const strictFormatter = manifest.hotspots.find(entry => entry.name === 'formatStrictNativeMarkdown()');
    if (!strictFormatter) {
      throw new Error('fixture missing formatStrictNativeMarkdown() hotspot');
    }
    strictFormatter.coveredChildSymbols = [
      ...new Set([
        ...(strictFormatter.coveredChildSymbols ?? []),
        'buildStrictNativeMarkdownRelationshipGroups',
        'formatEdgeMetadata',
      ]),
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const overlayPath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    fs.appendFileSync(
      overlayPath,
      [
        'function formatEdgeMetadata() {}',
        'function buildStrictNativeMarkdownRelationshipGroups() {',
        '  return formatEdgeMetadata({ metadata: { relation: "supabase-table-write", table: "tasks", writeOperation: "upsert" } });',
        '}',
        '',
      ].join('\n'),
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatStrictNativeMarkdown() strict-native nativeMarkdown formatter source body must not reference augmented formatter token formatEdgeMetadata',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatStrictNativeMarkdown() strict-native nativeMarkdown formatter source body must not reference NanoFlow metadata token relation:',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatStrictNativeMarkdown() strict-native nativeMarkdown formatter source body must not reference NanoFlow metadata token table:',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatStrictNativeMarkdown() strict-native nativeMarkdown formatter source body must not reference NanoFlow metadata token writeOperation',
    );
  });

  it('fails when an Android/Kotlin de-duplication helper is not covered by the manifest', () => {
    const root = makeFixture();
    fs.appendFileSync(
      path.join(root, 'scripts', 'generate-codegraph-nanoflow-overlay.mjs'),
      'function readAndroidKotlinUnregisteredHelper() {}\n',
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing Android/Kotlin de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('readAndroidKotlinUnregisteredHelper');
  });

  it('fails when a TypeScript graph de-duplication helper is not covered by the manifest', () => {
    const root = makeFixture();
    fs.appendFileSync(
      path.join(root, 'scripts', 'generate-codegraph-nanoflow-overlay.mjs'),
      'function readImportUnregisteredHelper() {}\n',
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing TypeScript de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('readImportUnregisteredHelper');
  });

  it('fails when a query formatter duplicate helper is not covered by the manifest', () => {
    const root = makeFixture();
    fs.appendFileSync(
      path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs'),
      'function orderRelatedFilesForQuery() {}\n',
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing query/formatter de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('orderRelatedFilesForQuery');
  });

  it('fails when a query formatter source-block child helper is not covered by the manifest', () => {
    const root = makeFixture();
    fs.appendFileSync(
      path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs'),
      'function readSourceBlockUnregisteredHelper() {}\n',
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing query/formatter de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('readSourceBlockUnregisteredHelper');
  });

  it('fails when query semantic selection and relevance helpers are not covered by the manifest', () => {
    const root = makeFixture();
    removeDedupCoveredChildSymbols(root, [
      'selectAngularSemanticApiEdges',
      'scoreNodeRelevanceForQuery',
    ]);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing query/formatter de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('selectAngularSemanticApiEdges');
    expect(result.stderr).toContain('scoreNodeRelevanceForQuery');
  });

  it('fails when strict native source-budget helpers are not covered by the manifest', () => {
    const root = makeFixture();
    removeDedupCoveredChildSymbols(root, [
      'strictNativeCodeBlockBudgetReached',
      'suppressedNativeCodeBlockNodeIds',
    ]);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing query/formatter de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('strictNativeCodeBlockBudgetReached');
    expect(result.stderr).toContain('suppressedNativeCodeBlockNodeIds');
  });

  it('fails when query scoring and explicit native code-block helpers are not covered by the manifest', () => {
    const root = makeFixture();
    removeDedupCoveredChildSymbols(root, [
      'queryScoringContext',
      'lowInformationNodePenalty',
      'explicitPathNativeCodeBlockNodes',
      'exactRelationEndpointCodeBlockNodes',
      'resolveNativeCodeBlockNode',
    ]);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing query/formatter de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('queryScoringContext');
    expect(result.stderr).toContain('lowInformationNodePenalty');
    expect(result.stderr).toContain('explicitPathNativeCodeBlockNodes');
    expect(result.stderr).toContain('exactRelationEndpointCodeBlockNodes');
    expect(result.stderr).toContain('resolveNativeCodeBlockNode');
  });

  it('fails when a query formatter arrow helper is not covered by the manifest', () => {
    const root = makeFixture();
    fs.appendFileSync(
      path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs'),
      'const scoreNativeProjectionArrowUnregistered = () => 0;\n',
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing query/formatter de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('scoreNativeProjectionArrowUnregistered');
  });

  it('fails when a context-pack source-ordering duplicate helper is not covered by the manifest', () => {
    const root = makeFixture();
    fs.appendFileSync(
      path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'),
      'function scoreContextPackSourceFile() {}\n',
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing context-pack source-ordering de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('scoreContextPackSourceFile');
  });

  it('fails when a context-pack Markdown relationship child helper is not covered by the manifest', () => {
    const root = makeFixture();
    fs.appendFileSync(
      path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'),
      'function buildContextPackRelationshipLinesUnregisteredHelper() {}\n',
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing context-pack source-ordering de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('buildContextPackRelationshipLinesUnregisteredHelper');
  });

  it('fails when context-pack summary and related ordering helpers are not covered by the manifest', () => {
    const root = makeFixture();
    removeDedupCoveredChildSymbols(root, [
      'summarizeContextPackSourceOrdering',
      'contextPackExploreQueryFor',
      'compareRelatedGraphNodeOrder',
    ]);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing context-pack source-ordering de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('summarizeContextPackSourceOrdering');
    expect(result.stderr).toContain('contextPackExploreQueryFor');
    expect(result.stderr).toContain('compareRelatedGraphNodeOrder');
  });

  it('fails when context-pack source visibility and relationship ordering helpers are not covered by the manifest', () => {
    const root = makeFixture();
    removeDedupCoveredChildSymbols(root, [
      'contextPackNodeMatchesQueryTerms',
      'isRenderableContextPackSourcePath',
      'queryMentionsCodegraphToolingSourcePollution',
      'queryExplicitlyRequestsContextPackSourcePath',
      'relationshipEdgeSourceOrder',
      'contextPackRelationshipNodeQueryScore',
      'contextPackRelationshipNodePenalty',
    ]);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing context-pack source-ordering de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('contextPackNodeMatchesQueryTerms');
    expect(result.stderr).toContain('isRenderableContextPackSourcePath');
    expect(result.stderr).toContain('queryMentionsCodegraphToolingSourcePollution');
    expect(result.stderr).toContain('queryExplicitlyRequestsContextPackSourcePath');
    expect(result.stderr).toContain('relationshipEdgeSourceOrder');
    expect(result.stderr).toContain('contextPackRelationshipNodeQueryScore');
    expect(result.stderr).toContain('contextPackRelationshipNodePenalty');
  });

  it('fails when context-pack query classification helpers are not covered by the manifest', () => {
    const root = makeFixture();
    removeDedupCoveredChildSymbols(root, [
      'summarizeContextPackQueryClassification',
      'classifyCodegraphDedupMaintenanceQuery',
      'queryMentionsCodegraphDedupMaintenance',
    ]);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing context-pack source-ordering de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('summarizeContextPackQueryClassification');
    expect(result.stderr).toContain('classifyCodegraphDedupMaintenanceQuery');
    expect(result.stderr).toContain('queryMentionsCodegraphDedupMaintenance');
  });

  it('fails when a context-pack source-ordering arrow helper is not covered by the manifest', () => {
    const root = makeFixture();
    fs.appendFileSync(
      path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'),
      'const contextPackSourceOrderingArrowUnregistered = () => 0;\n',
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing context-pack source-ordering de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('contextPackSourceOrderingArrowUnregistered');
  });

  it('fails when a context-pack diagnostic source-ordering helper is not covered by the manifest', () => {
    const root = makeFixture();
    fs.appendFileSync(
      path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'),
      'function contextPackDiagnosticUnregisteredSourceOrderingReason() {}\n',
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing context-pack source-ordering de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('contextPackDiagnosticUnregisteredSourceOrderingReason');
  });

  it('fails when a context-pack top-ranked decision diagnostic helper is not covered by the manifest', () => {
    const root = makeFixture();
    fs.appendFileSync(
      path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'),
      [
        'function summarizeContextPackTopRankedOverlayDecisionUnregistered() {}',
        'function contextPackTopRankedOverlayDecisionEntryUnregistered() {}',
        '',
      ].join('\n'),
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing context-pack source-ordering de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('summarizeContextPackTopRankedOverlayDecisionUnregistered');
    expect(result.stderr).toContain('contextPackTopRankedOverlayDecisionEntryUnregistered');
  });

  it('validates additional de-duplication manifest hotspots with the same lifecycle contract as required hotspots', () => {
    const root = makeFixture();
    const sourcePath = path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
    fs.appendFileSync(sourcePath, 'function extraNativeDelegationHotspot() {}\n');
    const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      hotspots: Array<Record<string, unknown>>;
    };
    manifest.hotspots.push({
      name: 'extraNativeDelegationHotspot()',
      sourcePath: 'scripts/query-codegraph-nanoflow-overlay.mjs',
      status: 'temporary-allowed',
      capabilityCategory: 'query/formatter duplicate hotspot',
      language: 'typescript',
      sourceSymbols: ['extraNativeDelegationHotspot'],
      coveredChildSymbols: [],
      nativeOwnedCapability: 'native CodeGraph owns generic query parsing, candidate ranking, formatter section order, callers/callees, impact, auto-sync, and indexing behavior',
      nanoFlowOwnedCapability: 'NanoFlow owns project-specific semantics and metadata.relation attachment',
      allowedRelations: ['metadata.relation'],
      forbiddenGenericBehavior: 'must not reimplement native auto-sync, indexing, generic search ranking, or callers/callees/impact',
      upstreamHookNeeded: 'upstream CodeGraph hook for relation filters and semantic boosts',
      removalCandidateWhen: 'upstream CodeGraph exposes relation-filtered query hooks',
      lastVerifiedGate: 'npm run codegraph:overlay:docs:validate',
      duplicateBoundaryRole: 'query-parsing',
      outputSurface: ['json'],
      extensionFieldPolicy: 'nanoflow-augmented',
    });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json hotspot extraNativeDelegationHotspot() missing required field delegatedUpstreamOwner');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json hotspot extraNativeDelegationHotspot() missing required field allowedPurpose');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json hotspot extraNativeDelegationHotspot() missing required field forbiddenScope');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json hotspot extraNativeDelegationHotspot() missing required field removalTrigger');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json hotspot extraNativeDelegationHotspot() missing required field verificationGate');
  });

  it('fails when strict native source evidence quality rules are not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/.*strict native source evidence contract.*\n?/g, ''),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing strict native source evidence contract');
    expect(result.stderr).toContain('AGENTS.md missing strict native source evidence contract');
  });

  it('fails when relation-specific strict native source evidence rules are not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/host-attribute/g, 'host_attr')
          .replace(/edge-function-header/g, 'edge_function_header')
          .replace(/template-url/g, 'template_url')
          .replace(/supabase-realtime-remove-channel/g, 'realtime_remove_channel'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing strict native source evidence contract');
    expect(result.stderr).toContain('host-attribute');
    expect(result.stderr).toContain('edge-function-header');
    expect(result.stderr).toContain('template-url');
    expect(result.stderr).toContain('supabase-realtime-remove-channel');
    expect(result.stderr).toContain('AGENTS.md missing strict native source evidence contract');
  });

  it('fails when strict native output order contracts are not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/strict native output order/g, 'strict-native-output-order')
          .replace(/query\/summary\/entryPoints\/nodes\/edges\/codeBlocks\/relatedFiles\/stats/g, 'native-json-field-list')
          .replace(/Code Context -> Entry Points -> Relationships -> Related Symbols -> Code/g, 'native-markdown-section-list'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing strict native output order contract');
    expect(result.stderr).toContain('query/summary/entryPoints/nodes/edges/codeBlocks/relatedFiles/stats');
    expect(result.stderr).toContain('Code Context -> Entry Points -> Relationships -> Related Symbols -> Code');
    expect(result.stderr).toContain('AGENTS.md missing strict native output order contract');
  });

  it('fails when strict native object projection contracts are not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/strict native object projection/g, 'strict-native-object-projection')
          .replace(/id\/kind\/name\/qualifiedName\/filePath\/language\/startLine\/endLine\/signature\/docstring\/visibility\/isExported\/isAsync\/isStatic\/isAbstract/g, 'native-node-field-list')
          .replace(/source\/target\/kind\/line\/column/g, 'native-edge-field-list')
          .replace(/filePath\/startLine\/endLine\/language\/content\/nodeName\/nodeKind/g, 'native-codeblock-field-list')
          .replace(/metadata\/provenance\/sourceName\/targetName/g, 'native-extension-field-list'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing strict native object projection contract');
    expect(result.stderr).toContain('id/kind/name/qualifiedName/filePath/language/startLine/endLine/signature/docstring/visibility/isExported/isAsync/isStatic/isAbstract');
    expect(result.stderr).toContain('source/target/kind/line/column');
    expect(result.stderr).toContain('filePath/startLine/endLine/language/content/nodeName/nodeKind');
    expect(result.stderr).toContain('metadata/provenance/sourceName/targetName');
    expect(result.stderr).toContain('AGENTS.md missing strict native object projection contract');
  });

  it('fails when the adapter gate infrastructure self-test step is not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8').replace(/codegraph:adapter:infra:test/g, 'codegraph-adapter-infra-test'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing adapter gate contract');
    expect(result.stderr).toContain('codegraph:adapter:infra:test');
    expect(result.stderr).toContain('AGENTS.md missing adapter gate contract');
  });

  it('fails when the adapter gate fresh wrapper log contract is not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/codegraph-adapter-gate-mcp-wrapper\.log/g, 'codegraph-adapter-gate-wrapper-log')
          .replace(/--fail-on-stale-current-wrapper/g, '--fail-on-stale-wrapper'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing adapter gate contract');
    expect(result.stderr).toContain('codegraph-adapter-gate-mcp-wrapper.log');
    expect(result.stderr).toContain('--fail-on-stale-current-wrapper');
    expect(result.stderr).toContain('AGENTS.md missing adapter gate contract');
  });

  it('fails when single shared tree freshness and multi-agent conflict handling is not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/single shared tree/g, 'single-shared-tree')
          .replace(/freshness and multi-agent conflict handling/g, 'freshness-and-multi-agent-conflict-handling')
          .replace(/pending index sync/g, 'pending-index-sync')
          .replace(/latest changed files/g, 'latest-changed-files')
          .replace(/git status --short/g, 'git-status-short')
          .replace(/git diff --name-only/g, 'git-diff-name-only')
          .replace(/claim file set/g, 'claim-file-set')
          .replace(/file lease/g, 'file-lease')
          .replace(/skipRefresh=true/g, 'skipRefresh=false')
          .replace(/NANOFLOW_OVERLAY_SKIP_REFRESH=1/g, 'NANOFLOW_OVERLAY_SKIP_REFRESH=0'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing single shared tree freshness contract');
    expect(result.stderr).toContain('single shared tree');
    expect(result.stderr).toContain('freshness and multi-agent conflict handling');
    expect(result.stderr).toContain('pending index sync');
    expect(result.stderr).toContain('latest changed files');
    expect(result.stderr).toContain('git status --short');
    expect(result.stderr).toContain('git diff --name-only');
    expect(result.stderr).toContain('claim file set');
    expect(result.stderr).toContain('file lease');
    expect(result.stderr).toContain('skipRefresh=true');
    expect(result.stderr).toContain('NANOFLOW_OVERLAY_SKIP_REFRESH=1');
    expect(result.stderr).toContain('AGENTS.md missing single shared tree freshness contract');
  });

  registerValidateCodegraphOverlayDocsTailSpecs();
  registerValidateCodegraphOverlayDocsDriftCountSpecs();

});
