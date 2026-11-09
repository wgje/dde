import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const sourceScriptPath = path.join(repoRoot, 'scripts', 'generate-artifact-manifest.cjs');
const requireFromHere = createRequire(import.meta.url);
const tempRoots: string[] = [];
type Fixture = {
  root: string;
  dist: string;
  script: string;
  output: string;
};
type ArtifactModule = {
  generateArtifactManifest(options?: { fs?: typeof fs; outputPath?: string }): unknown;
  main(): void;
  readCandidateCensus(repoRoot: string): { candidates: Array<{ path: string }> };
};
function write(filePath: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}
function writeJson(filePath: string, value: unknown): void {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
function digest(algorithm: 'sha1' | 'sha256', content: string | Buffer): string {
  return crypto.createHash(algorithm).update(content).digest('hex');
}
function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key, stableJson((value as Record<string, unknown>)[key]),
  ]));
}
function canonicalNgswHash(value: Record<string, unknown>): string {
  const copy = structuredClone(value);
  delete copy.timestamp;
  return digest('sha256', JSON.stringify(stableJson(copy)));
}
function headersText(mainPattern = '/main*.js', mainPolicy = 'public, max-age=31536000, immutable'): string {
  return [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  ! Link',
    ...['/', '/index.html', '/launch.html', '/ngsw.json', '/version.json'].flatMap((pattern) => [
      pattern, '  Cache-Control: no-store, no-cache, must-revalidate',
    ]),
    mainPattern,
    `  Cache-Control: ${mainPolicy}`,
    '',
  ].join('\n');
}
function outputEntry(bytes: number, input: string) {
  return {
    bytes, imports: [], exports: [], entryPoint: input,
    inputs: { [input]: { bytesInOutput: bytes } },
  };
}
function refreshEvidence(fixture: Fixture, statsOutputs?: Record<string, unknown>): void {
  const rootJs = fs.readdirSync(fixture.dist).filter((name) => name.endsWith('.js')).sort();
  const hashedPaths = ['/index.html', '/launch.html', ...rootJs.map((name) => `/${name}`)];
  const hashTable = Object.fromEntries(hashedPaths.map((requestPath) => [
    requestPath,
    digest('sha1', fs.readFileSync(path.join(fixture.dist, requestPath.slice(1)))),
  ]));
  const ngsw = {
    assetGroups: [{ name: 'app', urls: hashedPaths }],
    hashTable,
    timestamp: 1,
  };
  writeJson(path.join(fixture.dist, 'ngsw.json'), ngsw);
  writeJson(path.join(fixture.dist, 'version.json'), {
    gitSha: 'a'.repeat(40), buildTime: '2026-08-02T00:00:00.000Z',
    environment: 'test', appVersion: '1.2.3', deploymentTarget: 'fixture',
    supabaseProjectAlias: 'fixture', sentryRelease: '',
    ngswHash: canonicalNgswHash(ngsw),
  });
  const statsPath = path.join(fixture.root, 'dist', 'stats.json');
  if (statsOutputs === undefined) {
    fs.rmSync(statsPath, { force: true });
  } else {
    const inputNames = [...new Set(Object.values(statsOutputs).flatMap((output) =>
      Object.keys((output as { inputs?: Record<string, unknown> }).inputs ?? {})))];
    const inputs = Object.fromEntries(inputNames.map((name) => [name, { bytes: 1, imports: [] }]));
    writeJson(statsPath, { inputs, outputs: statsOutputs });
  }
}
function makeFixture(options: { stats?: boolean } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-artifact-manifest-'));
  const dist = path.join(root, 'dist', 'browser');
  const script = path.join(root, 'scripts', 'generate-artifact-manifest.cjs');
  const output = path.join(dist, 'artifact-manifest.json');
  tempRoots.push(root);
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(sourceScriptPath, script);
  for (const candidate of requireFromHere(sourceScriptPath).readCandidateCensus(repoRoot).candidates) {
    write(path.join(root, candidate.path), fs.readFileSync(path.join(repoRoot, candidate.path)));
  }
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  ['artifact-stats-evidence.cjs', 'artifact-output-publication.cjs'].forEach((name) => fs.copyFileSync(path.join(repoRoot, 'scripts', 'lib', name), path.join(root, 'scripts', 'lib', name)));
  write(path.join(dist, '_headers'), headersText());
  write(path.join(dist, 'index.html'), '<main>Index</main>\n');
  write(path.join(dist, 'launch.html'), '<main>Launch</main>\n');
  write(path.join(dist, 'main-APP1.js'), 'console.log("main");\n');
  const mainBytes = fs.statSync(path.join(dist, 'main-APP1.js')).size;
  const outputs = options.stats === false
    ? undefined : { 'dist/browser/main-APP1.js': outputEntry(mainBytes, 'src/main.ts') };
  refreshEvidence({ root, dist, script, output }, outputs);
  return { root, dist, script, output };
}
function hermeticEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const blocked = new Set(['GITHUB_SHA', 'DEPLOYMENT_TARGET']);
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.has(key.toUpperCase()))),
    ...extra,
  };
}
function run(fixture: Fixture, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [fixture.script], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: hermeticEnv(extraEnv),
    timeout: 5_000,
  });
}
function seedOutput(fixture: Fixture): Buffer {
  const previous = Buffer.from('{"previous":true}\n');
  write(fixture.output, previous);
  return previous;
}
function expectFailure(fixture: Fixture, reason: string, previous = seedOutput(fixture)): void {
  const result = run(fixture);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(reason);
  expect(result.stderr).not.toContain(fixture.root);
  expect(result.stdout).not.toContain('Wrote');
  expect(fs.readFileSync(fixture.output)).toEqual(previous);
}
function loadModule(fixture: Fixture): ArtifactModule {
  return requireFromHere(fixture.script) as ArtifactModule;
}
function injectedFs(overrides: Record<string, unknown>): typeof fs {
  const value = Object.create(fs) as typeof fs;
  for (const [name, implementation] of Object.entries(overrides)) {
    Object.defineProperty(value, name, { value: implementation });
  }
  return value;
}
function injectedSpecialFs(target: string): typeof fs {
  return injectedFs({ lstatSync(filePath: fs.PathLike) {
    const stat = fs.lstatSync(filePath);
    if (path.resolve(String(filePath)) !== target) return stat;
    return new Proxy(stat, { get(value, property, receiver) {
      return property === 'isFile' || property === 'isDirectory' || property === 'isSymbolicLink'
        ? () => false : Reflect.get(value, property, receiver);
    } });
  } });
}

describe('generate-artifact-manifest', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is import-safe and exposes only the supported API', () => {
    const fixture = makeFixture();
    fs.rmSync(fixture.output, { force: true });
    const probe = spawnSync(process.execPath, ['-e', [
      `const api=require(${JSON.stringify(fixture.script)});`,
      'process.stdout.write(JSON.stringify(Object.keys(api).sort()));',
    ].join('')], { cwd: fixture.root, encoding: 'utf8', env: hermeticEnv() });
    expect(probe.status).toBe(0);
    expect(probe.stderr).toBe('');
    expect(JSON.parse(probe.stdout)).toEqual(['generateArtifactManifest', 'main', 'readCandidateCensus']);
    expect(fs.existsSync(fixture.output)).toBe(false);
  });
  it('creates a deterministic complete manifest without optional stats', () => {
    const fixture = makeFixture({ stats: false });
    write(path.join(fixture.dist, 'chunk-GOJS1.js'), 'const marker = "go.Diagram";\n');
    write(path.join(fixture.dist, 'assets', 'z.txt'), 'z');
    write(path.join(fixture.dist, 'assets', 'A.txt'), 'A');
    refreshEvidence(fixture);
    const result = run(fixture);
    expect(result.status, result.stderr).toBe(0);
    const text = fs.readFileSync(fixture.output, 'utf8');
    const manifest = JSON.parse(text);
    expect(Object.keys(manifest)).toEqual([
      'schemaVersion', 'gitSha', 'deploymentTarget', 'ngswHash', 'metrics', 'files',
    ]);
    expect(Object.keys(manifest.files)).toEqual([...Object.keys(manifest.files)].sort());
    expect(manifest.files['/main-APP1.js']).toMatchObject({
      sha256: digest('sha256', fs.readFileSync(path.join(fixture.dist, 'main-APP1.js'))),
      cachePolicy: 'public, max-age=31536000, immutable',
    });
    expect(manifest.metrics.gojsFlowChunkBytes)
      .toBe(fs.statSync(path.join(fixture.dist, 'chunk-GOJS1.js')).size);
    expect(Object.hasOwn(manifest.files, '/artifact-manifest.json')).toBe(false);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    const rerun = run(fixture);
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(fs.readFileSync(fixture.output, 'utf8')).toBe(text);
  });

  it('keeps sharedIdentity.filesDigest stable when only build-time fields change', () => {
    const first = makeFixture({ stats: false });
    const second = makeFixture({ stats: false });
    const firstNgswPath = path.join(first.dist, 'ngsw.json');
    const secondNgswPath = path.join(second.dist, 'ngsw.json');
    const firstVersionPath = path.join(first.dist, 'version.json');
    const secondVersionPath = path.join(second.dist, 'version.json');
    const firstNgsw = JSON.parse(fs.readFileSync(firstNgswPath, 'utf8')) as Record<string, unknown>;
    const secondNgsw = JSON.parse(fs.readFileSync(secondNgswPath, 'utf8')) as Record<string, unknown>;
    const firstVersion = JSON.parse(fs.readFileSync(firstVersionPath, 'utf8')) as Record<string, unknown>;
    const secondVersion = JSON.parse(fs.readFileSync(secondVersionPath, 'utf8')) as Record<string, unknown>;
    firstNgsw.timestamp = 101;
    secondNgsw.timestamp = 202;
    firstVersion.buildTime = '2026-08-02T01:00:00.000Z';
    secondVersion.buildTime = '2026-08-02T02:00:00.000Z';
    writeJson(firstNgswPath, firstNgsw);
    writeJson(secondNgswPath, secondNgsw);
    writeJson(firstVersionPath, firstVersion);
    writeJson(secondVersionPath, secondVersion);
    const firstResult = run(first);
    const secondResult = run(second);
    expect(firstResult.status, firstResult.stderr).toBe(0);
    expect(secondResult.status, secondResult.stderr).toBe(0);
    const firstManifest = JSON.parse(fs.readFileSync(first.output, 'utf8'));
    const secondManifest = JSON.parse(fs.readFileSync(second.output, 'utf8'));
    expect(firstManifest.metrics.sharedIdentity.filesDigest)
      .toBe(secondManifest.metrics.sharedIdentity.filesDigest);
    expect(firstManifest.files['/ngsw.json'].sha256)
      .not.toBe(secondManifest.files['/ngsw.json'].sha256);
  });

  it('changes sharedIdentity.filesDigest when stable browser content changes', () => {
    const first = makeFixture({ stats: false });
    const second = makeFixture({ stats: false });
    write(path.join(second.dist, 'index.html'), '<main>Changed stable content</main>\n');
    refreshEvidence(second);
    const firstResult = run(first);
    const secondResult = run(second);
    expect(firstResult.status, firstResult.stderr).toBe(0);
    expect(secondResult.status, secondResult.stderr).toBe(0);
    const firstManifest = JSON.parse(fs.readFileSync(first.output, 'utf8'));
    const secondManifest = JSON.parse(fs.readFileSync(second.output, 'utf8'));
    expect(firstManifest.metrics.sharedIdentity.filesDigest)
      .not.toBe(secondManifest.metrics.sharedIdentity.filesDigest);
  });
  it.each([
    ['bare package label', 'const packageName = "gojs";\n'],
    ['generic diagram noun', 'const title = "Diagram";\n'],
  ])('does not classify absent-stats lexical noise: %s', (_name, source) => {
    const fixture = makeFixture({ stats: false });
    write(path.join(fixture.dist, 'chunk-NOISE1.js'), source);
    refreshEvidence(fixture);
    const result = run(fixture);
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(fixture.output, 'utf8'));
    expect(manifest.metrics.gojsFlowChunkBytes).toBe(0);
  });
  it('uses strict stats inputs for GoJS and Flow bytes without lexical false positives', () => {
    const fixture = makeFixture();
    const gojs = path.join(fixture.dist, 'chunk-GOJS1.js');
    const flow = path.join(fixture.dist, 'chunk-FLOW1.js');
    const sync = path.join(fixture.dist, 'chunk-SYNC1.js');
    write(gojs, '/* gojs runtime */\n'.repeat(10));
    write(flow, 'console.log("feature chunk");\n'.repeat(10));
    write(sync, 'const anchor = "gojs-node";\n'.repeat(20));
    const mainBytes = fs.statSync(path.join(fixture.dist, 'main-APP1.js')).size;
    const outputs = {
      'dist/browser/main-APP1.js': outputEntry(mainBytes, 'src/main.ts'),
      'dist/browser/chunk-GOJS1.js': outputEntry(fs.statSync(gojs).size, 'node_modules/gojs/release/go.mjs'),
      'dist/browser/chunk-FLOW1.js': outputEntry(fs.statSync(flow).size, 'src/app/features/flow/view.ts'),
      'dist/browser/chunk-SYNC1.js': outputEntry(fs.statSync(sync).size, 'src/services/sync-anchor.ts'),
    };
    refreshEvidence(fixture, outputs);
    const result = run(fixture);
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(fixture.output, 'utf8'));
    expect(manifest.metrics.gojsFlowChunkBytes).toBe(fs.statSync(gojs).size + fs.statSync(flow).size);
  });
  it.each(['_headers', 'index.html', 'launch.html', 'ngsw.json', 'version.json'])(
    'rejects missing and empty required evidence: %s',
    (name) => {
      const missing = makeFixture();
      fs.rmSync(path.join(missing.dist, name));
      expectFailure(missing, 'artifact-evidence-required-missing');
      const empty = makeFixture();
      write(path.join(empty.dist, name), '');
      expectFailure(empty, 'artifact-evidence-required-empty');
    },
  );
  it('requires exactly one canonical root main artifact', () => {
    const missing = makeFixture();
    fs.renameSync(path.join(missing.dist, 'main-APP1.js'), path.join(missing.dist, 'main-app.js'));
    expectFailure(missing, 'artifact-evidence-main-count');
    const duplicate = makeFixture();
    write(path.join(duplicate.dist, 'main-SECOND2.js'), 'second');
    refreshEvidence(duplicate, {
      'dist/browser/main-APP1.js': outputEntry(21, 'src/main.ts'),
      'dist/browser/main-SECOND2.js': outputEntry(6, 'src/second.ts'),
    });
    expectFailure(duplicate, 'artifact-evidence-main-count');
  });
  it.each([
    ['malformed version', (fixture: Fixture) => write(path.join(fixture.dist, 'version.json'), '{')],
    ['invalid git identity', (fixture: Fixture) => {
      const version = JSON.parse(fs.readFileSync(path.join(fixture.dist, 'version.json'), 'utf8'));
      version.gitSha = 'not-a-sha';
      writeJson(path.join(fixture.dist, 'version.json'), version);
    }],
    ['malformed ngsw', (fixture: Fixture) => write(path.join(fixture.dist, 'ngsw.json'), '{')],
  ])('rejects %s without environment fallback', (_name, mutate) => {
    const fixture = makeFixture();
    mutate(fixture);
    const previous = seedOutput(fixture);
    const result = run(fixture, { GITHUB_SHA: 'b'.repeat(40), DEPLOYMENT_TARGET: 'unsafe' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('artifact-evidence-');
    expect(fs.readFileSync(fixture.output)).toEqual(previous);
  });
  it('requires canonical NGSW and SHA-1 hash-table evidence', () => {
    const staleVersion = makeFixture();
    const version = JSON.parse(fs.readFileSync(path.join(staleVersion.dist, 'version.json'), 'utf8'));
    version.ngswHash = '0'.repeat(64);
    writeJson(path.join(staleVersion.dist, 'version.json'), version);
    expectFailure(staleVersion, 'artifact-evidence-ngsw-digest');
    const staleShell = makeFixture();
    const ngswPath = path.join(staleShell.dist, 'ngsw.json');
    const ngsw = JSON.parse(fs.readFileSync(ngswPath, 'utf8'));
    ngsw.assetGroups[0].urls.push('/missing.js');
    ngsw.hashTable['/missing.js'] = '0'.repeat(40);
    writeJson(ngswPath, ngsw);
    const updated = JSON.parse(fs.readFileSync(path.join(staleShell.dist, 'version.json'), 'utf8'));
    updated.ngswHash = canonicalNgswHash(ngsw);
    writeJson(path.join(staleShell.dist, 'version.json'), updated);
    expectFailure(staleShell, 'artifact-evidence-ngsw-hash-table');
  });
  it.each([
    ['environment', ''],
    ['appVersion', '   '],
    ['deploymentTarget', null],
    ['supabaseProjectAlias', {}],
    ['sentryRelease', null],
    ['buildTime', 'not-an-instant'],
    ['ngswHash', '0'.repeat(63)],
  ])('rejects invalid required version evidence: %s', (field, value) => {
    const fixture = makeFixture();
    const versionPath = path.join(fixture.dist, 'version.json');
    const version = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
    version[field] = value;
    writeJson(versionPath, version);
    expectFailure(fixture, 'artifact-evidence-version');
  });
  it.each([
    ['missing no-store', headersText('/main*.js', 'public, max-age=31536000, immutable').replace('no-store, ', '')],
    ['missing immutable', headersText('/main*.js', 'public, max-age=31536000')],
    ['missing Link removal', headersText().replace('  ! Link\n', '')],
    ['malformed directive', `${headersText()}  invalid\n`],
  ])('rejects strict header policy: %s', (_name, contents) => {
    const fixture = makeFixture();
    write(path.join(fixture.dist, '_headers'), contents);
    expectFailure(fixture, 'artifact-evidence-headers');
  });
  it.each([
    ['malformed', '{'],
    ['array', '[]\n'],
    ['missing inputs', '{"outputs":{}}\n'],
    ['empty outputs', '{"inputs":{},"outputs":{}}\n'],
    ['incomplete output', '{"inputs":{"src/main.ts":{"bytes":1,"imports":[]}},"outputs":{"dist/browser/main-APP1.js":{"bytes":21,"inputs":{}}}}\n'],
  ])('rejects present %s stats instead of falling back', (_name, contents) => {
    const fixture = makeFixture();
    write(path.join(fixture.root, 'dist', 'stats.json'), contents);
    expectFailure(fixture, 'artifact-evidence-stats');
  });
  it('rejects missing and mismatched main stats output evidence', () => {
    const missing = makeFixture();
    const indexBytes = fs.statSync(path.join(missing.dist, 'index.html')).size;
    refreshEvidence(missing, {
      'dist/browser/index.html': outputEntry(indexBytes, 'src/index.html'),
    });
    expectFailure(missing, 'artifact-evidence-stats-main');
    const mismatch = makeFixture();
    refreshEvidence(mismatch, {
      'dist/browser/main-APP1.js': outputEntry(999, 'src/main.ts'),
    });
    expectFailure(mismatch, 'artifact-evidence-stats-size');
  });
  it.each(['chunk-GOJS1.js', 'polyfills-POLY1.js', 'runtime-RUN1.js'])(
    'rejects incomplete present stats for hashed output: %s', (name) => {
    const fixture = makeFixture();
    const target = path.join(fixture.dist, name);
    write(target, 'const marker = "go.Diagram";\n');
    const mainBytes = fs.statSync(path.join(fixture.dist, 'main-APP1.js')).size;
    const outputs = {
      'dist/browser/main-APP1.js': outputEntry(mainBytes, 'src/main.ts'),
    };
    refreshEvidence(fixture, outputs);
    expectFailure(fixture, 'artifact-evidence-stats-output');
  });
  it('rejects a truly unreachable empty-input orphan output', () => {
    const fixture = makeFixture();
    const target = path.join(fixture.dist, 'chunk-ORPHAN1.js');
    write(target, 'const marker = "orphan";\n');
    const mainBytes = fs.statSync(path.join(fixture.dist, 'main-APP1.js')).size;
    refreshEvidence(fixture, {
      'dist/browser/main-APP1.js': outputEntry(mainBytes, 'src/main.ts'),
      'dist/browser/chunk-ORPHAN1.js': {
        bytes: fs.statSync(target).size, inputs: {}, imports: [], exports: [],
      },
    });
    expectFailure(fixture, 'artifact-evidence-stats-output');
  });
  it('rejects symlink, dangling, hardlinked and portable special entries', () => {
    const symlink = makeFixture();
    write(path.join(symlink.root, 'outside.txt'), 'outside');
    fs.symlinkSync(path.join(symlink.root, 'outside.txt'), path.join(symlink.dist, 'linked.txt'), 'file');
    expectFailure(symlink, 'artifact-evidence-entry-symlink');
    const dangling = makeFixture();
    fs.symlinkSync(path.join(dangling.root, 'missing.txt'), path.join(dangling.dist, 'dangling.txt'), 'file');
    expectFailure(dangling, 'artifact-evidence-entry-symlink');
    const hardlink = makeFixture();
    fs.linkSync(path.join(hardlink.dist, 'index.html'), path.join(hardlink.dist, 'linked-index.html'));
    expectFailure(hardlink, 'artifact-evidence-file-links');
    const special = makeFixture();
    const target = path.join(special.dist, 'special.bin');
    write(target, 'ordinary bytes');
    const fakeFs = injectedSpecialFs(target);
    const previous = seedOutput(special);
    expect(() => loadModule(special).generateArtifactManifest({ fs: fakeFs }))
      .toThrow('artifact-evidence-entry-special');
    expect(fs.readFileSync(special.output)).toEqual(previous);
  });
  it.skipIf(process.platform === 'win32')('rejects a real FIFO special entry', () => {
    const backslash = makeFixture();
    write(path.join(backslash.dist, 'odd\\name.js'), 'bytes');
    expectFailure(backslash, 'artifact-evidence-entry-path');
    const fixture = makeFixture();
    const fifo = path.join(fixture.dist, 'special.fifo');
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);
    expectFailure(fixture, 'artifact-evidence-entry-special');

    const raced = makeFixture();
    const target = path.join(raced.dist, 'race.txt');
    write(target, 'regular');
    let swapped = false;
    const fakeFs = injectedFs({
      openSync(filePath: fs.PathLike, flags: number) {
        if (path.resolve(String(filePath)) === target && !swapped) {
          fs.rmSync(target);
          const result = spawnSync('mkfifo', [target], { encoding: 'utf8' });
          expect(result.status, result.stderr).toBe(0);
          swapped = true;
        }
        return fs.openSync(filePath, flags);
      },
    });
    expect(() => loadModule(raced).generateArtifactManifest({ fs: fakeFs }))
      .toThrow('artifact-evidence-entry-special');
  });
  it('requests nonblocking descriptor opens to settle replacement specials', () => {
    const fixture = makeFixture();
    const target = path.join(fixture.dist, 'index.html');
    const marker = 0x40000000;
    let observed = false;
    const fakeFs = injectedFs({
      constants: { ...fs.constants, O_NONBLOCK: marker },
      openSync(filePath: fs.PathLike, flags: number) {
        if (path.resolve(String(filePath)) === target) observed = (flags & marker) === marker;
        return fs.openSync(filePath, flags & ~marker);
      },
    });
    loadModule(fixture).generateArtifactManifest({ fs: fakeFs });
    expect(observed).toBe(true);
  });
  it('rejects descriptor drift, short reads, close failures and directory drift', () => {
    const modes = ['identity', 'short-read', 'close', 'directory', 'output-readback'] as const;
    for (const mode of modes) {
      const fixture = makeFixture();
      const target = path.join(fixture.dist, 'index.html');
      let targetFd: number | null = null;
      let fstatCount = 0;
      let distReads = 0;
      let renamed = false;
      const fakeFs = injectedFs({
        openSync(filePath: fs.PathLike, flags: number) {
          const fd = fs.openSync(filePath, flags);
          if (path.resolve(String(filePath)) === target) targetFd = fd;
          return fd;
        },
        fstatSync(fd: number) {
          const stat = fs.fstatSync(fd);
          if (mode !== 'identity' || fd !== targetFd || fstatCount++ === 0) return stat;
          return new Proxy(stat, {
            get(value, property, receiver) {
              if (property === 'mtimeMs') return value.mtimeMs + 1;
              return Reflect.get(value, property, receiver);
            },
          });
        },
        readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
          if (mode === 'short-read' && fd === targetFd) return 0;
          return fs.readSync(fd, buffer, offset, length, position);
        },
        closeSync(fd: number) {
          fs.closeSync(fd);
          if (mode === 'close' && fd === targetFd) throw new Error('injected close failure');
        },
        readFileSync(filePath: fs.PathLike, ...args: unknown[]) {
          if (mode === 'output-readback' && renamed
            && path.resolve(String(filePath)) === fixture.output) return Buffer.from('wrong');
          const options = args[0] as Parameters<typeof fs.readFileSync>[1] | undefined;
          return fs.readFileSync(filePath, options);
        },
        renameSync(from: fs.PathLike, to: fs.PathLike) {
          const result = fs.renameSync(from, to);
          if (path.resolve(String(to)) === fixture.output) renamed = true;
          return result;
        },
        readdirSync(dir: fs.PathLike, options: { withFileTypes: true }) {
          const entries = fs.readdirSync(dir, options);
          if (mode === 'directory' && path.resolve(String(dir)) === fixture.dist && distReads++ > 0) {
            return entries.slice(1);
          }
          return entries;
        },
      });
      const previous = seedOutput(fixture);
      expect(() => loadModule(fixture).generateArtifactManifest({ fs: fakeFs }))
        .toThrow(mode === 'output-readback'
          ? 'artifact-evidence-output-rollback'
          : `artifact-evidence-${mode === 'identity' ? 'file-drift' : mode}`);
      expect(fs.readFileSync(fixture.output).equals(previous)).toBe(true);
    }
    const absent = makeFixture();
    fs.rmSync(absent.output, { force: true });
    const absentFs = injectedFs({ readFileSync: (filePath: fs.PathLike) => path.resolve(String(filePath)) === absent.output ? Buffer.from('wrong') : fs.readFileSync(filePath) });
    expect(() => loadModule(absent).generateArtifactManifest({ fs: absentFs }))
      .toThrow('artifact-evidence-output-readback');
    expect(fs.existsSync(absent.output)).toBe(false);
  });
  it('rejects same-shape nested directory replacement', () => {
    const fixture = makeFixture();
    const nested = path.join(fixture.dist, 'assets');
    const displaced = path.join(fixture.dist, 'displaced-assets');
    write(path.join(nested, 'same.txt'), 'old bytes');
    let reads = 0;
    const fakeFs = injectedFs({
      readdirSync(directory: fs.PathLike, options: { withFileTypes: true }) {
        if (path.resolve(String(directory)) === nested && reads++ === 1) {
          fs.renameSync(nested, displaced);
          write(path.join(nested, 'same.txt'), 'new bytes');
        }
        return fs.readdirSync(directory, options);
      },
    });
    const previous = seedOutput(fixture);
    expect(() => loadModule(fixture).generateArtifactManifest({ fs: fakeFs }))
      .toThrow('artifact-evidence-directory');
    expect(fs.readFileSync(fixture.output)).toEqual(previous);
  });
  it('rejects a canonical file escape', () => {
    const fixture = makeFixture();
    const target = path.join(fixture.dist, 'index.html');
    const fakeFs = injectedFs({
      realpathSync(filePath: fs.PathLike) {
        if (path.resolve(String(filePath)) === target) return path.join(fixture.root, 'outside.html');
        return fs.realpathSync.native(filePath);
      },
    });
    const previous = seedOutput(fixture);
    expect(() => loadModule(fixture).generateArtifactManifest({ fs: fakeFs }))
      .toThrow('artifact-evidence-file-escape');
    expect(fs.readFileSync(fixture.output)).toEqual(previous);
  });
  it('rejects a symlinked dist root and unsafe existing output', () => {
    const linkedRoot = makeFixture();
    const realDist = path.join(linkedRoot.root, 'real-browser');
    fs.renameSync(linkedRoot.dist, realDist);
    fs.symlinkSync(realDist, linkedRoot.dist, 'junction');
    expectFailure(linkedRoot, 'artifact-evidence-dist-root');
    const linkedOutput = makeFixture();
    write(path.join(linkedOutput.root, 'prior.json'), '{}\n');
    fs.symlinkSync(path.join(linkedOutput.root, 'prior.json'), linkedOutput.output, 'file');
    const result = run(linkedOutput);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('artifact-evidence-output');

    const hardlinkedOutput = makeFixture();
    const prior = path.join(hardlinkedOutput.root, 'prior.json');
    write(prior, '{"prior":true}\n');
    fs.linkSync(prior, hardlinkedOutput.output);
    const hardlinkResult = run(hardlinkedOutput);
    expect(hardlinkResult.status).toBe(1);
    expect(hardlinkResult.stderr).toContain('artifact-evidence-output');
    expect(fs.readFileSync(prior, 'utf8')).toBe('{"prior":true}\n');

    const specialOutput = makeFixture();
    const previous = seedOutput(specialOutput);
    const fakeFs = injectedSpecialFs(specialOutput.output);
    expect(() => loadModule(specialOutput).generateArtifactManifest({ fs: fakeFs }))
      .toThrow('artifact-evidence-output');
    expect(fs.readFileSync(specialOutput.output)).toEqual(previous);

    const escaped = makeFixture();
    const escapedOutput = path.join(escaped.root, 'escaped-manifest.json');
    expect(() => loadModule(escaped).generateArtifactManifest({ outputPath: escapedOutput }))
      .toThrow('artifact-evidence-output');
    expect(fs.existsSync(escapedOutput)).toBe(false);
  });
});
