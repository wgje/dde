import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const roots: string[] = [];

function fixture(): { root: string; output: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-artifact-publication-'));
  roots.push(root);
  return { root, output: path.join(root, 'artifact.json') };
}

function injectedFs(overrides: Record<string, unknown> = {}): typeof fs {
  const result = Object.create(fs) as typeof fs;
  Object.defineProperty(result, 'fsyncDirectorySync', { configurable: true, value: () => {} });
  Object.defineProperty(result, 'fsyncSync', { configurable: true, value: () => {} });
  for (const [name, value] of Object.entries(overrides)) {
    Object.defineProperty(result, name, { configurable: true, value });
  }
  return result;
}

function publish(root: string, output: string, content: string): Record<string, unknown> {
  const { publishOutput, validateOutput } = require('../../../scripts/lib/artifact-output-publication.cjs');
  const durableFs = injectedFs();
  const rootStat = fs.lstatSync(root);
  const rootReal = fs.realpathSync.native(root);
  const current = validateOutput(durableFs, output, rootReal);
  return publishOutput(durableFs, output, content, rootReal, current, root, rootStat);
}

function postRenameFaultFs(output: string, fault: 'directory' | 'readback'): typeof fs {
  const injected = injectedFs();
  let renamed = false;
  let fired = false;
  Object.defineProperty(injected, 'renameSync', {
    configurable: true,
    value(from: fs.PathLike, to: fs.PathLike) {
      const result = fs.renameSync(from, to);
      if (path.resolve(String(to)) === path.resolve(output)) renamed = true;
      return result;
    },
  });
  if (fault === 'directory') {
    Object.defineProperty(injected, 'fsyncDirectorySync', {
      configurable: true,
      value() {
        if (renamed && !fired) {
          fired = true;
          throw Object.assign(new Error('post-rename directory flush failed'), { code: 'EIO' });
        }
      },
    });
  } else {
    Object.defineProperty(injected, 'readFileSync', {
      configurable: true,
      value(filePath: fs.PathLike, ...args: unknown[]) {
        if (renamed && path.resolve(String(filePath)) === path.resolve(output) && !fired) {
          fired = true;
          throw Object.assign(new Error('post-rename readback failed'), { code: 'EIO' });
        }
        const options = args[0] as Parameters<typeof fs.readFileSync>[1] | undefined;
        return fs.readFileSync(filePath, options);
      },
    });
  }
  return injected;
}

describe('artifact-output-publication', () => {
  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  });

  it('publishes an absent regular output and removes transaction residue', () => {
    const { root, output } = fixture();
    publish(root, output, '{"version":1}\n');
    expect(fs.readFileSync(output, 'utf8')).toBe('{"version":1}\n');
    expect(fs.readdirSync(root).sort()).toEqual(['artifact.json']);
  });

  it('replaces an existing output without leaving a backup or lock', () => {
    const { root, output } = fixture();
    fs.writeFileSync(output, 'old\n');
    publish(root, output, 'new\n');
    expect(fs.readFileSync(output, 'utf8')).toBe('new\n');
    expect(fs.readdirSync(root).sort()).toEqual(['artifact.json']);
  });

  it('uses one direct replacement and returns a verified in-memory receipt', () => {
    const { root, output } = fixture();
    fs.writeFileSync(output, 'old\n');
    const renames: string[][] = [];
    const injected = injectedFs({
      renameSync(from: fs.PathLike, to: fs.PathLike) {
        renames.push([String(from), String(to)]);
        return fs.renameSync(from, to);
      },
    });
    const { publishOutput, validateOutput } = require('../../../scripts/lib/artifact-output-publication.cjs');
    const rootStat = fs.lstatSync(root);
    const rootReal = fs.realpathSync.native(root);
    const receipt = publishOutput(
      injected,
      output,
      'new\n',
      rootReal,
      validateOutput(injected, output, rootReal),
      root,
      rootStat,
    );
    const targetRenames = renames.filter(([, target]) => target === output);
    expect(targetRenames).toHaveLength(1);
    expect(targetRenames[0][0]).toMatch(/\.tmp$/);
    expect(receipt).toMatchObject({
      atomicReplace: 'same-directory-rename-replace-existing',
      directoryDurability: 'directory-durability-verified',
      sha256: createHash('sha256').update('new\n').digest('hex'),
      readerReceiptId: 'SRC-B',
      stable: true,
    });
  });

  it('returns two distinct reader receipts with a closed seven-field stable body', () => {
    const { root, output } = fixture();
    const receipt = publish(root, output, 'new\n');
    const snapshots = receipt.readerSnapshots as Array<Record<string, unknown>>;
    const stableFields = ['realPath', 'dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs'];
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map(snapshot => snapshot.readerReceiptId)).toEqual(['SRC-A', 'SRC-B']);
    expect(snapshots.every(snapshot => snapshot.stable === true)).toBe(true);
    expect(stableFields.map(field => snapshots[0][field]))
      .toEqual(stableFields.map(field => snapshots[1][field]));
    for (const snapshot of snapshots) {
      const body = Object.fromEntries(stableFields.map(field => [field, snapshot[field]]));
      expect(Object.keys(body)).toEqual(stableFields);
      expect(snapshot.snapshotDigest).toBe(
        createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex'),
      );
    }
    expect(receipt.readerReceiptId).toBe('SRC-B');
    expect(receipt.stable).toBe(true);
    expect(receipt.snapshotDigest).toBe(snapshots[1].snapshotDigest);
  });

  it.each([
    ['directory flush', 'directory'],
    ['final readback', 'readback'],
  ] as const)('restores an existing artifact after a post-rename %s failure', (_name, fault) => {
    const { root, output } = fixture();
    fs.writeFileSync(output, 'old\n');
    const injected = postRenameFaultFs(output, fault);
    const { publishOutput, validateOutput } = require('../../../scripts/lib/artifact-output-publication.cjs');
    const rootReal = fs.realpathSync.native(root);
    expect(() => publishOutput(
      injected,
      output,
      'new\n',
      rootReal,
      validateOutput(injected, output, rootReal),
      root,
      fs.lstatSync(root),
    )).toThrow(/artifact-evidence-output-(publish|readback)/);
    expect(fs.readFileSync(output, 'utf8')).toBe('old\n');
    expect(fs.readdirSync(root).sort()).toEqual(['artifact.json']);
  });

  it('removes a newly-created artifact after a post-rename failure', () => {
    const { root, output } = fixture();
    const injected = postRenameFaultFs(output, 'directory');
    const { publishOutput, validateOutput } = require('../../../scripts/lib/artifact-output-publication.cjs');
    const rootReal = fs.realpathSync.native(root);
    expect(() => publishOutput(
      injected,
      output,
      'new\n',
      rootReal,
      validateOutput(injected, output, rootReal),
      root,
      fs.lstatSync(root),
    )).toThrow('artifact-evidence-output-publish');
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('continues with an explicit receipt when directory fsync is unsupported', () => {
    const { root, output } = fixture();
    const injected = injectedFs({
      fsyncDirectorySync() {
        throw Object.assign(new Error('directory fsync unsupported'), { code: 'EPERM' });
      },
    });
    const { publishOutput, validateOutput } = require('../../../scripts/lib/artifact-output-publication.cjs');
    const receipt = publishOutput(
      injected,
      output,
      'new\n',
      fs.realpathSync.native(root),
      validateOutput(injected, output, fs.realpathSync.native(root)),
      root,
      fs.lstatSync(root),
    );
    expect(receipt.directoryDurability).toBe('file-flushed-no-directory-durability');
    expect(fs.readFileSync(output, 'utf8')).toBe('new\n');
  });

  it('fails before mutation when a required capability is absent', () => {
    const { root, output } = fixture();
    const injected = injectedFs({ writeFileSync: undefined });
    const { publishOutput, validateOutput } = require('../../../scripts/lib/artifact-output-publication.cjs');
    expect(() => publishOutput(
      injected,
      output,
      'new\n',
      fs.realpathSync.native(root),
      validateOutput(injected, output, fs.realpathSync.native(root)),
      root,
      fs.lstatSync(root),
    )).toThrow('artifact-evidence-output-durability');
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('does not remove an ambiguous live or permission-denied lock', () => {
    const { root, output } = fixture();
    const lockPath = `${output}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({
      ownerToken: 'a'.repeat(32),
      nonce: 'b'.repeat(32),
      pid: 42,
      createdProcessIdentity: 'foreign-process',
    }));
    const injected = injectedFs({ process: { kill: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } } });
    const { publishOutput, validateOutput } = require('../../../scripts/lib/artifact-output-publication.cjs');
    expect(() => publishOutput(
      injected,
      output,
      'new\n',
      fs.realpathSync.native(root),
      validateOutput(injected, output, fs.realpathSync.native(root)),
      root,
      fs.lstatSync(root),
    )).toThrow('artifact-evidence-output-lock');
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('preserves the old output when the target is replaced by a foreign identity', () => {
    const { root, output } = fixture();
    fs.writeFileSync(output, 'old\n');
    const injected = Object.create(fs) as typeof fs;
    Object.defineProperty(injected, 'fsyncDirectorySync', { value: () => {} });
    Object.defineProperty(injected, 'fsyncSync', { value: () => {} });
    let replaced = false;
    injected.readFileSync = ((filePath: fs.PathLike, ...args: unknown[]) => {
      if (path.resolve(String(filePath)) === path.resolve(output) && !replaced) {
        replaced = true;
        fs.rmSync(output);
        fs.writeFileSync(output, 'foreign\n');
        return Buffer.from('foreign\n');
      }
      return fs.readFileSync(filePath, ...(args as [any]));
    }) as typeof fs.readFileSync;
    const { publishOutput, validateOutput } = require('../../../scripts/lib/artifact-output-publication.cjs');
    const rootStat = fs.lstatSync(root);
    const rootReal = fs.realpathSync.native(root);
    const current = validateOutput(injected, output, rootReal);
    expect(() => publishOutput(injected, output, 'new\n', rootReal, current, root, rootStat)).toThrow(/artifact-evidence-/);
    expect(fs.readFileSync(output, 'utf8')).toBe('foreign\n');
  });

  it('rejects a symlinked output before publication', () => {
    const { root, output } = fixture();
    const target = path.join(root, 'outside');
    fs.writeFileSync(target, 'outside\n');
    fs.symlinkSync(target, output, 'file');
    expect(() => publish(root, output, 'new\n')).toThrow(/artifact-evidence-output/);
  });

  it('does not serialize raw transaction metadata into the output', () => {
    const { root, output } = fixture();
    publish(root, output, '{"safe":true}\n');
    expect(fs.readFileSync(output, 'utf8')).not.toMatch(/nonce|createdProcessIdentity|artifact-evidence/);
  });

  it('uses an explicit SHA-256 comparison in the Windows rename canary', () => {
    const source = fs.readFileSync(path.resolve('scripts/lib/artifact-output-publication.cjs'), 'utf8');
    expect(source).toContain("createHash('sha256')");
  });

  it('rejects transaction residue before it can enter an artifact manifest', () => {
    const { root, output } = fixture();
    fs.writeFileSync(`${output}.123.${'a'.repeat(32)}.tmp`, 'stale');
    const { generateArtifactManifest } = require('../../../scripts/generate-artifact-manifest.cjs');
    expect(() => generateArtifactManifest({
      repoRoot: root,
      distDir: root,
      outputPath: output,
    })).toThrow('artifact-evidence-output-residue');
  });
});
