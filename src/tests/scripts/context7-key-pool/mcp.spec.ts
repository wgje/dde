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
    stderr: () => stderr,
    close: async () => { await client.close().catch(() => undefined); },
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

async function eventuallyDifferentPid(filePath: string, previous: number): Promise<number> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (fs.existsSync(filePath)) {
      const current = Number(fs.readFileSync(filePath, 'utf8'));
      if (Number.isInteger(current) && current > 0 && current !== previous) return current;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('fixture child PID did not change');
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
  const now = new Date('2026-07-15T12:00:00.000Z');
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

afterEach(async () => {
  while (clients.length > 0) await clients.pop()!.close();
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
}, 15_000);

describe('stable Context7 key-pool parent MCP', () => {
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
          type: 'object',
          required: ['libraryName', 'query'],
          properties: { libraryName: { type: 'string' }, query: { type: 'string' } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        _meta: { fixture: true },
      },
      {
        name: 'query-docs',
        title: 'Query documentation',
        description: 'Query resolved documentation.',
        inputSchema: {
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
    expect(status.slots[0]).toMatchObject({ slot: 1, attemptedCalls: 1, successfulCalls: 1 });
    expect(parent.transport.pid).toBe(pid);
    expect(() => process.kill(pid!, 0)).not.toThrow();
  });

  it('replaces the child at 950 while the same parent client continues', async () => {
    const stateDir = tempRoot('switch');
    writeSeededState(stateDir, 949);
    const pidFile = path.join(tempRoot('pid'), 'child.pid');
    const parent = await startParent(stateDir, ['--pid-file', pidFile]);
    const parentPid = parent.transport.pid;
    await parent.client.callTool({
      name: 'query-docs', arguments: { libraryId: '/fixture', query: 'attempt 950' },
    });
    const firstChildPid = Number(await eventuallyFile(pidFile));
    await parent.client.callTool({
      name: 'query-docs', arguments: { libraryId: '/fixture', query: 'slot two' },
    });
    const secondChildPid = await eventuallyDifferentPid(pidFile, firstChildPid);
    expect(secondChildPid).not.toBe(firstChildPid);
    expect(parent.transport.pid).toBe(parentPid);
    const status = statusFrom(await parent.client.callTool({ name: 'context7-pool-status', arguments: {} }));
    expect(status.slots.map((slot: any) => slot.attemptedCalls)).toEqual([950, 1, 0, 0]);
  }, 30_000);

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

  it('serves local status without starting or calling any official child', async () => {
    const pidFile = path.join(tempRoot('pid'), 'child.pid');
    const parent = await startParent(tempRoot(), ['--pid-file', pidFile, '--immediate-exit']);
    const status = statusFrom(await parent.client.callTool({ name: 'context7-pool-status', arguments: {} }));
    expect(status.mode).toBe('uninitialized');
    expect(fs.existsSync(pidFile)).toBe(false);
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
    const localAppData = tempRoot('localappdata');
    const ignored = await startParent(tempRoot(), [], {
      NODE_ENV: 'production',
      LOCALAPPDATA: localAppData,
      CONTEXT7_POOL_TEST_CHILD_COMMAND: path.join(localAppData, 'missing-command.exe'),
      CONTEXT7_POOL_TEST_CHILD_ENTRY: path.join(localAppData, 'missing-entry.cjs'),
      CONTEXT7_POOL_TEST_CHILD_ARGS: JSON.stringify(['--immediate-exit']),
    });
    const listed = await ignored.client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual([
      'resolve-library-id', 'query-docs', 'context7-pool-status',
    ]);

    const outside = path.join(tempRoot('outside'), 'outside.cjs');
    fs.writeFileSync(outside, 'process.exit(99);');
    const rejected = spawnSync(process.execPath, [parentPath], {
      cwd: repoRoot,
      env: testEnv(tempRoot(), [], { CONTEXT7_POOL_TEST_CHILD_ENTRY: outside }),
      encoding: 'utf8',
      input: '',
      timeout: 5_000,
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toBe('context7-pool-bootstrap-failed\n');
  });

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
