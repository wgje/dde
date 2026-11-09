#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  attestBuiltTool, canonicalJson, validTrustedPeX64,
} = require('./lib/codegraph-read-identity.cjs');
const {
  canonicalV2FrameWire, validateV2FrameSequence,
} = require('./lib/codegraph-read-identity.cjs');
const {
  deriveExact15PathSet,
  deriveSourcePolicyV2,
} = require('./lib/codegraph-source-policy.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(__dirname, 'native', 'codegraph-read-identity-win32.cpp');
const PROTOCOL_PATH = path.join(__dirname, 'contracts', 'codegraph-read-identity-v1.json');
const V2_SOURCE_POLICY_PATH = path.join(__dirname, 'native', 'codegraph-source-policy-win32.cpp');
const V2_ROOT_CONTRACT_PATH = path.join(__dirname, 'contracts', 'codegraph-read-identity-v2.json');
const V2_COMPANION_CONTRACT_PATH = path.join(
  __dirname,
  'contracts',
  'codegraph-read-identity-v2-companion.json',
);
const BINARY_FILE = 'codegraph-read-identity-win32.exe';
const RECEIPT_FILE = 'codegraph-read-identity-win32.receipt.json';
const ARCHITECTURE = 'x64';
const FLAGS = Object.freeze([
  '/nologo', '/std:c++20', '/utf-8', '/O2', '/MT', '/W4', '/WX', '/EHsc', '/guard:cf',
  '/Qspectre', '/Brepro', '/DUNICODE', '/D_UNICODE', '/link', '/DYNAMICBASE',
  '/NXCOMPAT', '/HIGHENTROPYVA', '/GUARD:CF', '/CETCOMPAT',
]);
const V2_HEADER_LOGICAL_PATH = 'generated/codegraph-read-identity-v2-config.h';
const V2_HEADER_TEMPLATE = [
  '#pragma once',
  '#define CODEGRAPH_READ_IDENTITY_V2_PROTOCOL "CG2/2.8"',
  '#define CODEGRAPH_READ_IDENTITY_V2_ARTIFACT_REVISION 41',
  '',
].join('\n');
const V2_SOURCE_ROWS = Object.freeze([
  Object.freeze({ row: '01', logicalPath: 'scripts/native/codegraph-read-identity-win32.cpp', filePath: SOURCE_PATH }),
  Object.freeze({ row: '02', logicalPath: 'scripts/build-codegraph-read-identity-win32.cjs', filePath: __filename }),
  Object.freeze({ row: '03', logicalPath: 'scripts/lib/codegraph-read-identity.cjs', filePath: path.join(__dirname, 'lib', 'codegraph-read-identity.cjs') }),
  Object.freeze({ row: '12', logicalPath: 'scripts/native/codegraph-source-policy-win32.cpp', filePath: V2_SOURCE_POLICY_PATH }),
  Object.freeze({ row: '13', logicalPath: 'scripts/contracts/codegraph-read-identity-v2.json', filePath: V2_ROOT_CONTRACT_PATH }),
  Object.freeze({ row: '15', logicalPath: 'scripts/contracts/codegraph-read-identity-v2-companion.json', filePath: V2_COMPANION_CONTRACT_PATH }),
]);
const V2_IMPLEMENTATION_SOURCES = Object.freeze([
  Object.freeze({ logicalPath: 'scripts/native/codegraph-source-policy-win32.cpp', filePath: V2_SOURCE_POLICY_PATH }),
  Object.freeze({ logicalPath: 'scripts/native/codegraph-read-identity-v2-win32.cpp', filePath: path.join(__dirname, 'native', 'codegraph-read-identity-v2-win32.cpp') }),
  Object.freeze({ logicalPath: 'scripts/native/codegraph-read-identity-v2-manifest-win32.cpp', filePath: path.join(__dirname, 'native', 'codegraph-read-identity-v2-manifest-win32.cpp') }),
  Object.freeze({ logicalPath: 'scripts/native/codegraph-read-identity-v2-win32.hpp', filePath: path.join(__dirname, 'native', 'codegraph-read-identity-v2-win32.hpp') }),
]);

function renderV2Header(policyDefinitionDigest, pathSetDigest) {
  return `${V2_HEADER_TEMPLATE}\n`
    + `#define CODEGRAPH_READ_IDENTITY_V2_POLICY_DEFINITION_DIGEST \"${policyDefinitionDigest}\"\n`
    + `#define CODEGRAPH_READ_IDENTITY_V2_PATH_SET_DIGEST \"${pathSetDigest}\"\n`;
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function attestV2BuiltTool(binaryPath) {
  let attestationRoot = null;
  try {
    const absolute = path.resolve(binaryPath);
    attestationRoot = fs.mkdtempSync(path.join(path.dirname(absolute), 'attest-'));
    const attestedBinary = path.join(attestationRoot, path.basename(absolute));
    fs.copyFileSync(absolute, attestedBinary);
    const root = attestationRoot;
    const relativePath = path.basename(attestedBinary);
    const readRequest = {
      operation: 'read',
      nonce: 'a'.repeat(32),
      protocol: 'CG2/2.8',
      rootAbsolutePath: root,
      relativePath,
      maxBytes: 1024 * 1024,
    };
    const manifestRequest = {
      operation: 'manifest',
      nonce: 'b'.repeat(32),
      protocol: 'CG2/2.8',
      rootAbsolutePath: root,
      maxAggregateBytes: 1024 * 1024,
    };
    const invoke = request => {
      const result = spawnSync(attestedBinary, [], {
        input: canonicalJson(request) + '\n',
        encoding: null,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 256 * 1024 * 1024,
        env: {},
      });
      if (result.error || result.status !== 0 || (result.stderr && result.stderr.length > 0)) return null;
      const frames = [];
      const output = result.stdout;
      let offset = 0;
      while (offset < output.length) {
        if (output.length - offset < 9) return null;
        const bodyLength = Number(output.readBigUInt64BE(offset));
        offset += 8;
        if (!Number.isSafeInteger(bodyLength) || bodyLength <= 0
          || bodyLength > 256 * 1024 * 1024 || output.length - offset < bodyLength + 1) return null;
        const body = output.subarray(offset, offset + bodyLength);
        offset += bodyLength;
        if (output[offset] !== 0x0a) return null;
        offset += 1;
        try {
          frames.push(JSON.parse(body.toString('utf8')));
        } catch {
          return null;
        }
      }
      if (frames.length === 0) return null;
      const validation = validateV2FrameSequence(frames);
      return validation.ok ? frames : null;
    };
    const readFrames = invoke(readRequest);
    const manifestFrames = invoke(manifestRequest);
    if (!readFrames || !manifestFrames) return null;
    const readCaptured = readFrames.find(frame => frame.kind === 'captured')?.capturedEntry;
    const manifestCaptured = manifestFrames.find(frame => frame.kind === 'captured')?.capturedEntry;
    if (!readCaptured || !manifestCaptured
      || canonicalJson(readCaptured.identity) !== canonicalJson(manifestCaptured.identity)) return null;
    return Object.freeze({ binaryIdentity: readCaptured.identity });
  } catch {
    return null;
  } finally {
    if (attestationRoot) {
      try { fs.rmSync(attestationRoot, { recursive: true, force: true }); } catch {}
    }
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fixedResult(ok, details = {}) {
  return Object.freeze({ ok, ...details });
}

function createV2BuildProjection() {
  const sourceArrays = V2_SOURCE_ROWS.map(source => {
    const bytes = fs.readFileSync(source.filePath);
    return Object.freeze({
      bytes: String(bytes.length),
      path: source.logicalPath,
      row: source.row,
      sha256: sha256(bytes),
    });
  });
  const rootBytes = fs.readFileSync(V2_ROOT_CONTRACT_PATH);
  const companionBytes = fs.readFileSync(V2_COMPANION_CONTRACT_PATH);
  const root = JSON.parse(rootBytes.toString('utf8'));
  const companion = JSON.parse(companionBytes.toString('utf8'));
  if (root.contractRevision !== 41 || root.protocol?.version !== 'CG2/2.8'
    || companion.pathPolicy?.pathPolicyId !== root.pathPolicy?.pathPolicyId) {
    throw new TypeError('invalid CG2 contract binding');
  }
  const contractSetDigest = sha256(Buffer.from(canonicalJson({
    companionSha256: sha256(companionBytes),
    rootSha256: sha256(rootBytes),
  }), 'utf8'));
  const policy = deriveSourcePolicyV2();
  const pathSet = deriveExact15PathSet();
  const implementationParts = V2_IMPLEMENTATION_SOURCES.map(source => ({
    logicalPath: source.logicalPath,
    sha256: sha256(fs.readFileSync(source.filePath)),
  })).sort((left, right) => compareOrdinal(left.logicalPath, right.logicalPath));
  const implementationPartsDigest = sha256(Buffer.from(canonicalJson(implementationParts), 'utf8'));
  const generatedHeaderText = renderV2Header(policy.policyDefinitionDigest, pathSet.digest);
  const generatedHeader = Object.freeze({
    classification: 'EXTERNAL_EPHEMERAL_BUILD_MATERIAL',
    logicalPath: V2_HEADER_LOGICAL_PATH,
    templateSha256: sha256(Buffer.from(V2_HEADER_TEMPLATE, 'utf8')),
    projectionSha256: sha256(Buffer.from(generatedHeaderText, 'utf8')),
  });
  const projection = Object.freeze({
    architecture: ARCHITECTURE,
    artifactRevision: 41,
    contractSetDigest,
    generatedHeader,
    generatedHeaderText,
    implementationParts,
    implementationPartsDigest,
    pathSetDigest: pathSet.digest,
    policyDefinitionDigest: policy.policyDefinitionDigest,
    protocol: root.protocol.version,
    sourceArrays,
  });
  return Object.freeze({
    buildId: sha256(Buffer.from(canonicalJson(projection), 'utf8')),
    projection,
  });
}

function trustedProgramRoots() {
  return [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter(Boolean)
    .map(value => path.resolve(value));
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function trustedExistingFile(candidate, roots) {
  try {
    const resolved = fs.realpathSync.native(candidate);
    return fs.statSync(resolved).isFile() && roots.some(root => isWithin(resolved, root))
      ? resolved
      : null;
  } catch { return null; }
}

function findVisualStudio() {
  const roots = trustedProgramRoots();
  const x86Root = process.env['ProgramFiles(x86)'];
  if (!x86Root) return null;
  const vswhere = trustedExistingFile(
    path.join(x86Root, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
    roots,
  );
  if (!vswhere) return null;
  const result = spawnSync(vswhere, [
    '-latest',
    '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 64 * 1024,
    env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
  });
  if (result.error || result.status !== 0 || result.stderr.trim()) return null;
  const lines = result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (lines.length !== 1) return null;
  try {
    const installation = fs.realpathSync.native(lines[0]);
    return roots.some(root => isWithin(installation, root)) ? installation : null;
  } catch { return null; }
}

function versionParts(name) {
  return /^\d+(?:\.\d+){2,3}$/.test(name) ? name.split('.').map(Number) : null;
}

function compareVersionsDescending(left, right) {
  const a = versionParts(left) ?? [];
  const b = versionParts(right) ?? [];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference) return difference;
  }
  return compareOrdinal(left, right);
}

function findCompiler(installation) {
  const toolsRoot = path.join(installation, 'VC', 'Tools', 'MSVC');
  try {
    for (const version of fs.readdirSync(toolsRoot).sort(compareVersionsDescending)) {
      if (!versionParts(version)) continue;
      const candidate = trustedExistingFile(
        path.join(toolsRoot, version, 'bin', 'Hostx64', 'x64', 'cl.exe'),
        trustedProgramRoots(),
      );
      if (candidate) return { compilerPath: candidate, toolsRoot: path.join(toolsRoot, version) };
    }
  } catch { return null; }
  return null;
}

function findWindowsSdk() {
  const x86Root = process.env['ProgramFiles(x86)'];
  if (!x86Root) return null;
  const sdkRoot = path.join(x86Root, 'Windows Kits', '10');
  const includeRoot = path.join(sdkRoot, 'Include');
  try {
    for (const version of fs.readdirSync(includeRoot).sort(compareVersionsDescending)) {
      if (!versionParts(version)) continue;
      const required = [
        path.join(includeRoot, version, 'um', 'Windows.h'),
        path.join(includeRoot, version, 'shared', 'winerror.h'),
        path.join(includeRoot, version, 'ucrt', 'stdlib.h'),
        path.join(sdkRoot, 'Lib', version, 'um', 'x64', 'kernel32.lib'),
        path.join(sdkRoot, 'Lib', version, 'ucrt', 'x64', 'ucrt.lib'),
      ];
      if (required.every(file => fs.existsSync(file))) return { sdkRoot, version };
    }
  } catch { return null; }
  return null;
}

function buildEnvironment(compiler, sdk) {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const sdkInclude = path.join(sdk.sdkRoot, 'Include', sdk.version);
  const sdkLib = path.join(sdk.sdkRoot, 'Lib', sdk.version);
  const sdkBin = path.join(sdk.sdkRoot, 'bin', sdk.version, 'x64');
  return {
    SystemRoot: systemRoot,
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    PATH: [path.dirname(compiler.compilerPath), sdkBin, path.join(systemRoot, 'System32')].join(path.delimiter),
    INCLUDE: [
      path.join(compiler.toolsRoot, 'include'),
      path.join(sdkInclude, 'ucrt'),
      path.join(sdkInclude, 'shared'),
      path.join(sdkInclude, 'um'),
      path.join(sdkInclude, 'winrt'),
    ].join(';'),
    LIB: [
      path.join(compiler.toolsRoot, 'lib', 'x64'),
      path.join(sdkLib, 'ucrt', 'x64'),
      path.join(sdkLib, 'um', 'x64'),
    ].join(';'),
  };
}

function validExistingBuild(directory, expected) {
  try {
    const receiptPath = path.join(directory, RECEIPT_FILE);
    const receiptText = fs.readFileSync(receiptPath, 'utf8');
    const receipt = JSON.parse(receiptText);
    const binaryPath = path.join(directory, BINARY_FILE);
    const completeExpected = expected.binaryIdentity
      ? expected
      : { ...expected, binaryIdentity: receipt.binaryIdentity };
    const identity = receipt.binaryIdentity;
    return canonicalJson(receipt) === receiptText
      && canonicalJson(receipt) === canonicalJson(completeExpected)
      && typeof identity?.volumeSerial === 'string' && /^[a-f0-9]{16}$/.test(identity.volumeSerial)
      && typeof identity.fileId === 'string' && /^[a-f0-9]{32}$/.test(identity.fileId)
      && sha256(fs.readFileSync(binaryPath)) === receipt.binarySha256
      ? { binaryPath, receiptPath, receipt }
      : null;
  } catch { return null; }
}

function runCompiler(compilerPath, args, options) {
  return new Promise(resolve => {
    let settled = false;
    let outputBytes = 0;
    let terminationError = null;
    const child = spawn(compilerPath, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const terminateOwnTree = () => {
      if (!child.pid) return;
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      spawnSync(path.join(systemRoot, 'System32', 'taskkill.exe'), [
        '/PID', String(child.pid), '/T', '/F',
      ], {
        windowsHide: true,
        timeout: 15000,
        stdio: 'ignore',
        env: { SystemRoot: systemRoot },
      });
    };
    const observeOutput = chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024 && !terminationError) {
        terminationError = 'BUILD_OUTPUT_LIMIT';
        terminateOwnTree();
      }
    };
    child.stdout.on('data', observeOutput);
    child.stderr.on('data', observeOutput);
    child.once('error', () => finish({ ok: false, error: 'BUILD_FAILED' }));
    child.once('close', code => finish({
      ok: !terminationError && code === 0,
      error: terminationError ?? (code === 0 ? undefined : 'BUILD_FAILED'),
    }));
    const timer = setTimeout(() => {
      if (terminationError) return;
      terminationError = 'BUILD_TIMEOUT';
      terminateOwnTree();
    }, 120000);
  });
}

const DEFAULT_RUNTIME = Object.freeze({
  platform: process.platform,
  arch: process.arch,
  findVisualStudio,
  findCompiler,
  findWindowsSdk,
  runCompiler,
  attestBuiltTool,
  removeTemporary: fs.rmSync,
});

function cleanupOwnedTemporary(temporary, outputRoot, runtime) {
  if (!temporary || !isWithin(temporary, outputRoot)) return;
  try { runtime.removeTemporary(temporary, { recursive: true, force: true }); } catch {}
}

async function buildReadIdentityTool(options = {}, runtime = DEFAULT_RUNTIME) {
  let temporary;
  if (runtime.platform !== 'win32' || runtime.arch !== 'x64') {
    return fixedResult(false, { error: 'UNSUPPORTED_PLATFORM' });
  }
  const outputRoot = path.resolve(options.outputRoot ?? path.join(
    REPO_ROOT,
    '.codegraph',
    'native',
    'codegraph-read-identity-v1',
  ));
  const installation = runtime.findVisualStudio();
  const compiler = installation ? runtime.findCompiler(installation) : null;
  const sdk = runtime.findWindowsSdk();
  if (!compiler || !sdk) return fixedResult(false, { error: 'TOOLCHAIN_UNAVAILABLE' });
  const sourceBytes = fs.readFileSync(SOURCE_PATH);
  const protocolBytes = fs.readFileSync(PROTOCOL_PATH);
  const compilerBytes = fs.readFileSync(compiler.compilerPath);
  const sourceSha256 = sha256(sourceBytes);
  const protocolSha256 = sha256(protocolBytes);
  const compilerSha256 = sha256(compilerBytes);
  const protocol = JSON.parse(protocolBytes.toString('utf8')).protocol;
  const buildProjection = {
    architecture: ARCHITECTURE,
    compilerSha256,
    flags: FLAGS,
    protocol,
    protocolSha256,
    sourceSha256,
  };
  const buildId = sha256(Buffer.from(canonicalJson(buildProjection)));
  const toolDirectory = path.join(outputRoot, buildId);
  const receiptBase = {
    architecture: ARCHITECTURE,
    binaryFile: BINARY_FILE,
    buildId,
    compilerPath: compiler.compilerPath,
    compilerSha256,
    flags: FLAGS,
    protocol,
    protocolSha256,
    schemaVersion: 1,
    sourceSha256,
  };
  try {
    const binaryPath = path.join(toolDirectory, BINARY_FILE);
    const existingBinary = fs.existsSync(binaryPath) ? fs.readFileSync(binaryPath) : null;
    if (existingBinary) {
      const expected = { ...receiptBase, binarySha256: sha256(existingBinary) };
      const existing = validExistingBuild(toolDirectory, expected);
      const attested = existing && runtime.attestBuiltTool(binaryPath, {
        ...expected,
        binaryIdentity: existing.receipt.binaryIdentity,
      });
      if (!attested) return fixedResult(false, { error: 'OUTPUT_CONFLICT' });
      return fixedResult(true, {
        toolDirectory, binaryPath: existing.binaryPath, receiptPath: existing.receiptPath, buildId,
      });
    }
    fs.mkdirSync(outputRoot, { recursive: true });
    temporary = fs.mkdtempSync(path.join(outputRoot, `.${buildId}.tmp-`));
    const temporaryBinary = path.join(temporary, BINARY_FILE);
    const attestationHeader = path.join(temporary, 'read-identity-attestation.h');
    const compileSource = path.join(temporary, 'codegraph-read-identity-win32.cpp');
    const objectPath = path.join(temporary, 'codegraph-read-identity-win32.obj');
    const pdbPath = path.join(temporary, 'codegraph-read-identity-win32.pdb');
    fs.writeFileSync(attestationHeader, [
      `#define READ_IDENTITY_BUILD_ID \"${buildId}\"`,
      `#define READ_IDENTITY_PROTOCOL_SHA256 \"${protocolSha256}\"`,
      `#define READ_IDENTITY_SOURCE_SHA256 \"${sourceSha256}\"`,
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(compileSource, sourceBytes);
    const compileFlags = FLAGS.slice(0, FLAGS.indexOf('/link'));
    const linkFlags = FLAGS.slice(FLAGS.indexOf('/link') + 1);
    const args = [
      ...compileFlags,
      `/FI${attestationHeader}`,
      `/Fe:${temporaryBinary}`,
      `/Fo:${objectPath}`,
      `/Fd:${pdbPath}`,
      compileSource,
      '/link',
      `/PDB:${pdbPath}`,
      ...linkFlags,
    ];
    const compiled = await runtime.runCompiler(compiler.compilerPath, args, {
      env: buildEnvironment(compiler, sdk),
      cwd: temporary,
    });
    if (!compiled.ok) {
      cleanupOwnedTemporary(temporary, outputRoot, runtime);
      return fixedResult(false, { error: compiled.error });
    }
    const binaryBytes = fs.readFileSync(temporaryBinary);
    if (!validTrustedPeX64(binaryBytes)) {
      cleanupOwnedTemporary(temporary, outputRoot, runtime);
      return fixedResult(false, { error: 'BUILD_FAILED' });
    }
    const binarySha256 = sha256(binaryBytes);
    const attested = runtime.attestBuiltTool(temporaryBinary, {
      binarySha256,
      buildId,
      protocolSha256,
      sourceSha256,
    });
    if (!attested) {
      cleanupOwnedTemporary(temporary, outputRoot, runtime);
      return fixedResult(false, { error: 'BUILD_FAILED' });
    }
    const receipt = { ...receiptBase, binaryIdentity: attested.binaryIdentity, binarySha256 };
    fs.writeFileSync(path.join(temporary, RECEIPT_FILE), canonicalJson(receipt), 'utf8');
    fs.rmSync(attestationHeader, { force: true });
    fs.rmSync(compileSource, { force: true });
    fs.rmSync(objectPath, { force: true });
    fs.rmSync(pdbPath, { force: true });
    try {
      fs.renameSync(temporary, toolDirectory);
    } catch (error) {
      const existing = validExistingBuild(toolDirectory, receipt);
      cleanupOwnedTemporary(temporary, outputRoot, runtime);
      if (!existing) throw error;
    }
    return fixedResult(true, {
      toolDirectory,
      binaryPath: path.join(toolDirectory, BINARY_FILE),
      receiptPath: path.join(toolDirectory, RECEIPT_FILE),
      buildId,
    });
  } catch {
    cleanupOwnedTemporary(temporary, outputRoot, runtime);
    return fixedResult(false, { error: 'BUILD_FAILED' });
  }
}

function buildV2SourcePolicyTool(options = {}, runtime = DEFAULT_RUNTIME) {
  return buildReadIdentityV2Like(options, runtime, {
    outputName: 'codegraph-source-policy-v2',
    binaryFile: 'codegraph-source-policy-win32.exe',
    sourcePath: V2_SOURCE_POLICY_PATH,
    receiptFile: 'codegraph-source-policy-win32.receipt.json',
    projection: createV2BuildProjection(),
  });
}

function buildReadIdentityV2Like(options, runtime, spec) {
  if (runtime.platform !== 'win32' || runtime.arch !== 'x64') {
    return Promise.resolve(fixedResult(false, { error: 'UNSUPPORTED_PLATFORM' }));
  }
  const outputRoot = path.resolve(options.outputRoot ?? path.join(
    REPO_ROOT,
    '.codegraph',
    'native',
    spec.outputName,
  ));
  const installation = runtime.findVisualStudio();
  const compiler = installation ? runtime.findCompiler(installation) : null;
  const sdk = runtime.findWindowsSdk();
  if (!compiler || !sdk) return Promise.resolve(fixedResult(false, { error: 'TOOLCHAIN_UNAVAILABLE' }));
 const projection = spec.projection;
 const buildProjection = projection.projection;
 const sourceBytes = fs.readFileSync(spec.sourcePath);
 const compilerBytes = fs.readFileSync(compiler.compilerPath);
 const compilerSha256 = sha256(compilerBytes);
 const sourceSha256 = sha256(sourceBytes);
 const buildId = projection.buildId;
  const toolDirectory = path.join(outputRoot, buildId);
  const binaryPath = path.join(toolDirectory, spec.binaryFile);
  const receiptPath = path.join(toolDirectory, spec.receiptFile);
  const existingBinary = fs.existsSync(binaryPath) ? fs.readFileSync(binaryPath) : null;
  if (existingBinary) {
    try {
      const existing = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      if (existing?.binarySha256 === sha256(existingBinary)) {
        return Promise.resolve(fixedResult(true, { toolDirectory, binaryPath, receiptPath, buildId }));
      }
    } catch {}
    return Promise.resolve(fixedResult(false, { error: 'OUTPUT_CONFLICT' }));
  }
  return Promise.resolve().then(async () => {
    fs.mkdirSync(outputRoot, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(outputRoot, `.${buildId}.tmp-`));
    try {
      const temporaryBinary = path.join(temporary, spec.binaryFile);
      const headerPath = path.join(temporary, 'codegraph-read-identity-v2-config.h');
      const stagedHeader = path.join(temporary, 'codegraph-read-identity-v2-win32.hpp');
      fs.writeFileSync(headerPath, buildProjection.generatedHeaderText);
      fs.writeFileSync(stagedHeader, fs.readFileSync(V2_IMPLEMENTATION_SOURCES[3].filePath));
      const implementationSources = [
        Object.freeze({ logicalPath: 'codegraph-source-policy-win32.cpp', sourcePath: spec.sourcePath, objectPath: 'codegraph-source-policy-win32.obj' }),
        Object.freeze({ logicalPath: 'codegraph-read-identity-v2-win32.cpp', sourcePath: V2_IMPLEMENTATION_SOURCES[1].filePath, objectPath: 'codegraph-read-identity-v2-win32.obj' }),
        Object.freeze({ logicalPath: 'codegraph-read-identity-v2-manifest-win32.cpp', sourcePath: V2_IMPLEMENTATION_SOURCES[2].filePath, objectPath: 'codegraph-read-identity-v2-manifest-win32.obj' }),
      ];
      const compileFlags = FLAGS.slice(0, FLAGS.indexOf('/link'));
      const linkFlags = FLAGS.slice(FLAGS.indexOf('/link') + 1);
      const objects = [];
      for (const implementationSource of implementationSources) {
        const stagedSource = path.join(temporary, implementationSource.logicalPath);
        fs.writeFileSync(stagedSource, fs.readFileSync(implementationSource.sourcePath));
        const objectPath = path.join(temporary, implementationSource.objectPath);
        const unitPdb = path.join(temporary, `${implementationSource.objectPath}.pdb`);
        const compiled = await runtime.runCompiler(compiler.compilerPath, [
          ...compileFlags,
          '/c',
          `/FI${headerPath}`,
          `/Fo:${objectPath}`,
          `/Fd:${unitPdb}`,
          stagedSource,
        ], { env: buildEnvironment(compiler, sdk), cwd: temporary });
        if (!compiled.ok) return fixedResult(false, { error: compiled.error });
        objects.push(objectPath);
      }
      const pdbPath = path.join(temporary, 'codegraph-source-policy-v2.pdb');
      const args = [
        ...compileFlags,
        `/Fe:${temporaryBinary}`,
        ...objects,
        '/link',
        `/PDB:${pdbPath}`,
        ...linkFlags,
      ];
      const compiled = await runtime.runCompiler(compiler.compilerPath, args, {
        env: buildEnvironment(compiler, sdk),
        cwd: temporary,
      });
      if (!compiled.ok) return fixedResult(false, { error: compiled.error });
      const binaryBytes = fs.readFileSync(temporaryBinary);
      if (!validTrustedPeX64(binaryBytes)) return fixedResult(false, { error: 'BUILD_FAILED' });
      const binarySha256 = sha256(binaryBytes);
      const attested = attestV2BuiltTool(temporaryBinary);
      if (!attested) return fixedResult(false, { error: 'BUILD_FAILED' });
      const receipt = {
        adapterSha256: sha256(fs.readFileSync(path.join(__dirname, 'lib', 'codegraph-read-identity.cjs'))),
        architecture: ARCHITECTURE,
        artifactRevision: 41,
        binaryFile: spec.binaryFile,
        binaryIdentity: attested.binaryIdentity,
        binarySha256,
        buildId,
        buildProjection: buildId,
        compiler: { logicalPath: compiler.compilerPath, sha256: compilerSha256, version: '' },
        environment: [],
        flags: FLAGS,
       generatedHeader: {
       classification: 'EXTERNAL_EPHEMERAL_BUILD_MATERIAL',
       logicalPath: V2_HEADER_LOGICAL_PATH,
       templateSha256: sha256(Buffer.from(V2_HEADER_TEMPLATE, 'utf8')),
        projectionSha256: sha256(Buffer.from(buildProjection.generatedHeaderText, 'utf8')),
     },
       inputs: V2_SOURCE_ROWS.map(source => ({
         logicalPath: source.logicalPath,
         sha256: sha256(fs.readFileSync(source.filePath)),
       })).sort((left, right) => compareOrdinal(left.logicalPath, right.logicalPath)),
        implementationParts: buildProjection.implementationParts,
        implementationPartsDigest: buildProjection.implementationPartsDigest,
       linker: { logicalPath: '', sha256: '', version: '' },
       output: {
         binarySha256,
         publishedReference: {
           tag: 'PUBLISHED_REFERENCE_V1',
           token: Buffer.from(`${buildId}:${binarySha256}`).toString('base64url'),
         },
       },
       protocol: 'CG2/2.8',
       receiptCore: {
         buildProjection: buildId,
        contractSetDigest: buildProjection.contractSetDigest,
         protocol: 'CG2/2.8',
         toolchainDigest: compilerSha256,
       },
       sdk: { headers: [], libs: [], logicalRoot: sdk.sdkRoot, sha256: '' },
      sourceArrays: buildProjection.sourceArrays,
     };
     receipt.receiptSha256 = sha256(Buffer.from(canonicalJson(receipt), 'utf8'));
     fs.writeFileSync(path.join(temporary, spec.receiptFile), canonicalJson(receipt), 'utf8');
      for (const implementationSource of implementationSources) {
        fs.rmSync(path.join(temporary, implementationSource.logicalPath), { force: true });
        fs.rmSync(path.join(temporary, implementationSource.objectPath), { force: true });
      }
      fs.rmSync(headerPath, { force: true });
      fs.rmSync(stagedHeader, { force: true });
      try {
        fs.renameSync(temporary, toolDirectory);
      } catch (error) {
        cleanupOwnedTemporary(temporary, outputRoot, runtime);
        throw error;
      }
      return fixedResult(true, { toolDirectory, binaryPath, receiptPath, buildId });
    } catch (error) {
      process.stderr.write('V2_BUILD_DIAGNOSTIC ' + String(error && error.stack ? error.stack : error) + '\n');
      cleanupOwnedTemporary(temporary, outputRoot, runtime);
      return fixedResult(false, { error: 'BUILD_FAILED' });
    }
  });
}

function parseArgs(argv) {
  let outputRoot;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output-root' && argv[index + 1]) outputRoot = argv[++index];
    else if (argv[index] === '--json') json = true;
    else return null;
  }
  return { outputRoot, json };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write('codegraph-read-identity build failed: INVALID_ARGUMENT\n');
    process.exitCode = 2;
  } else {
    const result = await buildReadIdentityTool({ outputRoot: args.outputRoot });
    const rendered = canonicalJson(result);
    if (args.json || result.ok) process.stdout.write(`${rendered}\n`);
    else process.stderr.write(`codegraph-read-identity build failed: ${result.error}\n`);
    if (!result.ok) process.exitCode = 1;
  }
}

if (require.main === module) main().catch(() => {
  process.stderr.write('codegraph-read-identity build failed: BUILD_FAILED\n');
  process.exitCode = 1;
});

module.exports = Object.freeze({
  FLAGS,
  V2_HEADER_LOGICAL_PATH,
  V2_HEADER_TEMPLATE,
  createV2BuildProjection,
  buildReadIdentityTool,
  buildV2SourcePolicyTool,
});
