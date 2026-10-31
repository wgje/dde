import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const root = process.cwd();
const contractPath = path.join(root, 'scripts', 'contracts', 'codegraph-read-identity-v1.json');

type FixedErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'INVALID_REQUEST'
  | 'INVALID_ROOT'
  | 'INVALID_PATH'
  | 'PATH_NOT_FOUND'
  | 'PATH_REPARSE'
  | 'PATH_CASE_MISMATCH'
  | 'PATH_HARDLINK'
  | 'PATH_NOT_REGULAR'
  | 'FILE_TOO_LARGE'
  | 'FILE_DRIFT'
  | 'FILE_READ_FAILED'
  | 'TOOL_UNAVAILABLE'
  | 'TOOL_UNTRUSTED'
  | 'TOOL_TIMEOUT'
  | 'PROTOCOL_INVALID';

type ReadResult =
  | {
      ok: true;
      identity: { volumeSerial: string; fileId: string };
      size: number;
      lastWriteTime: string;
      sha256: string;
      bytes: Buffer;
      attestation: {
        binaryIdentity: { volumeSerial: string; fileId: string };
        binarySha256: string;
        buildId: string;
        protocolSha256: string;
        sourceSha256: string;
      };
    }
  | { ok: false; error: FixedErrorCode };

const adapter = require('../../../scripts/lib/codegraph-read-identity.cjs') as {
  PROTOCOL_NAME: string;
  FIXED_ERROR_CODES: readonly FixedErrorCode[];
  canonicalJson(value: unknown): string;
  validateV2FrameSequence(frames: unknown[]): { ok: boolean; error?: string };
  normalizeReadRequest(
    projectRoot: string,
    relativePath: string,
    options?: { maxBytes?: number; nonce?: string },
  ): Record<string, unknown> | null;
  decodeNativeResponse(
    text: string,
    expected: {
      nonce: string;
      binaryIdentity: { volumeSerial: string; fileId: string };
      binarySha256: string;
      buildId: string;
      protocolSha256: string;
      sourceSha256: string;
    },
  ): ReadResult;
  readCodegraphFileIdentity(
    projectRoot: string,
    relativePath: string,
    options?: { maxBytes?: number; toolDirectory?: string; timeoutMs?: number; platform?: string },
  ): ReadResult;
};
const builder = require('../../../scripts/build-codegraph-read-identity-win32.cjs') as {
  buildReadIdentityTool(
    options: { outputRoot: string },
    runtime?: {
      platform: string;
      arch: string;
      findVisualStudio(): string;
      findCompiler(installation: string): { compilerPath: string; toolsRoot: string };
      findWindowsSdk(): { sdkRoot: string; version: string };
      runCompiler(
        compilerPath: string,
        args: string[],
        options: { cwd: string; env: NodeJS.ProcessEnv },
      ): Promise<{ ok: boolean; error?: string }>;
      attestBuiltTool(
        binaryPath: string,
        expected: {
          binarySha256: string;
          buildId: string;
          protocolSha256: string;
          sourceSha256: string;
        },
      ): { binaryIdentity: { fileId: string; volumeSerial: string } } | null;
      removeTemporary(target: string, options: { recursive: boolean; force: boolean }): void;
    },
  ): Promise<{ ok: boolean; error?: string; toolDirectory?: string; receiptPath?: string }>;
  createV2BuildProjection(): {
    buildId: string;
    projection: {
      architecture: string;
      artifactRevision: number;
      protocol: string;
      generatedHeader: { classification: string; logicalPath: string };
      generatedHeaderText: string;
      sourceArrays: Array<{ row: string }>;
    };
  };
  buildV2SourcePolicyTool(options: { outputRoot: string }): Promise<{
    ok: boolean;
    error?: string;
    toolDirectory?: string;
    binaryPath?: string;
    receiptPath?: string;
  }>;
};

const v2NativeSource = fs.readFileSync(
  path.join(root, 'scripts', 'native', 'codegraph-source-policy-win32.cpp'),
  'utf8',
);
const v2RootContract = JSON.parse(fs.readFileSync(
  path.join(root, 'scripts', 'contracts', 'codegraph-read-identity-v2.json'),
  'utf8',
));
const v2CompanionContract = JSON.parse(fs.readFileSync(
  path.join(root, 'scripts', 'contracts', 'codegraph-read-identity-v2-companion.json'),
  'utf8',
));

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function minimalTrustedPeX64(): Buffer {
  const bytes = Buffer.alloc(0x200);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(0xf0, 0x94);
  bytes.writeUInt16LE(0x0002, 0x96);
  bytes.writeUInt16LE(0x020b, 0x98);
  bytes.writeUInt16LE(0x4160, 0xde);
  return bytes;
}

function successLine(overrides: Record<string, unknown> = {}): string {
  const bytes = Buffer.from([0, 1, 2, 0xfe, 0xff]);
  const value = {
    attestation: {
      binaryIdentity: { fileId: '23'.repeat(16), volumeSerial: '00000000cafebabe' },
      binarySha256: 'e'.repeat(64),
      buildId: 'a'.repeat(64),
      protocolSha256: 'b'.repeat(64),
      sourceSha256: 'c'.repeat(64),
    },
    bytesBase64: bytes.toString('base64'),
    identity: { fileId: '01'.repeat(16), volumeSerial: '000000001234abcd' },
    lastWriteTime: '133801632000000000',
    nonce: 'd'.repeat(32),
    ok: true,
    protocol: 'codegraph-read-identity-v1',
    sha256: sha256(bytes),
    size: bytes.length,
    ...overrides,
  };
  return adapter.canonicalJson(value);
}

const expected = {
  nonce: 'd'.repeat(32),
  binaryIdentity: { fileId: '23'.repeat(16), volumeSerial: '00000000cafebabe' },
  binarySha256: 'e'.repeat(64),
  buildId: 'a'.repeat(64),
  protocolSha256: 'b'.repeat(64),
  sourceSha256: 'c'.repeat(64),
};
const { nonce: _expectedNonce, ...expectedAttestation } = expected;

describe('CodeGraph native read-identity v1 adapter', () => {
  it('pins the complete bounded canonical wire contract and fixed errors', () => {
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    expect(contract).toEqual({
      schemaVersion: 1,
      protocol: 'codegraph-read-identity-v1',
      operation: 'read',
      limits: {
        requestBytes: 8192,
        responseBytes: 89479168,
        fileBytes: 67108864,
        pathCharacters: 32767,
        components: 256,
        timeoutMs: 15000,
      },
      requestKeys: ['maxBytes', 'nonce', 'operation', 'protocol', 'relativePath', 'root'],
      successKeys: [
        'attestation', 'bytesBase64', 'identity', 'lastWriteTime', 'nonce', 'ok',
        'protocol', 'sha256', 'size',
      ],
      errorKeys: ['error', 'nonce', 'ok', 'protocol'],
      attestationKeys: [
        'binaryIdentity', 'binarySha256', 'buildId', 'protocolSha256', 'sourceSha256',
      ],
      identityKeys: ['fileId', 'volumeSerial'],
      errors: [
        'UNSUPPORTED_PLATFORM', 'INVALID_REQUEST', 'INVALID_ROOT', 'INVALID_PATH',
        'PATH_NOT_FOUND', 'PATH_REPARSE', 'PATH_CASE_MISMATCH', 'PATH_HARDLINK',
        'PATH_NOT_REGULAR', 'FILE_TOO_LARGE', 'FILE_DRIFT', 'FILE_READ_FAILED',
        'TOOL_UNAVAILABLE', 'TOOL_UNTRUSTED', 'TOOL_TIMEOUT', 'PROTOCOL_INVALID',
      ],
    });
    expect(adapter.PROTOCOL_NAME).toBe(contract.protocol);
    expect(adapter.FIXED_ERROR_CODES).toEqual(contract.errors);
    expect(Object.isFrozen(adapter.FIXED_ERROR_CODES)).toBe(true);
  });

  it('builds the only accepted canonical request shape', () => {
    expect(adapter.normalizeReadRequest('C:\\Repo', '.codegraph/CURRENT.json', {
      maxBytes: 4096,
      nonce: '1'.repeat(32),
    })).toEqual({
      maxBytes: 4096,
      nonce: '1'.repeat(32),
      operation: 'read',
      protocol: 'codegraph-read-identity-v1',
      relativePath: '.codegraph/CURRENT.json',
      root: 'C:\\Repo',
    });
  });

  it.each([
    ['relative root', 'Repo', 'file.json'],
    ['UNC root', '\\\\server\\share', 'file.json'],
    ['device root', '\\\\?\\C:\\Repo', 'file.json'],
    ['NT root', '\\??\\C:\\Repo', 'file.json'],
    ['escape', 'C:\\Repo', '../file.json'],
    ['absolute child', 'C:\\Repo', 'C:/file.json'],
    ['ADS', 'C:\\Repo', 'file.json:stream'],
    ['device component', 'C:\\Repo', 'CON/file.json'],
    ['trailing dot', 'C:\\Repo', 'dir./file.json'],
    ['trailing space', 'C:\\Repo', 'dir /file.json'],
    ['empty component', 'C:\\Repo', 'dir//file.json'],
  ])('rejects %s before native execution', (_label, projectRoot, relativePath) => {
    expect(adapter.normalizeReadRequest(projectRoot, relativePath)).toBeNull();
  });

  it('decodes binary bytes and recursively freezes identity evidence', () => {
    const result = adapter.decodeNativeResponse(successLine(), expected);
    expect(result).toMatchObject({
      ok: true,
      identity: { fileId: '01'.repeat(16), volumeSerial: '000000001234abcd' },
      size: 5,
      lastWriteTime: '133801632000000000',
      sha256: sha256(Buffer.from([0, 1, 2, 0xfe, 0xff])),
      attestation: {
        binaryIdentity: expected.binaryIdentity,
        binarySha256: expected.binarySha256,
        buildId: expected.buildId,
        protocolSha256: expected.protocolSha256,
        sourceSha256: expected.sourceSha256,
      },
    });
    if (!result.ok) throw new Error('expected success');
    expect(result.bytes).toEqual(Buffer.from([0, 1, 2, 0xfe, 0xff]));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.identity)).toBe(true);
    expect(Object.isFrozen(result.attestation)).toBe(true);
    expect(Object.isFrozen(result.attestation.binaryIdentity)).toBe(true);
  });

  it.each([
    ['noncanonical JSON', `${successLine()} `],
    ['extra key', successLine({ extra: true })],
    ['wrong nonce', successLine({ nonce: 'e'.repeat(32) })],
    ['wrong attestation', successLine({
      attestation: { ...expectedAttestation, buildId: 'f'.repeat(64) },
    })],
    ['wrong runtime PE digest', successLine({
      attestation: { ...expectedAttestation, binarySha256: 'f'.repeat(64) },
    })],
    ['wrong runtime PE identity', successLine({
      attestation: {
        ...expectedAttestation,
        binaryIdentity: { ...expected.binaryIdentity, fileId: '45'.repeat(16) },
      },
    })],
    ['bad identity', successLine({ identity: { fileId: '01', volumeSerial: '000000001234abcd' } })],
    ['bad base64', successLine({ bytesBase64: 'AA=A' })],
    ['size mismatch', successLine({ size: 6 })],
    ['digest mismatch', successLine({ sha256: '0'.repeat(64) })],
    ['second JSON line', `${successLine()}\n${successLine()}`],
  ])('fails closed for %s', (_label, text) => {
    expect(adapter.decodeNativeResponse(text, expected)).toEqual({
      ok: false,
      error: 'PROTOCOL_INVALID',
    });
  });

  it('accepts only a canonical sanitized native error', () => {
    const valid = adapter.canonicalJson({
      error: 'PATH_REPARSE',
      nonce: expected.nonce,
      ok: false,
      protocol: adapter.PROTOCOL_NAME,
    });
    expect(adapter.decodeNativeResponse(valid, expected)).toEqual({
      ok: false,
      error: 'PATH_REPARSE',
    });
    const leaked = valid.replace('PATH_REPARSE', 'C:\\\\secret\\file.txt');
    expect(adapter.decodeNativeResponse(leaked, expected)).toEqual({
      ok: false,
      error: 'PROTOCOL_INVALID',
    });
  });

  it('sanitizes an unsafe parsed nonce before native error JSON reflection', () => {
    const source = fs.readFileSync(
      path.join(root, 'scripts', 'native', 'codegraph-read-identity-win32.cpp'),
      'utf8',
    );
    expect(source).toMatch(/std::string safeNonce\(std::string_view nonce\)/);
    expect(source).toMatch(/nonce\.size\(\) == 32[\s\S]*std::string\(32, '0'\)/);
    expect(source).toMatch(/errorJson\([\s\S]*safeNonce\(nonce\)/);
  });

  it('fails closed without invoking any Node filesystem identity fallback', () => {
    expect(adapter.readCodegraphFileIdentity('C:\\Repo', 'file.json', {
      platform: 'linux',
    })).toEqual({ ok: false, error: 'UNSUPPORTED_PLATFORM' });
    const source = fs.readFileSync(
      path.join(root, 'scripts', 'lib', 'codegraph-read-identity.cjs'),
      'utf8',
    );
    expect(source).not.toMatch(/\b(?:statSync|lstatSync|realpathSync)\s*\(/);
    expect(source).not.toMatch(/\b(?:dev|ino)\b/);
  });

  it('fails closed when no fully attested native tool is present', () => {
    expect(adapter.readCodegraphFileIdentity('C:\\Repo', 'file.json', {
      platform: 'win32',
      toolDirectory: 'C:\\missing-read-identity-tool',
    })).toEqual({ ok: false, error: 'TOOL_UNTRUSTED' });
  });

  it('owns and removes only its hermetic successful-build temporary directory', async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'read-identity-builder-'));
    const outputRoot = path.join(testRoot, 'output');
    const compilerPath = path.join(testRoot, 'cl.exe');
    fs.writeFileSync(compilerPath, 'trusted-compiler');
    const removed: string[] = [];
    const runtime = {
      platform: 'win32',
      arch: 'x64',
      findVisualStudio: () => testRoot,
      findCompiler: () => ({ compilerPath, toolsRoot: testRoot }),
      findWindowsSdk: () => ({ sdkRoot: testRoot, version: '10.0.26100.0' }),
      runCompiler: async (_compilerPath: string, args: string[]) => {
        const output = args.find(value => value.startsWith('/Fe:'))?.slice(4);
        if (!output) return { ok: false, error: 'BUILD_FAILED' };
        fs.writeFileSync(output, minimalTrustedPeX64());
        return { ok: true };
      },
      attestBuiltTool: (binaryPath: string) => ({
        binaryIdentity: {
          fileId: sha256(fs.readFileSync(binaryPath)).slice(0, 32),
          volumeSerial: '000000001234abcd',
        },
      }),
      removeTemporary: (target: string, options: { recursive: boolean; force: boolean }) => {
        removed.push(target);
        fs.rmSync(target, options);
      },
    };
    try {
      const result = await builder.buildReadIdentityTool({ outputRoot }, runtime);
      expect(result).toMatchObject({ ok: true });
      expect(fs.existsSync(result.receiptPath ?? '')).toBe(true);
      const receipt = JSON.parse(fs.readFileSync(result.receiptPath ?? '', 'utf8'));
      expect(receipt.binaryIdentity).toEqual({
        fileId: sha256(minimalTrustedPeX64()).slice(0, 32),
        volumeSerial: '000000001234abcd',
      });
      expect(removed).toEqual([]);
      expect(fs.readdirSync(outputRoot).some(name => name.includes('.tmp-'))).toBe(false);
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('does not let owned-temporary cleanup mask the primary compiler error', async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'read-identity-cleanup-'));
    const outputRoot = path.join(testRoot, 'output');
    const compilerPath = path.join(testRoot, 'cl.exe');
    fs.writeFileSync(compilerPath, 'trusted-compiler');
    let cleanupTarget = '';
    try {
      const result = await builder.buildReadIdentityTool({ outputRoot }, {
        platform: 'win32',
        arch: 'x64',
        findVisualStudio: () => testRoot,
        findCompiler: () => ({ compilerPath, toolsRoot: testRoot }),
        findWindowsSdk: () => ({ sdkRoot: testRoot, version: '10.0.26100.0' }),
        runCompiler: async () => ({ ok: false, error: 'BUILD_OUTPUT_LIMIT' }),
        attestBuiltTool: () => null,
        removeTemporary: target => {
          cleanupTarget = target;
          throw new Error('simulated cleanup failure');
        },
      });
      expect(result).toEqual({ ok: false, error: 'BUILD_OUTPUT_LIMIT' });
      expect(path.relative(outputRoot, cleanupTarget)).not.toMatch(/^\.\.(?:[\\/]|$)/);
    } finally {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('registers only the bounded build command and Windows gate', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.scripts['codegraph:read-identity:build'])
      .toBe('node scripts/build-codegraph-read-identity-win32.cjs --json');
    const workflow = fs.readFileSync(
      path.join(root, '.github', 'workflows', 'test-full-suite.yml'),
      'utf8',
    );
    expect(workflow.match(/^  codegraph-read-identity-win32:$/gm)).toHaveLength(1);
    expect(workflow).toContain('runs-on: windows-2022');
    expect(workflow).toContain('npm run codegraph:read-identity:build');
    expect(workflow).toContain('codegraph-read-identity-win32.integration.spec.ts');
  });

  it('derives native runtime PE evidence from the loaded current-process image', () => {
    const source = fs.readFileSync(
      path.join(root, 'scripts', 'native', 'codegraph-read-identity-win32.cpp'),
      'utf8',
    );
    expect(source).toMatch(/GetModuleFileNameW\(\s*nullptr,/);
    expect(source).toMatch(/CreateFileW\([\s\S]*GENERIC_READ \| FILE_READ_ATTRIBUTES/);
    expect(source).toMatch(/readStable\(image\.value, kMaxFileBytes, imageEvidence,/);
    expect(source).toContain('binaryIdentity');
    expect(source).toContain('binarySha256');
  });
});

describe('CodeGraph native read-identity v2 frame authority', () => {
  it('accepts only the closed empty-manifest success sequence', () => {
    const common = {
      operation: 'manifest',
      protocol: 'CG2/2.8',
      receiptSha256: 'a'.repeat(64),
      rootIdentity: 'b'.repeat(64),
      sessionId: 'c'.repeat(32),
      snapshotId: 'd'.repeat(32),
    };
    const result = {
      aggregateRawBytes: '0',
      capturedRawDigest: 'e'.repeat(64),
      contentDigest: 'f'.repeat(64),
      entryCount: '0',
      finalCensusDigest: '1'.repeat(64),
      finalProjectionCoreDigest: '2'.repeat(64),
      initialCensusDigest: '3'.repeat(64),
      metadataDigest: '4'.repeat(64),
      pathSetDigest: '5'.repeat(64),
      sourcePolicyDigest: '6'.repeat(64),
    };
    const frames = [
      {
        ...common,
        chunkCount: 0,
        entryCount: 0,
        initialCensusDigest: result.initialCensusDigest,
        kind: 'start',
        pathSetDigest: result.pathSetDigest,
        phase: 'census',
      },
      { ...common, ...result, kind: 'end', phase: 'attestation' },
      { ...common, kind: 'finalSuccess', phase: 'publication', result, success: true },
    ];

    expect(adapter.validateV2FrameSequence(frames)).toEqual({ ok: true });
    expect(adapter.validateV2FrameSequence([...frames, frames[2]])).toEqual({
      ok: false,
      error: 'PROTOCOL_SEQUENCE',
    });
  });

  it('derives an acyclic v2 build projection from the six owned source rows', () => {
    const first = builder.createV2BuildProjection();
    const second = builder.createV2BuildProjection();
    expect(first).toEqual(second);
    expect(first.projection).toMatchObject({
      architecture: 'x64',
      artifactRevision: 41,
      protocol: 'CG2/2.8',
      generatedHeader: {
        classification: 'EXTERNAL_EPHEMERAL_BUILD_MATERIAL',
        logicalPath: 'generated/codegraph-read-identity-v2-config.h',
      },
    });
    expect(first.projection.sourceArrays.map((entry: { row: string }) => entry.row))
      .toEqual(['01', '02', '03', '12', '13', '15']);
    expect(first.buildId).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires a real v2 native manifest and read entrypoint', () => {
    expect(v2NativeSource).toContain('int main()');
    expect(v2NativeSource).toMatch(/readRequestBytes/);
    expect(v2NativeSource).toMatch(/RequestParser/);
    expect(v2NativeSource).toContain('codegraph_source_policy_v2::Cg2RunManifest');
    expect(v2NativeSource).toContain('codegraph_source_policy_v2::Cg2RunRead');
  });

  it('requires the post-START row13/15 contract state and root self-binding', () => {
    expect(v2RootContract.scope.status).toBe('POST_START_MATERIALIZED' as string);
    expect(v2RootContract.start.value).toBe('YES' as string);
    expect(v2RootContract.preStartRelease.rootSelfBinding.postStartField)
      .toBe('rootPostimageSha256');
    expect(typeof v2RootContract.preStartRelease.rootSelfBinding.postStartValue)
      .toBe('string');
    expect(v2RootContract.pathSet.rows.find((row: { row: string }) => row.row === '12')?.status)
      .toBe('PRESENT');
    expect(v2RootContract.pathSet.rows.find((row: { row: string }) => row.row === '13')?.status)
      .toBe('PRESENT');
    expect(v2RootContract.pathSet.rows.find((row: { row: string }) => row.row === '15')?.status)
      .toBe('PRESENT');
  });

  it('requires builder V2 materialized receipt support', () => {
    expect(typeof builder.buildV2SourcePolicyTool).toBe('function');
    expect(v2CompanionContract.buildReceipt.receiptSchema.properties.sourceArrays.requiredRows)
      .toEqual(['01', '02', '03', '12', '13', '15']);
  });
});
