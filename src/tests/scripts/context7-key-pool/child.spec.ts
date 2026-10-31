// @vitest-environment node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../../..');
const childPath = path.join(repoRoot, 'scripts/context7-key-pool/context7-child.cjs');
const observerPath = path.join(repoRoot, 'scripts/context7-key-pool/context7-fetch-observer.cjs');
const fakeMcpPath = path.join(repoRoot, 'src/tests/fixtures/context7-key-pool/fake-context7-mcp.cjs');
const fakeFetchPath = path.join(repoRoot, 'src/tests/fixtures/context7-key-pool/fake-context7-upstream-fetch.cjs');
const roots: string[] = [];

type Tool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

type ChildAdapterModule = {
  EXPECTED_CONTEXT7_TOOL_CONTRACT: Record<string, unknown>;
  createContext7Child(options: Record<string, unknown>): Promise<{
    tools: Tool[];
    callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<{
      result: Record<string, unknown>;
      failureEvidence: null | { kind: string; status: number | null; retryAfterSeconds: number | null };
    }>;
    close(): Promise<void>;
    onExit(listener: () => void): () => void;
  }>;
  resolvePinnedContext7Entry(): string;
  validateOfficialToolSet(tools: Tool[], expectedSignature?: string): string;
  extractTrustedFailureEvidence(
    result: Record<string, unknown>,
    marker: string,
  ): {
    result: Record<string, unknown>;
    failureEvidence: null | { kind: string; status: number | null; retryAfterSeconds: number | null };
  };
};

function loadAdapter(): ChildAdapterModule {
  delete require.cache[childPath];
  return require(childPath) as ChildAdapterModule;
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context7-child-'));
  roots.push(root);
  return root;
}

function fakeArgs(...args: string[]): string[] {
  return args;
}

function writeLateExitMcpFixture(): string {
  const root = tempRoot();
  const entryPath = path.join(root, 'late-exit-context7-mcp.cjs');
  const serverPath = require.resolve('@modelcontextprotocol/sdk/server/index.js');
  const stdioPath = require.resolve('@modelcontextprotocol/sdk/server/stdio.js');
  const typesPath = require.resolve('@modelcontextprotocol/sdk/types.js');
  const tools = validTools();
  fs.writeFileSync(entryPath, `'use strict';
const { Server } = require(${JSON.stringify(serverPath)});
const { StdioServerTransport } = require(${JSON.stringify(stdioPath)});
const { ListToolsRequestSchema } = require(${JSON.stringify(typesPath)});
const server = new Server({name:'late-exit-context7',version:'1.0.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => {
  setTimeout(() => process.exit(0), 25);
  return {tools:${JSON.stringify(tools)}};
});
server.connect(new StdioServerTransport()).catch(() => process.exit(29));
`);
  return entryPath;
}

function runAbortHarness(pidFile: string): SpawnSyncReturns<string> {
  const root = tempRoot();
  const harnessPath = path.join(root, 'abort-harness.cjs');
  fs.writeFileSync(harnessPath, `'use strict';
const { createContext7Child } = require(${JSON.stringify(childPath)});
const fs = require('node:fs');
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(String(reason)));
(async () => {
  const child = await createContext7Child({
    apiKey: undefined,
    inheritedEnv: {PATH: process.env.PATH || ''},
    command: process.execPath,
    entryPath: ${JSON.stringify(fakeMcpPath)},
    observerPath: ${JSON.stringify(observerPath)},
    args: ['--delay-call', '5000', '--pid-file', ${JSON.stringify(pidFile)}],
    cwd: ${JSON.stringify(repoRoot)},
    connectTimeoutMs: 2000,
    callTimeoutMs: 5000,
    redact: (value) => value,
  });
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = child.callTool(
    'resolve-library-id',
    {libraryName:'fixture',query:'fixture'},
    {signal:controller.signal},
  );
  setTimeout(() => controller.abort(new Error('fixture in-flight cancellation')), 25);
  let error = null;
  try { await pending; } catch (caught) { error = String(caught && caught.message || caught); }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const pid = Number(fs.readFileSync(${JSON.stringify(pidFile)}, 'utf8'));
  let childAlive = true;
  try { process.kill(pid, 0); } catch { childAlive = false; }
  process.stdout.write(JSON.stringify({elapsedMs:Date.now()-startedAt,error,unhandled,childAlive}));
})().catch((error) => {
  process.stderr.write(String(error && error.stack || error));
  process.exit(1);
});
`);
  return spawnSync(process.execPath, [harnessPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: process.env.PATH ?? '' },
  });
}

async function fakeChild(options: {
  apiKey?: string;
  inheritedEnv?: NodeJS.ProcessEnv;
  args?: string[];
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
} = {}) {
  return loadAdapter().createContext7Child({
    apiKey: options.apiKey,
    inheritedEnv: options.inheritedEnv ?? {},
    command: process.execPath,
    entryPath: fakeMcpPath,
    observerPath,
    args: options.args ?? [],
    cwd: repoRoot,
    connectTimeoutMs: options.connectTimeoutMs ?? 2_000,
    callTimeoutMs: options.callTimeoutMs ?? 2_000,
    redact: (value: unknown) => value,
  });
}

function expectedFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function parseTextResult(result: Record<string, unknown>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe('text');
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

function validTools(): Tool[] {
  return [
    {
      name: 'resolve-library-id',
      title: 'Resolve a library',
      description: 'Resolve docs library identifiers.',
      inputSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['libraryName', 'query'],
        properties: { libraryName: { type: 'string' }, query: { type: 'string' } },
      },
      annotations: { readOnlyHint: true },
      _meta: { fixture: true },
    },
    {
      name: 'query-docs',
      title: 'Query documentation',
      description: 'Query resolved documentation.',
      inputSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        required: ['libraryId', 'query'],
        properties: { libraryId: { type: 'string' }, query: { type: 'string' } },
      },
      outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
  ];
}

function marker(char = 'a'): string {
  return char.repeat(64);
}

function envelope(nonce: string, fields = 'kind=http;status=429;retry-after=31'): string {
  return `nanoflow-context7-failure-v1:${nonce}:${fields}`;
}

function observerRun(mode: string, url = 'https://context7.com/api/v2/libs/search', nonce = marker()) {
  const script = `fetch(${JSON.stringify(url)}).then(async r=>process.stdout.write(JSON.stringify({status:r.status,text:await r.text(),headers:Object.fromEntries(r.headers)}))).catch(()=>process.exit(91));`;
  return spawnSync(process.execPath, ['--require', fakeFetchPath, '-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      NANOFLOW_CONTEXT7_FAILURE_MARKER: nonce,
      NANOFLOW_CONTEXT7_TEST_FETCH: mode,
    },
  });
}

async function expectPidStops(pidFile: string): Promise<void> {
  for (let i = 0; i < 40 && !fs.existsSync(pidFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(fs.existsSync(pidFile)).toBe(true);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 80; i += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      return;
    }
  }
  throw new Error('fixture child remained alive');
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Context7 official child adapter', () => {
  it('exports the pinned resolver, validator, extractor, expected contract and factory', () => {
    const adapter = loadAdapter();
    expect(adapter.resolvePinnedContext7Entry).toEqual(expect.any(Function));
    expect(adapter.validateOfficialToolSet).toEqual(expect.any(Function));
    expect(adapter.extractTrustedFailureEvidence).toEqual(expect.any(Function));
    expect(adapter.createContext7Child).toEqual(expect.any(Function));
    expect(Object.keys(adapter.EXPECTED_CONTEXT7_TOOL_CONTRACT)).toEqual(['resolve-library-id', 'query-docs']);
  });

  it('resolves only the regular local Context7 2.1.1 bin entry inside its package root', () => {
    const entry = loadAdapter().resolvePinnedContext7Entry();
    const packageJsonPath = require.resolve('@upstash/context7-mcp/package.json');
    const packageRoot = fs.realpathSync(path.dirname(packageJsonPath));
    const descriptor = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      name: string;
      version: string;
      bin: Record<string, string>;
    };
    expect(descriptor).toMatchObject({
      name: '@upstash/context7-mcp',
      version: '2.1.1',
      bin: { 'context7-mcp': 'dist/index.js' },
    });
    expect(fs.realpathSync(entry).startsWith(`${packageRoot}${path.sep}`)).toBe(true);
    expect(fs.statSync(entry).isFile()).toBe(true);
  });

  it('snapshots the exact SDK 1.25.1 default environment key set', () => {
    const { getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js') as {
      getDefaultEnvironment(): Record<string, string>;
    };
    const expected = process.platform === 'win32'
      ? ['APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PROCESSOR_ARCHITECTURE', 'PROGRAMFILES', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERNAME', 'USERPROFILE']
      : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];
    expect(Object.keys(getDefaultEnvironment()).sort()).toEqual(expected);
  });

  it('passes only the safe environment union and one canonical selected key to a keyed child', async () => {
    const selectedKey = 'fixture-selected-key-alpha';
    const inheritedEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      TEMP: os.tmpdir(),
      HTTPS_PROXY: 'http://proxy.fixture',
      NODE_EXTRA_CA_CERTS: path.join(tempRoot(), 'fixture-ca.pem'),
      CONTEXT7_API_KEY: 'inherited-canonical-sentinel',
      CONTEXT7_API_KEY_1: 'slot-one-sentinel',
      CONTEXT7_API_KEY_4: 'slot-four-sentinel',
      NANOFLOW_CONTEXT7_FAILURE_MARKER: marker('b'),
      AWS_SECRET_ACCESS_KEY: 'unrelated-secret-sentinel',
      RANDOM_SAFE_LOOKING_VALUE: 'must-not-pass',
    };
    if (process.platform === 'win32') {
      inheritedEnv.context7_api_key_2 = 'lowercase-sentinel';
      inheritedEnv.Context7_Api_Key_3 = 'mixed-sentinel';
      inheritedEnv.path = 'ignored-case-duplicate';
    } else {
      inheritedEnv.http_proxy = 'http://lowercase-proxy.fixture';
    }
    const child = await fakeChild({ apiKey: selectedKey, inheritedEnv });
    try {
      const { result } = await child.callTool('resolve-library-id', { libraryName: 'fixture', query: 'mode:env' });
      const data = parseTextResult(result);
      const names = data.envNames as string[];
      const { getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js') as {
        getDefaultEnvironment(): Record<string, string>;
      };
      const expectedSafe = ['PATH', 'TEMP', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS'];
      if (process.platform !== 'win32') expectedSafe.push('http_proxy');
      const expectedNames = [...new Set([
        ...Object.keys(getDefaultEnvironment()),
        ...expectedSafe,
        'CONTEXT7_API_KEY',
        'NANOFLOW_CONTEXT7_FAILURE_MARKER',
      ])].sort();
      const unavoidableWindowsKeys = process.platform === 'win32'
        ? ['LOGONSERVER', 'USERDOMAIN', 'WINDIR']
        : [];
      const osAdded = names.filter((name) => !expectedNames.includes(name));
      expect(osAdded).toEqual(unavoidableWindowsKeys);
      expect(names.filter((name) => !unavoidableWindowsKeys.includes(name))).toEqual(expectedNames);
      expect(data.keyFingerprint).toBe(expectedFingerprint(selectedKey));
      expect(JSON.stringify(data)).not.toContain(selectedKey);
      expect(JSON.stringify(data)).not.toContain('sentinel');
      expect(names.filter((name) => name.toUpperCase().startsWith('CONTEXT7_API_KEY'))).toEqual(['CONTEXT7_API_KEY']);
    } finally {
      await child.close();
    }
  });

  it('passes no Context7 key variable to an anonymous child', async () => {
    const child = await fakeChild({
      inheritedEnv: {
        PATH: process.env.PATH ?? '',
        CONTEXT7_API_KEY: 'canonical-sentinel',
        CONTEXT7_API_KEY_1: 'slot-sentinel',
        context7_api_key_2: 'lowercase-sentinel',
      },
    });
    try {
      const { result } = await child.callTool('resolve-library-id', { libraryName: 'fixture', query: 'mode:env' });
      const data = parseTextResult(result);
      expect((data.envNames as string[]).filter((name) => name.toUpperCase().startsWith('CONTEXT7_API_KEY'))).toEqual([]);
      expect(data.keyFingerprint).toBe(null);
    } finally {
      await child.close();
    }
  });

  it.each([
    ['missing', ['--tool-shape', 'missing'], /context7-child-tool-contract/],
    ['extra', ['--tool-shape', 'extra'], /context7-child-tool-contract/],
    ['status collision', ['--tool-shape', 'collision'], /context7-child-tool-contract/],
    ['non-object input schema', ['--tool-shape', 'non-object-schema'], /./],
    ['non-string required property', ['--tool-shape', 'required-non-string'], /./],
    ['changed required set', ['--tool-shape', 'required-drift'], /context7-child-tool-contract/],
    ['changed required string property', ['--tool-shape', 'string-drift'], /context7-child-tool-contract/],
    ['extra optional property', ['--tool-shape', 'extra-property'], /context7-child-tool-contract:resolve-library-id:property-set/],
    ['explicit additionalProperties true', ['--tool-shape', 'open-additional-properties'], /context7-child-tool-contract:resolve-library-id:additional-properties/],
  ])('rejects the first child for %s', async (_name, args, pattern) => {
    await expect(fakeChild({ args })).rejects.toThrow(pattern);
  });

  it('accepts the first child when additionalProperties is explicitly false', async () => {
    const child = await fakeChild({ args: ['--tool-shape', 'closed-additional-properties'] });
    try {
      expect(child.tools[0]?.inputSchema.additionalProperties).toBe(false);
    } finally {
      await child.close();
    }
  });

  it('canonicalizes every MCP-standard descriptor field and rejects replacement drift', () => {
    const { validateOfficialToolSet } = loadAdapter();
    const first = validTools();
    const signature = validateOfficialToolSet(first);
    expect(validateOfficialToolSet(structuredClone(first), signature)).toBe(signature);
    const drift = structuredClone(first);
    drift[1]!.description = 'replacement drift';
    expect(() => validateOfficialToolSet(drift, signature)).toThrow(/context7-child-tool-signature/);

    const nonObject = structuredClone(first);
    nonObject[0]!.inputSchema = [] as unknown as Record<string, unknown>;
    expect(() => validateOfficialToolSet(nonObject)).toThrow(/context7-child-tool-contract/);
    const nonStringRequired = structuredClone(first);
    nonStringRequired[0]!.inputSchema.required = ['libraryName', 7];
    expect(() => validateOfficialToolSet(nonStringRequired)).toThrow(/context7-child-tool-contract/);
  });

  it('preserves all schema-valid standard call result fields and recursively redacts only the child marker', async () => {
    const child = await fakeChild();
    try {
      const response = await child.callTool('query-docs', { libraryId: '/fixture/docs', query: 'mode:standard-result' });
      expect(response.failureEvidence).toBe(null);
      expect(response.result).toEqual({
        content: [
          { type: 'text', text: 'plain [REDACTED_MARKER] text', annotations: { audience: ['assistant'], priority: 0.5 } },
          { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
          { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/mpeg' },
          { type: 'resource_link', uri: 'fixture://resource', name: 'resource [REDACTED_MARKER]', mimeType: 'text/plain' },
          { type: 'resource', resource: { uri: 'fixture://embedded', mimeType: 'text/plain', text: '[REDACTED_MARKER]' } },
        ],
        isError: true,
        structuredContent: { answer: '[REDACTED_MARKER]', nested: ['preserved'] },
        _meta: { fixture: '[REDACTED_MARKER]', nested: { kept: true } },
      });
    } finally {
      await child.close();
    }
  });

  it('extracts only a whole-string current-nonce envelope and redacts the nonce regardless of trust', () => {
    const { extractTrustedFailureEvidence } = loadAdapter();
    const current = marker('c');
    const stale = marker('d');
    const trusted = extractTrustedFailureEvidence({ content: [{ type: 'text', text: envelope(current) }] }, current);
    expect(trusted).toEqual({
      result: { content: [{ type: 'text', text: envelope('[REDACTED_MARKER]') }] },
      failureEvidence: { kind: 'http', status: 429, retryAfterSeconds: 31 },
    });

    const untrusted = [
      { content: [{ type: 'text', text: 'normal 401 403 429 nanoflow-context7-failure-v1:' }] },
      { content: [{ type: 'text', text: JSON.stringify({ error: envelope(current) }) }] },
      { content: [{ type: 'text', text: `query=${envelope(current)}` }] },
      { content: [{ type: 'text', text: envelope(stale) }] },
      { content: [{ type: 'text', text: `prefix${envelope(current)}` }] },
      { content: [{ type: 'text', text: `${envelope(current)}suffix` }] },
      { content: [{ type: 'text', text: envelope(current) }, { type: 'text', text: 'extra' }] },
      { content: [{ type: 'image', data: envelope(current), mimeType: 'text/plain' }] },
    ];
    for (const result of untrusted) {
      const extracted = extractTrustedFailureEvidence(result, current);
      expect(extracted.failureEvidence).toBe(null);
      expect(JSON.stringify(extracted.result)).not.toContain(current);
    }
  });

  it.each([
    ['status:401', 'kind=http;status=401;retry-after=none', 401],
    ['status:403', 'kind=http;status=403;retry-after=none', 403],
    ['status:429;retry=1', 'kind=http;status=429;retry-after=1', 429],
    ['status:429;retry=86400', 'kind=http;status=429;retry-after=86400', 429],
    ['status:429;retry=0', 'kind=http;status=429;retry-after=none', 429],
    ['status:429;retry=86401', 'kind=http;status=429;retry-after=none', 429],
    ['status:429;retry=1.5', 'kind=http;status=429;retry-after=none', 429],
    ['transport-throw', 'kind=transport;status=none;retry-after=none', 599],
    ['body-cancel-fault', 'kind=observer-internal;status=none;retry-after=none', 599],
    ['header-fault', 'kind=observer-internal;status=none;retry-after=none', 599],
    ['normalization-fault', 'kind=observer-internal;status=none;retry-after=none', 599],
  ])('observer emits only the exact authenticated envelope for %s', (mode, fields, carrierStatus) => {
    const nonce = marker('e');
    const result = observerRun(mode, undefined, nonce);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const observed = JSON.parse(result.stdout) as { status: number; text: string; headers: Record<string, string> };
    expect(observed.status).toBe(carrierStatus);
    expect(JSON.parse(observed.text)).toEqual({ message: envelope(nonce, fields) });
    expect(JSON.stringify(observed)).not.toContain('upstream-body-sentinel');
    expect(JSON.stringify(observed)).not.toContain('raw-header-sentinel');
    expect(JSON.stringify(observed)).not.toContain('?secret-query');
    expect(observed.headers['x-upstream-sentinel']).toBeUndefined();
  });

  it('uses carrier 599 for synthetic 304 while preserving authenticated status 304', () => {
    const nonce = marker('f');
    const result = observerRun('status:304', undefined, nonce);
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout) as { status: number; text: string };
    expect(observed).toEqual({
      status: 599,
      text: JSON.stringify({ message: envelope(nonce, 'kind=http;status=304;retry-after=none') }),
      headers: { 'content-type': 'application/json' },
    });
  });

  it.each(['status:204', 'status:205', 'status:200'])('passes successful exact-endpoint responses through for %s', (mode) => {
    const result = observerRun(mode);
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout) as { status: number; text: string };
    expect(observed.status).toBe(Number(mode.slice('status:'.length)));
    expect(observed.text).toBe(mode === 'status:200' ? 'upstream-body-sentinel' : '');
  });

  it('does not observe other origins, paths, queries, or marker-looking upstream content', () => {
    for (const url of [
      'https://example.com/api/v2/libs/search',
      'https://context7.com/api/v2/context/extra',
    ]) {
      const result = observerRun('status:401', url);
      expect(result.status).toBe(0);
      const observed = JSON.parse(result.stdout) as { status: number; text: string };
      expect(observed.status).toBe(401);
      expect(observed.text).toBe('upstream-body-sentinel');
    }
    const exactEndpointWithQuery = observerRun('status:401', 'https://context7.com/api/v2/libs/search?secret-query=1');
    const observedQuery = JSON.parse(exactEndpointWithQuery.stdout) as { status: number; text: string };
    expect(observedQuery.status).toBe(401);
    expect(observedQuery.text).not.toContain('secret-query');
    const markerLike = observerRun('marker-like-json');
    expect(JSON.parse(markerLike.stdout)).toMatchObject({ status: 200 });
  });

  it('fails before initialize for invalid preload configuration and never trusts an inherited marker', () => {
    const invalid = spawnSync(process.execPath, ['--require', observerPath, fakeMcpPath, '--initialize-sentinel'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5_000,
      env: { NANOFLOW_CONTEXT7_FAILURE_MARKER: 'inherited-invalid-marker' },
    });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout).not.toContain('initialize-sentinel');
    expect(invalid.stdout + invalid.stderr).not.toContain('inherited-invalid-marker');
  });

  it('terminates only the observer child when even fallback Response construction is impossible', () => {
    const result = observerRun('response-construction-fault');
    expect(result.status).toBe(86);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(process.pid).toBeGreaterThan(0);
  });

  it('runs both real official tools without network and extracts synthetic 401 and 429 evidence after formatting', async () => {
    const adapter = loadAdapter();
    const child = await adapter.createContext7Child({
      apiKey: 'fixture-official-key',
      inheritedEnv: { PATH: process.env.PATH ?? '' },
      command: process.execPath,
      entryPath: adapter.resolvePinnedContext7Entry(),
      observerPath: fakeFetchPath,
      args: ['--transport', 'stdio'],
      cwd: repoRoot,
      connectTimeoutMs: 10_000,
      callTimeoutMs: 10_000,
      redact: (value: unknown) => value,
    });
    try {
      const resolveResult = await child.callTool('resolve-library-id', { libraryName: 'fixture', query: 'fixture' });
      expect(resolveResult.failureEvidence).toEqual({ kind: 'http', status: 401, retryAfterSeconds: null });
      const queryResult = await child.callTool('query-docs', { libraryId: '/fixture/docs', query: 'fixture' });
      expect(queryResult.failureEvidence).toEqual({ kind: 'http', status: 429, retryAfterSeconds: 17 });
      expect(JSON.stringify(resolveResult.result) + JSON.stringify(queryResult.result)).not.toMatch(/[a-f0-9]{64}/);
    } finally {
      await child.close();
    }
  }, 30_000);

  it('starts the real pinned child anonymously and lists tools without a network call', async () => {
    const adapter = loadAdapter();
    const child = await adapter.createContext7Child({
      apiKey: undefined,
      inheritedEnv: { PATH: process.env.PATH ?? '', CONTEXT7_API_KEY_1: 'slot-sentinel' },
      command: process.execPath,
      entryPath: adapter.resolvePinnedContext7Entry(),
      observerPath,
      args: ['--transport', 'stdio'],
      cwd: repoRoot,
      connectTimeoutMs: 10_000,
      callTimeoutMs: 10_000,
      redact: (value: unknown) => value,
    });
    try {
      expect(child.tools.map((tool) => tool.name)).toEqual(['resolve-library-id', 'query-docs']);
      for (const tool of child.tools) {
        const contract = adapter.EXPECTED_CONTEXT7_TOOL_CONTRACT[tool.name] as {
          stringProperties: string[];
        };
        expect(tool.inputSchema.$schema).toEqual(expect.any(String));
        expect(Object.keys(tool.inputSchema.properties as Record<string, unknown>).sort())
          .toEqual([...contract.stringProperties].sort());
        expect(Object.hasOwn(tool.inputSchema, 'additionalProperties')).toBe(false);
      }
    } finally {
      await child.close();
    }
  }, 20_000);

  it.each([
    ['connect', ['--delay-initialize', '500'], 50, 'create'],
    ['list', ['--delay-list', '500'], 50, 'create'],
    ['call', ['--delay-call', '500'], 50, 'call'],
  ] as const)('%s timeout rejects and closes the child', async (_kind, args, timeoutMs, phase) => {
    const root = tempRoot();
    const pidFile = path.join(root, 'child.pid');
    const promise = fakeChild({
      args: [...args, '--pid-file', pidFile],
      connectTimeoutMs: phase === 'call' ? 2_000 : timeoutMs,
      callTimeoutMs: timeoutMs,
    });
    if (phase === 'create') {
      await expect(promise).rejects.toThrow(/timed out|timeout/i);
    } else {
      const child = await promise;
      await expect(child.callTool('resolve-library-id', { libraryName: 'fixture', query: 'fixture' })).rejects.toThrow(/timed out|timeout/i);
    }
    await expectPidStops(pidFile);
  });

  it('unexpected exit rejects safely, notifies listeners, and never exits the parent', async () => {
    await expect(fakeChild({ args: fakeArgs('--immediate-exit') })).rejects.toThrow();
    const child = await fakeChild();
    let exits = 0;
    const unsubscribe = child.onExit(() => { exits += 1; });
    await child.callTool('resolve-library-id', { libraryName: 'fixture', query: 'mode:exit-now' }).catch(() => undefined);
    for (let i = 0; i < 40 && exits === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(exits).toBe(1);
    unsubscribe();
    expect(process.pid).toBeGreaterThan(0);
  });

  it('notifies a late exit listener exactly once after the child closed following tools/list', async () => {
    const child = await loadAdapter().createContext7Child({
      apiKey: undefined,
      inheritedEnv: { PATH: process.env.PATH ?? '' },
      command: process.execPath,
      entryPath: writeLateExitMcpFixture(),
      observerPath,
      args: [],
      cwd: repoRoot,
      connectTimeoutMs: 2_000,
      callTimeoutMs: 2_000,
      redact: (value: unknown) => value,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    let delivered = 0;
    const unsubscribe = child.onExit(() => { delivered += 1; });
    let cancelledDelivery = 0;
    const cancelLate = child.onExit(() => { cancelledDelivery += 1; });
    cancelLate();

    expect(delivered).toBe(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(delivered).toBe(1);
    expect(cancelledDelivery).toBe(0);
    await child.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(delivered).toBe(1);
    unsubscribe();
  });

  it('ignores child stderr so a noisy child cannot leak or block on pipe backpressure', async () => {
    const child = await fakeChild({ args: ['--stderr-bytes', String(2 * 1024 * 1024)] });
    try {
      expect(child.tools).toHaveLength(2);
    } finally {
      await child.close();
    }
  }, 10_000);

  it('aborts a delayed in-flight tools/call promptly, closes the child, and leaves no unhandled rejection', () => {
    const root = tempRoot();
    const pidFile = path.join(root, 'abort.pid');
    const result = runAbortHarness(pidFile);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const evidence = JSON.parse(result.stdout) as {
      elapsedMs: number;
      error: string;
      unhandled: string[];
      childAlive: boolean;
    };
    expect(evidence.error).toMatch(/fixture in-flight cancellation|abort/i);
    expect(evidence.elapsedMs).toBeLessThan(2_500);
    expect(evidence.unhandled).toEqual([]);
    expect(evidence.childAlive).toBe(false);
  }, 10_000);
});
