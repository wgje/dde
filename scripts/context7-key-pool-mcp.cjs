#!/usr/bin/env node
'use strict';

const BOOTSTRAP_FAILURE = 'context7-pool-bootstrap-failed';

async function bootstrap() {
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const { KEY_NAMES, loadCredentialPool } = require('./context7-key-pool/credentials.cjs');
const { createRedactor } = require('./context7-key-pool/redaction.cjs');
const { createStateStore } = require('./context7-key-pool/state-store.cjs');
const { STATUS_TOOL, projectPublicStatus } = require('./context7-key-pool/status.cjs');
const {
  createContext7Child,
  resolvePinnedContext7Entry,
} = require('./context7-key-pool/context7-child.cjs');
const { createPoolRuntime } = require('./context7-key-pool/runtime.cjs');

const repoRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.resolve(repoRoot, 'src/tests/fixtures/context7-key-pool');
const observerPath = path.resolve(__dirname, 'context7-key-pool/context7-fetch-observer.cjs');
const OFFICIAL_TOOL_NAMES = new Set(['resolve-library-id', 'query-docs']);
const TOOL_FAILURE = 'context7-pool-tool-failed';
const INPUT_FAILURE = 'context7-pool-input-invalid';
const DEFAULT_TIME_ZONE = 'UTC';
const CLOSE_BOUND_MS = 6_000;

function testFixtureMode(env) {
  return env.NODE_ENV === 'test' && env.CONTEXT7_POOL_TEST_FIXTURE === '1';
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function regularRealpath(value, failureClass) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(failureClass);
  let resolved;
  try {
    resolved = fs.realpathSync(value);
  } catch {
    throw new Error(failureClass);
  }
  if (!fs.statSync(resolved).isFile()) throw new Error(failureClass);
  return resolved;
}

function parseFixtureArgs(value) {
  if (value === undefined || value === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('context7-pool-fixture-args-invalid');
  }
  if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== 'string')) {
    throw new Error('context7-pool-fixture-args-invalid');
  }
  return parsed;
}

function defaultStateDir(env) {
  const localRoot = typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA
    ? env.LOCALAPPDATA
    : path.join(os.homedir(), '.local', 'share');
  return path.join(localRoot, 'NanoFlow', 'context7-key-pool');
}

function resolveStateDir(env) {
  if (testFixtureMode(env) && typeof env.CONTEXT7_POOL_TEST_STATE_DIR === 'string') {
    if (!path.isAbsolute(env.CONTEXT7_POOL_TEST_STATE_DIR)) {
      throw new Error('context7-pool-fixture-state-dir-invalid');
    }
    return path.resolve(env.CONTEXT7_POOL_TEST_STATE_DIR);
  }
  return defaultStateDir(env);
}

function resolveLaunch(env) {
  if (!testFixtureMode(env)) {
    return {
      command: process.execPath,
      entryPath: resolvePinnedContext7Entry(),
      args: [],
    };
  }
  const commandValue = env.CONTEXT7_POOL_TEST_CHILD_COMMAND || process.execPath;
  const entryValue = env.CONTEXT7_POOL_TEST_CHILD_ENTRY;
  const command = regularRealpath(commandValue, 'context7-pool-fixture-command-invalid');
  const entryPath = regularRealpath(entryValue, 'context7-pool-fixture-entry-invalid');
  const realFixtureRoot = fs.realpathSync(fixtureRoot);
  if (!isInside(realFixtureRoot, entryPath)) throw new Error('context7-pool-fixture-entry-outside-root');
  return { command, entryPath, args: parseFixtureArgs(env.CONTEXT7_POOL_TEST_CHILD_ARGS) };
}

function currentTimeZone(env) {
  return typeof env.CONTEXT7_POOL_TIME_ZONE === 'string' && env.CONTEXT7_POOL_TIME_ZONE
    ? env.CONTEXT7_POOL_TIME_ZONE
    : DEFAULT_TIME_ZONE;
}

function publicFailure(failureClass = TOOL_FAILURE) {
  return { content: [{ type: 'text', text: failureClass }], isError: true };
}

function isEmptyStatusArguments(value) {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.keys(value).length === 0;
}

function redactForStatus(env) {
  return createRedactor(KEY_NAMES.map(name => env[name]).filter(value => typeof value === 'string'));
}

function createStore(env, redact) {
  return createStateStore({
    stateDir: resolveStateDir(env),
    lockWaitMs: 30_000,
    redact,
  });
}

async function inspectedPublicStatus(
  store,
  runtime = null,
  routeOverride = null,
  reconciliationOverride = null,
) {
  const inspected = await store.inspectStored();
  const storedSnapshot = {
    state: inspected.state,
    health: inspected.health,
    reconciliation: reconciliationOverride ?? inspected.reconciliation,
    now: new Date(),
  };
  return projectPublicStatus({
    ...storedSnapshot,
    ...(routeOverride ? { activeRoute: routeOverride } : {}),
    runtime,
  });
}

async function livePublicStatus(store, runtime) {
  return inspectedPublicStatus(
    store,
    runtime.getPublicRuntime(),
    runtime.getRouteOverride(),
    runtime.hasAppliedCredentials() ? 'applied' : null,
  );
}

async function runStatus(env) {
  const redact = redactForStatus(env);
  const store = createStore(env, redact);
  const status = redact(await inspectedPublicStatus(store));
  process.stdout.write(`${JSON.stringify(status)}\n`);
}

function createApplication(env) {
  const credentials = loadCredentialPool(env);
  const redact = createRedactor(credentials.map(credential => credential.value));
  const baseStore = createStore(env, redact);
  const store = testFixtureMode(env) && env.CONTEXT7_POOL_TEST_RECORD_OUTCOME_FAILURE === '1'
    ? {
        ...baseStore,
        async recordOutcome() {
          throw new Error('context7-pool-test-outcome-persistence-failed');
        },
      }
    : baseStore;
  const launch = resolveLaunch(env);
  const timeZone = currentTimeZone(env);
  const runtime = createPoolRuntime({
    credentials,
    store,
    timeZone,
    now: () => new Date(),
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    redact,
    childFactory: ({ apiKey }) => createContext7Child({
      apiKey,
      inheritedEnv: { ...env },
      command: launch.command,
      entryPath: launch.entryPath,
      observerPath,
      args: launch.args,
      cwd: repoRoot,
      connectTimeoutMs: 10_000,
      callTimeoutMs: 70_000,
      redact,
    }),
  });
  return { redact, runtime, store };
}

async function runMcp(env) {
  const { redact, runtime, store } = createApplication(env);
  const server = new Server(
    { name: 'nanoflow-context7-key-pool', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  const transport = new StdioServerTransport();
  let shutdownPromise = null;

  const shutdown = (closeServer) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await runtime.close().catch(() => undefined);
      if (closeServer) await server.close().catch(() => undefined);
    })();
    return shutdownPromise;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const tools = await runtime.listTools();
      return { tools: [...tools, STATUS_TOOL] };
    } catch (error) {
      redact(error);
      throw new Error(TOOL_FAILURE);
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    try {
      if (name === STATUS_TOOL.name) {
        if (!isEmptyStatusArguments(request.params.arguments)) return publicFailure(INPUT_FAILURE);
        const status = await livePublicStatus(store, runtime);
        return {
          content: [{ type: 'text', text: JSON.stringify(status) }],
          structuredContent: status,
        };
      }
      if (!OFFICIAL_TOOL_NAMES.has(name)) return publicFailure();
      return await runtime.callTool(name, request.params.arguments ?? {}, { signal: extra.signal });
    } catch (error) {
      redact(error);
      return publicFailure();
    }
  });

  server.onclose = () => { void shutdown(false); };
  process.once('SIGTERM', () => {
    const forced = setTimeout(() => process.exit(0), CLOSE_BOUND_MS);
    forced.unref?.();
    void shutdown(true).finally(() => {
      clearTimeout(forced);
      process.exit(0);
    });
  });

  await server.connect(transport);
}

async function main() {
  if (process.argv.slice(2).includes('--status')) {
    await runStatus(process.env);
    return;
  }
  await runMcp(process.env);
}

await main();
}

bootstrap().catch(() => {
  process.stderr.write(`${BOOTSTRAP_FAILURE}\n`);
  process.exitCode = 1;
});
