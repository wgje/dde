import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const guardSource = path.join(repoRoot, 'scripts', 'ci', 'check-deploy-artifacts.cjs');
const generatorSource = path.join(repoRoot, 'scripts', 'generate-artifact-manifest.cjs');
const statsEvidenceSource = path.join(repoRoot, 'scripts', 'lib', 'artifact-stats-evidence.cjs');
const publicationSource = path.join(repoRoot, 'scripts', 'lib', 'artifact-output-publication.cjs');
const tempRoots: string[] = [];
const fingerprint = Array.from({ length: 32 }, () => 'AA').join(':');
const require = createRequire(import.meta.url);
const { canonicalNgswHash } = require('../../../scripts/lib/artifact-stats-evidence.cjs') as {
  canonicalNgswHash(value: Record<string, unknown>): string;
};

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeJson(filePath: string, value: unknown): void {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha(algorithm: 'sha1' | 'sha256', value: string): string {
  return crypto.createHash(algorithm).update(value).digest('hex');
}

function hermeticEnv(): NodeJS.ProcessEnv {
  const blocked = new Set([
    'ANDROID_TWA_PACKAGE_NAME', 'ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS',
    'ANDROID_TWA_SHA256_FINGERPRINTS', 'GITHUB_SHA', 'DEPLOYMENT_TARGET',
  ]);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.has(key.toUpperCase())));
}

function run(root: string, script: string, envOverrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [path.join(root, script)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...hermeticEnv(), ...envOverrides },
    timeout: 5_000,
  });
}

function createFixture(): { root: string; dist: string; manifest: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-deploy-integrity-'));
  const dist = path.join(root, 'dist', 'browser');
  const manifest = path.join(dist, 'artifact-manifest.json');
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(guardSource, path.join(root, 'scripts', 'ci', 'check-deploy-artifacts.cjs'));
  fs.copyFileSync(generatorSource, path.join(root, 'scripts', 'generate-artifact-manifest.cjs'));
  for (const candidate of require(generatorSource).readCandidateCensus(repoRoot).candidates) {
    write(path.join(root, candidate.path), fs.readFileSync(path.join(repoRoot, candidate.path), 'utf8'));
  }
  fs.copyFileSync(statsEvidenceSource, path.join(root, 'scripts', 'lib', 'artifact-stats-evidence.cjs'));
  fs.copyFileSync(publicationSource, path.join(root, 'scripts', 'lib', 'artifact-output-publication.cjs'));
  write(path.join(root, 'ngsw-config.json'), '{}\n');
  const index = '<main>A</main>\n';
  const launch = '<main>Launch</main>\n';
  const main = 'console.log("main");\n';
  write(path.join(dist, '_headers'), [
    '/*', '  ! Link', '/', '  Cache-Control: no-store', '/index.html',
    '  Cache-Control: no-store', '/launch.html', '  Cache-Control: no-store',
    '/ngsw.json', '  Cache-Control: no-store', '/version.json',
    '  Cache-Control: no-store', '/main*.js',
    '  Cache-Control: public, max-age=31536000, immutable', '',
  ].join('\n'));
  write(path.join(dist, 'index.html'), index);
  write(path.join(dist, 'launch.html'), launch);
  write(path.join(dist, 'main-APP1.js'), main);
  writeJson(path.join(root, 'dist', 'stats.json'), {
    inputs: { 'src/main.ts': { bytes: Buffer.byteLength(main), imports: [] } },
    outputs: {
      'dist/browser/main-APP1.js': {
        bytes: Buffer.byteLength(main), imports: [], exports: [], entryPoint: 'src/main.ts',
        inputs: { 'src/main.ts': { bytesInOutput: Buffer.byteLength(main) } },
      },
    },
  });
  const ngsw = {
    assetGroups: [{ name: 'app', urls: ['/index.html', '/launch.html', '/main-APP1.js'] }],
    hashTable: {
      '/index.html': sha('sha1', index),
      '/launch.html': sha('sha1', launch),
      '/main-APP1.js': sha('sha1', main),
    },
    timestamp: 1,
  };
  writeJson(path.join(dist, 'ngsw.json'), ngsw);
  writeJson(path.join(dist, 'manifest.webmanifest'), { id: '/', scope: '/', start_url: '/' });
  writeJson(path.join(dist, 'version.json'), {
    gitSha: 'a'.repeat(40), buildTime: '2026-01-01T00:00:00.000Z', environment: 'test',
    appVersion: '1.0.0', deploymentTarget: 'cloudflare', supabaseProjectAlias: 'fixture',
    sentryRelease: '', ngswHash: canonicalNgswHash(ngsw),
  });
  writeJson(path.join(dist, '.well-known', 'assetlinks.json'), [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app', package_name: 'app.nanoflow.twa',
      sha256_cert_fingerprints: [fingerprint],
    },
  }]);
  write(path.join(dist, 'assets', 'nested.txt'), 'nested evidence\n');
  const generated = run(root, 'scripts/generate-artifact-manifest.cjs');
  if (generated.status !== 0) throw new Error(generated.stderr || generated.stdout);
  return { root, dist, manifest };
}

function runGuard(root: string, envOverrides: NodeJS.ProcessEnv = {
  ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS: fingerprint,
}) {
  return run(root, 'scripts/ci/check-deploy-artifacts.cjs', envOverrides);
}

function expectIntegrityFailure(result: ReturnType<typeof runGuard>, reason: string, root: string): void {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(reason);
  expect(result.stderr).not.toContain(root);
  expect(`${result.stdout}${result.stderr}`).not.toContain('artifact manifest valid');
  expect(`${result.stdout}${result.stderr}`).not.toContain('check-deploy-artifacts PASSED');
}

describe('deploy artifact manifest content integrity', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes an untouched generated tree with a canonical nested path', () => {
    const { root, manifest } = createFixture();
    const files = JSON.parse(fs.readFileSync(manifest, 'utf8')).files;
    expect(Object.hasOwn(files, '/assets/nested.txt')).toBe(true);
    const result = runGuard(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('check-deploy-artifacts PASSED');
  });

  it('validates an explicit Vercel static output directory', () => {
    const { root, dist } = createFixture();
    const vercelStatic = path.join(root, '.vercel', 'output', 'static');
    fs.cpSync(dist, vercelStatic, { recursive: true });
    const result = runGuard(root, {
      ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS: fingerprint,
      ARTIFACT_DIST_DIR: vercelStatic,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('check-deploy-artifacts PASSED');
  });

  it('fails closed when the expected TWA fingerprint environment is absent', () => {
    const { root } = createFixture();
    const result = runGuard(root, {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'assetlinks.json expected TWA fingerprint environment is missing or invalid',
    );
    expect(result.stderr).not.toContain(root);
  });

  it('rejects an arbitrary nonempty TWA fingerprint value', () => {
    const { root } = createFixture();
    const result = runGuard(root, {
      ANDROID_TWA_EXPECTED_SHA256_CERT_FINGERPRINTS: 'not-a-fingerprint',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'assetlinks.json expected TWA fingerprint environment is missing or invalid',
    );
    expect(result.stderr).not.toContain(root);
  });

  it('rejects a candidate-set change even when the artifact files are unchanged', () => {
    const { root, manifest } = createFixture();
    const payload = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    payload.metrics.candidates[0].path = 'package.json';
    writeJson(manifest, payload);
    expectIntegrityFailure(runGuard(root), 'artifact-manifest-candidate-set-drift', root);
  });

  it('rejects a final disk/browser shared-identity mismatch', () => {
    const { root, manifest } = createFixture();
    const payload = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    payload.metrics.sharedIdentity.filesDigest = '0'.repeat(64);
    writeJson(manifest, payload);
    expectIntegrityFailure(runGuard(root), 'artifact-manifest-shared-identity-drift', root);
  });

  it('rejects a same-size post-manifest content mutation', () => {
    const { root, dist } = createFixture();
    write(path.join(dist, 'index.html'), '<main>B</main>\n');
    expectIntegrityFailure(runGuard(root), 'artifact-manifest-sha256-mismatch:/index.html', root);
  });

  it('rejects a post-manifest size mutation', () => {
    const { root, dist } = createFixture();
    fs.appendFileSync(path.join(dist, 'index.html'), 'changed\n');
    expectIntegrityFailure(runGuard(root), 'artifact-manifest-size-mismatch:/index.html', root);
  });

  it('rejects a same-count advertised-file substitution in sorted order', () => {
    const { root, dist } = createFixture();
    fs.rmSync(path.join(dist, 'assets', 'nested.txt'));
    write(path.join(dist, 'assets', 'replacement.txt'), 'replacement\n');
    const result = runGuard(root);
    expectIntegrityFailure(result, 'artifact-manifest-file-missing-on-disk:/assets/nested.txt', root);
    expect(result.stderr).toContain('artifact-manifest-unadvertised-disk-file:/assets/replacement.txt');
    expect(result.stderr.indexOf('/assets/nested.txt')).toBeLessThan(result.stderr.indexOf('/assets/replacement.txt'));
  });

  it('rejects a non-regular root artifact manifest before excluding it', () => {
    const { root, manifest } = createFixture();
    fs.rmSync(manifest);
    fs.mkdirSync(manifest);
    expectIntegrityFailure(
      runGuard(root),
      'artifact-manifest-root-not-regular:/artifact-manifest.json',
      root,
    );
  });

  it('rejects a junction or symlink artifact without following it', () => {
    const { root, dist } = createFixture();
    const artifact = path.join(dist, 'assets', 'nested.txt');
    const target = path.join(root, 'junction-target');
    fs.rmSync(artifact);
    fs.mkdirSync(target);
    fs.symlinkSync(target, artifact, 'junction');
    expectIntegrityFailure(
      runGuard(root),
      'artifact-manifest-disk-entry-not-regular:/assets/nested.txt',
      root,
    );
  });

  it('classifies an extension-matched dangling link before reading content', () => {
    const { root, dist } = createFixture();
    const artifact = path.join(dist, 'assets', 'dangling.js');
    fs.symlinkSync(path.join(root, 'missing-target.js'), artifact, 'file');
    expectIntegrityFailure(
      runGuard(root),
      'artifact-manifest-disk-entry-not-regular:/assets/dangling.js',
      root,
    );
  });

  it.each([null, []])('rejects a non-object manifest files value %#', (files) => {
    const { root, manifest } = createFixture();
    const payload = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    payload.files = files;
    writeJson(manifest, payload);
    expectIntegrityFailure(runGuard(root), 'artifact-manifest-files-invalid', root);
  });

  it('rejects a noncanonical manifest key without logging the alias', () => {
    const { root, manifest } = createFixture();
    const payload = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    payload.files['/assets//nested.txt'] = payload.files['/assets/nested.txt'];
    delete payload.files['/assets/nested.txt'];
    writeJson(manifest, payload);
    const result = runGuard(root);
    expectIntegrityFailure(result, 'artifact-manifest-path-noncanonical', root);
    expect(result.stderr).not.toContain('/assets//nested.txt');
  });
});
