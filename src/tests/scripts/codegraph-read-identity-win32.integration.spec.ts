import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const adapter = require('../../../scripts/lib/codegraph-read-identity.cjs') as {
  canonicalJson(value: unknown): string;
  normalizeReadRequest(
    projectRoot: string,
    relativePath: string,
    options?: { maxBytes?: number },
  ): {
    maxBytes: number;
    nonce: string;
    operation: string;
    protocol: string;
    relativePath: string;
    root: string;
  } | null;
  readCodegraphFileIdentity(
    projectRoot: string,
    relativePath: string,
    options: { maxBytes?: number; toolDirectory: string; timeoutMs?: number },
  ): {
    ok: boolean;
    error?: string;
    identity?: { volumeSerial: string; fileId: string };
    bytes?: Buffer;
    size?: number;
    sha256?: string;
    attestation?: {
      binaryIdentity: { volumeSerial: string; fileId: string };
      binarySha256: string;
    };
  };
  validateV2FrameSequence(frames: unknown[]): { ok: boolean; error?: string };
  computeV2ChunkDigest(chunk: unknown): { ok: boolean; digest?: string; error?: string };
};
const builder = require('../../../scripts/build-codegraph-read-identity-win32.cjs') as {
  createV2BuildProjection(): {
    buildId: string;
    projection: { generatedHeaderText: string };
  };
  buildReadIdentityTool(options: { outputRoot: string }): Promise<{
    ok: boolean;
    error?: string;
    toolDirectory?: string;
    binaryPath?: string;
    receiptPath?: string;
  }>;
  buildV2SourcePolicyTool(options: { outputRoot: string }): Promise<{
    ok: boolean;
    error?: string;
    toolDirectory?: string;
    binaryPath?: string;
    receiptPath?: string;
  }>;
};

const windows = process.platform === 'win32';
const roots: string[] = [];
let projectRoot = '';
let toolDirectory = '';
let binaryPath = '';
let v2ToolDirectory = '';
let v2BinaryPath = '';

function temporaryRoot(label: string): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), label));
  roots.push(result);
  return result;
}

function write(relativePath: string, bytes: Buffer | string): string {
  const target = path.join(projectRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

function read(relativePath: string, maxBytes = 1024 * 1024) {
  return adapter.readCodegraphFileIdentity(projectRoot, relativePath, {
    maxBytes,
    toolDirectory,
    timeoutMs: 15000,
  });
}

function invokeRaw(input: Buffer | string) {
  return spawnSync(binaryPath, [], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    env: {},
  });
}

beforeAll(async () => {
  if (!windows) return;
  projectRoot = temporaryRoot('nanoflow-read-identity-project-');
  const outputRoot = temporaryRoot('nanoflow-read-identity-tool-');
  const built = await builder.buildReadIdentityTool({ outputRoot });
  expect(built, built.error).toMatchObject({ ok: true });
  toolDirectory = built.toolDirectory ?? '';
  binaryPath = built.binaryPath ?? '';
  expect(fs.statSync(binaryPath).isFile()).toBe(true);
  expect(fs.statSync(built.receiptPath ?? '').isFile()).toBe(true);
  const v2OutputRoot = temporaryRoot('nanoflow-read-identity-v2-tool-');
  const v2Built = await builder.buildV2SourcePolicyTool({ outputRoot: v2OutputRoot });
  expect(v2Built, v2Built.error).toMatchObject({ ok: true });
  v2ToolDirectory = v2Built.toolDirectory ?? '';
  v2BinaryPath = v2Built.binaryPath ?? '';
  expect(fs.statSync(v2BinaryPath).isFile()).toBe(true);
  expect(fs.statSync(v2Built.receiptPath ?? '').isFile()).toBe(true);
}, 120_000);

afterAll(() => {
  for (const target of roots.splice(0).reverse()) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe('CodeGraph read-identity native Windows helper', () => {
  it.runIf(windows)('accepts the attestBuiltTool byte-equivalent request natively', () => {
    const absolute = path.resolve(binaryPath);
    const root = path.parse(absolute).root;
    const relativePath = path.relative(root, absolute).split(path.sep).join('/');
    const request = adapter.normalizeReadRequest(root, relativePath, {
      maxBytes: 67108864,
    });
    expect(request).not.toBeNull();
    if (!request) throw new Error('normalizeReadRequest returned null');
    const result = invokeRaw(`${adapter.canonicalJson(request)}\n`);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      protocol: string;
      nonce: string;
      identity: { volumeSerial: string; fileId: string };
      attestation: { binarySha256: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.protocol).toBe('codegraph-read-identity-v1');
    expect(parsed.nonce).toBe(request.nonce);
    expect(parsed.identity.volumeSerial).toMatch(/^[a-f0-9]{16}$/);
    expect(parsed.identity.fileId).toMatch(/^[a-f0-9]{32}$/);
    expect(parsed.attestation.binarySha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.runIf(windows)('returns exact binary bytes and stable 128-bit identity from one handle', () => {
    const bytes = Buffer.from([0, 0xff, 0x80, 0x0d, 0x0a, 0, 1, 2]);
    write('Data/Binary.bin', bytes);
    const first = read('Data/Binary.bin');
    const second = read('Data/Binary.bin');
    expect(first).toMatchObject({
      ok: true,
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      identity: {
        volumeSerial: expect.stringMatching(/^[a-f0-9]{16}$/),
        fileId: expect.stringMatching(/^[a-f0-9]{32}$/),
      },
    });
    expect(first.bytes).toEqual(bytes);
    expect(second.identity).toEqual(first.identity);
    expect(first.attestation?.binaryIdentity).toEqual(second.attestation?.binaryIdentity);
    expect(first.attestation?.binarySha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.runIf(windows)('distinguishes equal bytes at different file identities', () => {
    write('same-a.txt', 'same');
    write('same-b.txt', 'same');
    const first = read('same-a.txt');
    const second = read('same-b.txt');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.sha256).toBe(first.sha256);
    expect(second.identity).not.toEqual(first.identity);
  });

  it.runIf(windows)('retains identity while reporting changed bytes on a later read', () => {
    const target = write('changed.txt', 'before');
    const before = read('changed.txt');
    fs.writeFileSync(target, 'after!');
    const after = read('changed.txt');
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    expect(after.identity).toEqual(before.identity);
    expect(after.sha256).not.toBe(before.sha256);
  });

  it.runIf(windows)('enforces byte cap and cap plus one without partial payload', () => {
    write('bounded.bin', Buffer.alloc(33, 7));
    expect(read('bounded.bin', 33)).toMatchObject({ ok: true, size: 33 });
    expect(read('bounded.bin', 32)).toEqual({ ok: false, error: 'FILE_TOO_LARGE' });
  });

  it.runIf(windows)('rejects hardlinks and does not return bytes', () => {
    const original = write('original.txt', 'hardlinked');
    fs.linkSync(original, path.join(projectRoot, 'linked.txt'));
    expect(read('original.txt')).toEqual({ ok: false, error: 'PATH_HARDLINK' });
    expect(read('linked.txt')).toEqual({ ok: false, error: 'PATH_HARDLINK' });
  });

  it.runIf(windows)('rejects junction and symbolic-link traversal', () => {
    const outside = temporaryRoot('nanoflow-read-identity-outside-');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(outside, path.join(projectRoot, 'junction'), 'junction');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(projectRoot, 'file-link.txt'), 'file');
    expect(read('junction/secret.txt')).toEqual({ ok: false, error: 'PATH_REPARSE' });
    expect(read('file-link.txt')).toEqual({ ok: false, error: 'PATH_REPARSE' });
  });

  it.runIf(windows)('rejects case aliases, ADS, traversal, namespaces, and trailing normalization', () => {
    write('ExactCase/File.txt', 'case');
    expect(read('exactcase/File.txt')).toEqual({ ok: false, error: 'PATH_CASE_MISMATCH' });
    expect(read('ExactCase/file.txt')).toEqual({ ok: false, error: 'PATH_CASE_MISMATCH' });
    expect(read('ExactCase/File.txt:stream')).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(read('../outside.txt')).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(read('ExactCase./File.txt')).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(adapter.readCodegraphFileIdentity('\\\\?\\C:\\', 'file', { toolDirectory }))
      .toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(adapter.readCodegraphFileIdentity('\\\\server\\share', 'file', { toolDirectory }))
      .toEqual({ ok: false, error: 'INVALID_REQUEST' });
  });

  it.runIf(windows)('rejects directories and missing targets with fixed errors', () => {
    fs.mkdirSync(path.join(projectRoot, 'directory'));
    expect(read('directory')).toEqual({ ok: false, error: 'PATH_NOT_REGULAR' });
    expect(read('missing.txt')).toEqual({ ok: false, error: 'PATH_NOT_FOUND' });
  });

  it.runIf(windows)('rejects malformed, multiple, oversized, and invalid UTF-8 requests natively', () => {
    const expected = JSON.stringify({
      error: 'INVALID_REQUEST',
      nonce: '0'.repeat(32),
      ok: false,
      protocol: 'codegraph-read-identity-v1',
    });
    for (const input of [
      '{"extra":true}\n',
      '{}\n{}\n',
      `${'x'.repeat(8193)}\n`,
      Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a]),
    ]) {
      const result = invokeRaw(input);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(expected);
      expect(result.stdout).not.toMatch(/[A-Z]:\\|secret|Program Files/i);
    }
  });

  it.runIf(windows)('never reflects unsafe nonce text into native error JSON', () => {
    const expected = JSON.stringify({
      error: 'INVALID_REQUEST',
      nonce: '0'.repeat(32),
      ok: false,
      protocol: 'codegraph-read-identity-v1',
    });
    const request = (nonce: string) => `${JSON.stringify({
      maxBytes: 1,
      nonce,
      operation: 'read',
      protocol: 'codegraph-read-identity-v1',
      relativePath: 'missing.txt',
      root: projectRoot,
    })}\n`;
    const textVectors = [
      `${'a'.repeat(31)}"`,
      `${'a'.repeat(31)}\\`,
      `${'a'.repeat(31)}\u0001`,
      `${'a'.repeat(31)}é`,
      `${'a'.repeat(31)}\ud800`,
    ];
    const invalidUtf8 = Buffer.concat([
      Buffer.from('{"maxBytes":1,"nonce":"'),
      Buffer.from('a'.repeat(31)),
      Buffer.from([0xff]),
      Buffer.from(`","operation":"read","protocol":"codegraph-read-identity-v1",`
        + `"relativePath":"missing.txt","root":${JSON.stringify(projectRoot)}}\n`),
    ]);
    for (const input of [...textVectors.map(request), invalidUtf8]) {
      const result = invokeRaw(input);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(expected);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
  });

  it.runIf(windows)('rejects a same-bytes replacement PE with a different file identity', () => {
    const cloneRoot = temporaryRoot('nanoflow-read-identity-clone-');
    const clone = path.join(cloneRoot, 'tool');
    fs.cpSync(toolDirectory, clone, { recursive: true });
    expect(adapter.readCodegraphFileIdentity(projectRoot, 'same-a.txt', {
      toolDirectory: clone,
    })).toEqual({ ok: false, error: 'PROTOCOL_INVALID' });
  });

  it.runIf(windows)('rejects a tampered PE before native execution', () => {
    const cloneRoot = temporaryRoot('nanoflow-read-identity-tamper-');
    const clone = path.join(cloneRoot, 'tool');
    fs.cpSync(toolDirectory, clone, { recursive: true });
    const binary = path.join(clone, 'codegraph-read-identity-win32.exe');
    const bytes = fs.readFileSync(binary);
    bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(binary, bytes);
    expect(adapter.readCodegraphFileIdentity(projectRoot, 'same-a.txt', {
      toolDirectory: clone,
    })).toEqual({ ok: false, error: 'TOOL_UNTRUSTED' });
  });

  it.runIf(!windows)('fails closed instead of substituting Node identity evidence', () => {
    const result = adapter.readCodegraphFileIdentity('/tmp/project', 'file.json', {
      toolDirectory: '/tmp/untrusted-tool',
    });
    expect(result).toEqual({ ok: false, error: 'UNSUPPORTED_PLATFORM' });
  });
});

describe('CodeGraph V2 source-policy native Windows tool', () => {
  it.runIf(windows)('exposes a V2 build projection carrying buildId and inner projection', () => {
    const projection = builder.createV2BuildProjection();
    expect(typeof projection.buildId).toBe('string');
    expect(projection.buildId).toMatch(/^[a-f0-9]{64}$/);
    expect(projection.projection.generatedHeaderText).toBeTypeOf('string');
    expect(projection.projection.generatedHeaderText).toContain('CODEGRAPH_READ_IDENTITY_V2_POLICY_DEFINITION_DIGEST');
    expect(projection.projection.generatedHeaderText).toContain('CODEGRAPH_READ_IDENTITY_V2_PATH_SET_DIGEST');
  });

  function decodeFrames(output: Buffer): unknown[] {
    let offset = 0;
    const frames: unknown[] = [];
    while (offset < output.length) {
      expect(output.length - offset).toBeGreaterThanOrEqual(9);
      const bodyLength = Number(output.readBigUInt64BE(offset));
      offset += 8;
      expect(Number.isSafeInteger(bodyLength)).toBe(true);
      expect(bodyLength).toBeGreaterThan(0);
      expect(output.length - offset).toBeGreaterThanOrEqual(bodyLength + 1);
      const body = output.subarray(offset, offset + bodyLength);
      offset += bodyLength;
      expect(output[offset]).toBe(0x0a);
      offset += 1;
      frames.push(JSON.parse(body.toString('utf8')));
    }
    return frames;
  }

  function invokeV2(request: Record<string, unknown>) {
    return spawnSync(v2BinaryPath, [], {
      input: `${adapter.canonicalJson(request)}\n`,
      encoding: null,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 64 * 1024 * 1024,
      env: {},
    });
  }

  function validV2FrameFixture(operation: 'read' | 'manifest', chunkCount: number, entryCount = 1) {
    const tuple = {
      attestation: {
        before: {
          ctimeNs: '1', fileId: 'a'.repeat(32), hardlinkCount: '1', mtimeNs: '1',
          reparseState: 'NOT_REPARSE', size: '1', volumeSerial: 'b'.repeat(8),
        },
        after: {
          ctimeNs: '1', fileId: 'a'.repeat(32), hardlinkCount: '1', mtimeNs: '1',
          reparseState: 'NOT_REPARSE', size: '1', volumeSerial: 'b'.repeat(8),
        },
        oplock: 'HELD_NO_BREAK',
      },
      entryIndex: '0',
      identity: { fileId: 'a'.repeat(32), volumeSerial: 'b'.repeat(8) },
      relativePath: 'file.txt',
      sha256: 'c'.repeat(64),
      size: '1',
    };
    const common = {
      operation,
      protocol: 'CG2/2.8',
      receiptSha256: '1'.repeat(64),
      rootIdentity: '2'.repeat(64),
      sessionId: '3'.repeat(32),
      snapshotId: '4'.repeat(32),
    };
    const captured = {
      ...tuple,
      decodedBytesBase64: Buffer.from([1]).toString('base64url'),
      decodedLength: '1',
    };
    const result = {
      aggregateRawBytes: '1',
      capturedRawDigest: 'a'.repeat(64),
      contentDigest: 'b'.repeat(64),
      entryCount: String(entryCount),
      finalCensusDigest: 'c'.repeat(64),
      finalProjectionCoreDigest: 'd'.repeat(64),
      initialCensusDigest: 'e'.repeat(64),
      metadataDigest: 'f'.repeat(64),
      pathSetDigest: '0'.repeat(64),
      sourcePolicyDigest: '1'.repeat(64),
    };
    const frames: unknown[] = [
      {
        kind: 'start', phase: 'census', entryCount, chunkCount,
        initialCensusDigest: result.initialCensusDigest, pathSetDigest: result.pathSetDigest,
        ...common,
      },
      ...Array.from({ length: entryCount }, (_, entryIndex) => ({
        kind: 'initialCensus', phase: 'census', entryIndex: String(entryIndex),
        censusTuple: { ...tuple, entryIndex: String(entryIndex) }, ...common,
      })),
    ];
    if (operation === 'read') {
      frames.push({ kind: 'captured', phase: 'read', capturedEntry: captured, ...common });
    } else {
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const chunk = {
          kind: 'chunk', phase: 'read', chunkIndex, chunkCount,
          cursorBefore: 'Yg', cursorAfter: 'Yw',
          items: Array.from({ length: entryCount }, (_, entryIndex) => ({
            ...tuple, entryIndex: String(entryIndex),
          })),
          ...common,
        };
        const computed = adapter.computeV2ChunkDigest(chunk);
        expect(computed.ok).toBe(true);
        frames.push({ ...chunk, chunkDigest: computed.digest });
        for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
          frames.push({
            kind: 'captured', phase: 'read',
            capturedEntry: { ...captured, entryIndex: String(entryIndex) },
            ...common,
          });
        }
      }
    }
    frames.push(
      ...Array.from({ length: entryCount }, (_, entryIndex) => ({
        kind: 'finalCensus', phase: 'attestation', entryIndex: String(entryIndex),
        censusTuple: { ...tuple, entryIndex: String(entryIndex) }, ...common,
      })),
      ...Array.from({ length: entryCount }, (_, entryIndex) => ({
        kind: 'projection', phase: 'source-policy',
        projectionEntry: {
          class: 'INCLUDE', entryIndex: String(entryIndex), path: 'file.txt',
          role: 'source', sha256: tuple.sha256, size: '1',
        },
        ...common,
      })),
      { kind: 'end', phase: 'attestation', ...result, ...common },
      { kind: 'finalSuccess', phase: 'publication', success: true, result, ...common },
    );
    return frames;
  }

  it.runIf(!windows)('accepts a valid chunkless read frame sequence', () => {
    const frames = validV2FrameFixture('read', 0);
    expect(adapter.validateV2FrameSequence(frames)).toMatchObject({ ok: true });
  });

  it.runIf(!windows)('rejects read frames that introduce chunks', () => {
    const frames = validV2FrameFixture('read', 1);
    expect(adapter.validateV2FrameSequence(frames)).toEqual({ ok: false, error: 'PROTOCOL_SEQUENCE' });
  });

  it.runIf(!windows)('preserves manifest chunk rules', () => {
    const frames = validV2FrameFixture('manifest', 1);
    expect(adapter.validateV2FrameSequence(frames)).toMatchObject({ ok: true });
  });

  it.runIf(windows)('emits schema-correct read frames and stable identity', () => {
    write('V2Read.txt', 'read payload');
    const request = {
      operation: 'read',
      nonce: 'd'.repeat(32),
      protocol: 'CG2/2.8',
      rootAbsolutePath: projectRoot,
      relativePath: 'V2Read.txt',
      maxBytes: 1024 * 1024,
    };
    const result = invokeV2(request);
    expect(result.status).toBe(0);
    expect(result.stderr.length).toBe(0);
    const frames = decodeFrames(result.stdout);
    expect(adapter.validateV2FrameSequence(frames)).toMatchObject({ ok: true });
    const captured = frames.find(
      (frame): frame is { kind: 'captured'; capturedEntry: { identity: { fileId: string; volumeSerial: string } } } =>
        (frame as { kind: string }).kind === 'captured',
    ) as { capturedEntry: { identity: { fileId: string; volumeSerial: string } } };
    expect(captured.capturedEntry.identity.fileId).toMatch(/^[a-f0-9]{32}$/);
    expect(captured.capturedEntry.identity.volumeSerial).toMatch(/^[a-f0-9]{8}$/);
  });

  it.runIf(windows)('emits schema-correct nonempty manifest frames', () => {
    const manifestRoot = temporaryRoot('nanoflow-read-identity-v2-manifest-');
    fs.writeFileSync(path.join(manifestRoot, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(manifestRoot, 'b.sql'), 'select 1;\n');
    const request = {
      operation: 'manifest',
      nonce: 'e'.repeat(32),
      protocol: 'CG2/2.8',
      rootAbsolutePath: manifestRoot,
      maxAggregateBytes: 1024 * 1024,
    };
    const result = invokeV2(request);
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(result.stderr.length).toBe(0);
    const frames = decodeFrames(result.stdout);
    expect(adapter.validateV2FrameSequence(frames)).toMatchObject({ ok: true });
    expect((frames[0] as { entryCount: number }).entryCount).toBeGreaterThan(0);
  });

  it.runIf(windows)('rejects malformed V2 request with bounded error sequence', () => {
    const result = invokeV2({ operation: 'read', nonce: 'x' });
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.toString()).toMatch(/ADAPTER_BAD_REQUEST/);
  });

  it.runIf(windows)('writes a receipt that binds compiled implementation parts', () => {
    const receiptPath = path.join(v2ToolDirectory, 'codegraph-source-policy-win32.receipt.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    expect(receipt.artifactRevision).toBe(41);
    expect(receipt.protocol).toBe('CG2/2.8');
    expect(receipt.generatedHeader.projectionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Array.isArray(receipt.implementationParts)).toBe(true);
    expect(receipt.sourceArrays.map((row: { row: string }) => row.row))
      .toEqual(['01', '02', '03', '12', '13', '15']);
  });
});
