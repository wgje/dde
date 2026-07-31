'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StdioClientTransport,
  getDefaultEnvironment,
} = require('@modelcontextprotocol/sdk/client/stdio.js');
const {
  CallToolResultSchema,
  ListToolsResultSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const repoRoot = path.resolve(__dirname, '../..');
const FAILURE_PREFIX = 'nanoflow-context7-failure-v1';
const MARKER_RE = /^[a-f0-9]{64}$/;
const STATUS_TOOL_NAME = 'context7-pool-status';
const SAFE_ENV_NAMES = Object.freeze([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
]);

const EXPECTED_CONTEXT7_TOOL_CONTRACT = Object.freeze({
  'resolve-library-id': Object.freeze({
    required: Object.freeze(['libraryName', 'query']),
    stringProperties: Object.freeze(['libraryName', 'query']),
  }),
  'query-docs': Object.freeze({
    required: Object.freeze(['libraryId', 'query']),
    stringProperties: Object.freeze(['libraryId', 'query']),
  }),
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function descriptorSignature(tools) {
  return JSON.stringify(
    [...tools]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(canonicalize),
  );
}

function failContract(detail) {
  throw new Error(`context7-child-tool-contract:${detail}`);
}

function validateOfficialToolSet(tools, expectedSignature) {
  if (!Array.isArray(tools)) failContract('tools-not-array');
  const expectedNames = Object.keys(EXPECTED_CONTEXT7_TOOL_CONTRACT).sort();
  const names = tools.map((tool) => tool && tool.name).sort();
  if (names.includes(STATUS_TOOL_NAME)) failContract('status-tool-collision');
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) failContract('tool-names');

  for (const tool of tools) {
    if (!isPlainObject(tool)) failContract('tool-not-object');
    const contract = EXPECTED_CONTEXT7_TOOL_CONTRACT[tool.name];
    const schema = tool.inputSchema;
    if (!isPlainObject(schema) || schema.type !== 'object') failContract(`${tool.name}:input-schema`);
    if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string')) {
      failContract(`${tool.name}:required`);
    }
    const required = [...schema.required].sort();
    const expectedRequired = [...contract.required].sort();
    if (JSON.stringify(required) !== JSON.stringify(expectedRequired)) failContract(`${tool.name}:required-set`);
    if (!isPlainObject(schema.properties)) failContract(`${tool.name}:properties`);
    for (const propertyName of contract.stringProperties) {
      const property = schema.properties[propertyName];
      if (!isPlainObject(property) || property.type !== 'string') {
        failContract(`${tool.name}:${propertyName}:string`);
      }
    }
  }

  const signature = descriptorSignature(tools);
  if (expectedSignature !== undefined && signature !== expectedSignature) {
    throw new Error('context7-child-tool-signature:mismatch');
  }
  return signature;
}

function resolvePinnedContext7Entry() {
  const packageJsonPath = require.resolve('@upstash/context7-mcp/package.json', { paths: [repoRoot] });
  const packageRoot = fs.realpathSync(path.dirname(packageJsonPath));
  const descriptor = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (
    descriptor.name !== '@upstash/context7-mcp'
    || descriptor.version !== '2.1.1'
    || !isPlainObject(descriptor.bin)
    || descriptor.bin['context7-mcp'] !== 'dist/index.js'
  ) {
    throw new Error('context7-child-pinned-entry:descriptor-mismatch');
  }
  const entryPath = fs.realpathSync(path.resolve(packageRoot, descriptor.bin['context7-mcp']));
  const relative = path.relative(packageRoot, entryPath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('context7-child-pinned-entry:outside-package');
  }
  if (!fs.statSync(entryPath).isFile()) {
    throw new Error('context7-child-pinned-entry:not-regular-file');
  }
  return entryPath;
}

function inheritedValue(inheritedEnv, canonicalName) {
  if (process.platform !== 'win32') return inheritedEnv[canonicalName];
  if (Object.prototype.hasOwnProperty.call(inheritedEnv, canonicalName)) return inheritedEnv[canonicalName];
  const match = Object.keys(inheritedEnv).find((name) => name.toUpperCase() === canonicalName);
  return match === undefined ? undefined : inheritedEnv[match];
}

function buildChildEnvironment(inheritedEnv, apiKey, marker) {
  const effective = { ...getDefaultEnvironment() };
  const names = process.platform === 'win32'
    ? SAFE_ENV_NAMES
    : [...SAFE_ENV_NAMES, 'http_proxy', 'https_proxy', 'no_proxy'];
  for (const name of names) {
    const value = inheritedValue(inheritedEnv, name);
    if (typeof value === 'string') effective[name] = value;
  }
  for (const name of Object.keys(effective)) {
    if (name.toUpperCase().startsWith('CONTEXT7_API_KEY') || name === 'NANOFLOW_CONTEXT7_FAILURE_MARKER') {
      delete effective[name];
    }
  }
  if (apiKey !== undefined) effective.CONTEXT7_API_KEY = apiKey;
  effective.NANOFLOW_CONTEXT7_FAILURE_MARKER = marker;
  return effective;
}

function redactMarker(value, marker) {
  if (typeof value === 'string') return value.split(marker).join('[REDACTED_MARKER]');
  if (Array.isArray(value)) return value.map((entry) => redactMarker(entry, marker));
  if (!isPlainObject(value)) return value;
  const redacted = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[redactMarker(key, marker)] = redactMarker(entry, marker);
  }
  return redacted;
}

function extractTrustedFailureEvidence(result, marker) {
  if (!MARKER_RE.test(marker)) throw new Error('context7-child-marker-invalid');
  let failureEvidence = null;
  const content = result && result.content;
  if (
    Array.isArray(content)
    && content.length === 1
    && isPlainObject(content[0])
    && content[0].type === 'text'
    && typeof content[0].text === 'string'
  ) {
    const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(
      `^${FAILURE_PREFIX}:${escapedMarker}:kind=(http|transport|observer-internal);status=(none|[0-9]{3});retry-after=(none|[0-9]+)$`,
    ).exec(content[0].text);
    if (match) {
      const kind = match[1];
      const status = match[2] === 'none' ? null : Number(match[2]);
      const retryAfterSeconds = match[3] === 'none' ? null : Number(match[3]);
      const validRetry = retryAfterSeconds === null
        || (Number.isInteger(retryAfterSeconds) && retryAfterSeconds >= 1 && retryAfterSeconds <= 86400);
      const validShape = kind === 'http'
        ? Number.isInteger(status) && status >= 100 && status <= 599 && validRetry
        : status === null && retryAfterSeconds === null;
      if (validShape) failureEvidence = { kind, status, retryAfterSeconds };
    }
  }
  return {
    result: redactMarker(result, marker),
    failureEvidence,
  };
}

function safeError(error, marker, redact) {
  const original = error instanceof Error ? error.message : String(error);
  const withoutMarker = original.split(marker).join('[REDACTED_MARKER]');
  let message = withoutMarker;
  if (typeof redact === 'function') {
    try {
      const redacted = redact(withoutMarker);
      message = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
    } catch {
      message = 'context7-child-failure';
    }
  }
  return new Error(message || 'context7-child-failure');
}

async function createContext7Child(options) {
  if (!isPlainObject(options)) throw new Error('context7-child-options-invalid');
  const {
    apiKey,
    inheritedEnv,
    command,
    entryPath,
    observerPath,
    args,
    cwd,
    connectTimeoutMs,
    callTimeoutMs,
    redact,
  } = options;
  if (apiKey !== undefined && typeof apiKey !== 'string') throw new Error('context7-child-api-key-invalid');
  if (!isPlainObject(inheritedEnv)) throw new Error('context7-child-inherited-env-invalid');
  if (![command, entryPath, observerPath, cwd].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new Error('context7-child-launch-invalid');
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) throw new Error('context7-child-args-invalid');
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs <= 0) throw new Error('context7-child-connect-timeout-invalid');
  if (!Number.isInteger(callTimeoutMs) || callTimeoutMs <= 0) throw new Error('context7-child-call-timeout-invalid');

  const marker = crypto.randomBytes(32).toString('hex');
  const env = buildChildEnvironment(inheritedEnv, apiKey, marker);
  const client = new Client({ name: 'nanoflow-context7-key-pool', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command,
    args: ['--require', observerPath, entryPath, ...args],
    cwd,
    env,
    stderr: 'ignore',
  });
  const exitListeners = new Set();
  let closed = false;
  let closePromise = null;
  client.onerror = () => {};
  client.onclose = () => {
    closed = true;
    for (const listener of [...exitListeners]) {
      try { listener(); } catch { /* listener isolation */ }
    }
  };

  const close = async () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closed = true;
      await client.close().catch(() => transport.close().catch(() => undefined));
    })();
    return closePromise;
  };

  try {
    await client.connect(transport, { timeout: connectTimeoutMs });
    const listed = await client.request(
      { method: 'tools/list', params: {} },
      ListToolsResultSchema,
      { timeout: connectTimeoutMs },
    );
    validateOfficialToolSet(listed.tools);

    return {
      tools: listed.tools,
      async callTool(name, toolArgs, callOptions = {}) {
        if (closed) throw new Error('context7-child-closed');
        try {
          const result = await client.request(
            { method: 'tools/call', params: { name, arguments: toolArgs } },
            CallToolResultSchema,
            { timeout: callTimeoutMs, signal: callOptions.signal },
          );
          return extractTrustedFailureEvidence(result, marker, redact);
        } catch (error) {
          await close();
          throw safeError(error, marker, redact);
        }
      },
      close,
      onExit(listener) {
        if (typeof listener !== 'function') throw new Error('context7-child-exit-listener-invalid');
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
    };
  } catch (error) {
    await close();
    throw safeError(error, marker, redact);
  }
}

module.exports = {
  EXPECTED_CONTEXT7_TOOL_CONTRACT,
  createContext7Child,
  extractTrustedFailureEvidence,
  resolvePinnedContext7Entry,
  validateOfficialToolSet,
};
