import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sourcePolicy = require('../../../scripts/lib/codegraph-source-policy.cjs') as {
  SOURCE_POLICY_VERSION: number;
  SOURCE_POLICY_DEFINITION: {
    schemaVersion: number;
    version: number;
    excludedDirectories: readonly string[];
    artifactSuffixes: readonly string[];
    packagedPatterns: readonly string[];
    sourceFamilies: readonly string[];
  };
  SOURCE_POLICY_DIGEST: string;
  SOURCE_POLICY_V2_VERSION: number;
  classifySourcePath(relativePath: string): string | null;
  classifySourcePolicyV2Path(relativePath: string): { class: string; role: string } | null;
  deriveExact15PathSet(): { rows: Array<{ row: string }>; digest: string };
  validateExact15NMinusOneWitness(witness: unknown): boolean;
  fieldV3Digest(fields: Array<[string, Buffer | string]>): string;
  assertNoWindowsCaseCollisions(relativePaths: string[]): void;
  buildSourceManifest(projectRoot: string): {
    schemaVersion: number;
    sourcePolicyVersion: number;
    sourcePolicyDigest: string;
    sourceManifestDigest: string;
    metadataDigest: string;
    contentDigest: string;
    inputDigest: string;
    entries: Array<{
      path: string;
      role: string;
      size: number;
      mtimeNs: string;
      ctimeNs: string;
      sha256: string;
      inputSha256: string;
    }>;
  };
};

const SOURCE_POLICY_V1_DIGEST =
  'ca78ea5e17d32399faac676bcab26fc1d7f48186a89792774d37a6b8549d0ca3';

const tempRoots: string[] = [];

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function expectedDigest(label: string, entries: unknown[]): string {
  return crypto.createHash('sha256').update(canonicalJson({
    schemaVersion: 1,
    sourcePolicyVersion: 1,
    sourcePolicyDigest: SOURCE_POLICY_V1_DIGEST,
    label,
    entries,
  })).digest('hex');
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-source-policy-'));
  tempRoots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('NanoFlow SourcePolicy v1', () => {
  it('pins the complete immutable v1 definition and digest', () => {
    expect(sourcePolicy.SOURCE_POLICY_DEFINITION).toEqual({
      schemaVersion: 1,
      version: 1,
      excludedDirectories: [
        '.angular', '.cache', '.codegraph', '.feedback_images', '.git', '.gradle',
        '.next', '.nuxt', '.tmp', '.turbo', '.worktrees', 'build', 'cache',
        'coverage', 'dist', 'dist-ssr', 'logs', 'node_modules', 'out',
        'playwright-report', 'temp', 'test-results', 'tmp',
      ],
      artifactSuffixes: ['.bak', '.log', '.map', '.swp', '.temp', '.tmp', '.tsbuildinfo'],
      packagedPatterns: ['*.min.js', '*.min.css'],
      sourceFamilies: [
        'typescript', 'javascript', 'angular-template', 'angular-style', 'sql',
        'supabase', 'android-kotlin', 'android-xml', 'agent-instructions',
        'context7-contract', 'codegraph-contract', 'toolchain-contract',
      ],
    });
    expect(sourcePolicy.SOURCE_POLICY_DIGEST).toBe(SOURCE_POLICY_V1_DIGEST);
    expect(Object.isFrozen(sourcePolicy.SOURCE_POLICY_DEFINITION)).toBe(true);
    for (const value of Object.values(sourcePolicy.SOURCE_POLICY_DEFINITION)) {
      if (Array.isArray(value)) expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it('derives packaged-artifact filtering from the digested definition', () => {
    const policySource = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'lib', 'codegraph-source-policy.cjs'),
      'utf8',
    );
    const body = policySource.match(
      /function isPackagedOrTemporaryArtifact\(fileName\) \{([\s\S]*?)\n\}/,
    )?.[1] ?? '';

    expect(body).toContain('SOURCE_POLICY_DEFINITION.packagedPatterns');
    expect(body).not.toContain("lower.endsWith('.min.js')");
    expect(body).not.toContain("lower.endsWith('.min.css')");
  });

  it('does not globally rerank native graph nodes or edges in the overlay query adapter', () => {
    const querySource = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'query-codegraph-nanoflow-overlay.mjs'),
      'utf8',
    );

    expect(querySource).not.toMatch(/\brankNodesForQuery\s*\(/);
    expect(querySource).not.toMatch(/\brankGraphEdgesForQuery\s*\(/);
  });

  it('discovers generic node and edge rank helpers as de-duplication hotspots', () => {
    const validatorSource = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'validate-codegraph-overlay-docs.cjs'),
      'utf8',
    );
    const discoveryPatternSource = validatorSource.match(
      /const DEDUP_CONTRACT_QUERY_FORMATTER_DISCOVERY_PATTERN\s*=\s*([\s\S]*?);/,
    )?.[1] ?? '';

    expect(discoveryPatternSource).toContain('rankNodesForQuery');
    expect(discoveryPatternSource).toContain('rankGraphEdgesForQuery');
  });

  it('classifies every required source family through one versioned policy', () => {
    expect(sourcePolicy.SOURCE_POLICY_VERSION).toBe(1);
    expect(sourcePolicy.SOURCE_POLICY_DIGEST).toMatch(/^[a-f0-9]{64}$/);

    expect([
      'src/app/sample.ts',
      'src/app/sample.tsx',
      'src/app/sample.js',
      'src/app/sample.component.html',
      'src/app/sample.component.scss',
      'supabase/migrations/20260731000000_sample.sql',
      'supabase/functions/sample/index.ts',
      'android/app/src/main/java/app/nanoflow/Sample.kt',
      'android/app/src/main/AndroidManifest.xml',
      'features/nested/AGENTS.md',
      'docs/codegraph-nanoflow-dedup-contract.json',
      'scripts/context7-key-pool.cjs',
      '.codex/config.toml',
      'package.json',
      'package-lock.json',
    ].map(file => [file, sourcePolicy.classifySourcePath(file)])).toEqual([
      ['src/app/sample.ts', 'typescript'],
      ['src/app/sample.tsx', 'typescript'],
      ['src/app/sample.js', 'javascript'],
      ['src/app/sample.component.html', 'angular-template'],
      ['src/app/sample.component.scss', 'angular-style'],
      ['supabase/migrations/20260731000000_sample.sql', 'supabase-sql'],
      ['supabase/functions/sample/index.ts', 'supabase-edge-function'],
      ['android/app/src/main/java/app/nanoflow/Sample.kt', 'android-kotlin'],
      ['android/app/src/main/AndroidManifest.xml', 'android-xml'],
      ['features/nested/AGENTS.md', 'agent-instructions'],
      ['docs/codegraph-nanoflow-dedup-contract.json', 'codegraph-contract'],
      ['scripts/context7-key-pool.cjs', 'context7-contract'],
      ['.codex/config.toml', 'codegraph-config'],
      ['package.json', 'toolchain-contract'],
      ['package-lock.json', 'toolchain-contract'],
    ]);
  });

  it('excludes generated, cache, log, temporary, and packaged artifacts', () => {
    for (const file of [
      '.feedback_images/a.ts',
      '.gradle/cache/sample.kt',
      '.codegraph/nanoflow-overlay.json',
      '.worktrees/other/src/app/sample.ts',
      'dist/app/main.js',
      'build/app/main.js',
      'coverage/src/app/sample.ts.html',
      'node_modules/pkg/index.js',
      'tmp/sample.ts',
      'logs/nanoflow.log',
      'src/app/main.min.js',
      'src/app/main.js.map',
      'src/app/sample.tsbuildinfo',
    ]) {
      expect(sourcePolicy.classifySourcePath(file), file).toBeNull();
    }
  });

  it('rejects Windows ordinal-ignore-case path collisions', () => {
    expect(() => sourcePolicy.assertNoWindowsCaseCollisions([
      'src/app/Foo.ts',
      'src/app/foo.ts',
    ])).toThrow(/source-policy-path-case-collision.*Foo\.ts.*foo\.ts/i);
  });

  it('builds an ordinal manifest with nanosecond metadata and content digests', () => {
    const root = makeRoot();
    const firstPath = writeFile(root, 'src/app/z-last.ts', 'export const value = 1;\n');
    const preservedTime = new Date('2026-07-31T00:00:00.000Z');
    fs.utimesSync(firstPath, preservedTime, preservedTime);
    writeFile(root, 'android/app/src/main/java/app/nanoflow/A.kt', 'class A\n');
    writeFile(root, 'nested/AGENTS.md', '# Rules\n');
    writeFile(root, '.codegraph/ignored.ts', 'export const ignored = true;\n');

    const manifest = sourcePolicy.buildSourceManifest(root);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      sourcePolicyVersion: 1,
      sourcePolicyDigest: sourcePolicy.SOURCE_POLICY_DIGEST,
    });
    expect(manifest.entries.map(entry => entry.path)).toEqual([
      'android/app/src/main/java/app/nanoflow/A.kt',
      'nested/AGENTS.md',
      'src/app/z-last.ts',
    ]);
    for (const entry of manifest.entries) {
      expect(entry.path).not.toContain('\\');
      expect(entry.size).toBeGreaterThan(0);
      expect(entry.mtimeNs).toMatch(/^\d+$/);
      expect(entry.ctimeNs).toMatch(/^\d+$/);
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.inputSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    for (const digest of [
      manifest.sourceManifestDigest,
      manifest.metadataDigest,
      manifest.contentDigest,
      manifest.inputDigest,
    ]) expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.metadataDigest).toBe(expectedDigest('metadata', manifest.entries.map(({
      path: sourcePath, role, size, mtimeNs, ctimeNs,
    }) => ({ path: sourcePath, role, size, mtimeNs, ctimeNs }))));
    expect(manifest.contentDigest).toBe(expectedDigest('content', manifest.entries.map(({
      path: sourcePath, sha256,
    }) => ({ path: sourcePath, sha256 }))));
    expect(manifest.inputDigest).toBe(expectedDigest('input', manifest.entries.map(({
      path: sourcePath, inputSha256,
    }) => ({ path: sourcePath, inputSha256 }))));
    expect(manifest.sourceManifestDigest).toBe(expectedDigest('manifest', manifest.entries));

    fs.writeFileSync(firstPath, 'export const value = 2;\n', 'utf8');
    fs.utimesSync(firstPath, preservedTime, preservedTime);
    const changed = sourcePolicy.buildSourceManifest(root);
    const beforeEntry = manifest.entries.find(entry => entry.path === 'src/app/z-last.ts');
    const afterEntry = changed.entries.find(entry => entry.path === 'src/app/z-last.ts');
    expect(afterEntry?.size).toBe(beforeEntry?.size);
    expect(afterEntry?.mtimeNs).toBe(beforeEntry?.mtimeNs);
    expect(afterEntry?.sha256).not.toBe(beforeEntry?.sha256);
    expect(changed.contentDigest).not.toBe(manifest.contentDigest);
  });

  it('masks explicit derived-doc and generation marker blocks only for input digests', () => {
    const root = makeRoot();
    const agentsPath = writeFile(root, 'AGENTS.md', [
      '# Rules',
      '<!-- nanoflow-derived:start -->',
      'overlay nodes: 10',
      '<!-- nanoflow-derived:end -->',
      '<!-- nanoflow-generation: old-generation -->',
      '',
    ].join('\n'));
    const before = sourcePolicy.buildSourceManifest(root).entries[0];

    fs.writeFileSync(agentsPath, [
      '# Rules',
      '<!-- nanoflow-derived:start -->',
      'overlay nodes: 999',
      '<!-- nanoflow-derived:end -->',
      '<!-- nanoflow-generation: new-generation -->',
      '',
    ].join('\n'));
    const after = sourcePolicy.buildSourceManifest(root).entries[0];

    expect(after.sha256).not.toBe(before.sha256);
    expect(after.inputSha256).toBe(before.inputSha256);
    expect(after.inputSha256).toBe(crypto.createHash('sha256').update([
      '# Rules',
      '<!-- nanoflow-derived -->',
      '<!-- nanoflow-generation -->',
      '',
    ].join('\n')).digest('hex'));
  });
});

describe('NanoFlow SourcePolicy v2 materialization', () => {
  it('binds the revision41 v2 contracts to one classifier definition', () => {
    const rootContractPath = path.join(
      process.cwd(),
      'scripts',
      'contracts',
      'codegraph-read-identity-v2.json',
    );
    const companionContractPath = path.join(
      process.cwd(),
      'scripts',
      'contracts',
      'codegraph-read-identity-v2-companion.json',
    );
    const rootContract = JSON.parse(fs.readFileSync(rootContractPath, 'utf8'));
    const companionContract = JSON.parse(fs.readFileSync(companionContractPath, 'utf8'));

    expect(rootContract.pathPolicy.pathPolicyId).toBe('CG2-PATH-POLICY/3');
    expect(companionContract.classifier.matchSemantics.glob)
      .toBe('only * and ? are metacharacters; * matches zero or more UTF-16 code units; ? matches one; no escape syntax; full filename match');
    expect(sourcePolicy.SOURCE_POLICY_V2_VERSION).toBe(2);
    expect(sourcePolicy.classifySourcePolicyV2Path('supabase/migrations/001.sql'))
      .toEqual({ class: 'INCLUDE', role: 'SUPABASE_SQL' });
    expect(sourcePolicy.classifySourcePolicyV2Path('android/app/src/main/res/layout/main.xml'))
      .toEqual({ class: 'INCLUDE', role: 'ANDROID_XML' });
  });

  it('derives the bounded Exact15 path-set digest and validates every removal witness', () => {
    const pathSet = sourcePolicy.deriveExact15PathSet();
    expect(pathSet.rows.map((row: { row: string }) => row.row)).toEqual([
      '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15',
    ]);
    expect(pathSet.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(sourcePolicy.validateExact15NMinusOneWitness({
      candidateRows: pathSet.rows.map((row: { row: string }) => row.row),
      extraMutablePaths: [],
      generatedHeaderExcluded: true,
      removalResults: pathSet.rows.map((row: { row: string }) => `${row.row}|SOURCE_POLICY_SCOPE_GAP`),
      repositoryPathsDigest: 'a'.repeat(64),
      trackedPathCount: '0',
      witnessVersion: 'EXACT15-NW/2',
    })).toBe(true);
  });

  it('recomputes every published FieldV3 identity vector without importing adapter code', () => {
    const rootContract = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'contracts', 'codegraph-read-identity-v2.json'),
      'utf8',
    ));
    for (const vector of rootContract.digestDag.identityFieldVectors as string[]) {
      const [field, _encoding, value, expected] = vector.split('|');
      expect(sourcePolicy.fieldV3Digest([
        ['domain', Buffer.from('field-vector-v3', 'ascii')],
        ['field', Buffer.from(field, 'ascii')],
        ['value', Buffer.from(value, 'utf8')],
      ])).toBe(expected);
    }
  });
});
