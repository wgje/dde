import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const analyzerPath = path.join(repoRoot, 'scripts', 'analyze-codegraph-mcp-log.cjs');
const wrapperScriptPath = path.join(repoRoot, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
const tempRoots: string[] = [];

function makeTempLog(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-analyze-context7-pollution-'));
  tempRoots.push(root);
  return path.join(root, 'wrapper.log');
}

function wrapperScriptHash(): string {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(wrapperScriptPath))
    .digest('hex');
}

function writeLog(logPath: string, events: unknown[]): void {
  fs.writeFileSync(logPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
}

function runAnalyzer(logPath: string) {
  return spawnSync(
    process.execPath,
    [
      analyzerPath,
      logPath,
      '--json',
      '--fail-on-current-source-ordering',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('analyze-codegraph-mcp-log context7 source pollution', () => {
  it('fails current source-ordering guard when docs/context7 blocks outrank implementation source', () => {
    const logPath = makeTempLog();
    const runId = 'context7-pollution-run';
    writeLog(logPath, [
      {
        ts: '2026-06-29T15:00:00.000Z',
        runId,
        event: 'wrapper.start',
        wrapperVersion: 'nanoflow-codegraph-wrapper-test',
        scriptPath: wrapperScriptPath,
        scriptSha256: wrapperScriptHash(),
      },
      {
        ts: '2026-06-29T15:00:01.000Z',
        runId,
        event: 'nanoflow.context.response',
        requestId: `${runId}:request-1`,
        requestKind: 'nanoflow-context-pack',
        tool: 'nanoflow_context_pack',
        query: 'supabase functions transcribe edge-function-invoke route-reference source ordering',
        outputMode: 'markdown',
        failureClass: 'success',
        sourceOrdering: {
          sourceSectionCount: 1,
          duplicateSourceSectionCount: 0,
          sourceBlockCount: 2,
          firstSourceFiles: [
            'docs/context7/03-api-reference/edge-functions.md',
            'supabase/functions/transcribe/index.ts',
          ],
          rankedOverlayFiles: [
            'docs/context7/03-api-reference/edge-functions.md',
            'supabase/functions/transcribe/index.ts',
          ],
          rawTopRankedOverlayFile: 'docs/context7/03-api-reference/edge-functions.md',
          rankedOverlayFileDetails: [
            {
              filePath: 'docs/context7/03-api-reference/edge-functions.md',
              score: 188,
              lowValuePenalty: 0,
            },
            {
              filePath: 'supabase/functions/transcribe/index.ts',
              score: 80,
              lowValuePenalty: 0,
            },
          ],
          topRankedOverlayFile: 'docs/context7/03-api-reference/edge-functions.md',
          topRankedOverlayFileSkippedLowValue: false,
          topRankedOverlayFileVisibleIndex: 0,
          firstSourceBlockIsTopRankedOverlayFile: true,
          topRankedOverlayFileMissing: false,
        },
      },
    ]);

    const result = runAnalyzer(logPath);
    expect(result.status).toBe(1);
    const summary = JSON.parse(result.stdout);
    expect(summary.currentContextSourceOrdering.lowValueSourcePollution).toBe(1);
    expect(summary.currentContextSourceOrdering.latestIssue.issue).toBe('low-value-source-block-visible');
    expect(summary.currentContextSourceOrdering.latestIssue.sourceOrdering.firstSourceFiles[0])
      .toBe('docs/context7/03-api-reference/edge-functions.md');
  });
});
