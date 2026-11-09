import { expect, it } from 'vitest';

import {
  contextResponseEvent,
  expectCleanCurrentContextSourceOrdering,
  expectCurrentContextSourceOrderingIssue,
  makeLog,
  makeScriptFile,
  makeSourceOrderingFixture,
  runAnalyzer,
  wrapperStartEvent,
} from './analyze-codegraph-mcp-log.spec-helpers';

const CURRENT_SOURCE_ORDERING_ANALYZER_TIMEOUT_MS = 30_000;

export function registerAnalyzeCodegraphMcpLogSourceOrderingCurrentSpecs(): void {
  it('can infer low-value source pollution when ranked details are missing', () => {
    const script = makeScriptFile('module.exports = { version: "current-inferred-low-value-source-guard" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-inferred-low-value-source', {
        query: 'ProjectShellComponent',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 2,
          firstSourceFiles: [
            'src/app/core/shell/project-shell.component.spec.ts',
            'src/app/core/shell/project-shell.component.ts',
          ],
          rankedOverlayFiles: [],
          rankedOverlayFileDetails: [],
          topRankedOverlayFile: null,
          topRankedOverlayFileVisibleIndex: -1,
          firstSourceBlockIsTopRankedOverlayFile: false,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expectCurrentContextSourceOrderingIssue(
      summary,
      { lowValueVisibleSourceBlocks: 1, lowValueSourcePollution: 1 },
      { requestId: 'request-inferred-low-value-source', issue: 'low-value-source-block-visible' },
    );
  }, CURRENT_SOURCE_ORDERING_ANALYZER_TIMEOUT_MS);

  it('fails non-first inferred low-value source pollution when ranked details are missing', () => {
    const script = makeScriptFile('module.exports = { version: "current-inferred-non-first-low-value-source-guard" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-inferred-non-first-low-value-source', {
        query: 'ProjectShellComponent',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 3,
          firstSourceFiles: [
            'src/app/core/shell/project-shell.component.ts',
            'src/app/core/shell/project-shell.component.spec.ts',
            'src/app/core/shell/project-shell.actions.ts',
          ],
          rankedOverlayFiles: [],
          rankedOverlayFileDetails: [],
          topRankedOverlayFile: null,
          topRankedOverlayFileVisibleIndex: -1,
          firstSourceBlockIsTopRankedOverlayFile: false,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expectCurrentContextSourceOrderingIssue(
      summary,
      { lowValueVisibleSourceBlocks: 1, lowValueSourcePollution: 1 },
      { requestId: 'request-inferred-non-first-low-value-source', issue: 'low-value-source-block-visible' },
    );
  }, CURRENT_SOURCE_ORDERING_ANALYZER_TIMEOUT_MS);

  it('does not infer low-value source pollution when the query explicitly asks for tests', () => {
    const script = makeScriptFile('module.exports = { version: "current-inferred-low-value-test-query" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-test-source', {
        query: 'ProjectShellComponent spec',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 2,
          firstSourceFiles: [
            'src/app/core/shell/project-shell.component.spec.ts',
            'src/app/core/shell/project-shell.component.ts',
          ],
          rankedOverlayFiles: [],
          rankedOverlayFileDetails: [],
          topRankedOverlayFile: null,
          topRankedOverlayFileVisibleIndex: -1,
          firstSourceBlockIsTopRankedOverlayFile: false,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expectCleanCurrentContextSourceOrdering(summary, {
      lowValueVisibleSourceBlocks: 0,
      lowValueSourcePollution: 0,
    });
  }, CURRENT_SOURCE_ORDERING_ANALYZER_TIMEOUT_MS);

  it('does not re-infer low-value pollution for preferred explicit tooling source details', () => {
    const script = makeScriptFile('module.exports = { version: "current-preferred-tooling-source-guard" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-preferred-tooling-source', {
        query: 'contextPackExploreQueryFor filterContextPackBaseSourceBlockEntries sourceOrdering sourceSelection quality',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 2,
          firstSourceFiles: [
            'scripts/codegraph-nanoflow-mcp-stdio.cjs',
            'supabase/functions/_shared/widget-common.ts',
          ],
          rankedOverlayFiles: [
            'supabase/functions/_shared/widget-common.ts',
            'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          ],
          rawTopRankedOverlayFile: 'supabase/functions/_shared/widget-common.ts',
          rankedOverlayFileDetails: [
            {
              filePath: 'supabase/functions/_shared/widget-common.ts',
              lowValuePenalty: 0,
              rawLowValuePenalty: 0,
              explicitSymbolEvidence: false,
              preferredSymbolEvidence: false,
            },
            {
              filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
              lowValuePenalty: 0,
              rawLowValuePenalty: 6000,
              pathClassLowValue: true,
              codegraphToolingSource: true,
              explicitSymbolEvidence: true,
              preferredSymbolEvidence: true,
            },
          ],
          topRankedOverlayFile: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          topRankedOverlayFileSelectionReason: 'preferred-symbol-evidence',
          topRankedOverlayFileVisibleIndex: 0,
          firstSourceBlockIsTopRankedOverlayFile: true,
          topRankedOverlayFileMissing: false,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expectCleanCurrentContextSourceOrdering(summary, {
      lowValueVisibleSourceBlocks: 0,
      lowValueSourcePollution: 0,
    });
  }, CURRENT_SOURCE_ORDERING_ANALYZER_TIMEOUT_MS);

  it('does not infer low-value source pollution for lifecycle tooling transport queries without a CodeGraph anchor', () => {
    const script = makeScriptFile('module.exports = { version: "current-tooling-lifecycle-source-guard" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-transport-wrapper-source', {
        query: 'Transport closed wrapper stale config timeout logs source map package lock minified dist source ordering',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 2,
          firstSourceFiles: [
            'scripts/codegraph-nanoflow-mcp-stdio.cjs',
            'src/app/core/services/sync/project-sync-cursor.service.ts',
          ],
          rankedOverlayFiles: [],
          rankedOverlayFileDetails: [],
          topRankedOverlayFile: null,
          topRankedOverlayFileVisibleIndex: -1,
          firstSourceBlockIsTopRankedOverlayFile: false,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(0);
    expectCleanCurrentContextSourceOrdering(summary, {
      lowValueVisibleSourceBlocks: 0,
      lowValueSourcePollution: 0,
    });
  }, CURRENT_SOURCE_ORDERING_ANALYZER_TIMEOUT_MS);

  it('does not infer low-value source pollution for direct CodeGraph MCP diagnostics', () => {
    const script = makeScriptFile('module.exports = { version: "current-direct-mcp-source-guard" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-direct-mcp-cleanup', {
        query: 'CodeGraph direct MCP after cleanup verification',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 3,
          firstSourceFiles: [
            'main.ts',
            'scripts/smoke-codegraph-mcp-wrapper.cjs',
            'scripts/codegraph-adapter-context.cjs',
          ],
          rankedOverlayFiles: [
            'main.ts',
            'scripts/codegraph-adapter-context.cjs',
            'scripts/smoke-codegraph-mcp-wrapper.cjs',
          ],
          rankedOverlayFileDetails: [],
          topRankedOverlayFile: 'main.ts',
          topRankedOverlayFileVisibleIndex: 0,
          firstSourceBlockIsTopRankedOverlayFile: true,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(0);
    expectCleanCurrentContextSourceOrdering(summary, {
      lowValueVisibleSourceBlocks: 0,
      lowValueSourcePollution: 0,
    });
  }, CURRENT_SOURCE_ORDERING_ANALYZER_TIMEOUT_MS);

  it('does not fail low-value source diagnostics without a clean source alternative', () => {
    const script = makeScriptFile('module.exports = { version: "current-low-value-source-diagnostic-only" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-low-value-only', {
        query: 'internal script diagnostic',
        sourceOrdering: makeSourceOrderingFixture({
          firstSourceFiles: ['scripts/generate-codegraph-nanoflow-overlay.mjs'],
          rankedOverlayFiles: ['scripts/generate-codegraph-nanoflow-overlay.mjs'],
          rankedOverlayFileDetails: [{
            filePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs',
            score: 1_200,
            matchRank: 0,
            nodeRank: 0,
            matchScore: 4_000,
            nodeScore: 500,
            pathScore: 0,
            symbolScore: 0,
            sourceBlockScore: 800,
            lowValuePenalty: 6_000,
          }],
          topRankedOverlayFile: 'scripts/generate-codegraph-nanoflow-overlay.mjs',
          topRankedOverlayFileVisibleIndex: 0,
          firstSourceBlockIsTopRankedOverlayFile: true,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.currentContextSourceOrdering).toEqual(expect.objectContaining({
      lowValueVisibleSourceBlocks: 1,
      lowValueSourcePollution: 0,
      latestIssue: null,
    }));
  }, CURRENT_SOURCE_ORDERING_ANALYZER_TIMEOUT_MS);

  it('does not fail when a missing top-ranked overlay file is a filtered low-value helper', () => {
    const script = makeScriptFile('module.exports = { version: "current-filtered-low-value-top-ranked" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-filtered-low-value-top-ranked', {
        query: 'sync-required-field',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 3,
          firstSourceFiles: [
            'src/app/core/services/sync/project-sync-cursor.service.ts',
            'src/app/core/services/sync/project-task-data.service.ts',
            'src/app/core/services/sync/task-sync-query.service.ts',
          ],
          rankedOverlayFiles: [
            'src/tests/scripts/codegraph-nanoflow-overlay-json-projection-sync-rule-field-budget.spec-helpers.ts',
            'src/app/core/services/sync/project-sync-cursor.service.ts',
          ],
          rankedOverlayFileDetails: [
            {
              filePath: 'src/tests/scripts/codegraph-nanoflow-overlay-json-projection-sync-rule-field-budget.spec-helpers.ts',
              score: 9959,
              matchRank: 0,
              nodeRank: 0,
              matchScore: 15959,
              nodeScore: 0,
              pathScore: 0,
              symbolScore: 0,
              sourceBlockScore: 0,
              lowValuePenalty: 6000,
            },
            {
              filePath: 'src/app/core/services/sync/project-sync-cursor.service.ts',
              score: 9000,
              matchRank: 1,
              nodeRank: 1,
              matchScore: 9000,
              nodeScore: 0,
              pathScore: 0,
              symbolScore: 0,
              sourceBlockScore: 0,
              lowValuePenalty: 0,
            },
          ],
          topRankedOverlayFile: 'src/tests/scripts/codegraph-nanoflow-overlay-json-projection-sync-rule-field-budget.spec-helpers.ts',
          topRankedOverlayFileVisibleIndex: -1,
          firstSourceBlockIsTopRankedOverlayFile: false,
          topRankedOverlayFileMissing: true,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(0);
    expect(summary.currentContextSourceOrdering).toEqual(expect.objectContaining({
      topRankedMissing: 0,
      topRankedNotFirst: 0,
      lowValueVisibleSourceBlocks: 0,
      lowValueSourcePollution: 0,
      latestIssue: null,
    }));
  }, CURRENT_SOURCE_ORDERING_ANALYZER_TIMEOUT_MS);

  it('fails when native relationship sections are duplicated in the current context pack', () => {
    const script = makeScriptFile('module.exports = { version: "current-duplicate-native-sections" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-duplicate-native-sections', {
        query: 'ProjectSyncService',
        sourceOrdering: makeSourceOrderingFixture({
          relationshipsSectionCount: 2,
          duplicateRelationshipsSectionCount: 1,
          relatedSymbolsSectionCount: 2,
          duplicateRelatedSymbolsSectionCount: 1,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(1);
    expect(summary.currentContextSourceOrdering).toEqual(expect.objectContaining({
      duplicateRelationshipsSections: 1,
      duplicateRelatedSymbolsSections: 1,
      latestIssue: expect.objectContaining({
        requestId: 'request-duplicate-native-sections',
        issue: 'duplicate-native-relationship-sections',
      }),
    }));
  }, CURRENT_SOURCE_ORDERING_ANALYZER_TIMEOUT_MS);

  it('fails when relationship kind subsections are duplicated in the current context pack', () => {
    const script = makeScriptFile('module.exports = { version: "current-duplicate-relationship-kind-sections" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-duplicate-relationship-kind-sections', {
        query: 'ProjectSyncService',
        sourceOrdering: makeSourceOrderingFixture({
          duplicateRelationshipKindSectionCount: 1,
          relationshipKindSectionCounts: {
            calls: 2,
            references: 1,
          },
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(1);
    expect(summary.currentContextSourceOrdering).toEqual(expect.objectContaining({
      duplicateRelationshipKindSections: 1,
      latestIssue: expect.objectContaining({
        requestId: 'request-duplicate-relationship-kind-sections',
        issue: 'duplicate-relationship-kind-sections',
        sourceOrdering: expect.objectContaining({
          duplicateRelationshipKindSectionCount: 1,
          relationshipKindSectionCounts: {
            calls: 2,
            references: 1,
          },
        }),
      }),
    }));
  }, CURRENT_SOURCE_ORDERING_ANALYZER_TIMEOUT_MS);

  it('classifies spec-helper source blocks as low-value pollution for broad implementation queries', () => {
    const script = makeScriptFile('module.exports = { version: "current-spec-helper-low-value" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-spec-helper-pollution', {
        query: 'service',
        sourceOrdering: makeSourceOrderingFixture({
          firstSourceFiles: [
            'src/app/core/services/sync/batch-sync-task-intent.spec-helpers.ts',
            'src/app/core/services/sync/project-sync-cursor.service.ts',
          ],
          rankedOverlayFiles: [
            'src/app/core/services/sync/batch-sync-task-intent.spec-helpers.ts',
            'src/app/core/services/sync/project-sync-cursor.service.ts',
          ],
          rankedOverlayFileDetails: [
            {
              filePath: 'src/app/core/services/sync/batch-sync-task-intent.spec-helpers.ts',
              score: 9_000,
              matchRank: 0,
              nodeRank: 0,
              matchScore: 9_000,
              nodeScore: 0,
              pathScore: 0,
              symbolScore: 0,
              sourceBlockScore: 5_000,
              lowValuePenalty: 0,
            },
            {
              filePath: 'src/app/core/services/sync/project-sync-cursor.service.ts',
              score: 7_000,
              matchRank: 1,
              nodeRank: 1,
              matchScore: 7_000,
              nodeScore: 0,
              pathScore: 0,
              symbolScore: 0,
              sourceBlockScore: 4_000,
              lowValuePenalty: 0,
            },
          ],
          topRankedOverlayFile: 'src/app/core/services/sync/batch-sync-task-intent.spec-helpers.ts',
          topRankedOverlayFileVisibleIndex: 0,
          firstSourceBlockIsTopRankedOverlayFile: true,
          topRankedOverlayFileMissing: false,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(1);
    expect(summary.currentContextSourceOrdering).toEqual(expect.objectContaining({
      lowValueVisibleSourceBlocks: 1,
      lowValueSourcePollution: 1,
      latestIssue: expect.objectContaining({
        issue: 'low-value-source-block-visible',
      }),
    }));
  }, CURRENT_SOURCE_ORDERING_ANALYZER_TIMEOUT_MS);

  it('classifies fixture mock and browser-test source blocks as low-value pollution for broad implementation queries', () => {
    const script = makeScriptFile('module.exports = { version: "current-fixture-mock-low-value" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-fixture-mock-pollution', {
        query: 'session service',
        sourceOrdering: makeSourceOrderingFixture({
          firstSourceFiles: [
            'src/fixtures/session-data.ts',
            'src/app/core/services/session.service.ts',
            'src/__mocks__/session.service.ts',
            'cypress/e2e/session.cy.ts',
          ],
          rankedOverlayFiles: [],
          rankedOverlayFileDetails: [],
          topRankedOverlayFile: null,
          topRankedOverlayFileVisibleIndex: -1,
          firstSourceBlockIsTopRankedOverlayFile: false,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(1);
    expect(summary.currentContextSourceOrdering).toEqual(expect.objectContaining({
      lowValueVisibleSourceBlocks: 3,
      lowValueSourcePollution: 1,
      latestIssue: expect.objectContaining({
        requestId: 'request-fixture-mock-pollution',
        issue: 'low-value-source-block-visible',
      }),
    }));
  }, CURRENT_SOURCE_ORDERING_ANALYZER_TIMEOUT_MS);

  it('classifies generated repository tooling and static asset source blocks as low-value pollution without ranked details', () => {
    const script = makeScriptFile('module.exports = { version: "current-generated-low-value" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-generated-pollution', {
        query: 'contract service',
        sourceOrdering: makeSourceOrderingFixture({
          firstSourceFiles: [
            'src/generated/contracts.pb.ts',
            'src/app/core/services/contract.service.ts',
            '.github/scripts/check-contracts.ts',
            'cloudflare/workers-static-assets/contract-worker.js',
            'scripts/generate-contract-fixtures.ts',
          ],
          rankedOverlayFiles: [],
          rankedOverlayFileDetails: [],
          topRankedOverlayFile: null,
          topRankedOverlayFileVisibleIndex: -1,
          firstSourceBlockIsTopRankedOverlayFile: false,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(1);
    expect(summary.currentContextSourceOrdering).toEqual(expect.objectContaining({
      lowValueVisibleSourceBlocks: 4,
      lowValueSourcePollution: 1,
      latestIssue: expect.objectContaining({
        requestId: 'request-generated-pollution',
        issue: 'low-value-source-block-visible',
      }),
    }));
  }, CURRENT_SOURCE_ORDERING_ANALYZER_TIMEOUT_MS);

  it('separates historical source-ordering issues from the latest wrapper script hash', () => {
    const oldHash = '1'.repeat(64);
    const newHash = '2'.repeat(64);
    const scriptPath = 'D:/Code/dde/scripts/codegraph-nanoflow-mcp-stdio.cjs';
    const logPath = makeLog([
      wrapperStartEvent('old-run', scriptPath, {
        scriptSha256: oldHash,
      }),
      contextResponseEvent('old-run', 'old-bad-order', {
        query: 'EventDrivenSyncPulseService triggerNow',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 2,
          firstSourceFiles: ['src/noisy.ts', 'src/services/event-driven-sync-pulse.service.ts'],
          rankedOverlayFiles: ['src/services/event-driven-sync-pulse.service.ts'],
          topRankedOverlayFile: 'src/services/event-driven-sync-pulse.service.ts',
          topRankedOverlayFileVisibleIndex: 1,
          firstSourceBlockIsTopRankedOverlayFile: false,
        }),
      }),
      wrapperStartEvent('new-run', scriptPath, {
        ts: '2026-06-13T18:01:00.000Z',
        scriptSha256: newHash,
      }),
      contextResponseEvent('new-run', 'new-clean', {
        ts: '2026-06-13T18:01:01.000Z',
        query: 'EventDrivenSyncPulseService triggerNow',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 2,
          firstSourceFiles: ['src/services/event-driven-sync-pulse.service.ts', 'src/noisy.ts'],
          rankedOverlayFiles: ['src/services/event-driven-sync-pulse.service.ts'],
          topRankedOverlayFile: 'src/services/event-driven-sync-pulse.service.ts',
        }),
      }),
    ]);

    const result = runAnalyzer(logPath);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.contextSourceOrdering).toEqual(expect.objectContaining({
      total: 2,
      topRankedNotFirst: 1,
      latestIssue: expect.objectContaining({
        requestId: 'old-bad-order',
        wrapperStart: expect.objectContaining({ scriptSha256: oldHash }),
      }),
    }));
    expect(summary.currentWrapper).toEqual(expect.objectContaining({
      scriptSha256: newHash,
      runId: 'new-run',
    }));
    expectCleanCurrentContextSourceOrdering(summary, {
      latestIssue: null,
      latestMissingDiagnostics: null,
    });
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('Historical context-pack source ordering issues remain in the log'),
    ]));
    expect(summary.recommendations).not.toEqual(expect.arrayContaining([
      expect.stringContaining('current wrapper still has context-pack source ordering issues'),
    ]));
  }, CURRENT_SOURCE_ORDERING_ANALYZER_TIMEOUT_MS);

  it('marks the current wrapper as matching the on-disk script hash', () => {
    const script = makeScriptFile('module.exports = { version: "fresh" };\n');
    const logPath = makeLog([wrapperStartEvent('fresh-run', script)]);

    const result = runAnalyzer(logPath);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.currentWrapper).toEqual(expect.objectContaining({
      scriptPath: script.path,
      scriptSha256: script.sha256,
      diskScriptSha256: script.sha256,
      matchesDisk: true,
      staleAgainstDisk: false,
    }));
    expect(summary.recommendations).not.toEqual(expect.arrayContaining([
      expect.stringContaining('does not match the current on-disk wrapper script'),
    ]));
  }, CURRENT_SOURCE_ORDERING_ANALYZER_TIMEOUT_MS);
}
