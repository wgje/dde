import { expect, it } from 'vitest';

import {
  contextResponseEvent,
  makeLog,
  makeScriptFile,
  makeSourceOrderingFixture,
  runAnalyzer,
  wrapperStartEvent,
} from './analyze-codegraph-mcp-log.spec-helpers';

const ANALYZER_SPEC_TIMEOUT_MS = 30_000;

export function registerAnalyzeCodegraphMcpLogOverlayDiagnosticSpecs(): void {
  it('tracks overlay timeouts separately from transport failures', () => {
    const logPath = makeLog([
      {
        ts: '2026-06-12T08:24:03.596Z',
        event: 'overlay.query.timeout',
        failureClass: 'overlay-timeout',
        query: 'HostListener keydown click',
        queryId: 'run:overlay-25',
        outputMode: 'context-json',
        contextJson: true,
        elapsedMs: 27987,
        limit: 60,
        profileMeta: {
          skipRefresh: true,
          contextJson: true,
        },
        lastProfilePhase: { phase: 'selectGraphResults', elapsedMs: 10469.523 },
      },
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-critical']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.transportHealthy).toBe(true);
    expect(summary.overlayTimeouts.count).toBe(1);
    expect(summary.overlayTimeouts.byDate).toEqual({ '2026-06-12': 1 });
    expect(summary.latestOverlayTimeout.query).toBe('HostListener keydown click');
    expect(summary.latestOverlayTimeout.outputMode).toBe('context-json');
    expect(summary.latestOverlayTimeout.contextJson).toBe(true);
    expect(summary.latestOverlayTimeout.profileMeta.skipRefresh).toBe(true);
    expect(summary.latestOverlayTimeout.lastProfilePhase.phase).toBe('selectGraphResults');
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('summarizes CodeGraph auto-sync disabled stderr as an index-frozen root cause', () => {
    const script = makeScriptFile('module.exports = { version: "autosync-disabled" };\n');
    const logPath = makeLog([
      wrapperStartEvent('autosync-disabled-run', script),
      {
        ts: '2026-06-13T18:00:02.000Z',
        runId: 'autosync-disabled-run',
        event: 'child.stderr',
        text: 'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen.\nReason: CodeGraph file lock held by another process past the retry budget; auto-sync disabled.',
      },
      contextResponseEvent('autosync-disabled-run', 'context-after-autosync-warning', {
        ts: '2026-06-13T18:00:03.000Z',
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-critical']);
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(0);
    expect(summary.codegraphAutoSyncDisabled).toEqual(expect.objectContaining({
      count: 1,
      byDate: { '2026-06-13': 1 },
      latest: expect.objectContaining({
        event: 'child.stderr',
        runId: 'autosync-disabled-run',
        failureClass: 'codegraph-autosync-disabled',
        textTail: expect.stringContaining('index is frozen'),
      }),
    }));
    expect(summary.currentCodegraphAutoSyncDisabled).toEqual(expect.objectContaining({
      count: 1,
      latest: expect.objectContaining({
        failureClass: 'codegraph-autosync-disabled',
      }),
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('CodeGraph auto-sync is disabled'),
      expect.stringContaining('codegraph sync'),
    ]));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('keeps the stderr auto-sync warning when later response diagnostics only contain unrelated text tails', () => {
    const script = makeScriptFile('module.exports = { version: "autosync-warning-tail" };\n');
    const logPath = makeLog([
      wrapperStartEvent('autosync-warning-tail-run', script),
      {
        ts: '2026-06-13T18:00:02.000Z',
        runId: 'autosync-warning-tail-run',
        event: 'child.stderr',
        text: 'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen.\nReason: CodeGraph file lock held by another process past the retry budget; auto-sync disabled.',
      },
      contextResponseEvent('autosync-warning-tail-run', 'context-after-tail-warning', {
        ts: '2026-06-13T18:00:03.000Z',
        responseWarnings: {
          codegraphAutoSyncDisabled: true,
          failureClass: 'codegraph-autosync-disabled',
          textTail: 'unrelated source-code tail without the original warning banner',
        },
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-autosync-disabled']);
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(1);
    expect(summary.currentCodegraphAutoSyncDisabled).toEqual(expect.objectContaining({
      count: 2,
      latest: expect.objectContaining({
        event: 'child.stderr',
        failureClass: 'codegraph-autosync-disabled',
        textTail: expect.stringContaining('index is frozen'),
      }),
    }));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('fails the current auto-sync disabled guard when the live index is frozen', () => {
    const script = makeScriptFile('module.exports = { version: "autosync-disabled-guard" };\n');
    const logPath = makeLog([
      wrapperStartEvent('autosync-disabled-guard-run', script),
      {
        ts: '2026-06-13T18:00:02.000Z',
        runId: 'autosync-disabled-guard-run',
        event: 'child.stderr',
        text: 'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen.\nReason: CodeGraph file lock held by another process past the retry budget; auto-sync disabled.',
      },
      contextResponseEvent('autosync-disabled-guard-run', 'context-after-autosync-warning', {
        ts: '2026-06-13T18:00:03.000Z',
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-autosync-disabled']);
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(1);
    expect(summary.currentCodegraphAutoSyncDisabled).toEqual(expect.objectContaining({
      count: 1,
      latest: expect.objectContaining({
        failureClass: 'codegraph-autosync-disabled',
        textTail: expect.stringContaining('index is frozen'),
      }),
    }));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('fails the current auto-sync disabled guard when the warning is logged on a context response', () => {
    const script = makeScriptFile('module.exports = { version: "autosync-response-warning" };\n');
    const logPath = makeLog([
      wrapperStartEvent('autosync-response-warning-run', script),
      contextResponseEvent('autosync-response-warning-run', 'context-with-autosync-warning', {
        ts: '2026-06-13T18:00:03.000Z',
        baseResponseWarnings: {
          codegraphAutoSyncDisabled: true,
          failureClass: 'codegraph-autosync-disabled',
          textTail: 'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen.',
        },
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-autosync-disabled']);
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(1);
    expect(summary.currentCodegraphAutoSyncDisabled).toEqual(expect.objectContaining({
      count: 1,
      latest: expect.objectContaining({
        event: 'nanoflow.context.response',
        failureClass: 'codegraph-autosync-disabled',
        baseResponseWarnings: expect.objectContaining({
          codegraphAutoSyncDisabled: true,
        }),
      }),
    }));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('keeps auto-sync root-cause evidence but compacts heavyweight response diagnostics', () => {
    const script = makeScriptFile('module.exports = { version: "autosync-compact-warning" };\n');
    const heavyCandidateDetails = Array.from({ length: 30 }, (_, index) => ({
      filePath: `src/app/heavy-${index}.ts`,
      score: 10_000 - index,
      matchRank: index,
      nodeRank: index,
      matchScore: 1_000,
      nodeScore: 900,
      pathScore: 800,
      symbolScore: 700,
      sourceBlockScore: 600,
      lowValuePenalty: 0,
      rawLowValuePenalty: 0,
      shouldNotLeakHeavyDiagnostic: `heavy-source-ordering-${index}`,
    }));
    const warningText = [
      'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen.',
      'Reason: CodeGraph file lock held by another process past the retry budget; auto-sync disabled.',
      '',
      'should-not-leak-full-warning-body',
      'x'.repeat(5_000),
    ].join('\n');
    const logPath = makeLog([
      wrapperStartEvent('autosync-compact-warning-run', script),
      contextResponseEvent('autosync-compact-warning-run', 'context-with-heavy-autosync-warning', {
        ts: '2026-06-13T18:00:03.000Z',
        sourceOrdering: makeSourceOrderingFixture({
          rankedOverlayFileDetails: heavyCandidateDetails,
          visibleSourceFileDetails: heavyCandidateDetails,
        }),
        sourceSelection: {
          overlayCandidateFiles: heavyCandidateDetails,
          contextCandidateFiles: heavyCandidateDetails,
        },
        baseResponseWarnings: {
          codegraphAutoSyncDisabled: true,
          failureClass: 'codegraph-autosync-disabled',
          textTail: warningText,
          shouldNotLeakHeavyDiagnostic: 'heavy-base-warning',
        },
        responseWarnings: {
          codegraphAutoSyncDisabled: true,
          failureClass: 'codegraph-autosync-disabled',
          textTail: warningText,
          shouldNotLeakHeavyDiagnostic: 'heavy-response-warning',
        },
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-autosync-disabled']);
    const summary = JSON.parse(result.stdout);
    const latest = summary.currentCodegraphAutoSyncDisabled.latest;

    expect(result.status, result.stderr).toBe(1);
    expect(latest).toEqual(expect.objectContaining({
      event: 'nanoflow.context.response',
      failureClass: 'codegraph-autosync-disabled',
      textTail: expect.stringContaining('index is frozen'),
      baseResponseWarnings: expect.objectContaining({
        codegraphAutoSyncDisabled: true,
        failureClass: 'codegraph-autosync-disabled',
        textTail: expect.stringContaining('index is frozen'),
      }),
      responseWarnings: expect.objectContaining({
        codegraphAutoSyncDisabled: true,
        failureClass: 'codegraph-autosync-disabled',
        textTail: expect.stringContaining('index is frozen'),
      }),
    }));
    expect(latest.sourceOrdering).toBeUndefined();
    expect(latest.sourceSelection).toBeUndefined();
    expect(JSON.stringify(latest)).not.toContain('should-not-leak');
    expect(JSON.stringify(latest)).not.toContain('heavy-source-ordering-');
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('summarizes non-timeout overlay subprocess failures for root-cause triage', () => {
    const logPath = makeLog([
      {
        ts: '2026-06-12T08:24:03.596Z',
        event: 'overlay.query.exit',
        failureClass: 'overlay-nonzero-exit',
        query: 'edge-function-method',
        queryId: 'run:overlay-41',
        outputMode: 'native-json',
        code: 1,
        signal: null,
        stdoutBytes: 0,
        stderrBytes: 512,
        stdoutStartsWithJson: false,
        elapsedMs: 1200,
        lastProfilePhase: { phase: 'parseOverlayJson', elapsedMs: 42.5 },
      },
      {
        ts: '2026-06-12T08:25:03.596Z',
        event: 'overlay.query.max-buffer',
        failureClass: 'overlay-max-buffer',
        query: 'template-component',
        queryId: 'run:overlay-42',
        outputMode: 'context-json',
        contextJson: true,
        stdoutBytes: 20_000_000,
        stderrBytes: 256,
        elapsedMs: 3000,
        resultStats: {
          outputFormat: 'json',
          parsedJson: true,
          count: 128,
          matchCount: 20,
          nodeCount: 128,
          edgeCount: 96,
          codeBlockCount: 8,
          relationshipGroupCount: 4,
          sourceBlockCount: 8,
          truncated: true,
        },
      },
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-critical']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.transportHealthy).toBe(true);
    expect(summary.overlayFailures).toEqual(expect.objectContaining({
      count: 2,
      byClass: {
        'overlay-nonzero-exit': 1,
        'overlay-max-buffer': 1,
      },
      byDate: {
        '2026-06-12': 2,
      },
      latest: expect.objectContaining({
        event: 'overlay.query.max-buffer',
        failureClass: 'overlay-max-buffer',
        query: 'template-component',
        outputMode: 'context-json',
        contextJson: true,
        stdoutBytes: 20_000_000,
        resultStats: expect.objectContaining({
          outputFormat: 'json',
          parsedJson: true,
          count: 128,
          codeBlockCount: 8,
          truncated: true,
        }),
      }),
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('Overlay subprocess failures are query-path failures'),
    ]));
  }, ANALYZER_SPEC_TIMEOUT_MS);
}
