// @vitest-environment node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');
const parentPath = path.join(repoRoot, 'scripts/context7-key-pool-mcp.cjs');
const fakeMcpPath = path.join(repoRoot, 'src/tests/fixtures/context7-key-pool/fake-context7-mcp.cjs');
const roots: string[] = [];
const handles: ParentHandle[] = [];
const secrets = [1, 2, 3, 4].map(slot => `synthetic-stress-slot-${slot}-never-real`);

type ParentHandle = {
  client: Client;
  transport: StdioClientTransport;
  close(): Promise<void>;
};

function tempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `context7-stress-${label}-`));
  roots.push(root);
  return root;
}

function envFor(stateDir: string, childArgs: string[] = []): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    NODE_ENV: 'test',
    CONTEXT7_POOL_TEST_FIXTURE: '1',
    CONTEXT7_POOL_TEST_STATE_DIR: stateDir,
    CONTEXT7_POOL_TEST_CHILD_COMMAND: process.execPath,
    CONTEXT7_POOL_TEST_CHILD_ENTRY: fakeMcpPath,
    CONTEXT7_POOL_TEST_CHILD_ARGS: JSON.stringify(childArgs),
    CONTEXT7_POOL_TIME_ZONE: 'UTC',
    CONTEXT7_API_KEY_1: secrets[0]!,
    CONTEXT7_API_KEY_2: secrets[1]!,
    CONTEXT7_API_KEY_3: secrets[2]!,
    CONTEXT7_API_KEY_4: secrets[3]!,
  };
}

async function startParent(stateDir: string, childArgs: string[] = []): Promise<ParentHandle> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [parentPath],
    cwd: repoRoot,
    env: envFor(stateDir, childArgs),
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  const client = new Client({ name: 'context7-stress-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const handle = { client, transport, close: async () => { await client.close().catch(() => undefined); } };
  handles.push(handle);
  return handle;
}

function publicStatus(result: Awaited<ReturnType<Client['callTool']>>): any {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

async function status(parent: ParentHandle): Promise<any> {
  return publicStatus(await parent.client.callTool({ name: 'context7-pool-status', arguments: {} }));
}

async function callMany(parent: ParentHandle, count: number, prefix: string): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const result = await parent.client.callTool({
      name: 'query-docs',
      arguments: { libraryId: '/fixture', query: `${prefix}-${index}` },
    });
    expect(result.isError).not.toBe(true);
  }
}

async function mirroredAttemptCount(stateDir: string, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const primary = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
      const backup = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.backup.json'), 'utf8'));
      const count = Object.values(primary.payload.records as Record<string, any>)
        .reduce((sum: number, record: any) => sum + record.attemptedCalls, 0);
      if (count === expected && primary.revision === backup.revision && primary.checksumSha256 === backup.checksumSha256) return;
    } catch { /* persistence is between atomic mirror steps */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`mirrored reservation count did not reach ${expected}`);
}

afterEach(async () => {
  while (handles.length > 0) await handles.pop()!.close();
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
}, 15_000);

describe.sequential('Context7 key-pool parent stress and crash durability', () => {
  it('routes 1000 successes as 950/50 and resumes slot two at ordinal 51 after restart', async () => {
    const stateDir = tempRoot('thousand');
    const first = await startParent(stateDir);
    await callMany(first, 1000, 'thousand');
    const firstStatus = await status(first);
    expect(firstStatus.slots.map((slot: any) => slot.attemptedCalls)).toEqual([950, 50, 0, 0]);
    expect(firstStatus.slots.map((slot: any) => slot.successfulCalls)).toEqual([950, 50, 0, 0]);
    await first.close();

    const restarted = await startParent(stateDir);
    await callMany(restarted, 1, 'restart');
    const restartedStatus = await status(restarted);
    expect(restartedStatus.slots.map((slot: any) => slot.attemptedCalls)).toEqual([950, 51, 0, 0]);
    expect(restartedStatus).toMatchObject({ mode: 'stored-unreconciled', activeSlot: null });
    const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    const slotTwo = persisted.payload.activeSlots.find((identity: any) => identity.slot === 2);
    expect(persisted.payload.records[slotTwo.fingerprintSha256]).toMatchObject({
      attemptedCalls: 51,
      successfulCalls: 51,
      settledAttempts: expect.arrayContaining([{ periodId: persisted.payload.periodId, attemptOrdinal: 51 }]),
    });
  }, 180_000);

  it('retains a mirrored conservative reservation when the parent dies before fake response', async () => {
    const stateDir = tempRoot('crash');
    const worker = await startParent(stateDir, ['--delay-call', '30000']);
    const inFlight = worker.client.callTool({
      name: 'query-docs', arguments: { libraryId: '/fixture', query: 'die after reserve' },
    });
    await mirroredAttemptCount(stateDir, 1);
    const pid = worker.transport.pid!;
    process.kill(pid, 'SIGKILL');
    await expect(inFlight).rejects.toBeDefined();

    const restarted = await startParent(stateDir);
    const recovered = await status(restarted);
    expect(recovered.slots.map((slot: any) => slot.attemptedCalls)).toEqual([1, 0, 0, 0]);
    const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    const slotOne = persisted.payload.activeSlots.find((identity: any) => identity.slot === 1);
    const firstRecord = persisted.payload.records[slotOne.fingerprintSha256];
    expect(firstRecord).toMatchObject({ attemptedCalls: 1, successfulCalls: 0, settledAttempts: [] });
  }, 30_000);

  it('serializes two independent parents sharing one state directory without lost updates', async () => {
    const stateDir = tempRoot('two-parent');
    const first = await startParent(stateDir);
    const second = await startParent(stateDir);
    await Promise.all([
      callMany(first, 50, 'parent-a'),
      callMany(second, 50, 'parent-b'),
    ]);
    const combined = await status(first);
    expect(combined.slots.map((slot: any) => slot.attemptedCalls)).toEqual([100, 0, 0, 0]);
    expect(combined.slots.map((slot: any) => slot.successfulCalls)).toEqual([100, 0, 0, 0]);
  }, 60_000);
});
