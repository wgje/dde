import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { makeFixture, runValidator } from './validate-codegraph-overlay-docs.spec-helpers';

const TYPESCRIPT_OWNER = 'collectTypeScript()';
const WRONG_OWNER = 'buildNativeGraph()';
const REQUIRED_CHILDREN = [
  'readTypeScriptStandardLibraryReferences',
  'collectTypeScriptStandardLibraryDeclarations',
] as const;
const OWNER_ALIAS_CASES = REQUIRED_CHILDREN.flatMap(symbol => [
  [symbol, 'collectTypeScript'],
  [symbol, ' collectTypeScript() '],
] as const);

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

function addRawOccurrence(
  root: string,
  owner: string,
  symbol: string,
  field: 'name' | 'sourceSymbols' | 'coveredChildSymbols',
): void {
  const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    hotspots: ManifestHotspot[];
  };
  const hotspot = manifest.hotspots.find(entry => entry.name === owner);
  if (!hotspot) throw new Error(`fixture missing de-duplication hotspot ${owner}`);
  if (field === 'name') {
    manifest.hotspots.push({
      ...hotspot,
      name: symbol,
      sourceSymbols: [],
      coveredChildSymbols: [],
    });
  } else {
    hotspot[field] = [...(hotspot[field] ?? []), symbol];
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function ownerDiagnostic(symbol: string, ownerCount: number, totalCount: number): string {
  return `required TypeScript covered child ${symbol} must occur exactly once in ${TYPESCRIPT_OWNER}.coveredChildSymbols and nowhere else (owner=${ownerCount}, total=${totalCount})`;
}

function addOwnerAliasOccurrence(root: string, alias: string, symbol: string): void {
  const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    hotspots: ManifestHotspot[];
  };
  const owner = manifest.hotspots.find(entry => entry.name === TYPESCRIPT_OWNER);
  if (!owner) throw new Error(`fixture missing de-duplication hotspot ${TYPESCRIPT_OWNER}`);
  manifest.hotspots.push({ ...owner, name: alias, coveredChildSymbols: [symbol] });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

export function registerValidateCodegraphOverlayDocsTypeScriptDedupContractSpecs(
  removeDedupCoveredChildSymbols: RemoveDedupCoveredChildSymbols,
): void {
  it('fails when TypeScript standard-library suppression helpers are not covered by the manifest', () => {
    const root = makeFixture();
    removeDedupCoveredChildSymbols(root, [
      'readTypeScriptStandardLibraryReferences',
      'collectTypeScriptStandardLibraryDeclarations',
    ]);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-dedup-contract.json missing TypeScript de-duplication sourceSymbols or coveredChildSymbols');
    expect(result.stderr).toContain('readTypeScriptStandardLibraryReferences');
    expect(result.stderr).toContain('collectTypeScriptStandardLibraryDeclarations');
  });

  it.each(REQUIRED_CHILDREN)('fails when %s moves to another TypeScript hotspot', symbol => {
    const root = makeFixture();
    removeDedupCoveredChildSymbols(root, [symbol], TYPESCRIPT_OWNER);
    addRawOccurrence(root, WRONG_OWNER, symbol, 'coveredChildSymbols');

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ownerDiagnostic(symbol, 0, 1));
  });

  it.each([
    [REQUIRED_CHILDREN[0], 'sourceSymbols'],
    [REQUIRED_CHILDREN[1], 'name'],
  ] as const)('fails when %s is duplicated outside its TypeScript owner through %s', (symbol, field) => {
    const root = makeFixture();
    addRawOccurrence(root, WRONG_OWNER, symbol, field);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ownerDiagnostic(symbol, 1, 2));
  });

  it('fails when a required TypeScript child is duplicated within its owner', () => {
    const root = makeFixture();
    const symbol = REQUIRED_CHILDREN[0];
    addRawOccurrence(root, TYPESCRIPT_OWNER, symbol, 'coveredChildSymbols');

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ownerDiagnostic(symbol, 2, 2));
  });

  it.each(OWNER_ALIAS_CASES)('fails when %s moves to TypeScript owner alias %s', (symbol, alias) => {
    const root = makeFixture();
    removeDedupCoveredChildSymbols(root, [symbol], TYPESCRIPT_OWNER);
    addOwnerAliasOccurrence(root, alias, symbol);

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ownerDiagnostic(symbol, 0, 1));
  });

  it('accepts the exact TypeScript owner identity', () => {
    expect(runValidator(makeFixture()).status).toBe(0);
  });
}
