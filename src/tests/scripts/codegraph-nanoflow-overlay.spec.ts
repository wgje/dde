import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayBaseSpecs } from './codegraph-nanoflow-overlay-base.spec-helpers';
import {
  officialCodeGraphLanguages,
  officialCodeGraphNodeKinds,
} from './codegraph-nanoflow-overlay-codegraph-constants.spec-helpers';
import { registerCodegraphOverlayContext7Specs } from './codegraph-nanoflow-overlay-context7.spec-helpers';
import { writeCodegraphOverlayCoreFixtureFiles } from './codegraph-nanoflow-overlay-fixture-core.spec-helpers';
import { writeCodegraphOverlayGraphFixtureFiles } from './codegraph-nanoflow-overlay-fixture-graph.spec-helpers';
import { registerCodegraphOverlayJsonProjectionSpecs } from './codegraph-nanoflow-overlay-json-projection.spec-helpers';
import { registerCodegraphOverlayMarkdownBudgetSpecs } from './codegraph-nanoflow-overlay-markdown-budget.spec-helpers';
import { registerCodegraphOverlayMcpLifecycleSpecs } from './codegraph-nanoflow-overlay-mcp-lifecycle.spec-helpers';
import { registerCodegraphOverlayMcpContextQualitySpecs } from './codegraph-nanoflow-overlay-mcp-context-quality.spec-helpers';
import { registerCodegraphOverlayMcpResilienceSpecs } from './codegraph-nanoflow-overlay-mcp-resilience.spec-helpers';
import { registerCodegraphOverlayMcpToolSpecs } from './codegraph-nanoflow-overlay-mcp-tools.spec-helpers';
import { registerCodegraphOverlayAndroidImportQuerySpecs } from './codegraph-nanoflow-overlay-query-android-imports.spec-helpers';
import { registerCodegraphOverlayModuleRelationSpecs } from './codegraph-nanoflow-overlay-modules-relations.spec-helpers';
import { registerCodegraphOverlayObjectModuleSpecs } from './codegraph-nanoflow-overlay-object-module.spec-helpers';
import { registerCodegraphOverlayPriorityAndEnumSpecs } from './codegraph-nanoflow-overlay-priority-enums.spec-helpers';
import { registerCodegraphOverlayQuerySpecs } from './codegraph-nanoflow-overlay-query.spec-helpers';
import { registerCodegraphOverlayTypeParameterSpecs } from './codegraph-nanoflow-overlay-type-parameters.spec-helpers';
import { registerCodegraphOverlayTypeScriptCoreSpecs } from './codegraph-nanoflow-overlay-typescript-core.spec-helpers';
import { registerCodegraphOverlayTypeScriptFilteringSpecs } from './codegraph-nanoflow-overlay-typescript-filtering.spec-helpers';

const repoRoot = path.resolve(__dirname, '../../..');
const scriptPath = path.join(repoRoot, 'scripts', 'generate-codegraph-nanoflow-overlay.mjs');
const queryScriptPath = path.join(repoRoot, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
const wrapperScriptPath = path.join(repoRoot, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
const codexConfigHelperPath = path.join(repoRoot, 'scripts', 'codegraph-codex-config.cjs');
const adapterContextScriptPath = path.join(repoRoot, 'scripts', 'codegraph-adapter-context.cjs');
const adapterDoctorScriptPath = path.join(repoRoot, 'scripts', 'codegraph-adapter-doctor.cjs');
const mcpSmokeScriptPath = path.join(repoRoot, 'scripts', 'smoke-codegraph-mcp-wrapper.cjs');
const adaptationDocPath = path.join(repoRoot, 'docs', 'codegraph-nanoflow-adaptation.md');
const WRAPPER_STDOUT_TIMEOUT_MS = 10_000;
const WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS = 60_000;
const WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS = 90_000;
const WRAPPER_REPO_OVERLAY_ENV = {
  NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: String(WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS),
  NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: String(WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS),
  NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP: '0',
};
const tempRoots: string[] = [];
const originalWrapperLogPath = process.env.NANOFLOW_CODEGRAPH_MCP_LOG;

function writeFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-overlay-'));
  tempRoots.push(root);
  writeCodegraphOverlayCoreFixtureFiles(root, writeFile);
  writeCodegraphOverlayGraphFixtureFiles(root, writeFile);
  return root;
}

function runOverlay(root: string, args: string[] = []) {
  return spawnSync(process.execPath, [scriptPath, '--root', root, '--stdout', ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function queryOverlay(root: string, query: string, args: string[] | number = []) {
  const extraArgs = typeof args === 'number' ? ['--limit', String(args)] : args;
  return spawnSync(process.execPath, [queryScriptPath, '--root', root, '--query', query, '--json', ...extraArgs], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function expectSpawnSuccess(result: ReturnType<typeof spawnSync>): void {
  expect(result.status, [
    `stderr: ${result.stderr}`,
    `stdout: ${result.stdout}`,
    `error: ${result.error?.message ?? ''}`,
  ].join('\n')).toBe(0);
}

function makeFakeCodegraph(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-fake-'));
  tempRoots.push(root);
  const fakePath = path.join(root, 'fake-codegraph.cjs');
  fs.writeFileSync(
    fakePath,
    [
      "'use strict';",
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "rl.on('line', line => {",
      "  if (!line.trim()) return;",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'tools/list') {",
      "    console.log(JSON.stringify({",
      "      jsonrpc: '2.0',",
      "      id: message.id,",
      "      result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] },",
      "    }));",
      "    return;",
      "  }",
      "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
      "    console.log(JSON.stringify({",
      "      jsonrpc: '2.0',",
      "      id: message.id,",
      "      result: { content: [{ type: 'text', text: '## Exploration: ' + message.params.arguments.query + '\\nbase codegraph context' }] },",
      "    }));",
      "    return;",
      "  }",
      "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
      "});",
      '',
    ].join('\n'),
  );
  return fakePath;
}

function makeContentLengthFakeCodegraph(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-framed-fake-'));
  tempRoots.push(root);
  const fakePath = path.join(root, 'fake-codegraph-framed.cjs');
  fs.writeFileSync(
    fakePath,
    [
      "'use strict';",
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "function writeFrame(message) {",
      "  const payload = Buffer.from(JSON.stringify(message), 'utf8');",
      "  process.stdout.write('Content-Length: ' + payload.length + '\\r\\n\\r\\n');",
      "  process.stdout.write(payload);",
      "}",
      "rl.on('line', line => {",
      "  if (!line.trim()) return;",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'tools/list') {",
      "    writeFrame({",
      "      jsonrpc: '2.0',",
      "      id: message.id,",
      "      result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] },",
      "    });",
      "    return;",
      "  }",
      "  writeFrame({ jsonrpc: '2.0', id: message.id, result: { content: [] } });",
      "});",
      '',
    ].join('\n'),
  );
  return fakePath;
}

function makeSlowFakeCodegraph(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-slow-fake-'));
  tempRoots.push(root);
  const fakePath = path.join(root, 'fake-codegraph.cjs');
  fs.writeFileSync(
    fakePath,
    [
      "'use strict';",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  setTimeout(() => process.exit(0), 50);",
      "});",
      "setInterval(() => {}, 1000);",
      '',
    ].join('\n'),
  );
  return fakePath;
}

function makeExitingToolsListFakeCodegraph(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-exiting-tools-list-fake-'));
  tempRoots.push(root);
  const fakePath = path.join(root, 'fake-codegraph.cjs');
  fs.writeFileSync(
    fakePath,
    [
      "'use strict';",
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "rl.on('line', line => {",
      "  if (!line.trim()) return;",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'tools/list') {",
      "    console.log(JSON.stringify({",
      "      jsonrpc: '2.0',",
      "      id: message.id,",
      "      result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] },",
      "    }));",
      "    setTimeout(() => process.exit(0), 10);",
      "    return;",
      "  }",
      "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
      "});",
      '',
    ].join('\n'),
  );
  return fakePath;
}

function makeReplayBackpressureFakeCodegraph(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-replay-backpressure-fake-'));
  tempRoots.push(root);
  const fakePath = path.join(root, 'fake-codegraph.cjs');
  fs.writeFileSync(
    fakePath,
    [
      "'use strict';",
      "const fs = require('node:fs');",
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const statePath = process.env.FAKE_CODEGRAPH_STATE_PATH;",
      "const messagesPath = process.env.FAKE_CODEGRAPH_MESSAGES_PATH;",
      "let lineCount = 0;",
      "const runCount = statePath && fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, 'utf8')) : 0;",
      "if (statePath) fs.writeFileSync(statePath, String(runCount + 1));",
      "if (runCount === 0) {",
      "  setTimeout(() => process.exit(70), 5000);",
      "}",
      "if (runCount === 1) {",
      "  process.stdin.pause();",
      "  setTimeout(() => process.exit(70), 50);",
      "  return;",
      "}",
      "rl.on('line', line => {",
      "  if (!line.trim()) return;",
      "  lineCount += 1;",
      "  const message = JSON.parse(line);",
      "  if (messagesPath) fs.appendFileSync(messagesPath, JSON.stringify({ runCount, lineCount, method: message.method, id: message.id }) + '\\n');",
      "  if (message.id === undefined) return;",
      "  if (message.method === 'initialize') {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-codegraph', version: '1.0.0' } } }));",
      "    return;",
      "  }",
      "  if (message.method === 'tools/list') {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] } }));",
      "    if (runCount === 0) setTimeout(() => process.exit(70), 10);",
      "    return;",
      "  }",
      "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
      "});",
      '',
    ].join('\n'),
  );
  return fakePath;
}

function makeHangingExploreFakeCodegraph(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-hanging-explore-fake-'));
  tempRoots.push(root);
  const fakePath = path.join(root, 'fake-codegraph.cjs');
  fs.writeFileSync(
    fakePath,
    [
      "'use strict';",
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "rl.on('line', line => {",
      "  if (!line.trim()) return;",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'tools/list') {",
      "    console.log(JSON.stringify({",
      "      jsonrpc: '2.0',",
      "      id: message.id,",
      "      result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] },",
      "    }));",
      "    return;",
      "  }",
      "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
      "    return;",
      "  }",
      "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
      "});",
      '',
    ].join('\n'),
  );
  return fakePath;
}

function makeDelayedExploreFakeCodegraph(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-delayed-explore-fake-'));
  tempRoots.push(root);
  const fakePath = path.join(root, 'fake-codegraph.cjs');
  fs.writeFileSync(
    fakePath,
    [
      "'use strict';",
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const delayMs = Number(process.env.FAKE_CODEGRAPH_EXPLORE_DELAY_MS || '200');",
      "rl.on('line', line => {",
      "  if (!line.trim()) return;",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'tools/list') {",
      "    console.log(JSON.stringify({",
      "      jsonrpc: '2.0',",
      "      id: message.id,",
      "      result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] },",
      "    }));",
      "    return;",
      "  }",
      "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
      "    setTimeout(() => {",
      "      console.log(JSON.stringify({",
      "        jsonrpc: '2.0',",
      "        id: message.id,",
      "        result: { content: [{ type: 'text', text: 'late base codegraph context' }] },",
      "      }));",
      "    }, delayMs);",
      "    return;",
      "  }",
      "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
      "});",
      '',
    ].join('\n'),
  );
  return fakePath;
}

function makeBlockedInputFakeCodegraph(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-blocked-input-fake-'));
  tempRoots.push(root);
  const fakePath = path.join(root, 'fake-codegraph.cjs');
  fs.writeFileSync(
    fakePath,
    [
      "'use strict';",
      "// Simulate a wedged codegraph child that stays alive but stops consuming stdin.",
      "setInterval(() => {}, 1000);",
      '',
    ].join('\n'),
  );
  return fakePath;
}

function makeMalformedContentFakeCodegraph(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-malformed-content-fake-'));
  tempRoots.push(root);
  const fakePath = path.join(root, 'fake-codegraph.cjs');
  fs.writeFileSync(
    fakePath,
    [
      "'use strict';",
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "rl.on('line', line => {",
      "  if (!line.trim()) return;",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'tools/list') {",
      "    console.log(JSON.stringify({",
      "      jsonrpc: '2.0',",
      "      id: message.id,",
      "      result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] },",
      "    }));",
      "    return;",
      "  }",
      "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
      "    console.log(JSON.stringify({",
      "      jsonrpc: '2.0',",
      "      id: message.id,",
      "      result: { content: [{ type: 'text', text: 42 }] },",
      "    }));",
      "    return;",
      "  }",
      "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
      "});",
      '',
    ].join('\n'),
  );
  return fakePath;
}

function parseJsonLines(filePath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function parseJsonLinesFromText(text: string): Array<Record<string, unknown>> {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForLogEvent(
  filePath: string,
  event: string,
  timeoutMs = 10_000,
  predicate: (entry: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const match = parseJsonLines(filePath).find((entry) => entry.event === event && predicate(entry));
      if (match) {
        return match;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for log event ${event} in ${filePath}`);
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

function readJsonLine(child: ChildProcessWithoutNullStreams, timeoutMs = WRAPPER_STDOUT_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for wrapper stdout. Buffer: ${buffer}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) return;

      const line = buffer.slice(0, newlineIndex).trim();
      cleanup();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Wrapper exited before response: ${code}`));
    };

    function cleanup(): void {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    }

    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

function writeMcpFrame(child: ChildProcessWithoutNullStreams, message: unknown): void {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
  child.stdin.write(payload);
}

async function writeManyJsonLines(
  child: ChildProcessWithoutNullStreams,
  messages: unknown[],
  stopSignal: Promise<unknown>,
): Promise<void> {
  let streamClosed = false;
  let stopRequested = false;
  let notifyStreamError: (() => void) | undefined;
  const streamErrorSignal = new Promise<void>((resolve) => {
    notifyStreamError = resolve;
  });
  const stopSignalSettled = stopSignal.then(() => {
    stopRequested = true;
  });
  const onError = () => {
    streamClosed = true;
    notifyStreamError?.();
  };
  child.stdin.on('error', onError);
  try {
    for (const message of messages) {
      if (stopRequested || streamClosed || child.stdin.destroyed || child.stdin.writableEnded) {
        return;
      }

      const line = `${JSON.stringify(message)}\n`;
      const canContinue = child.stdin.write(line);
      if (canContinue) {
        await Promise.race([
          new Promise<void>((resolve) => setImmediate(resolve)),
          stopSignalSettled,
          streamErrorSignal,
        ]);
        continue;
      }

      await Promise.race([
        new Promise<void>((resolve) => child.stdin.once('drain', resolve)),
        stopSignalSettled,
        streamErrorSignal,
      ]);
    }
  } finally {
    child.stdin.off('error', onError);
  }
}

async function removeTempRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function readMcpFrame(child: ChildProcessWithoutNullStreams): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for wrapper MCP frame. Buffer: ${buffer.toString('utf8')}`));
    }, 10_000);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = findMcpHeaderEnd(buffer);
      if (!headerEnd) return;

      const header = buffer.slice(0, headerEnd.index).toString('utf8');
      const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
      if (!match) {
        cleanup();
        reject(new Error(`Invalid MCP frame header: ${header}`));
        return;
      }

      const bodyLength = Number(match[1]);
      const bodyStart = headerEnd.index + headerEnd.length;
      const bodyEnd = bodyStart + bodyLength;
      if (buffer.length < bodyEnd) return;

      const body = buffer.slice(bodyStart, bodyEnd).toString('utf8');
      cleanup();
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Wrapper exited before MCP frame: ${code}`));
    };

    function cleanup(): void {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    }

    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

function findMcpHeaderEnd(buffer: Buffer): { index: number; length: number } | null {
  const crlfIndex = buffer.indexOf(Buffer.from('\r\n\r\n'));
  if (crlfIndex !== -1) return { index: crlfIndex, length: 4 };

  const lfIndex = buffer.indexOf(Buffer.from('\n\n'));
  if (lfIndex !== -1) return { index: lfIndex, length: 2 };

  return null;
}

describe('generate-codegraph-nanoflow-overlay', { timeout: 10_000 }, () => {
  beforeEach(() => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-test-log-'));
    tempRoots.push(logRoot);
    process.env.NANOFLOW_CODEGRAPH_MCP_LOG = path.join(logRoot, 'wrapper.log');
  });

  afterEach(async () => {
    if (originalWrapperLogPath === undefined) {
      delete process.env.NANOFLOW_CODEGRAPH_MCP_LOG;
    } else {
      process.env.NANOFLOW_CODEGRAPH_MCP_LOG = originalWrapperLogPath;
    }

    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await removeTempRoot(root);
    }
  });

  const context: CodegraphOverlaySpecContext = {
    repoRoot,
    scriptPath,
    queryScriptPath,
    wrapperScriptPath,
    codexConfigHelperPath,
    adapterContextScriptPath,
    adapterDoctorScriptPath,
    mcpSmokeScriptPath,
    adaptationDocPath,
    WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS,
    WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS,
    WRAPPER_REPO_OVERLAY_ENV,
    tempRoots,
    officialCodeGraphLanguages,
    officialCodeGraphNodeKinds,
    writeFile,
    makeFixture,
    runOverlay,
    queryOverlay,
    expectSpawnSuccess,
    makeFakeCodegraph,
    makeContentLengthFakeCodegraph,
    makeSlowFakeCodegraph,
    makeExitingToolsListFakeCodegraph,
    makeReplayBackpressureFakeCodegraph,
    makeHangingExploreFakeCodegraph,
    makeDelayedExploreFakeCodegraph,
    makeBlockedInputFakeCodegraph,
    makeMalformedContentFakeCodegraph,
    parseJsonLines,
    parseJsonLinesFromText,
    waitForLogEvent,
    waitForExit,
    readJsonLine,
    writeMcpFrame,
    writeManyJsonLines,
    readMcpFrame,
  };

  it('skips source files that disappear between overlay collection passes', () => {
    const root = makeFixture();
    const vanishingFile = path.join(root, 'src', 'vanishing-source.ts');
    writeFile(root, 'src/vanishing-source.ts', 'export const vanishingSource = 1;\n');
    const hookPath = path.join(root, 'delete-after-first-read.cjs');
    fs.writeFileSync(
      hookPath,
      [
        "'use strict';",
        "const fs = require('node:fs');",
        "const target = process.env.NANOFLOW_VANISHING_SOURCE_FILE;",
        "const originalReadFileSync = fs.readFileSync.bind(fs);",
        "let deleted = false;",
        "fs.readFileSync = function patchedReadFileSync(file, ...args) {",
        "  const result = originalReadFileSync(file, ...args);",
        "  if (!deleted && target && String(file) === target) {",
        "    deleted = true;",
        "    fs.unlinkSync(target);",
        "  }",
        "  return result;",
        "};",
        '',
      ].join('\n'),
    );

    const result = spawnSync(
      process.execPath,
      ['--require', hookPath, scriptPath, '--root', root, '--stdout'],
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        env: {
          ...process.env,
          NANOFLOW_VANISHING_SOURCE_FILE: vanishingFile,
        },
        maxBuffer: 32 * 1024 * 1024,
      },
    );

    expectSpawnSuccess(result);
  });

  registerCodegraphOverlayBaseSpecs(context);
  registerCodegraphOverlayQuerySpecs(context);
  registerCodegraphOverlayMarkdownBudgetSpecs(context);
  registerCodegraphOverlayJsonProjectionSpecs(context);
  registerCodegraphOverlayPriorityAndEnumSpecs(context);
  registerCodegraphOverlayTypeScriptCoreSpecs(context);
  registerCodegraphOverlayTypeScriptFilteringSpecs(context);
  registerCodegraphOverlayObjectModuleSpecs(context);
  registerCodegraphOverlayTypeParameterSpecs(context);
  registerCodegraphOverlayModuleRelationSpecs(context);
  registerCodegraphOverlayAndroidImportQuerySpecs(context);
  registerCodegraphOverlayContext7Specs(context);
  registerCodegraphOverlayMcpToolSpecs(context);
  registerCodegraphOverlayMcpContextQualitySpecs(context);
  registerCodegraphOverlayMcpResilienceSpecs(context);
  registerCodegraphOverlayMcpLifecycleSpecs(context);
});
