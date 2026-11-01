// @vitest-environment node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');
const require = createRequire(import.meta.url);
const parentPath = path.join(repoRoot, 'scripts/context7-key-pool-mcp.cjs');
const fixtureRoot = path.join(repoRoot, 'src/tests/fixtures/context7-key-pool');
const fakeMcpPath = path.join(fixtureRoot, 'fake-context7-mcp.cjs');
const policyPath = path.join(repoRoot, 'scripts/context7-key-pool/policy.cjs');
const statusPath = path.join(repoRoot, 'scripts/context7-key-pool/status.cjs');
const roots: string[] = [];
const clients: ParentClient[] = [];

const syntheticSecrets = [1, 2, 3, 4].map(slot => `synthetic-context7-slot-${slot}-never-real`);

type Tool = Record<string, unknown> & { name: string };
type ParentClient = {
  client: Client;
  transport: StdioClientTransport;
  pid: number | undefined;
  stderr(): string;
  close(): Promise<void>;
};

function tempRoot(label = 'mcp'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `context7-pool-${label}-`));
  roots.push(root);
  return root;
}

function testEnv(stateDir: string, childArgs: string[] = [], overrides: NodeJS.ProcessEnv = {}): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    NODE_ENV: 'test',
    CONTEXT7_POOL_TEST_FIXTURE: '1',
    CONTEXT7_POOL_TEST_STATE_DIR: stateDir,
    CONTEXT7_POOL_TEST_CHILD_COMMAND: process.execPath,
    CONTEXT7_POOL_TEST_CHILD_ENTRY: fakeMcpPath,
    CONTEXT7_POOL_TEST_CHILD_ARGS: JSON.stringify(childArgs),
    CONTEXT7_POOL_TIME_ZONE: 'UTC',
    CONTEXT7_API_KEY_1: syntheticSecrets[0]!,
    CONTEXT7_API_KEY_2: syntheticSecrets[1]!,
    CONTEXT7_API_KEY_3: syntheticSecrets[2]!,
    CONTEXT7_API_KEY_4: syntheticSecrets[3]!,
    ...Object.fromEntries(Object.entries(overrides).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  };
}

async function startParent(stateDir: string, childArgs: string[] = [], overrides: NodeJS.ProcessEnv = {}): Promise<ParentClient> {
  let stderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [parentPath],
    cwd: repoRoot,
    env: testEnv(stateDir, childArgs, overrides),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'context7-pool-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const handle: ParentClient = {
    client,
    transport,
    pid: Number.isFinite(transport.pid) ? Number(transport.pid) : undefined,
    stderr: () => stderr,
    close: async () => {
      const pid = Number.isFinite(transport.pid) ? Number(transport.pid) : undefined;
      await Promise.race([
        client.close().catch(() => undefined),
        new Promise(resolve => setTimeout(resolve, 2_000)),
      ]);
      if (Number.isInteger(pid) && pid !== undefined && pid > 0) {
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already stopped; keep cleanup idempotent.
        }
      }
    },
  };
  clients.push(handle);
  return handle;
}

async function eventuallyFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`fixture file was not created: ${path.basename(filePath)}`);
}

type ChildInstance = { pid: number; instanceId: string };

async function eventuallyChildInstances(filePath: string, count: number): Promise<ChildInstance[]> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (fs.existsSync(filePath)) {
      const instances = fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as ChildInstance);
      if (instances.length >= count
        && instances.every(instance => (
          Number.isInteger(instance.pid)
          && instance.pid > 0
          && /^[0-9a-f-]{36}$/.test(instance.instanceId)
        ))) {
        return instances;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`fixture did not record ${count} child instances`);
}

async function expectPidStops(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 10));
    } catch {
      return;
    }
  }
  throw new Error(`process ${pid} remained alive`);
}

function statusFrom(result: Awaited<ReturnType<Client['callTool']>>): Record<string, any> {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe('text');
  const parsed = JSON.parse(content[0]!.text) as Record<string, unknown>;
  expect(result.structuredContent).toEqual(parsed);
  return parsed;
}

function canonicalTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalTree);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort().map(key => [key, canonicalTree((value as Record<string, unknown>)[key])]));
}

function writeSeededState(stateDir: string, successfulAttempts: number): void {
  const policy = require(policyPath) as {
    reconcileState(args: Record<string, unknown>): any;
    selectRoute(state: any, now: Date): any;
    reserveRoute(args: Record<string, unknown>): { state: any; reservation: any };
    applyOutcome(args: Record<string, unknown>): any;
  };
  const now = new Date();
  const identities = syntheticSecrets.map((secret, index) => ({
    slot: index + 1,
    fingerprintSha256: createHash('sha256').update(secret).digest('hex'),
  }));
  let state = policy.reconcileState({ state: null, identities, timeZone: 'UTC', now });
  for (let index = 0; index < successfulAttempts; index += 1) {
    const route = policy.selectRoute(state, now);
    const reserved = policy.reserveRoute({ state, route, now });
    state = policy.applyOutcome({ state: reserved.state, token: reserved.reservation, outcome: { kind: 'success' }, now });
  }
  const revision = 0;
  const body = JSON.stringify(canonicalTree({ schemaVersion: 1, revision, payload: state }));
  const envelope = {
    schemaVersion: 1,
    revision,
    checksumSha256: createHash('sha256').update(body).digest('hex'),
    payload: state,
  };
  fs.mkdirSync(stateDir, { recursive: true });
  const serialized = JSON.stringify(envelope);
  fs.writeFileSync(path.join(stateDir, 'state.json'), serialized);
  fs.writeFileSync(path.join(stateDir, 'state.backup.json'), serialized);
}

function writeLocalRequireFailureHook(): { hookPath: string; sentinel: string; leakedPath: string } {
  const root = tempRoot('require-hook');
  const hookPath = path.join(root, 'fail-local-require.cjs');
  const sentinel = 'RAW_LOCAL_REQUIRE_SENTINEL_MUST_NOT_LEAK';
  const leakedPath = path.join(root, 'raw-absolute-state-path.json');
  fs.writeFileSync(hookPath, `'use strict';
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function guardedFixtureLoad(request, parent, isMain) {
  if (request === './context7-key-pool/credentials.cjs') {
    const error = new Error(${JSON.stringify(`${sentinel} ${leakedPath}`)});
    error.stack = ${JSON.stringify(`Error: ${sentinel}\n    at ${leakedPath}:7:11`)};
    throw error;
  }
  return originalLoad.call(this, request, parent, isMain);
};
`);
  return { hookPath, sentinel, leakedPath };
}

function writeStateReadCounterHook(stateDir: string): {
  hookPath: string;
  readCount(): number;
} {
  const root = tempRoot('read-counter-hook');
  const hookPath = path.join(root, 'count-state-reads.cjs');
  const countPath = path.join(root, 'state-read-count.txt');
  fs.writeFileSync(hookPath, `'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const stateDir = path.resolve(${JSON.stringify(stateDir)});
const countPath = ${JSON.stringify(countPath)};
const originalReadFile = fsp.readFile;
let count = 0;
fsp.readFile = async function countedReadFile(filePath, ...args) {
  const resolved = path.resolve(String(filePath));
  const name = path.basename(resolved);
  if (path.dirname(resolved) === stateDir && (name === 'state.json' || name === 'state.backup.json')) {
    count += 1;
    fs.writeFileSync(countPath, String(count));
  }
  return originalReadFile.call(this, filePath, ...args);
};
`);
  return {
    hookPath,
    readCount: () => fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0,
  };
}

function writeMalformedRouteOverrideHook(): string {
  const root = tempRoot('malformed-route-hook');
  const hookPath = path.join(root, 'malformed-route-override.cjs');
  fs.writeFileSync(hookPath, `'use strict';
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function routeOverrideFixture(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (request !== './context7-key-pool/runtime.cjs') return loaded;
  return {
    ...loaded,
    createPoolRuntime(options) {
      const runtime = loaded.createPoolRuntime(options);
      return {
        ...runtime,
        getRouteOverride() {
          return {kind:'anonymous',reason:'outcome-persistence-failed',extra:'forbidden'};
        },
      };
    },
  };
};
`);
  return hookPath;
}

function writeStatusActiveRouteContractHook(): string {
  const root = tempRoot('status-active-route-hook');
  const hookPath = path.join(root, 'require-active-route.cjs');
  fs.writeFileSync(hookPath, `'use strict';
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function activeRouteContractFixture(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (request !== './context7-key-pool/status.cjs') return loaded;
  return {
    ...loaded,
    projectPublicStatus(args) {
      if (args && args.runtime && args.runtime.keyedDispatches === 1) {
        const route = args.activeRoute;
        if (!route
          || route.kind !== 'anonymous'
          || route.reason !== 'outcome-persistence-failed'
          || Object.keys(route).sort().join(',') !== 'kind,reason') {
          throw new Error('status-active-route-contract-missing');
        }
      }
      return loaded.projectPublicStatus(args);
    },
  };
};
`);
  return hookPath;
}

afterEach(async () => {
  while (clients.length > 0) await clients.pop()!.close();
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
}, 15_000);

describe('stable Context7 key-pool parent MCP', () => {
  it('normalizes local dependency bootstrap failures before MCP without raw stack or paths', () => {
    const { hookPath, sentinel, leakedPath } = writeLocalRequireFailureHook();
    const failed = spawnSync(process.execPath, ['--require', hookPath, parentPath], {
      cwd: repoRoot,
      env: getDefaultEnvironment(),
      encoding: 'utf8',
      input: '',
      timeout: 5_000,
    });
    expect(failed.status).not.toBe(0);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toBe('context7-pool-bootstrap-failed\n');
    expect(failed.stderr).not.toContain(sentinel);
    expect(failed.stderr).not.toContain(leakedPath);
    expect(failed.stderr).not.toContain(hookPath);
  });

  it('rejects non-empty status arguments before state reads or child activity', async () => {
    const stateDir = tempRoot('status-input');
    const pidFile = path.join(tempRoot('pid'), 'status-input-child.pid');
    const counter = writeStateReadCounterHook(stateDir);
    const parent = await startParent(stateDir, ['--pid-file', pidFile], {
      NODE_OPTIONS: `--require=${counter.hookPath}`,
    });

    const empty = await parent.client.callTool({ name: 'context7-pool-status', arguments: {} });
    expect(empty.isError).not.toBe(true);
    const readsAfterEmpty = counter.readCount();
    expect(readsAfterEmpty).toBeGreaterThan(0);
    const invalid = await parent.client.callTool({
      name: 'context7-pool-status',
      arguments: { forbidden: 'raw-status-input-sentinel' },
    });
    expect(invalid).toEqual({
      content: [{ type: 'text', text: 'context7-pool-input-invalid' }],
      isError: true,
    });
    expect(JSON.stringify(invalid)).not.toContain('raw-status-input-sentinel');
    expect(counter.readCount()).toBe(readsAfterEmpty);
    expect(fs.existsSync(pidFile)).toBe(false);

    for (const argumentsValue of [null, []]) {
      const readsBeforeRejectedShape = counter.readCount();
      await expect(parent.client.callTool({
        name: 'context7-pool-status',
        arguments: argumentsValue as any,
      })).rejects.toMatchObject({ code: -32603 });
      expect(counter.readCount()).toBe(readsBeforeRejectedShape);
    }

    const omitted = await parent.client.callTool({ name: 'context7-pool-status' });
    expect(omitted.isError).not.toBe(true);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('projects the live outcome-persistence latch without extra child or quota activity', async () => {
    const stateDir = tempRoot('live-latch');
    const pidFile = path.join(tempRoot('pid'), 'live-latch-child.pid');
    const contractHook = writeStatusActiveRouteContractHook();
    const parent = await startParent(stateDir, ['--pid-file', pidFile], {
      CONTEXT7_POOL_TEST_RECORD_OUTCOME_FAILURE: '1',
      NODE_OPTIONS: `--require=${contractHook}`,
    });
    await expect(parent.client.callTool({
      name: 'query-docs',
      arguments: { libraryId: '/fixture', query: 'trigger synthetic persistence latch' },
    })).resolves.toMatchObject({ content: [{ type: 'text', text: 'fixture-ok' }] });
    const childPid = Number(await eventuallyFile(pidFile));

    const first = statusFrom(await parent.client.callTool({ name: 'context7-pool-status', arguments: {} }));
    expect(first).toMatchObject({
      mode: 'anonymous',
      activeSlot: null,
      anonymousReason: 'outcome-persistence-failed',
      runtime: { keyedDispatches: 1, anonymousDispatches: 0 },
    });
    expect(first.slots.map((slot: any) => slot.attemptedCalls)).toEqual([1, 0, 0, 0]);
    expect(first.slots.map((slot: any) => slot.successfulCalls)).toEqual([0, 0, 0, 0]);

    const second = statusFrom(await parent.client.callTool({ name: 'context7-pool-status' }));
    expect(second).toMatchObject({
      mode: 'anonymous',
      activeSlot: null,
      anonymousReason: 'outcome-persistence-failed',
    });
    expect(second.runtime).toEqual(first.runtime);
    expect(second.slots).toEqual(first.slots);
    expect(Number(fs.readFileSync(pidFile, 'utf8'))).toBe(childPid);
    expect(() => process.kill(childPid, 0)).not.toThrow();
  });

  it('fails closed when a runtime route override is malformed for stored state', async () => {
    const hookPath = writeMalformedRouteOverrideHook();
    const pidFile = path.join(tempRoot('pid'), 'malformed-route-child.pid');
    const parent = await startParent(tempRoot('malformed-route'), ['--pid-file', pidFile], {
      NODE_OPTIONS: `--require=${hookPath}`,
    });
    await expect(parent.client.callTool({
      name: 'query-docs',
      arguments: { libraryId: '/fixture', query: 'establish stored state' },
    })).resolves.toMatchObject({ content: [{ type: 'text', text: 'fixture-ok' }] });
    const result = await parent.client.callTool({ name: 'context7-pool-status', arguments: {} });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'context7-pool-tool-failed' }],
      isError: true,
    });
    expect(JSON.stringify(result)).not.toContain('extra');
    expect(Number(await eventuallyFile(pidFile))).toBeGreaterThan(0);
  });

  it('projects live stored-state inspection failures as redacted fail-closed status', async () => {
    const stateDir = tempRoot('live-inspection-failure');
    fs.writeFileSync(path.join(stateDir, 'state.json'), '{corrupt');
    const parent = await startParent(stateDir);
    const result = await parent.client.callTool({ name: 'context7-pool-status', arguments: {} });
    const status = statusFrom(result);
    expect(status).toMatchObject({
      mode: 'anonymous',
      activeSlot: null,
      anonymousReason: 'state-unavailable-fail-closed',
      stateHealth: 'fail-closed',
    });
    expect(JSON.stringify(result)).not.toContain(stateDir);
  });

  it('preserves both official descriptors and advertises exactly the public status descriptor', async () => {
    const parent = await startParent(tempRoot());
    const listed = await parent.client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual([
      'resolve-library-id',
      'query-docs',
      'context7-pool-status',
    ]);
    expect(listed.tools.slice(0, 2)).toEqual([
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
    ]);
    const { STATUS_TOOL } = require(statusPath) as { STATUS_TOOL: Tool };
    expect(listed.tools[2]).toEqual(STATUS_TOOL);
  });

  it('increments one durable attempt while keeping the same parent PID alive', async () => {
    const parent = await startParent(tempRoot());
    const pid = parent.transport.pid;
    expect(pid).toEqual(expect.any(Number));
    await expect(parent.client.callTool({
      name: 'resolve-library-id',
      arguments: { libraryName: 'fixture', query: 'one safe call' },
    })).resolves.toMatchObject({ content: [{ type: 'text', text: 'fixture-ok' }] });
    const status = statusFrom(await parent.client.callTool({ name: 'context7-pool-status', arguments: {} }));
    expect(status).toMatchObject({ mode: 'keyed', activeSlot: 1, anonymousReason: null });
    expect(status.slots[0]).toMatchObject({ slot: 1, attemptedCalls: 1, successfulCalls: 1 });
    expect(parent.transport.pid).toBe(pid);
    expect(() => process.kill(pid!, 0)).not.toThrow();
  });

  it('boots and serves MCP with only the first contiguous key slot', async () => {
    const parent = await startParent(tempRoot('single-key'), [], {
      CONTEXT7_API_KEY_2: '',
      CONTEXT7_API_KEY_3: '',
      CONTEXT7_API_KEY_4: '',
    });
    const listed = await parent.client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual([
      'resolve-library-id',
      'query-docs',
      'context7-pool-status',
    ]);
    await expect(parent.client.callTool({
      name: 'resolve-library-id',
      arguments: { libraryName: 'fixture', query: 'single contiguous key' },
    })).resolves.toMatchObject({ content: [{ type: 'text', text: 'fixture-ok' }] });
    const status = statusFrom(await parent.client.callTool({
      name: 'context7-pool-status',
      arguments: {},
    }));
    expect(status).toMatchObject({ mode: 'keyed', activeSlot: 1, anonymousReason: null });
    expect(status.slots).toHaveLength(1);
    expect(status.slots[0]).toMatchObject({ slot: 1, attemptedCalls: 1, successfulCalls: 1 });
    expect(JSON.stringify(status)).not.toContain(syntheticSecrets[0]);
  });

  it('fails bootstrap before MCP when keys form a non-contiguous gap', () => {
    const env = testEnv(tempRoot('gap'), [], {
      CONTEXT7_API_KEY_3: 'synthetic-context7-gap-slot-3-never-real',
      CONTEXT7_API_KEY_4: 'synthetic-context7-gap-slot-4-never-real',
    });
    delete env.CONTEXT7_API_KEY_2;
    const failed = spawnSync(process.execPath, [parentPath], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      input: '',
      timeout: 5_000,
    });
    expect(failed.status).not.toBe(0);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toBe('context7-pool-bootstrap-failed\n');
    expect(failed.stderr).not.toContain('synthetic-context7-gap-slot-3-never-real');
  });

  it('replaces the child at 950 while the same parent client continues', async () => {
    const stateDir = tempRoot('switch');
    writeSeededState(stateDir, 949);
    const instanceLog = path.join(tempRoot('pid'), 'child-instances.jsonl');
    const parent = await startParent(stateDir, ['--instance-log', instanceLog]);
    const parentPid = parent.transport.pid;
    await parent.client.callTool({
      name: 'query-docs', arguments: { libraryId: '/fixture', query: 'attempt 950' },
    });
    const [firstChild] = await eventuallyChildInstances(instanceLog, 1);
    await parent.client.callTool({
      name: 'query-docs', arguments: { libraryId: '/fixture', query: 'slot two' },
    });
    const instances = await eventuallyChildInstances(instanceLog, 2);
    const secondChild = instances[1]!;
    expect(secondChild.instanceId).not.toBe(firstChild!.instanceId);
    if (secondChild.pid !== firstChild!.pid) await expectPidStops(firstChild!.pid);
    expect(parent.transport.pid).toBe(parentPid);
    const status = statusFrom(await parent.client.callTool({ name: 'context7-pool-status', arguments: {} }));
    expect(status).toMatchObject({ mode: 'keyed', activeSlot: 2, anonymousReason: null });
    expect(status.slots.map((slot: any) => slot.attemptedCalls)).toEqual([950, 1, 0, 0]);
  }, 90_000);

  it('recovers from child crashes without closing parent stdio and redacts the MCP error', async () => {
    const parent = await startParent(tempRoot());
    const pid = parent.transport.pid;
    const failed = await parent.client.callTool({
      name: 'resolve-library-id',
      arguments: { libraryName: 'fixture', query: 'mode:exit-now' },
    });
    expect(failed).toMatchObject({ isError: true });
    expect(JSON.stringify(failed)).toMatch(/^.*context7-pool-[a-z-]+.*$/s);
    expect(JSON.stringify(failed)).not.toContain('mode:exit-now');
    await expect(parent.client.callTool({
      name: 'resolve-library-id', arguments: { libraryName: 'fixture', query: 'after crash' },
    })).resolves.toMatchObject({ content: [{ type: 'text', text: 'fixture-ok' }] });
    expect(parent.transport.pid).toBe(pid);
  }, 15_000);

  it('serves read-only status without initializing state or starting any official child', async () => {
    const stateDir = tempRoot('read-only-status');
    const pidFile = path.join(tempRoot('pid'), 'child.pid');
    const parent = await startParent(stateDir, ['--pid-file', pidFile, '--immediate-exit']);
    const status = statusFrom(await parent.client.callTool({ name: 'context7-pool-status', arguments: {} }));
    expect(status).toMatchObject({
      mode: 'uninitialized',
      activeSlot: null,
      runtime: { keyedDispatches: 0, anonymousDispatches: 0 },
    });
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'state.json'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'state.backup.json'))).toBe(false);
  });

  it('recursively excludes secrets, full fingerprints, state paths, queries and child stderr from status', async () => {
    const stateDir = tempRoot('secret-state-path');
    const query = 'synthetic-query-must-never-enter-status';
    const parent = await startParent(stateDir, ['--stderr-bytes', '64']);
    await parent.client.callTool({ name: 'query-docs', arguments: { libraryId: '/fixture', query } });
    const result = await parent.client.callTool({ name: 'context7-pool-status', arguments: {} });
    const serialized = JSON.stringify(result);
    for (const secret of syntheticSecrets) expect(serialized).not.toContain(secret);
    for (const secret of syntheticSecrets) {
      expect(serialized).not.toContain(createHash('sha256').update(secret).digest('hex'));
    }
    expect(serialized).not.toContain(stateDir);
    expect(serialized).not.toContain(query);
    expect(serialized).not.toContain('x'.repeat(64));
  });

  it('fails bootstrap before MCP with one fixed stderr class and keeps tool failures connected', async () => {
    const env = { ...getDefaultEnvironment(), NODE_ENV: 'test', CONTEXT7_POOL_TEST_FIXTURE: '1' };
    const failed = spawnSync(process.execPath, [parentPath], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      input: '',
      timeout: 5_000,
    });
    expect(failed.status).not.toBe(0);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toBe('context7-pool-bootstrap-failed\n');

    const parent = await startParent(tempRoot());
    const first = await parent.client.callTool({ name: 'unknown-tool', arguments: { secret: syntheticSecrets[0] } });
    expect(first).toMatchObject({ isError: true });
    expect(JSON.stringify(first)).not.toContain(syntheticSecrets[0]);
    await expect(parent.client.callTool({
      name: 'resolve-library-id', arguments: { libraryName: 'fixture', query: 'still connected' },
    })).resolves.toMatchObject({ content: [{ type: 'text', text: 'fixture-ok' }] });
  });

  it('closes the active child on stdin transport close and SIGTERM', async () => {
    const firstPidFile = path.join(tempRoot('pid'), 'stdin-child.pid');
    const first = await startParent(tempRoot(), ['--pid-file', firstPidFile]);
    await first.client.listTools();
    const firstChildPid = Number(await eventuallyFile(firstPidFile));
    await first.close();
    await expectPidStops(firstChildPid);

    const secondPidFile = path.join(tempRoot('pid'), 'signal-child.pid');
    const second = await startParent(tempRoot(), ['--pid-file', secondPidFile]);
    await second.client.listTools();
    const secondChildPid = Number(await eventuallyFile(secondPidFile));
    process.kill(second.transport.pid!, 'SIGTERM');
    await expectPidStops(secondChildPid);
  }, 15_000);

  it('ignores fake launch overrides without both test gates and confines gated entries to fixture root', async () => {
    for (const gates of [
      { NODE_ENV: 'production', CONTEXT7_POOL_TEST_FIXTURE: '0' },
      { NODE_ENV: 'test', CONTEXT7_POOL_TEST_FIXTURE: '0' },
      { NODE_ENV: 'production', CONTEXT7_POOL_TEST_FIXTURE: '1' },
    ]) {
      const localAppData = tempRoot('localappdata');
      const ignored = await startParent(tempRoot(), [], {
        ...gates,
        LOCALAPPDATA: localAppData,
        CONTEXT7_POOL_TEST_CHILD_COMMAND: path.join(localAppData, 'missing-command.exe'),
        CONTEXT7_POOL_TEST_CHILD_ENTRY: path.join(localAppData, 'missing-entry.cjs'),
        CONTEXT7_POOL_TEST_CHILD_ARGS: JSON.stringify(['--immediate-exit']),
      });
      const listed = await ignored.client.listTools();
      expect(listed.tools.map(tool => tool.name)).toEqual([
        'resolve-library-id', 'query-docs', 'context7-pool-status',
      ]);
      await ignored.close();
    }

    const outside = path.join(tempRoot('outside'), 'outside.cjs');
    fs.writeFileSync(outside, 'process.exit(99);');
    const traversal = path.join(fixtureRoot, '..', '..', '..', 'scripts', 'context7-key-pool-mcp.cjs');
    for (const rejectedEntry of [outside, traversal]) {
      const rejected = spawnSync(process.execPath, [parentPath], {
        cwd: repoRoot,
        env: testEnv(tempRoot(), [], { CONTEXT7_POOL_TEST_CHILD_ENTRY: rejectedEntry }),
        encoding: 'utf8',
        input: '',
        timeout: 5_000,
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr).toBe('context7-pool-bootstrap-failed\n');
      expect(rejected.stderr).not.toContain(rejectedEntry);
    }

    const linkPath = path.join(fixtureRoot, `.context7-pool-escape-${process.pid}-${Date.now()}.cjs`);
    let linkCreated = false;
    try {
      fs.symlinkSync(outside, linkPath, 'file');
      linkCreated = true;
      const rejectedLink = spawnSync(process.execPath, [parentPath], {
        cwd: repoRoot,
        env: testEnv(tempRoot(), [], { CONTEXT7_POOL_TEST_CHILD_ENTRY: linkPath }),
        encoding: 'utf8',
        input: '',
        timeout: 5_000,
      });
      expect(rejectedLink.status).not.toBe(0);
      expect(rejectedLink.stdout).toBe('');
      expect(rejectedLink.stderr).toBe('context7-pool-bootstrap-failed\n');
      expect(rejectedLink.stderr).not.toContain(outside);
    } catch (error: any) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error;
    } finally {
      if (linkCreated) fs.rmSync(linkPath, { force: true });
    }
  }, 30_000);

  it('--status inspects stored state without credentials or stdio and fails closed on corruption', () => {
    const missingDir = tempRoot('missing');
    const missing = spawnSync(process.execPath, [parentPath, '--status'], {
      cwd: repoRoot,
      env: testEnv(missingDir, [], {
        CONTEXT7_API_KEY_1: '', CONTEXT7_API_KEY_2: '', CONTEXT7_API_KEY_3: '', CONTEXT7_API_KEY_4: '',
      }),
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(missing).toMatchObject({ status: 0, stderr: '' });
    expect(missing.stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      mode: 'uninitialized', stateHealth: 'uninitialized', activeSlot: null,
    });

    const corruptDir = tempRoot('corrupt');
    fs.writeFileSync(path.join(corruptDir, 'state.json'), '{corrupt');
    const corrupt = spawnSync(process.execPath, [parentPath, '--status'], {
      cwd: repoRoot,
      env: testEnv(corruptDir, [], {
        CONTEXT7_API_KEY_1: '', CONTEXT7_API_KEY_2: '', CONTEXT7_API_KEY_3: '', CONTEXT7_API_KEY_4: '',
      }),
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(corrupt).toMatchObject({ status: 0, stderr: '' });
    expect(JSON.parse(corrupt.stdout)).toMatchObject({
      mode: 'anonymous',
      anonymousReason: 'state-unavailable-fail-closed',
      stateHealth: 'fail-closed',
    });
    expect(`${missing.stdout}${corrupt.stdout}`).not.toContain(syntheticSecrets[0]);
  });
});
