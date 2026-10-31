import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { makeFixture, runValidator } from './validate-codegraph-overlay-docs.spec-helpers';

const OWNER = 'contextPackSourceRankingQueryFor()';
const SANITIZER = 'sanitizeContextPackBaseMarkdownSections()';
const SOURCE_PATH = 'scripts/codegraph-nanoflow-mcp-stdio.cjs';
const REQUIRED_CHILDREN = ['queryTokens', 'localizedContextPackQueryAliases'] as const;
const OWNER_ALIASES = ['contextPackSourceRankingQueryFor', ' contextPackSourceRankingQueryFor() '] as const;

type RemoveDedupCoveredChildSymbols = (
  root: string,
  symbols: string[],
  owner?: string,
) => void;

type ManifestHotspot = Record<string, unknown> & {
  name: string;
  sourceSymbols?: string[];
  coveredChildSymbols?: string[];
};

type ManifestField = 'name' | 'sourceSymbols' | 'coveredChildSymbols';

function editManifest(root: string, edit: (hotspots: ManifestHotspot[]) => void): void {
  const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    hotspots: ManifestHotspot[];
  };
  edit(manifest.hotspots);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function addOccurrence(root: string, ownerName: string, symbol: string, field: ManifestField): void {
  editManifest(root, hotspots => {
    const owner = hotspots.find(entry => entry.name === ownerName);
    if (!owner) throw new Error(`fixture missing de-duplication hotspot ${ownerName}`);
    if (field === 'name') {
      hotspots.push({ ...owner, name: symbol, coveredChildSymbols: [] });
      return;
    }
    owner[field] = [...(owner[field] ?? []), symbol];
  });
}

function addOwnerAlias(root: string, alias: string, symbol: string): void {
  editManifest(root, hotspots => {
    const owner = hotspots.find(entry => entry.name === OWNER);
    if (!owner) throw new Error(`fixture missing de-duplication hotspot ${OWNER}`);
    hotspots.push({ ...owner, name: alias, coveredChildSymbols: [symbol] });
  });
}

function ownerDiagnostic(symbol: string, ownerCount: number, totalCount: number): string {
  return `required context-pack covered child ${symbol} must occur exactly once in ${OWNER}.coveredChildSymbols for ${SOURCE_PATH} and nowhere else in that sourcePath (owner=${ownerCount}, total=${totalCount})`;
}

export function registerValidateCodegraphOverlayDocsContextPackDedupContractSpecs(
  removeDedupCoveredChildSymbols: RemoveDedupCoveredChildSymbols,
): void {
  it('fails when context-pack query tokenization helpers are not covered by the manifest', () => {
    const root = makeFixture();
    removeDedupCoveredChildSymbols(root, [...REQUIRED_CHILDREN]);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing context-pack source-ordering de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('queryTokens');
    expect(result.stderr).toContain('localizedContextPackQueryAliases');
  });

  it.each(REQUIRED_CHILDREN)('fails when %s moves to the sanitizer hotspot', symbol => {
    const root = makeFixture();
    removeDedupCoveredChildSymbols(root, [symbol], OWNER);
    addOccurrence(root, SANITIZER, symbol, 'coveredChildSymbols');

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ownerDiagnostic(symbol, 0, 1));
  });

  it.each(REQUIRED_CHILDREN)('fails when %s is duplicated under the sanitizer hotspot', symbol => {
    const root = makeFixture();
    addOccurrence(root, SANITIZER, symbol, 'coveredChildSymbols');

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ownerDiagnostic(symbol, 1, 2));
  });

  it.each(REQUIRED_CHILDREN)('fails when %s is duplicated within its exact owner', symbol => {
    const root = makeFixture();
    addOccurrence(root, OWNER, symbol, 'coveredChildSymbols');

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ownerDiagnostic(symbol, 2, 2));
  });

  it.each(REQUIRED_CHILDREN.flatMap(symbol => OWNER_ALIASES.map(alias => [symbol, alias] as const)))(
    'fails when %s moves to context-pack owner alias %s',
    (symbol, alias) => {
      const root = makeFixture();
      removeDedupCoveredChildSymbols(root, [symbol], OWNER);
      addOwnerAlias(root, alias, symbol);

      const result = runValidator(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(ownerDiagnostic(symbol, 0, 1));
    },
  );

  it.each([
    [REQUIRED_CHILDREN[0], 'sourceSymbols'],
    [REQUIRED_CHILDREN[1], 'name'],
  ] as const)('fails when %s is duplicated through %s', (symbol, field) => {
    const root = makeFixture();
    addOccurrence(root, SANITIZER, symbol, field);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ownerDiagnostic(symbol, 1, 2));
  });

  it('accepts exact wrapper ownership and the same-name queryTokens in the overlay-query source', () => {
    const root = makeFixture();
    fs.appendFileSync(path.join(root, 'scripts', 'query-codegraph-nanoflow-overlay.mjs'), 'function queryTokens() {}\n');
    addOccurrence(root, 'queryOverlay()', 'queryTokens', 'coveredChildSymbols');
    expect(runValidator(root).status).toBe(0);
  });
}
