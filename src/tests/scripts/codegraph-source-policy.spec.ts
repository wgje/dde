import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sourcePolicy = require('../../../scripts/lib/codegraph-source-policy.cjs') as {
  SOURCE_POLICY_VERSION: number;
  SOURCE_POLICY_DIGEST: string;
  classifySourcePath(relativePath: string): string | null;
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

const tempRoots: string[] = [];

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
    const discoveryPatternLiteral = validatorSource.match(
      /const DEDUP_CONTRACT_QUERY_FORMATTER_DISCOVERY_PATTERN\s*=\s*([\s\S]*?);/,
    )?.[1] ?? '';
    const parsedPatternLiteral = discoveryPatternLiteral.match(/^\/([\s\S]*)\/([a-z]*)$/);

    expect(parsedPatternLiteral).not.toBeNull();

    const discoveryPattern = new RegExp(parsedPatternLiteral![1], parsedPatternLiteral![2]);
    const syntheticQuerySource = [
      'function rankGraphEdgesForQuery(edges) { return edges; }',
      'function rankRelationshipEdgesForQuery(edges) { return edges; }',
    ].join('\n');

    expect(Array.from(syntheticQuerySource.matchAll(discoveryPattern), match => match[1])).toEqual([
      'rankGraphEdgesForQuery',
      'rankRelationshipEdgesForQuery',
    ]);
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
