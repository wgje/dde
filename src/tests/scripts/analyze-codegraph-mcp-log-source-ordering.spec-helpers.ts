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
import { registerAnalyzeCodegraphMcpLogSourceOrderingCurrentSpecs } from './analyze-codegraph-mcp-log-source-ordering-current.spec-helpers';
import { registerAnalyzeCodegraphMcpLogSourceOrderingTailSpecs } from './analyze-codegraph-mcp-log-source-ordering-tail.spec-helpers';

export function registerAnalyzeCodegraphMcpLogSourceOrderingSpecs(): void {
  it('summarizes wrapper identity and context-pack source ordering quality', () => {
    const script = makeScriptFile('module.exports = { version: "current-with-source-ordering-issues" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-ok', {
        query: 'vitest.services.config.mts setupFiles',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 2,
          firstSourceFiles: ['vitest.services.config.mts', 'src/noisy.ts'],
        }),
      }),
      contextResponseEvent('run-current', 'request-stale', {
        ts: '2026-06-13T18:00:02.000Z',
        query: 'old wrapper context pack',
        sourceOrdering: undefined,
      }),
      contextResponseEvent('run-current', 'request-bad-order', {
        ts: '2026-06-13T18:00:03.000Z',
        query: 'explicit config query',
        sourceOrdering: makeSourceOrderingFixture({
          sourceSectionCount: 2,
          duplicateSourceSectionCount: 1,
          sourceBlockCount: 2,
          firstSourceFiles: ['src/noisy.ts', 'vitest.services.config.mts'],
          topRankedOverlayFileVisibleIndex: 1,
          firstSourceBlockIsTopRankedOverlayFile: false,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.wrapperStarts.total).toBe(1);
    expect(summary.wrapperStarts.versions).toEqual({
      'nanoflow-codegraph-wrapper-2026-06-14': 1,
    });
    expect(summary.wrapperStarts.latest).toEqual(expect.objectContaining({
      wrapperVersion: 'nanoflow-codegraph-wrapper-2026-06-14',
      scriptSha256: script.sha256,
    }));
    expect(summary.contextSourceOrdering).toEqual(expect.objectContaining({
      total: 3,
      withDiagnostics: 2,
      missingDiagnostics: 1,
      duplicateSourceSections: 1,
      topRankedMissing: 0,
      topRankedNotFirst: 1,
    }));
    expect(summary.contextSourceOrdering.latestIssue).toEqual(expect.objectContaining({
      requestId: 'request-bad-order',
      query: 'explicit config query',
      issue: 'top-ranked-overlay-not-first',
      sourceOrdering: expect.objectContaining({
        duplicateSourceSectionCount: 1,
        topRankedOverlayFileVisibleIndex: 1,
      }),
      wrapperStart: expect.objectContaining({
        wrapperVersion: 'nanoflow-codegraph-wrapper-2026-06-14',
        scriptSha256: script.sha256,
      }),
    }));
    expect(summary.contextSourceOrdering.latestMissingDiagnostics).toEqual(expect.objectContaining({
      requestId: 'request-stale',
      query: 'old wrapper context pack',
      wrapperStart: expect.objectContaining({
        wrapperVersion: 'nanoflow-codegraph-wrapper-2026-06-14',
        scriptSha256: script.sha256,
      }),
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('sourceOrdering diagnostics'),
      expect.stringContaining('top-ranked overlay files'),
    ]));

    const sinceResult = runAnalyzer(logPath, ['--since=2026-06-13T18:00:01.500Z']);
    const sinceSummary = JSON.parse(sinceResult.stdout);

    expect(sinceResult.status).toBe(0);
    expect(sinceSummary.wrapperStarts.total).toBe(0);
    expect(sinceSummary.contextSourceOrdering.latestMissingDiagnostics).toEqual(expect.objectContaining({
      requestId: 'request-stale',
      wrapperStart: expect.objectContaining({
        wrapperVersion: 'nanoflow-codegraph-wrapper-2026-06-14',
        scriptSha256: script.sha256,
      }),
    }));

    const splitSinceResult = runAnalyzer(logPath, ['--since', '2026-06-13T18:00:01.500Z']);
    const splitSinceSummary = JSON.parse(splitSinceResult.stdout);

    expect(splitSinceResult.status).toBe(0);
    expect(splitSinceSummary.wrapperStarts.total).toBe(0);
    expect(splitSinceSummary.contextSourceOrdering.latestMissingDiagnostics).toEqual(expect.objectContaining({
      requestId: 'request-stale',
      wrapperStart: expect.objectContaining({
        wrapperVersion: 'nanoflow-codegraph-wrapper-2026-06-14',
        scriptSha256: script.sha256,
      }),
    }));

    const emptyWindowResult = runAnalyzer(logPath, ['--since', '2026-06-13T18:10:00.000Z']);
    const emptyWindowSummary = JSON.parse(emptyWindowResult.stdout);

    expect(emptyWindowResult.status).toBe(0);
    expect(emptyWindowSummary.totalEvents).toBe(0);
    expect(emptyWindowSummary.activeWrappers.total).toBe(0);
    expect(emptyWindowSummary.currentWrapper).toBeNull();
    expect(emptyWindowSummary.currentContextWrapper).toBeNull();
  }, 15_000);

  it('does not flag top-ranked overlay not first when native order preservation is intentional', () => {
    const script = makeScriptFile('module.exports = { version: "current-native-order-preserved" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-native-order-preserved', {
        query: 'OverlayGenericService generic symbol match',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 2,
          baseSourceReorderAllowed: false,
          firstSourceFiles: [
            'src/app/core/services/native-first.service.ts',
            'src/app/core/services/overlay-generic.service.ts',
          ],
          rankedOverlayFiles: ['src/app/core/services/overlay-generic.service.ts'],
          topRankedOverlayFile: 'src/app/core/services/overlay-generic.service.ts',
          topRankedOverlayFileVisibleIndex: 1,
          firstSourceBlockIsTopRankedOverlayFile: false,
          topRankedOverlayFileMissing: false,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.contextSourceOrdering).toEqual(expect.objectContaining({
      total: 1,
      withDiagnostics: 1,
      topRankedMissing: 0,
      topRankedNotFirst: 0,
      latestIssue: null,
    }));
    expectCleanCurrentContextSourceOrdering(summary, {
      latestIssue: null,
    });
  }, 15_000);

  it('records benign low-value top-ranked overlay missing evidence without failing the source-ordering guard', () => {
    const script = makeScriptFile('module.exports = { version: "benign-top-ranked-missing" };\n');
    const lowValueFile = 'src/tests/scripts/codegraph-nanoflow-overlay.spec.ts';
    const cleanVisibleFile = 'scripts/codegraph-nanoflow-mcp-stdio.cjs';
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-benign-low-value-missing', {
        query: 'codegraph nanoflow adaptation dedup contract native output source ordering strict native gaps',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 1,
          firstSourceFiles: [cleanVisibleFile],
          rankedOverlayFiles: [lowValueFile, cleanVisibleFile],
          rawTopRankedOverlayFile: lowValueFile,
          topRankedOverlayFile: lowValueFile,
          topRankedOverlayFileSelectionReason: 'raw-score-top',
          topRankedOverlayFileVisibleIndex: -1,
          firstSourceBlockIsTopRankedOverlayFile: false,
          topRankedOverlayFileMissing: true,
          rankedOverlayFileDetails: [
            {
              filePath: lowValueFile,
              score: 30_000,
              matchRank: 0,
              nodeRank: 0,
              matchScore: 20_000,
              nodeScore: 10_000,
              pathScore: 100,
              symbolScore: 500,
              sourceBlockScore: 0,
              lowValuePenalty: 12_000,
              rawLowValuePenalty: 12_000,
              pathClassLowValue: true,
            },
            {
              filePath: cleanVisibleFile,
              score: 25_000,
              matchRank: 1,
              nodeRank: 1,
              matchScore: 18_000,
              nodeScore: 7_000,
              pathScore: 100,
              symbolScore: 500,
              sourceBlockScore: 0,
              lowValuePenalty: 0,
              rawLowValuePenalty: 0,
              dedupMaintenanceSource: true,
            },
          ],
          topRankedOverlayDecision: {
            rawFile: lowValueFile,
            selectedFile: lowValueFile,
            selectionReason: 'raw-score-top',
            rawVisibleIndex: -1,
            selectedVisibleIndex: -1,
            rawLowValuePenalty: 12_000,
            selectedLowValuePenalty: 12_000,
            skippedLowValue: false,
            baseSourceReorderAllowed: true,
            baseSourceReorderReason: 'overlay-evidence-first',
            queryMentionsTests: false,
            queryMentionsCodegraphDedupMaintenance: true,
            queryMentionsCodegraphTooling: true,
          },
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(0);
    expect(summary.currentContextSourceOrdering).toEqual(expect.objectContaining({
      total: 1,
      withDiagnostics: 1,
      topRankedMissing: 0,
      benignTopRankedMissing: 1,
      latestIssue: null,
      latestBenignTopRankedMissing: expect.objectContaining({
        requestId: 'request-benign-low-value-missing',
        benignReason: 'low-value-top-ranked-overlay-filtered',
        sourceOrdering: expect.objectContaining({
          rawTopRankedOverlayFile: lowValueFile,
          topRankedOverlayFile: lowValueFile,
          topRankedOverlayDecision: expect.objectContaining({
            rawFile: lowValueFile,
            rawLowValuePenalty: 12_000,
            queryMentionsTests: false,
          }),
        }),
      }),
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('benign top-ranked overlay missing'),
    ]));
  }, 15_000);

  it('summarizes base metadata filtering diagnostics for context-pack quality triage', () => {
    const script = makeScriptFile('module.exports = { version: "base-section-filtering" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-filtered-base-sections', {
        query: 'codegraph mcp wrapper telemetry pollution',
        baseSectionFiltering: {
          rawLineCount: 24,
          keptLineCount: 18,
          filteredLineCount: 6,
          filteredByReason: {
            'tooling-pollution-source': 2,
            'tooling-test-symbol': 4,
          },
          sectionsTouched: ['Blast radius', 'Relationships', 'Related Symbols'],
          filteredLineDetails: [{
            section: 'Blast radius',
            reason: 'tooling-pollution-source',
            filePath: 'src/services/logger.service.ts',
            linePreview: '- `LoggerService` (src/services/logger.service.ts:1)',
          }],
        },
        sourceSelection: {
          visibleSourceFiles: [{
            filePath: 'scripts/analyze-codegraph-mcp-log.cjs',
            visibleIndex: 0,
            selected: true,
            lowValuePenalty: 0,
          }],
          filteredSourceFiles: [{
            filePath: 'src/services/logger.service.ts',
            reason: 'tooling-pollution-source',
            rawLowValuePenalty: 12_000,
          }],
          overlayCandidateFiles: [{
            filePath: 'scripts/analyze-codegraph-mcp-log.cjs',
            rank: 0,
            score: 12_000,
            lowValuePenalty: 0,
          }],
        },
      }),
    ]);

    const result = runAnalyzer(logPath);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.contextSourceOrdering).toEqual(expect.objectContaining({
      total: 1,
      withDiagnostics: 1,
      baseSectionFilteringEvents: 1,
      baseSectionFilteredLines: 6,
      sourceSelectionEvents: 1,
      sourceSelectionFilteredFiles: 1,
    }));
    expect(summary.contextSourceOrdering.latestBaseSectionFiltering).toEqual(expect.objectContaining({
      requestId: 'request-filtered-base-sections',
      baseSectionFiltering: expect.objectContaining({
        filteredLineCount: 6,
        sectionsTouched: ['Blast radius', 'Relationships', 'Related Symbols'],
      }),
    }));
    expect(summary.currentContextSourceOrdering).toEqual(expect.objectContaining({
      baseSectionFilteringEvents: 1,
      baseSectionFilteredLines: 6,
      sourceSelectionEvents: 1,
      sourceSelectionFilteredFiles: 1,
    }));
    expect(summary.currentDiskContextSourceOrdering).toEqual(expect.objectContaining({
      baseSectionFilteringEvents: 1,
      baseSectionFilteredLines: 6,
      sourceSelectionEvents: 1,
      sourceSelectionFilteredFiles: 1,
    }));
    expect(summary.contextSourceOrdering.latestSourceSelection).toEqual(expect.objectContaining({
      requestId: 'request-filtered-base-sections',
      sourceSelection: expect.objectContaining({
        filteredSourceFiles: expect.arrayContaining([
          expect.objectContaining({
            filePath: 'src/services/logger.service.ts',
            reason: 'tooling-pollution-source',
          }),
        ]),
        overlayCandidateFiles: expect.arrayContaining([
          expect.objectContaining({
            filePath: 'scripts/analyze-codegraph-mcp-log.cjs',
            lowValuePenalty: 0,
          }),
        ]),
      }),
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('latestBaseSectionFiltering'),
      expect.stringContaining('latestSourceSelection'),
    ]));
  }, 15_000);

  it('preserves query classification and dedup source evidence in source-ordering summaries', () => {
    const script = makeScriptFile('module.exports = { version: "query-classification-source-ordering" };\n');
    const query = 'dedup contract selectAngularSemanticApiEdges strictNativeCodeBlockBudgetReached summarizeContextPackSourceOrdering';
    const queryClassification = {
      codegraphDedupMaintenance: true,
      dedupMaintenanceReason: 'strong-maintenance-helper-signal',
      hasCodegraphAnchor: false,
      hasMaintenanceIntent: true,
      hasStrongMaintenanceIntent: true,
      hasDedupMaintenanceHelperSignal: true,
      matchedCodegraphAnchorSegments: [],
      matchedMaintenanceIntentSegments: ['dedup', 'contract'],
      matchedStrongMaintenanceIntentSegments: ['dedup', 'contract'],
      matchedDedupMaintenanceHelperSegments: ['select', 'angular', 'semantic', 'api', 'edges', 'strict', 'native', 'code', 'block', 'budget', 'reached', 'summarize', 'context', 'pack', 'source', 'ordering'],
      matchedDedupMaintenanceHelperCompoundSignals: [
        'select:angular:semantic:api:edges',
        'strict:native:code:block:budget:reached',
        'summarize:context:pack:source:ordering',
      ],
      codegraphTooling: false,
      codegraphToolingQuality: false,
      codegraphToolingSourcePollution: false,
      context7Documentation: false,
      tests: false,
      segments: ['dedup', 'contract', 'select', 'angular', 'semantic', 'api', 'edges'],
    };
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-query-classification', {
        query,
        queryClassification,
        sourceSelection: {
          overlayCandidateFiles: [{
            filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
            rank: 0,
            selected: true,
            lowValuePenalty: 0,
            rawLowValuePenalty: 0,
            codegraphToolingSource: true,
            dedupMaintenanceSource: true,
          }],
        },
        sourceOrdering: makeSourceOrderingFixture({
          queryClassification,
          sourceSectionCount: 2,
          duplicateSourceSectionCount: 1,
          firstSourceFiles: ['scripts/codegraph-nanoflow-mcp-stdio.cjs'],
          rankedOverlayFiles: ['scripts/codegraph-nanoflow-mcp-stdio.cjs'],
          rankedOverlayFileDetails: [{
            filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
            score: 30_000,
            matchRank: 0,
            nodeRank: 0,
            matchScore: 15_000,
            nodeScore: 2_000,
            pathScore: 20,
            symbolScore: 2_000,
            sourceBlockScore: 30_000,
            lowValuePenalty: 0,
            rawLowValuePenalty: 0,
            codegraphToolingSource: true,
            dedupMaintenanceSource: true,
          }],
          topRankedOverlayFile: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          topRankedOverlayFileVisibleIndex: 0,
          firstSourceBlockIsTopRankedOverlayFile: true,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.contextSourceOrdering.latestIssue).toEqual(expect.objectContaining({
      requestId: 'request-query-classification',
      issue: 'duplicate-source-sections',
      queryClassification: expect.objectContaining({
        codegraphDedupMaintenance: true,
        dedupMaintenanceReason: 'strong-maintenance-helper-signal',
        hasDedupMaintenanceHelperSignal: true,
      }),
      sourceOrdering: expect.objectContaining({
        queryClassification: expect.objectContaining({
          codegraphDedupMaintenance: true,
          dedupMaintenanceReason: 'strong-maintenance-helper-signal',
        }),
        rankedOverlayFileDetails: expect.arrayContaining([
          expect.objectContaining({
            filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
            codegraphToolingSource: true,
            dedupMaintenanceSource: true,
          }),
        ]),
      }),
    }));
    expect(summary.contextSourceOrdering.latestSourceSelection).toEqual(expect.objectContaining({
      requestId: 'request-query-classification',
      queryClassification: expect.objectContaining({
        codegraphDedupMaintenance: true,
      }),
      sourceSelection: expect.objectContaining({
        overlayCandidateFiles: expect.arrayContaining([
          expect.objectContaining({
            filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
            dedupMaintenanceSource: true,
          }),
        ]),
      }),
    }));
  }, 15_000);

  it('uses context-pack timeout source ordering as current context evidence', () => {
    const script = makeScriptFile('module.exports = { version: "current-timeout-source-ordering" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-timeout-overlay-only', {
        event: 'nanoflow.context.timeout',
        query: 'codegraph mcp wrapper timeout source ordering',
        failureClass: 'base-codegraph-timeout-overlay-only',
        sourceOrdering: makeSourceOrderingFixture({
          firstSourceFiles: ['scripts/analyze-codegraph-mcp-log.cjs'],
          rankedOverlayFiles: ['scripts/analyze-codegraph-mcp-log.cjs'],
          rankedOverlayFileDetails: [{
            filePath: 'scripts/analyze-codegraph-mcp-log.cjs',
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
          topRankedOverlayFile: 'scripts/analyze-codegraph-mcp-log.cjs',
        }),
      }),
    ]);

    const result = runAnalyzer(logPath);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.contextSourceOrdering).toEqual(expect.objectContaining({
      total: 1,
      withDiagnostics: 1,
      missingDiagnostics: 0,
    }));
    expect(summary.currentContextWrapper).toEqual(expect.objectContaining({
      runId: 'run-current',
      matchesDisk: true,
    }));
    expect(summary.currentDiskContextWrapper).toEqual(expect.objectContaining({
      latestEvent: 'nanoflow.context.timeout',
      latestFailureClass: 'base-codegraph-timeout-overlay-only',
      matchesDisk: true,
    }));
    expectCleanCurrentContextSourceOrdering(summary, { total: 1 });
    expect(summary.currentDiskContextSourceOrdering).toEqual(expect.objectContaining({
      total: 1,
      withDiagnostics: 1,
      missingDiagnostics: 0,
    }));
  }, 15_000);

  it('can fail the guard when the current context-pack source ordering is unhealthy', () => {
    const script = makeScriptFile('module.exports = { version: "current-source-ordering-guard" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-bad-order', {
        query: 'explicit config query',
        sourceOrdering: makeSourceOrderingFixture({
          sourceSectionCount: 2,
          duplicateSourceSectionCount: 1,
          sourceBlockCount: 2,
          firstSourceFiles: ['src/noisy.ts', 'vitest.services.config.mts'],
          topRankedOverlayFileVisibleIndex: 1,
          firstSourceBlockIsTopRankedOverlayFile: false,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(summary.currentContextWrapper).toEqual(expect.objectContaining({
      runId: 'run-current',
      matchesDisk: true,
    }));
    expectCurrentContextSourceOrderingIssue(
      summary,
      { duplicateSourceSections: 1, topRankedNotFirst: 1 },
      { requestId: 'request-bad-order', issue: 'top-ranked-overlay-not-first' },
    );
  }, 15_000);

  it('can fail the guard when low-value source blocks consume the current source budget', () => {
    const script = makeScriptFile('module.exports = { version: "current-low-value-source-guard" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-low-value-source', {
        query: 'app.component templateUrl template-url',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 2,
          firstSourceFiles: [
            'scripts/generate-codegraph-nanoflow-overlay.mjs',
            'src/app/app.component.html',
          ],
          rankedOverlayFiles: [
            'scripts/generate-codegraph-nanoflow-overlay.mjs',
            'src/app/app.component.html',
          ],
          rankedOverlayFileDetails: [
            {
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
            },
            {
              filePath: 'src/app/app.component.html',
              score: 1_100,
              matchRank: 1,
              nodeRank: 1,
              matchScore: 2_500,
              nodeScore: 500,
              pathScore: 2_000,
              symbolScore: 500,
              sourceBlockScore: 800,
              lowValuePenalty: 0,
            },
          ],
          topRankedOverlayFile: 'scripts/generate-codegraph-nanoflow-overlay.mjs',
          topRankedOverlayFileVisibleIndex: 0,
          firstSourceBlockIsTopRankedOverlayFile: true,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expectCurrentContextSourceOrderingIssue(
      summary,
      { lowValueVisibleSourceBlocks: 1, lowValueSourcePollution: 1 },
      { requestId: 'request-low-value-source', issue: 'low-value-source-block-visible' },
    );
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('low-value source pollution'),
    ]));
  }, 15_000);

  it('can fail the guard when story demo source blocks consume broad component context', () => {
    const script = makeScriptFile('module.exports = { version: "current-story-demo-source-guard" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-story-demo-source', {
        query: 'action button component',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 3,
          firstSourceFiles: [
            'src/stories/action-button.stories.tsx',
            'src/app/shared/components/action-button.component.ts',
            'src/app/shared/components/action-button-menu.component.ts',
          ],
          rankedOverlayFiles: [
            'src/stories/action-button.stories.tsx',
            'src/app/shared/components/action-button.component.ts',
            'src/app/shared/components/action-button-menu.component.ts',
          ],
          rankedOverlayFileDetails: [
            {
              filePath: 'src/stories/action-button.stories.tsx',
              score: 3_000,
              matchRank: 0,
              nodeRank: 0,
              matchScore: 2_000,
              nodeScore: 400,
              pathScore: 300,
              symbolScore: 300,
              sourceBlockScore: 0,
              lowValuePenalty: 0,
            },
            {
              filePath: 'src/app/shared/components/action-button.component.ts',
              score: 2_500,
              matchRank: 1,
              nodeRank: 1,
              matchScore: 1_500,
              nodeScore: 400,
              pathScore: 300,
              symbolScore: 300,
              sourceBlockScore: 0,
              lowValuePenalty: 0,
            },
            {
              filePath: 'src/app/shared/components/action-button-menu.component.ts',
              score: 2_400,
              matchRank: 2,
              nodeRank: 2,
              matchScore: 1_400,
              nodeScore: 400,
              pathScore: 300,
              symbolScore: 300,
              sourceBlockScore: 0,
              lowValuePenalty: 0,
            },
          ],
          topRankedOverlayFile: 'src/stories/action-button.stories.tsx',
          topRankedOverlayFileVisibleIndex: 0,
          firstSourceBlockIsTopRankedOverlayFile: true,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expectCurrentContextSourceOrderingIssue(
      summary,
      { lowValueVisibleSourceBlocks: 1, lowValueSourcePollution: 1 },
      { requestId: 'request-story-demo-source', issue: 'low-value-source-block-visible' },
    );
    expect(summary.currentContextSourceOrdering).toEqual(expect.objectContaining({
      latestIssue: expect.objectContaining({
        sourceOrdering: expect.objectContaining({
          firstSourceFiles: expect.arrayContaining(['src/stories/action-button.stories.tsx']),
        }),
      }),
    }));
  }, 15_000);

	  it('does not classify an explicitly requested script source block as low-value pollution', () => {
	    const script = makeScriptFile('module.exports = { version: "current-explicit-script-source" };\n');
	    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-explicit-script-source', {
        query: 'query-codegraph-nanoflow-overlay.mjs template-url style-url strict native JSON',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 2,
          firstSourceFiles: [
            'scripts/query-codegraph-nanoflow-overlay.mjs',
            'src/app/app.component.html',
          ],
          rankedOverlayFiles: [
            'scripts/query-codegraph-nanoflow-overlay.mjs',
            'src/app/app.component.html',
          ],
          rankedOverlayFileDetails: [
            {
              filePath: 'scripts/query-codegraph-nanoflow-overlay.mjs',
              score: 1_200,
              matchRank: 0,
              nodeRank: 0,
              matchScore: 4_000,
              nodeScore: 500,
              pathScore: 0,
              symbolScore: 0,
              sourceBlockScore: 800,
              lowValuePenalty: 6_000,
            },
            {
              filePath: 'src/app/app.component.html',
              score: 1_100,
              matchRank: 1,
              nodeRank: 1,
              matchScore: 2_500,
              nodeScore: 500,
              pathScore: 2_000,
              symbolScore: 500,
              sourceBlockScore: 800,
              lowValuePenalty: 0,
            },
          ],
          topRankedOverlayFile: 'scripts/query-codegraph-nanoflow-overlay.mjs',
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
	  }, 15_000);

	  it('does not classify a tokenized script filename query as low-value pollution', () => {
	    const script = makeScriptFile('module.exports = { version: "current-tokenized-script-source" };\n');
	    const logPath = makeLog([
	      wrapperStartEvent('run-current', script),
	      contextResponseEvent('run-current', 'request-tokenized-script-source', {
	        query: 'query codegraph nanoflow overlay mjs template-url style-url',
	        sourceOrdering: makeSourceOrderingFixture({
	          sourceBlockCount: 2,
	          firstSourceFiles: [
	            'scripts/query-codegraph-nanoflow-overlay.mjs',
	            'src/app/app.component.html',
	          ],
	          rankedOverlayFiles: [
	            'scripts/query-codegraph-nanoflow-overlay.mjs',
	            'src/app/app.component.html',
	          ],
	          rankedOverlayFileDetails: [
	            {
	              filePath: 'scripts/query-codegraph-nanoflow-overlay.mjs',
	              score: 1_200,
	              matchRank: 0,
	              nodeRank: 0,
	              matchScore: 4_000,
	              nodeScore: 500,
	              pathScore: 0,
	              symbolScore: 0,
	              sourceBlockScore: 800,
	              lowValuePenalty: 6_000,
	            },
	            {
	              filePath: 'src/app/app.component.html',
	              score: 1_100,
	              matchRank: 1,
	              nodeRank: 1,
	              matchScore: 2_500,
	              nodeScore: 500,
	              pathScore: 2_000,
	              symbolScore: 500,
	              sourceBlockScore: 800,
	              lowValuePenalty: 0,
	            },
	          ],
	          topRankedOverlayFile: 'scripts/query-codegraph-nanoflow-overlay.mjs',
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
	  }, 15_000);

  it('does not classify MCP warning diagnostic tooling scripts as low-value pollution', () => {
    const script = makeScriptFile('module.exports = { version: "current-mcp-warning-diagnostic-script-source" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-mcp-warning-diagnostics-source', {
        query: 'MCP warning diagnostics responseWarnings',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 2,
          firstSourceFiles: [
            'scripts/codegraph-nanoflow-mcp-stdio.cjs',
            'src/services/toast.service.ts',
          ],
          rankedOverlayFiles: [
            'scripts/codegraph-nanoflow-mcp-stdio.cjs',
            'src/services/toast.service.ts',
          ],
          rankedOverlayFileDetails: [
            {
              filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
              score: 15_430,
              matchRank: 19,
              nodeRank: 72,
              matchScore: 13_780,
              nodeScore: 1_330,
              pathScore: 0,
              symbolScore: 320,
              sourceBlockScore: 0,
              lowValuePenalty: 0,
            },
            {
              filePath: 'src/services/toast.service.ts',
              score: 11_000,
              matchRank: 1,
              nodeRank: 1,
              matchScore: 6_000,
              nodeScore: 2_000,
              pathScore: 1_500,
              symbolScore: 1_500,
              sourceBlockScore: 0,
              lowValuePenalty: 0,
            },
          ],
          topRankedOverlayFile: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
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
  }, 15_000);

  it('does not classify explicit de-duplication adapter hotspot queries as script source pollution', () => {
    const script = makeScriptFile('module.exports = { version: "current-dedup-hotspot-script-source" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-dedup-hotspot-script-source', {
        query: 'Android Kotlin de-duplication hotspots collectAndroid readAndroidKotlinFileSymbols resolveAndroidKotlinCallTarget addAndroidKotlinTypeReferenceEdges manifest validator',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 2,
          firstSourceFiles: [
            'scripts/generate-codegraph-nanoflow-overlay.mjs',
            'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt',
          ],
          rankedOverlayFiles: [
            'scripts/generate-codegraph-nanoflow-overlay.mjs',
            'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt',
          ],
          rankedOverlayFileDetails: [
            {
              filePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs',
              score: 14_000,
              matchRank: 0,
              nodeRank: 0,
              matchScore: 7_000,
              nodeScore: 2_000,
              pathScore: 1_000,
              symbolScore: 4_000,
              sourceBlockScore: 0,
              lowValuePenalty: 6_000,
            },
            {
              filePath: 'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt',
              score: 11_000,
              matchRank: 1,
              nodeRank: 1,
              matchScore: 5_000,
              nodeScore: 2_000,
              pathScore: 2_000,
              symbolScore: 2_000,
              sourceBlockScore: 0,
              lowValuePenalty: 0,
            },
          ],
          topRankedOverlayFile: 'scripts/generate-codegraph-nanoflow-overlay.mjs',
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
  }, 15_000);

  it('does not infer camelCase de-duplication maintenance scripts as low-value pollution', () => {
    const script = makeScriptFile('module.exports = { version: "current-dedup-camelcase-script-source" };\n');
    const query = 'NanoFlow CodeGraph duplicate hotspots queryOverlay scoreCandidate selectGraphResults formatNativeMarkdown contextPackSourceRankingQueryFor sanitizeContextPackBaseMarkdownSections collectTypeScript buildNativeGraph dedup contract remaining duplicate audit';
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-dedup-camelcase-script-source', {
        query,
        sourceOrdering: makeSourceOrderingFixture({
          sourceRankingQuery: query,
          sourceVisibilityQuery: query,
          sourceBlockCount: 3,
          firstSourceFiles: [
            'scripts/query-codegraph-nanoflow-overlay.mjs',
            'scripts/codegraph-nanoflow-mcp-stdio.cjs',
            'scripts/generate-codegraph-nanoflow-overlay.mjs',
          ],
          rankedOverlayFiles: [
            'scripts/query-codegraph-nanoflow-overlay.mjs',
            'scripts/codegraph-nanoflow-mcp-stdio.cjs',
            'scripts/generate-codegraph-nanoflow-overlay.mjs',
          ],
          rankedOverlayFileDetails: [
            {
              filePath: 'scripts/query-codegraph-nanoflow-overlay.mjs',
              score: 30_000,
              matchRank: 0,
              nodeRank: 0,
              matchScore: 15_000,
              nodeScore: 2_000,
              pathScore: 20,
              symbolScore: 2_000,
              sourceBlockScore: 30_000,
              lowValuePenalty: 0,
            },
            {
              filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
              score: 20_000,
              matchRank: 1,
              nodeRank: 1,
              matchScore: 15_000,
              nodeScore: 2_000,
              pathScore: 20,
              symbolScore: 1_000,
              sourceBlockScore: 20_000,
              lowValuePenalty: 0,
            },
            {
              filePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs',
              score: 19_000,
              matchRank: 2,
              nodeRank: 2,
              matchScore: 15_000,
              nodeScore: 2_000,
              pathScore: 20,
              symbolScore: 1_000,
              sourceBlockScore: 19_000,
              lowValuePenalty: 0,
            },
          ],
          topRankedOverlayFile: 'scripts/query-codegraph-nanoflow-overlay.mjs',
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
  }, 15_000);

  registerAnalyzeCodegraphMcpLogSourceOrderingTailSpecs();
  registerAnalyzeCodegraphMcpLogSourceOrderingCurrentSpecs();
}
