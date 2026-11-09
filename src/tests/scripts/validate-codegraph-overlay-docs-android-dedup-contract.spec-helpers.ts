import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { makeFixture, runValidator } from './validate-codegraph-overlay-docs.spec-helpers';

const ANDROID_DEDUP_COVERAGE_PREFIX =
  'docs/codegraph-nanoflow-dedup-contract.json missing Android/Kotlin de-duplication sourceSymbols or coveredChildSymbols';

const ANDROID_DEDUP_OWNERSHIP_CASES = [
  ['collectAndroid()', 'readAndroidKotlinFunctions'],
  ['readAndroidKotlinFileSymbols()', 'readAndroidKotlinCallableOwnerClasses'],
  ['readAndroidKotlinFileSymbols()', 'readAndroidKotlinClassTypeParametersEnd'],
  ['readAndroidKotlinFileSymbols()', 'readAndroidKotlinFunctionsFromNativeEndpoints'],
] as const;

type RemoveDedupCoveredChildSymbols = (
  root: string,
  symbols: string[],
  owner: string,
) => void;

function addDedupCoveredChildSymbol(root: string, owner: string, symbol: string): void {
  const manifestPath = path.join(root, 'docs', 'codegraph-nanoflow-dedup-contract.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    hotspots: Array<{
      name: string;
      coveredChildSymbols?: string[];
    }>;
  };
  const hotspot = manifest.hotspots.find(entry => entry.name === owner);
  if (!hotspot) throw new Error(`fixture missing de-duplication hotspot ${owner}`);
  hotspot.coveredChildSymbols = [...(hotspot.coveredChildSymbols ?? []), symbol];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function androidCoverageDiagnostics(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .filter(line => line.startsWith(`- ${ANDROID_DEDUP_COVERAGE_PREFIX}:`));
}

export function registerValidateCodegraphOverlayDocsAndroidDedupContractSpecs(
  removeDedupCoveredChildSymbols: RemoveDedupCoveredChildSymbols,
): void {
  it('fails when an Android/Kotlin de-duplication helper is not covered by the manifest', () => {
    const root = makeFixture();
    fs.appendFileSync(
      path.join(root, 'scripts', 'generate-codegraph-nanoflow-overlay.mjs'),
      'function readAndroidKotlinUnregisteredHelper() {}\n',
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ANDROID_DEDUP_COVERAGE_PREFIX);
    expect(result.stderr).toContain('readAndroidKotlinUnregisteredHelper');
  });

  it('removes an Android/Kotlin child only from its declared owner', () => {
    const root = makeFixture();
    const owner = 'collectAndroid()';
    const wrongOwner = 'readAndroidKotlinFileSymbols()';
    const symbol = 'readAndroidKotlinFunctions';
    addDedupCoveredChildSymbol(root, wrongOwner, symbol);

    removeDedupCoveredChildSymbols(root, [symbol], owner);
    const result = runValidator(root);

    expect(result.status, result.stderr).toBe(0);
    expect(androidCoverageDiagnostics(result.stderr)).toEqual([]);
  });

  it.each(ANDROID_DEDUP_OWNERSHIP_CASES)(
    'fails when %s omits covered child %s',
    (owner, removedHelper) => {
      const root = makeFixture();
      removeDedupCoveredChildSymbols(root, [removedHelper], owner);

      const result = runValidator(root);

      expect(result.status).toBe(1);
      expect(androidCoverageDiagnostics(result.stderr)).toEqual([
        `- ${ANDROID_DEDUP_COVERAGE_PREFIX}: ${removedHelper}`,
      ]);
    },
  );
}
