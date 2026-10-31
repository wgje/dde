import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../..');
const format = require(path.join(
  repoRoot,
  'scripts',
  'lib',
  'codegraph-overlay-generation-format.cjs',
)) as {
  CONTRACT_DIGEST: string;
  canonicalControlBytes(value: unknown): Buffer;
  writePrettyJson(value: unknown, write: (chunk: Buffer) => void, maxChunkBytes?: number): {
    bytes: number;
    sha256: string;
  };
  writeGenerationPayload(options: {
    overlay: unknown;
    generationId: string;
    sequence: string;
    openFile: (relativePath: string) => {
      write(chunk: Buffer): void;
      close(): void;
    };
  }): {
    arrays: Array<{
      jsonPath: string[];
      count: number;
      shards: Array<{ path: string; bytes: number; sha256: string; count: number }>;
    }>;
    compatibility: { path: string; bytes: number; sha256: string };
    skeleton: { path: string; bytes: number; sha256: string };
  };
};

function setAtPath(root: Record<string, unknown>, pathParts: string[], value: unknown): void {
  let owner = root;
  for (const part of pathParts.slice(0, -1)) owner = owner[part] as Record<string, unknown>;
  owner[pathParts.at(-1)!] = value;
}

describe('CodeGraph Overlay generation format', () => {
  it('pins the complete generation contract with an independent literal digest', () => {
    expect(require(path.join(repoRoot, 'scripts', 'contracts', 'codegraph-overlay-generation-v1.json')).overlaySchemaDigest)
      .toBe('3d4c1049024c8895f5e2fe5504bf2814b87d66211d93a9ff22bc901be8db9031');
    expect(format.CONTRACT_DIGEST).toBe(
      '8ea13a94e966e16efe3d91821a891a2f8b3c2e696d5ff812093760260d98464f',
    );
  });

  it('uses one independently pinned canonical control projection', () => {
    const bytes = format.canonicalControlBytes({
      z: 2,
      nested: { beta: true, alpha: 'x' },
      array: [{ y: 2, x: 1 }],
      a: 1,
    });

    expect(bytes.toString('utf8')).toBe(
      '{"a":1,"array":[{"x":1,"y":2}],"nested":{"alpha":"x","beta":true},"z":2}\n',
    );
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(
      '10957d363047d7cddd76178c8eb02689c36cef6589c005a2237961e8a52fee26',
    );
  });

  it.each([
    ['negative zero', -0],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects noncanonical control numbers: %s', (_label, value) => {
    expect(() => format.canonicalControlBytes({ value }))
      .toThrow('codegraph-overlay-generation-control-value-invalid');
  });

  it('streams the producer JSON projection with bounded internal chunks', () => {
    const value = {
      schemaVersion: 1,
      nested: {
        text: 'quote " slash \\ line\nemoji 😀',
        values: [1, true, null, { z: 3, a: 2 }],
      },
    };
    const chunks: Buffer[] = [];

    const evidence = format.writePrettyJson(value, chunk => chunks.push(Buffer.from(chunk)), 17);
    const bytes = Buffer.concat(chunks);
    const expected = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map(chunk => chunk.length))).toBeLessThanOrEqual(17);
    expect(bytes).toEqual(expected);
    expect(evidence).toEqual({
      bytes: expected.length,
      sha256: crypto.createHash('sha256').update(expected).digest('hex'),
    });
  });

  it('coalesces small JSON tokens into bounded writer windows', () => {
    const value = {
      records: Array.from({ length: 4_096 }, (_unused, index) => ({
        id: index,
        label: `record-${index}`,
        ready: index % 2 === 0,
      })),
    };
    const chunks: Buffer[] = [];
    const expected = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

    format.writePrettyJson(value, chunk => chunks.push(Buffer.from(chunk)), 1_024);

    expect(Buffer.concat(chunks)).toEqual(expected);
    expect(Math.max(...chunks.map(chunk => chunk.length))).toBeLessThanOrEqual(1_024);
    expect(chunks.length).toBeLessThanOrEqual(Math.ceil(expected.length / 512));
  });

  it('writes a reconstructable immutable skeleton and bounded JSONL array shards', () => {
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-08-03T00:00:00.000Z',
      project: { root: 'D:/Code/dde' },
      coverageTargets: ['typescript', 'angular'],
      typescript: {
        files: [{ path: 'src/a.ts' }],
        classes: [{ kind: 'class', name: 'A' }, { name: 'B', kind: 'class' }],
      },
      graph: {
        nodes: [{ id: 'class:src/a.ts:A', kind: 'class' }],
        edges: [],
      },
    };
    const open = new Map<string, Buffer[]>();
    const closed = new Map<string, Buffer>();

    const result = format.writeGenerationPayload({
      overlay,
      generationId: `g-${'a'.repeat(64)}`,
      sequence: '7',
      openFile(relativePath) {
        expect(open.has(relativePath)).toBe(false);
        const chunks: Buffer[] = [];
        open.set(relativePath, chunks);
        return {
          write(chunk) { chunks.push(Buffer.from(chunk)); },
          close() { closed.set(relativePath, Buffer.concat(chunks)); },
        };
      },
    });

    expect(open.size).toBe(closed.size);
    expect(result.compatibility.path).toBe('compatibility/nanoflow-overlay.json');
    expect(closed.get(result.compatibility.path)).toEqual(
      Buffer.from(`${JSON.stringify(overlay, null, 2)}\n`, 'utf8'),
    );
    expect(result.skeleton.path).toBe('payload/skeleton.json');

    const reconstructed = JSON.parse(closed.get(result.skeleton.path)!.toString('utf8')) as Record<string, unknown>;
    for (const array of result.arrays) {
      const records = array.shards.flatMap(shard => closed.get(shard.path)!.toString('utf8')
        .trimEnd()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as unknown));
      expect(records).toHaveLength(array.count);
      setAtPath(reconstructed, array.jsonPath, records);
      for (const shard of array.shards) {
        expect(shard.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
        expect(crypto.createHash('sha256').update(closed.get(shard.path)!).digest('hex'))
          .toBe(shard.sha256);
      }
    }
    expect(reconstructed).toEqual(overlay);
  });

  it('splits before a shard would cross the fixed 8 MiB production limit', () => {
    const record = 'x'.repeat(262_140);
    const closed = new Map<string, Buffer>();
    const result = format.writeGenerationPayload({
      overlay: { coverageTargets: Array.from({ length: 33 }, () => record) },
      generationId: `g-${'b'.repeat(64)}`,
      sequence: '8',
      openFile(relativePath) {
        const chunks: Buffer[] = [];
        return {
          write(chunk) { chunks.push(Buffer.from(chunk)); },
          close() { closed.set(relativePath, Buffer.concat(chunks)); },
        };
      },
    });
    const coverage = result.arrays.find(entry => entry.jsonPath.join('.') === 'coverageTargets');

    expect(coverage?.shards).toHaveLength(2);
    expect(coverage?.shards.reduce((total, shard) => total + shard.count, 0)).toBe(33);
    expect(Math.max(...coverage!.shards.map(shard => shard.bytes))).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('accepts an exact 262,144-byte JSONL record and rejects limit plus one', () => {
    const writeRecord = (textLength: number) => format.writeGenerationPayload({
      overlay: { coverageTargets: ['x'.repeat(textLength)] },
      generationId: `g-${'c'.repeat(64)}`,
      sequence: '9',
      openFile() {
        return { write() {}, close() {} };
      },
    });

    expect(() => writeRecord(262_141)).not.toThrow();
    expect(() => writeRecord(262_142))
      .toThrow('codegraph-overlay-generation-record-too-large');
  });
});
