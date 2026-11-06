import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const {
  projectStats, requiredCacheableBrowserOutputs, validateNgswAssetEvidence, readBrowserFiles,
  artifactIdentity, sameArtifactIdentity, canonicalDigest,
} = require('../../../scripts/lib/artifact-stats-evidence.cjs') as {
  projectStats(options: { stats: unknown; files: Map<string, unknown>; requiredOutput?: string }): Map<string, unknown>;
  requiredCacheableBrowserOutputs(outputs: Map<string, unknown>, files: Map<string, unknown>): string[];
  validateNgswAssetEvidence(ngsw: any, files: Map<string, any>, hash: (bytes: Buffer) => string, eligible?: string[]): void;
  readBrowserFiles(fsImpl: typeof fs, directory: string): Map<string, any>;
  artifactIdentity(stat: fs.Stats): Record<string, number>;
  sameArtifactIdentity(left: fs.Stats, right: fs.Stats): boolean;
  canonicalDigest(value: unknown): string;
};
const { validateOutput, publishOutput } = require('../../../scripts/lib/artifact-output-publication.cjs') as {
  validateOutput(fsImpl: typeof fs, output: string, root: string): any;
  publishOutput(fsImpl: typeof fs, output: string, serialized: string, root: string, state: any, rootPath: string, rootState: any): void;
};

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function input(imports: unknown[] = []) {
  return { bytes: 1, imports };
}

function output(bytes: number, inputs: Record<string, unknown> = {}, imports: unknown[] = [], entryPoint?: string) {
  return { bytes, inputs, imports, exports: [], ...(entryPoint === undefined ? {} : { entryPoint }) };
}

function files(...paths: string[]): Map<string, unknown> {
  return new Map(paths.map((filePath) => [`/${filePath}`, { size: 1 }]));
}

function stats(outputs: Record<string, unknown>, inputs: Record<string, unknown> = { 'src/main.ts': input() }) {
  return { inputs, outputs };
}

function sha1(bytes: Buffer): string {
  return crypto.createHash('sha1').update(bytes).digest('hex');
}

function publicationFixture(existing = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-publication-'));
  roots.push(root);
  const output = path.join(root, 'artifact-manifest.json');
  if (existing) fs.writeFileSync(output, 'old\n');
  const rootReal = fs.realpathSync(root);
  return {
    root, output, rootReal, rootState: fs.lstatSync(root),
    state: existing ? validateOutput(fs, output, rootReal) : null,
  };
}

function injected(overrides: Record<string, unknown>): typeof fs {
  const value = Object.create(fs) as typeof fs;
  Object.defineProperty(value, 'fsyncDirectorySync', { value: () => {} });
  Object.defineProperty(value, 'fsyncSync', { value: () => {} });
  for (const [name, implementation] of Object.entries(overrides)) Object.defineProperty(value, name, { value: implementation });
  return value;
}
const durableFs = injected({});

describe('artifact stats evidence projection', () => {
  it('canonicalizes object keys while preserving ordered arrays', () => {
    const first = { z: 1, nested: { b: true, a: 'x' }, list: ['a', 'b'] };
    const second = { list: ['a', 'b'], nested: { a: 'x', b: true }, z: 1 };
    expect(canonicalDigest(first)).toBe(canonicalDigest(second));
    expect(canonicalDigest({ list: ['b', 'a'] })).not.toBe(canonicalDigest({ list: ['a', 'b'] }));
  });

  it('accepts declared entrypoint roots and component CSS metadata without a disk file', () => {
    const result = projectStats({
      stats: stats({
        'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [], 'src/main.ts'),
        'app.component-HASH.css': output(1, { 'angular:styles\\component:css;hash;src/app.ts': { bytesInOutput: 1 } }),
      }, {
        'src/main.ts': input(),
        'angular:styles\\component:css;hash;src/app.ts': input(),
      }),
      files: files('main-APP1.js'),
      requiredOutput: '/main-APP1.js',
    });
    expect(result.has('/main-APP1.js')).toBe(true);
  });

  it('accepts Angular component CSS output without an exports field', () => {
    const result = projectStats({
      stats: stats({
        'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [], 'src/main.ts'),
        'app.component-HASH.css': {
          bytes: 1,
          inputs: { 'angular:styles\\component:css;hash;src/app.ts': { bytesInOutput: 1 } },
          imports: [],
        },
      }, {
        'src/main.ts': input(),
        'angular:styles\\component:css;hash;src/app.ts': input(),
      }),
      files: files('main-APP1.js'),
      requiredOutput: '/main-APP1.js',
    });
    expect(result.has('/main-APP1.js')).toBe(true);
  });

  it('accepts root styles CSS output without an exports field but rejects JS without one', () => {
    expect(() => projectStats({
      stats: stats({
        'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [], 'src/main.ts'),
        'styles-HASH.css': { bytes: 1, inputs: {}, imports: [] },
      }),
      files: files('main-APP1.js', 'styles-HASH.css'),
    })).not.toThrow();

    expect(() => projectStats({
      stats: stats({
        'main-APP1.js': { bytes: 1, inputs: { 'src/main.ts': { bytesInOutput: 1 } }, imports: [], entryPoint: 'src/main.ts' },
      }),
      files: files('main-APP1.js'),
    })).toThrow(/artifact-evidence-stats/);
  });

  it.each([
    ['css', 'src/app/focus/gate-actions.component.css'],
    ['scss', 'src/app/parking/parking-dock.component.scss'],
  ])('accepts an external %s ng-component CSS input without a disk output', (_kind, inputPath) => {
    const result = projectStats({
      stats: stats({
        'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [], 'src/main.ts'),
        'component-HASH.css': {
          bytes: 1,
          inputs: { [inputPath]: { bytesInOutput: 1 } },
          imports: [],
          'ng-component': true,
        },
      }, {
        'src/main.ts': input(),
        [inputPath]: input(),
      }),
      files: files('main-APP1.js'),
      requiredOutput: '/main-APP1.js',
    });
    expect(result.has('/main-APP1.js')).toBe(true);
  });

  it.each([
    ['missing component marker', { 'src/app/component.css': { bytesInOutput: 1 } }, {}],
    ['non-CSS component input', { 'src/app/component.ts': { bytesInOutput: 1 } }, { 'ng-component': true }],
    ['multiple component inputs', {
      'src/app/component.css': { bytesInOutput: 1 },
      'src/app/component.scss': { bytesInOutput: 1 },
    }, { 'ng-component': true }],
  ])('rejects external component CSS with %s', (_name, componentInputs, metadata) => {
    expect(() => projectStats({
      stats: stats({
        'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [], 'src/main.ts'),
        'component-HASH.css': { bytes: 1, inputs: componentInputs, imports: [], ...metadata },
      }, {
        'src/main.ts': input(),
        ...Object.fromEntries(Object.keys(componentInputs).map((key) => [key, input()])),
      }),
      files: files('main-APP1.js'),
    })).toThrow(/artifact-evidence-stats-output/);
  });

  it('rejects a missing non-component CSS output even when its input exists', () => {
    expect(() => projectStats({
      stats: stats({
        'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [], 'src/main.ts'),
        'styles-HASH.css': { bytes: 1, inputs: { 'src/styles.css': { bytesInOutput: 1 } }, imports: [] },
      }, {
        'src/main.ts': input(),
        'src/styles.css': input(),
      }),
      files: files('main-APP1.js'),
    })).toThrow(/artifact-evidence-stats-output/);
  });

  it('accepts a zero-input shared chunk reachable from a declared root', () => {
    const result = projectStats({
      stats: stats({
        'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [{ path: 'chunk-SHARED1.js', kind: 'import-statement' }], 'src/main.ts'),
        'chunk-SHARED1.js': output(1, {}, []),
      }),
      files: files('main-APP1.js', 'chunk-SHARED1.js'),
    });
    expect(result.has('/chunk-SHARED1.js')).toBe(true);
  });

  it('accepts a zero-input JavaScript entrypoint with a present input and matching physical size', () => {
    const result = projectStats({
      stats: stats({
        'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [], 'src/main.ts'),
        'chunk-ENTRY1.js': output(3, {}, [], 'src/app/entry.ts'),
      }, {
        'src/main.ts': input(),
        'src/app/entry.ts': input(),
      }),
      files: new Map([
        ['/main-APP1.js', { size: 1 }],
        ['/chunk-ENTRY1.js', { size: 3 }],
      ]),
    });
    expect(result.has('/chunk-ENTRY1.js')).toBe(true);
  });

  it('rejects an unknown zero-input entrypoint and an unreachable empty-input orphan', () => {
    expect(() => projectStats({
      stats: stats({
        'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [], 'src/main.ts'),
        'chunk-UNKNOWN1.js': output(1, {}, [], 'src/missing-entry.ts'),
      }),
      files: files('main-APP1.js', 'chunk-UNKNOWN1.js'),
    })).toThrow(/artifact-evidence-stats/);

    expect(() => projectStats({
      stats: stats({
        'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [], 'src/main.ts'),
        'chunk-ORPHAN1.js': output(1),
      }),
      files: files('main-APP1.js', 'chunk-ORPHAN1.js'),
    })).toThrow(/artifact-evidence-stats-output/);
  });

  it.each([
    ['unreachable zero-input output', { 'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [], 'src/main.ts'), 'chunk-ORPHAN1.js': output(1) }],
    ['missing entrypoint input', { 'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [], 'src/missing.ts') }],
  ])('rejects %s', (_name, outputs) => {
    expect(() => projectStats({ stats: stats(outputs), files: files(...Object.keys(outputs)) }))
      .toThrow(/artifact-evidence-stats/);
  });

  it('rejects path collisions and dangling internal imports but allows external edges and cycles', () => {
    expect(() => projectStats({
      stats: stats({ 'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [], 'src/main.ts') }),
      files: files('main-APP1.js', 'chunk\\X.js'),
    })).toThrow(/artifact-evidence-stats/);

    expect(() => projectStats({
      stats: stats({
        'main-APP1.js': output(1, {
          'src/main.ts': { bytesInOutput: 1 }, 'src\\main.ts': { bytesInOutput: 0 },
        }, [], 'src/main.ts'),
      }),
      files: files('main-APP1.js'),
    })).toThrow(/artifact-evidence-stats/);

    expect(() => projectStats({
      stats: stats({
        'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [{ path: 'chunk-X.js', kind: 'import-statement' }], 'src/main.ts'),
        'chunk\\X.js': output(1),
        'chunk/X.js': output(1),
      }),
      files: files('main-APP1.js', 'chunk/X.js'),
    })).toThrow(/artifact-evidence-stats/);

    expect(() => projectStats({
      stats: stats({
        'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [{ path: 'missing.js', kind: 'import-statement' }], 'src/main.ts'),
      }),
      files: files('main-APP1.js'),
    })).toThrow(/artifact-evidence-stats/);

    expect(() => projectStats({
      stats: stats({
        'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [{ path: '<runtime>', kind: 'import-statement', external: true }], 'src/main.ts'),
      }),
      files: files('main-APP1.js'),
    })).not.toThrow();

    expect(() => projectStats({
      stats: stats({
        'main-APP1.js': output(1, { 'src/main.ts': { bytesInOutput: 1 } }, [{ path: 'chunk-CYCLE1.js', kind: 'import-statement' }], 'src/main.ts'),
        'chunk-CYCLE1.js': output(1, {}, [{ path: 'main-APP1.js', kind: 'import-statement' }]),
      }),
      files: files('main-APP1.js', 'chunk-CYCLE1.js'),
    })).not.toThrow();
  });

  it('accepts canonical NGSW URLs and rejects encoded, query, hash, slash and traversal aliases', () => {
    const bytes = Buffer.from('asset');
    const valid = {
      assetGroups: [{ name: 'app', urls: ['/index.html'] }],
      hashTable: { '/index.html': sha1(bytes) },
      timestamp: 1,
    };
    expect(() => validateNgswAssetEvidence(valid, new Map([['/index.html', { bytes }]]), sha1)).not.toThrow();
    for (const url of ['/index%2ehtml', '/index.html?x', '/index.html#x', '/index\\html', '//index.html', '/a/../index.html']) {
      const invalid = { assetGroups: [{ name: 'app', urls: [url] }], hashTable: { [url]: sha1(bytes) }, timestamp: 1 };
      expect(() => validateNgswAssetEvidence(invalid, new Map([['/index.html', { bytes }]]), sha1))
        .toThrow('artifact-evidence-ngsw-hash-table');
    }
  });

  it('validates NGSW timestamp type and safe nonnegative range before canonicalization', () => {
    for (const value of [undefined, null, '1', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = { assetGroups: [], hashTable: {}, timestamp: value };
      expect(() => validateNgswAssetEvidence(invalid, new Map(), sha1)).toThrow('artifact-evidence-ngsw');
    }
    const valid = { assetGroups: [], hashTable: {}, timestamp: 0 };
    expect(() => validateNgswAssetEvidence(valid, new Map(), sha1)).not.toThrow();
    valid.timestamp = Date.now();
    expect(() => validateNgswAssetEvidence(valid, new Map(), sha1)).not.toThrow();
  });

  it('requires eligible stats outputs in NGSW but permits noneligible disk extras', () => {
    const bytes = Buffer.from('asset');
    const files = new Map([
      ['/main.js', { bytes }], ['/lazy.js', { bytes }], ['/extra.js', { bytes }],
    ]);
    const eligible = requiredCacheableBrowserOutputs(
      new Map([['/main.js', {}], ['/lazy.js', {}]]), files,
    );
    expect(eligible).toEqual(['/lazy.js', '/main.js']);
    const ngsw = {
      assetGroups: [{ name: 'app', urls: ['/main.js'] }],
      hashTable: { '/main.js': sha1(bytes) }, timestamp: 1,
    };
    expect(() => validateNgswAssetEvidence(ngsw, files, sha1, eligible)).toThrow('artifact-evidence-ngsw-hash-table');
    expect(() => validateNgswAssetEvidence(ngsw, files, sha1, ['/main.js'])).not.toThrow();
  });

  it.each(['unrelated.tmp', 'nested/foreign.bak', 'nested/.quarantine', 'deep/foreign.lock'])
    ('rejects transaction residue at any depth: %s', (relativePath) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-browser-root-'));
      roots.push(root);
      const filePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'residue');
      expect(() => readBrowserFiles(fs, root)).toThrow('artifact-evidence-output-residue');
    });

  it('rejects a symlink or reparse browser root before reading entries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-browser-root-'));
    roots.push(root);
    const original = fs.lstatSync;
    const fakeFs = injected({
      lstatSync(filePath: fs.PathLike, ...args: unknown[]) {
        const stat = original.call(fs, filePath, ...(args as []));
        if (path.resolve(String(filePath)) === path.resolve(root)) {
          return new Proxy(stat, { get: (value, key, receiver) => key === 'isSymbolicLink'
            ? () => true : Reflect.get(value, key, receiver) });
        }
        return stat;
      },
    });
    expect(() => readBrowserFiles(fakeFs, root)).toThrow('artifact-evidence-ngsw');
  });

  it('binds browser evidence to the complete shared identity authority', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-browser-root-'));
    roots.push(root);
    const stat = fs.lstatSync(root);
    expect(artifactIdentity(stat)).toMatchObject({
      dev: expect.any(Number), ino: expect.any(Number), size: expect.any(Number),
      mtimeMs: expect.any(Number), ctimeMs: expect.any(Number), birthtimeMs: expect.any(Number),
    });
    expect(sameArtifactIdentity(stat, stat)).toBe(true);
  });

  it('rejects browser root identity drift after the scan', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-browser-root-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'main.js'), 'main');
    const original = fs.lstatSync;
    let reads = 0;
    const fakeFs = injected({
      lstatSync(filePath: fs.PathLike, ...args: unknown[]) {
        const stat = original.call(fs, filePath, ...(args as []));
        if (path.resolve(String(filePath)) === path.resolve(root) && ++reads > 1) {
          return new Proxy(stat, { get: (value, key, receiver) => key === 'ctimeMs'
            ? value.ctimeMs + 1 : Reflect.get(value, key, receiver) });
        }
        return stat;
      },
    });
    expect(() => readBrowserFiles(fakeFs, root)).toThrow('artifact-evidence-ngsw');
  });

  it('fails closed on a cooperative lock collision without touching the target', () => {
    const f = publicationFixture();
    fs.writeFileSync(`${f.output}.lock`, 'foreign-owner');
    expect(() => publishOutput(durableFs, f.output, 'new\n', f.rootReal, f.state, f.root, f.rootState))
      .toThrow('artifact-evidence-output-lock');
    expect(fs.readFileSync(f.output, 'utf8')).toBe('old\n');
  });

  it('does not delete a foreign replacement during readback rollback', () => {
    const f = publicationFixture();
    let replaced = false;
    const fakeFs = injected({
      readFileSync(filePath: fs.PathLike, ...args: unknown[]) {
        if (path.resolve(String(filePath)) === f.output && !replaced) {
          replaced = true;
          fs.rmSync(f.output);
          fs.writeFileSync(f.output, 'foreign\n');
          return Buffer.from('wrong');
        }
        return fs.readFileSync(filePath, ...(args as [any]));
      },
    });
    expect(() => publishOutput(fakeFs, f.output, 'new\n', f.rootReal, f.state, f.root, f.rootState))
      .toThrow('artifact-evidence-output-drift');
    expect(fs.readFileSync(f.output, 'utf8')).toBe('foreign\n');
  });

  it('rejects dist identity replacement before publication', () => {
    const f = publicationFixture();
    const original = fs.lstatSync;
    let rootReads = 0;
    const fakeFs = injected({
      lstatSync(filePath: fs.PathLike, ...args: unknown[]) {
        const stat = original.call(fs, filePath, ...(args as []));
        if (path.resolve(String(filePath)) === f.root && ++rootReads === 2) {
          return new Proxy(stat, { get: (value, key, receiver) => key === 'isDirectory' ? () => false : Reflect.get(value, key, receiver) });
        }
        return stat;
      },
    });
    expect(() => publishOutput(fakeFs, f.output, 'new\n', f.rootReal, f.state, f.root, f.rootState))
      .toThrow('artifact-evidence-output-drift');
    expect(fs.readFileSync(f.output, 'utf8')).toBe('old\n');
  });

  it('does not create backup authority when final readback fails', () => {
    const f = publicationFixture();
    const original = fs.readFileSync;
    const fakeFs = injected({
      readFileSync(filePath: fs.PathLike, ...args: unknown[]) {
        if (path.resolve(String(filePath)) === f.output) return Buffer.from('wrong');
        return original.call(fs, filePath, ...(args as [any]));
      },
    });
    expect(() => publishOutput(fakeFs, f.output, 'new\n', f.rootReal, f.state, f.root, f.rootState))
      .toThrow('artifact-evidence-output-readback');
    expect(fs.readdirSync(f.root).some((name) => name.endsWith('.bak'))).toBe(false);
  });

  it('rejects ctime drift with otherwise matching output identity', () => {
    const f = publicationFixture();
    let reads = 0;
    const fakeFs = injected({
      lstatSync(filePath: fs.PathLike) {
        const stat = fs.lstatSync(filePath);
        if (path.resolve(String(filePath)) === f.output && reads++ > 4) {
          return new Proxy(stat, { get: (value, key, receiver) => key === 'ctimeMs'
            ? value.ctimeMs + 1 : Reflect.get(value, key, receiver) });
        }
        return stat;
      },
    });
    expect(() => publishOutput(fakeFs, f.output, 'new\n', f.rootReal, f.state, f.root, f.rootState))
      .toThrow('artifact-evidence-output-drift');
  });

  it('does not remove a lock when PID liveness changes after ESRCH', () => {
    const f = publicationFixture();
    const lockPath = `${f.output}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({
      ownerToken: 'a'.repeat(32), nonce: 'b'.repeat(32), pid: 42, createdProcessIdentity: 'foreign-process',
    }));
    let probes = 0;
    const fakeFs = injected({ process: { kill: () => { if (probes++ === 0) throw Object.assign(new Error('dead'), { code: 'ESRCH' }); } } });
    expect(() => publishOutput(fakeFs, f.output, 'new\n', f.rootReal, f.state, f.root, f.rootState))
      .toThrow('artifact-evidence-output-lock');
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('quarantines known residue outside the authoritative root', () => {
    const f = publicationFixture();
    const ownerToken = 'a'.repeat(32);
    const nonce = 'b'.repeat(32);
    const pid = process.pid + 100000;
    fs.writeFileSync(`${f.output}.lock`, JSON.stringify({
      ownerToken, nonce, pid, createdProcessIdentity: 'dead-process',
    }));
    fs.writeFileSync(`${f.output}.${pid}.${ownerToken}.${nonce}.tmp`, 'stale');
    expect(() => publishOutput(durableFs, f.output, 'new\n', f.rootReal, f.state, f.root, f.rootState)).not.toThrow();
    expect(fs.readdirSync(f.root).sort()).toEqual(['artifact-manifest.json']);
    expect(fs.readdirSync(path.dirname(f.root)).some((name) => name.startsWith(`${path.basename(f.root)}.artifact-quarantine-`))).toBe(true);
  });

  it('leaves known and foreign residue untouched when either is ambiguous', () => {
    const f = publicationFixture();
    const ownerToken = 'a'.repeat(32);
    const nonce = 'b'.repeat(32);
    const pid = process.pid + 100000;
    fs.writeFileSync(`${f.output}.lock`, JSON.stringify({
      ownerToken, nonce, pid, createdProcessIdentity: 'dead-process',
    }));
    const known = `${f.output}.${pid}.${ownerToken}.${nonce}.tmp`;
    const foreign = `${f.output}.foreign.tmp`;
    fs.writeFileSync(known, 'stale');
    fs.writeFileSync(foreign, 'foreign');
    const lockBefore = fs.lstatSync(`${f.output}.lock`);
    const knownBefore = fs.lstatSync(known);
    const foreignBefore = fs.lstatSync(foreign);
    expect(() => publishOutput(durableFs, f.output, 'new\n', f.rootReal, f.state, f.root, f.rootState))
      .toThrow('artifact-evidence-output-residue');
    expect(fs.existsSync(`${f.output}.lock`)).toBe(true);
    expect(fs.existsSync(known)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.readFileSync(`${f.output}.lock`, 'utf8')).toContain(ownerToken);
    expect(fs.readFileSync(known, 'utf8')).toBe('stale');
    expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign');
    expect(sameArtifactIdentity(lockBefore, fs.lstatSync(`${f.output}.lock`))).toBe(true);
    expect(sameArtifactIdentity(knownBefore, fs.lstatSync(known))).toBe(true);
    expect(sameArtifactIdentity(foreignBefore, fs.lstatSync(foreign))).toBe(true);
  });

  it('fails before target mutation when the Windows rename canary fails', () => {
    const f = publicationFixture();
    const fakeFs = injected({ mkdtempSync: () => { throw new Error('canary unavailable'); } });
    expect(() => publishOutput(fakeFs, f.output, 'new\n', f.rootReal, f.state, f.root, f.rootState))
      .toThrow('artifact-evidence-output-canary');
    expect(fs.readFileSync(f.output, 'utf8')).toBe('old\n');
  });

  it('reports direct replacement failure without touching the target', () => {
    const f = publicationFixture();
    const fakeFs = injected({ renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (path.resolve(String(to)) === f.output) throw new Error('replace failed');
      return fs.renameSync(from, to);
    } });
    expect(() => publishOutput(fakeFs, f.output, 'new\n', f.rootReal, f.state, f.root, f.rootState))
      .toThrow('artifact-evidence-output-replace');
    expect(fs.readFileSync(f.output, 'utf8')).toBe('old\n');
  });
});
