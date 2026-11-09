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

export function registerAnalyzeCodegraphMcpLogSourceOrderingLowValueSpecs(): void {
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
}
