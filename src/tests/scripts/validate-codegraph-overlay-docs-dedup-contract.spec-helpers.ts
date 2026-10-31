import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { registerValidateCodegraphOverlayDocsAndroidDedupContractSpecs } from './validate-codegraph-overlay-docs-android-dedup-contract.spec-helpers';
import { registerValidateCodegraphOverlayDocsContextPackDedupContractSpecs } from './validate-codegraph-overlay-docs-context-pack-dedup-contract.spec-helpers';
import { registerValidateCodegraphOverlayDocsFormatterDelegationSpecs } from './validate-codegraph-overlay-docs-formatter-delegation.spec-helpers';
import { registerValidateCodegraphOverlayDocsTypeScriptDedupContractSpecs } from './validate-codegraph-overlay-docs-typescript-dedup-contract.spec-helpers';
import { makeFixture, runValidator } from './validate-codegraph-overlay-docs.spec-helpers';

function removeDedupCoveredChildSymbols(root: string, symbols: string[], owner?: string): void {
  const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    hotspots: Array<{
      coveredChildSymbols?: string[];
    }>;
  };
  const toRemove = new Set(symbols);
  for (const hotspot of manifest.hotspots) {
    if (owner !== undefined && (hotspot as { name?: string }).name !== owner) continue;
    hotspot.coveredChildSymbols = (hotspot.coveredChildSymbols ?? [])
      .filter(symbol => !toRemove.has(symbol));
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}
function addStrictNativeJsonFormatterFixture(root: string): void {
  fs.appendFileSync(path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs'), 'function toNativeJsonFormatterResponse() {}\nfunction serializeNativeJsonNode() {}\nfunction serializeNativeJsonEdge() {}\nfunction nativeJsonEdgeLine() {}\nfunction nativeJsonEdgeColumn() {}\nfunction serializeNativeJsonCodeBlock() {}\n');
  const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { hotspots: Array<Record<string, unknown>> };
  const template = manifest.hotspots.find(entry => entry.name === 'formatStrictNativeMarkdown()');
  if (!template) throw new Error('fixture missing strict native Markdown formatter hotspot');
  manifest.hotspots.push({ ...template, name: 'toNativeJsonFormatterResponse()', sourcePath: 'scripts/query-codegraph-nanoflow-overlay.mjs',
    allowedPurpose: 'attach NanoFlow metadata.relation source evidence to the strict native JSON projection while preserving upstream field names and stripping extension fields',
    language: 'overlay-json', sourceSymbols: ['toNativeJsonFormatterResponse'],
    coveredChildSymbols: ['serializeNativeJsonNode', 'serializeNativeJsonEdge', 'nativeJsonEdgeLine', 'nativeJsonEdgeColumn', 'serializeNativeJsonCodeBlock'],
    duplicateBoundaryRole: 'native-json-formatter', outputSurface: ['nativeJson'],
  });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}
export function registerValidateCodegraphOverlayDocsDedupContractSpecs(): void {
  registerValidateCodegraphOverlayDocsAndroidDedupContractSpecs(removeDedupCoveredChildSymbols);
  registerValidateCodegraphOverlayDocsContextPackDedupContractSpecs(removeDedupCoveredChildSymbols);
  registerValidateCodegraphOverlayDocsFormatterDelegationSpecs();
  registerValidateCodegraphOverlayDocsTypeScriptDedupContractSpecs(removeDedupCoveredChildSymbols);

  it('fails when upstream versioning and de-duplication boundaries are not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/upstream CodeGraph fixed version/g, 'upstream-codegraph-fixed-version')
          .replace(/@colbymchenry\/codegraph@1\.5\.0/g, '@colbymchenry/codegraph@1.1.1')
          .replace(/--codegraph-target @colbymchenry\/codegraph@<new-version>/g, '--codegraph-target @colbymchenry/codegraph@latest')
          .replace(/delegates generic TypeScript symbol\/import\/export\/call\/impact/g, 'duplicates generic TypeScript graph extraction')
          .replace(/must not reimplement native auto-sync, indexing, generic search ranking, or callers\/callees\/impact/g, 'may replace native indexing and search')
          .replace(/NanoFlow overlay owns only project-specific semantics, output-quality policy, Codex host reliability, and repository hard-rule anchors/g, 'NanoFlow overlay owns all CodeGraph behavior'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing upstream CodeGraph boundary contract');
    expect(result.stderr).toContain('@colbymchenry/codegraph@1.5.0');
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

  it('fails when a malformed required duplicate partitions covered children before the valid entry', () => {
    const root = makeFixture();
    const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      hotspots: Array<{
        name: string;
        sourcePath: string;
        coveredChildSymbols?: string[];
      }>;
    };
    const validIndex = manifest.hotspots.findIndex(entry => entry.name === 'collectTypeScript()');
    const validEntry = manifest.hotspots[validIndex];
    const partitionedChild = 'readTypeScriptStandardLibraryReferences';
    validEntry.coveredChildSymbols = validEntry.coveredChildSymbols
      ?.filter(symbol => symbol !== partitionedChild);
    manifest.hotspots.splice(validIndex, 0, {
      name: validEntry.name,
      sourcePath: validEntry.sourcePath,
      coveredChildSymbols: [partitionedChild],
    });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json duplicate hotspot name collectTypeScript()',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot collectTypeScript() missing required field status',
    );
  });

  it('sorts duplicate hotspot diagnostics before coverage diagnostics', () => {
    const root = makeFixture();
    const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      hotspots: Array<Record<string, unknown> & { name: string }>;
    };
    const duplicateNames = ['collectTypeScript()', 'buildNativeGraph()'];
    for (const name of duplicateNames) {
      const entry = manifest.hotspots.find(candidate => candidate.name === name);
      if (!entry) throw new Error(`fixture missing de-duplication hotspot ${name}`);
      manifest.hotspots.push({ ...entry });
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.appendFileSync(
      path.join(root, 'scripts', 'generate-codegraph-nanoflow-overlay.mjs'),
      'function readImportDuplicateOrderingCoverageGap() {}\n',
    );

    const result = runValidator(root);
    const diagnostics = result.stderr.split(/\r?\n/).filter(Boolean);
    const duplicateDiagnostics = diagnostics.filter(line => line.includes('duplicate hotspot name'));
    const expectedDuplicates = ['buildNativeGraph()', 'collectTypeScript()']
      .map(name => `- docs/codegraph-nanoflow-dedup-contract.json duplicate hotspot name ${name}`);

    expect(result.status).toBe(1);
    expect(duplicateDiagnostics).toEqual(expectedDuplicates);
    expect(diagnostics.indexOf(expectedDuplicates[1])).toBeLessThan(
      diagnostics.findIndex(line => line.includes('missing TypeScript de-duplication')),
    );
  });

  it('allows distinct de-duplication hotspot names to share a source path', () => {
    expect(runValidator(makeFixture()).status).toBe(0);
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

  it('requires a dedicated strict native JSON formatter boundary', () => {
    const root = makeFixture();
    addStrictNativeJsonFormatterFixture(root);
    const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      hotspots: Array<Record<string, unknown>>;
    };
    manifest.hotspots = manifest.hotspots.filter(
      entry => entry.name !== 'toNativeJsonFormatterResponse()',
    );
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json missing de-duplication hotspot toNativeJsonFormatterResponse()',
    );
  });

  it('fails when strict native JSON helpers are absorbed by the Markdown formatter boundary', () => {
    const root = makeFixture();
    addStrictNativeJsonFormatterFixture(root);
    const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      hotspots: Array<Record<string, unknown> & {
        coveredChildSymbols?: string[];
      }>;
    };
    const nativeJsonFormatter = manifest.hotspots.find(
      entry => entry.name === 'toNativeJsonFormatterResponse()',
    );
    const strictMarkdownFormatter = manifest.hotspots.find(
      entry => entry.name === 'formatStrictNativeMarkdown()',
    );
    if (!nativeJsonFormatter || !strictMarkdownFormatter) {
      throw new Error('fixture missing strict native JSON/Markdown formatter hotspots');
    }
    nativeJsonFormatter.duplicateBoundaryRole = 'native-markdown-formatter';
    nativeJsonFormatter.outputSurface = ['nativeMarkdown'];
    strictMarkdownFormatter.coveredChildSymbols = [
      ...(strictMarkdownFormatter.coveredChildSymbols ?? []),
      'toNativeJsonFormatterResponse',
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot toNativeJsonFormatterResponse() strict-native nativeJson hotspot must use duplicateBoundaryRole native-json-formatter',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot toNativeJsonFormatterResponse() strict-native nativeJson outputSurface must include only nativeJson',
    );
    expect(result.stderr).toContain(
      'docs/codegraph-nanoflow-dedup-contract.json hotspot formatStrictNativeMarkdown() strict-native nativeMarkdown formatter must not include native JSON helper toNativeJsonFormatterResponse',
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

  it('fails when context-pack output shaping helpers are not covered by the manifest', () => {
    const root = makeFixture();
    fs.appendFileSync(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'), 'function insertContextPackSectionContent() {}\nfunction insertContextPackRelationshipContent() {}\nfunction limitContextPackOverlayEvidence() {}\nfunction limitContextPackMarkdownSourceFiles() {}\nfunction isPureNoHitContextPack() {}\nfunction isWeakExplicitNoHitContextPack() {}\nfunction classifyContextPackBaseMarkdownHeading() {}\n');
    removeDedupCoveredChildSymbols(root, [
      'insertContextPackSectionContent',
      'insertContextPackRelationshipContent',
      'limitContextPackOverlayEvidence',
      'limitContextPackMarkdownSourceFiles',
      'isPureNoHitContextPack',
      'isWeakExplicitNoHitContextPack',
      'classifyContextPackBaseMarkdownHeading',
    ]);
    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing context-pack source-ordering de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('insertContextPackSectionContent');
    expect(result.stderr).toContain('insertContextPackRelationshipContent');
    expect(result.stderr).toContain('limitContextPackOverlayEvidence');
    expect(result.stderr).toContain('limitContextPackMarkdownSourceFiles');
    expect(result.stderr).toContain('isPureNoHitContextPack');
    expect(result.stderr).toContain('isWeakExplicitNoHitContextPack');
    expect(result.stderr).toContain('classifyContextPackBaseMarkdownHeading');
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
}
