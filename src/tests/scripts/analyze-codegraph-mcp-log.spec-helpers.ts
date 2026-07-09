import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';

export const repoRoot = path.resolve(__dirname, '../../..');

const scriptPath = path.join(repoRoot, 'scripts', 'analyze-codegraph-mcp-log.cjs');
const tempRoots: string[] = [];
const DEFAULT_WRAPPER_VERSION = 'nanoflow-codegraph-wrapper-2026-06-14';

type LogEvent = Record<string, unknown>;
type ScriptFile = { path: string; sha256: string };

export function cleanupAnalyzerTempRoots(): void {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
}

export function makeLog(lines: unknown[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-mcp-log-'));
  tempRoots.push(root);
  const logPath = path.join(root, 'nanoflow-mcp-wrapper.log');
  fs.writeFileSync(logPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return logPath;
}

export function makeRawLog(lines: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-mcp-log-'));
  tempRoots.push(root);
  const logPath = path.join(root, 'nanoflow-mcp-wrapper.log');
  fs.writeFileSync(logPath, lines.join('\n') + '\n');
  return logPath;
}

export function runAnalyzer(logPath: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const emitText = args.includes('--text');
  return spawnSync(process.execPath, [
    scriptPath,
    logPath,
    ...(emitText ? [] : ['--json']),
    ...args,
  ], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

export function makeScriptFile(contents: string): { path: string; sha256: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-mcp-script-'));
  tempRoots.push(root);
  const filePath = path.join(root, 'codegraph-nanoflow-mcp-stdio.cjs');
  fs.writeFileSync(filePath, contents);
  return { path: filePath, sha256: crypto.createHash('sha256').update(contents).digest('hex') };
}

export function makeCodexMcpConfig(options: {
  root: string;
  wrapperScriptPath: string;
  codegraphTarget: string;
  env?: Record<string, string>;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-mcp-config-'));
  tempRoots.push(root);
  const configPath = path.join(root, 'config.toml');
  const envEntries = Object.entries(options.env ?? {})
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join('\n');
  fs.writeFileSync(configPath, [
    '[mcp_servers.codegraph]',
    'command = "node"',
    'args = [',
    `  ${JSON.stringify(options.wrapperScriptPath)},`,
    `  ${JSON.stringify(options.codegraphTarget)},`,
    '  "serve",',
    '  "--mcp",',
    `  "--path",`,
    `  ${JSON.stringify(options.root)},`,
    ']',
    '',
    '[mcp_servers.codegraph.env]',
    envEntries,
    '',
  ].join('\n'));
  return configPath;
}

export function wrapperStartEvent(
  runId: string,
  script: ScriptFile | string,
  overrides: LogEvent = {},
): LogEvent {
  return {
    ts: '2026-06-13T18:00:00.000Z',
    runId,
    event: 'wrapper.start',
    wrapperVersion: DEFAULT_WRAPPER_VERSION,
    scriptPath: typeof script === 'string' ? script : script.path,
    scriptSha256: typeof script === 'string' ? undefined : script.sha256,
    ...overrides,
  };
}

export function contextResponseEvent(
  runId: string,
  requestId: string,
  overrides: LogEvent = {},
): LogEvent {
  return {
    ts: '2026-06-13T18:00:01.000Z',
    runId,
    event: 'nanoflow.context.response',
    requestId,
    query: 'vitest.services.config.mts',
    failureClass: 'success',
    sourceOrdering: makeSourceOrderingFixture(),
    ...overrides,
  };
}

export function toolsListResponseEvent(
  runId: string,
  overrides: LogEvent = {},
): LogEvent {
  return {
    ts: '2026-06-13T18:01:01.000Z',
    runId,
    event: 'client.response',
    requestKind: 'tools-list',
    failureClass: 'success',
    ...overrides,
  };
}

export function childExitEvent(overrides: LogEvent = {}): LogEvent {
  return {
    ts: '2026-06-13T18:00:01.000Z',
    event: 'child.exit',
    ...overrides,
  };
}

export function makeSourceOrderingFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sourceRankingQuery: 'vitest.services.config.mts',
    sourceVisibilityQuery: 'vitest.services.config.mts',
    sourceSectionCount: 1,
    duplicateSourceSectionCount: 0,
    relationshipsSectionCount: 1,
    duplicateRelationshipsSectionCount: 0,
    relationshipKindSectionCounts: {},
    duplicateRelationshipKindSectionCount: 0,
    relatedSymbolsSectionCount: 1,
    duplicateRelatedSymbolsSectionCount: 0,
    sourceBlockCount: 1,
    baseSourceReorderAllowed: true,
    firstSourceFiles: ['vitest.services.config.mts'],
    rankedOverlayFiles: ['vitest.services.config.mts'],
    rankedOverlayFileDetails: [{
      filePath: 'vitest.services.config.mts',
      score: 100,
      matchRank: 0,
      nodeRank: 0,
      matchScore: 100,
      nodeScore: 100,
      pathScore: 100,
      symbolScore: 100,
      sourceBlockScore: 0,
      lowValuePenalty: 0,
    }],
    topRankedOverlayFile: 'vitest.services.config.mts',
    topRankedOverlayFileVisibleIndex: 0,
    firstSourceBlockIsTopRankedOverlayFile: true,
    topRankedOverlayFileMissing: false,
    ...overrides,
  };
}

export function expectCleanCurrentContextSourceOrdering(
  summary: { currentContextSourceOrdering: unknown },
  overrides: Record<string, unknown> = {},
): void {
  expect(summary.currentContextSourceOrdering).toEqual(expect.objectContaining({
    total: 1,
    withDiagnostics: 1,
    missingDiagnostics: 0,
    duplicateSourceSections: 0,
    topRankedMissing: 0,
    topRankedNotFirst: 0,
    lowValueVisibleSourceBlocks: 0,
    lowValueSourcePollution: 0,
    ...overrides,
  }));
}

export function expectCurrentContextSourceOrderingIssue(
  summary: { currentContextSourceOrdering: unknown },
  metrics: Record<string, unknown>,
  latestIssue: Record<string, unknown>,
): void {
  expect(summary.currentContextSourceOrdering).toEqual(expect.objectContaining({
    ...metrics,
    latestIssue: expect.objectContaining(latestIssue),
  }));
}

export function expectChildSpawnErrorSummary(
  summary: { childSpawnErrors: unknown; recommendations: unknown },
  options: { scriptSha256: string },
): void {
  expect(summary.childSpawnErrors).toEqual(expect.objectContaining({
    count: 1,
    byCode: { ENOENT: 1 },
    byDate: { '2026-06-12': 1 },
    latest: expect.objectContaining({
      event: 'child.spawn.error',
      code: 'ENOENT',
      message: 'spawn codegraph ENOENT',
      target: 'D:/Code/tools/codegraph/missing.js',
      resolvedTarget: 'D:/Code/tools/codegraph/missing.js',
      exists: false,
      investigation: expect.objectContaining({
        failureBoundary: 'base-codegraph-child',
        failureClass: 'child-spawn-missing-target',
        transportShouldStayAlive: false,
      }),
      wrapperStart: expect.objectContaining({
        runId: 'spawn-error-run',
        scriptSha256: options.scriptSha256,
      }),
    }),
  }));
  expect(summary.recommendations).toEqual(expect.arrayContaining([
    expect.stringContaining('Child spawn errors are startup failures'),
  ]));
}
