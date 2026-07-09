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

export function registerAnalyzeCodegraphMcpLogSourceOrderingTailSpecs(): void {
  it('still classifies script source as pollution for broad Android Kotlin runtime queries', () => {
    const script = makeScriptFile('module.exports = { version: "current-android-runtime-script-pollution" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-android-runtime-script-pollution', {
        query: 'Android Kotlin widget receiver lifecycle',
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

    expect(result.status, result.stderr).toBe(1);
    expectCurrentContextSourceOrderingIssue(
      summary,
      { lowValueVisibleSourceBlocks: 1, lowValueSourcePollution: 1 },
      { requestId: 'request-android-runtime-script-pollution', issue: 'low-value-source-block-visible' },
    );
  }, 15_000);

  it('treats localized test wording as explicit test evidence for source-ordering guards', () => {
    const script = makeScriptFile('module.exports = { version: "current-localized-test-source" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-localized-test-source', {
        query: '测试 stale wrapper 返回退出 host 重启 断言',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 2,
          firstSourceFiles: [
            'src/tests/scripts/codegraph-nanoflow-overlay-mcp-lifecycle-diagnostics.spec-helpers.ts',
            'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          ],
          rankedOverlayFiles: [
            'src/tests/scripts/codegraph-nanoflow-overlay-mcp-lifecycle-diagnostics.spec-helpers.ts',
            'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          ],
          rankedOverlayFileDetails: [
            {
              filePath: 'src/tests/scripts/codegraph-nanoflow-overlay-mcp-lifecycle-diagnostics.spec-helpers.ts',
              score: 1_200,
              matchRank: 0,
              nodeRank: 0,
              matchScore: 4_000,
              nodeScore: 500,
              pathScore: 0,
              symbolScore: 0,
              sourceBlockScore: 800,
              lowValuePenalty: 0,
            },
            {
              filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
              score: 1_100,
              matchRank: 1,
              nodeRank: 1,
              matchScore: 2_500,
              nodeScore: 500,
              pathScore: 0,
              symbolScore: 500,
              sourceBlockScore: 800,
              lowValuePenalty: 0,
            },
          ],
          topRankedOverlayFile: 'src/tests/scripts/codegraph-nanoflow-overlay-mcp-lifecycle-diagnostics.spec-helpers.ts',
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

  it('does not classify explicitly requested i18n source blocks as low-value pollution', () => {
    const script = makeScriptFile('module.exports = { version: "current-explicit-i18n-source" };\n');
    const logPath = makeLog([
      wrapperStartEvent('run-current', script),
      contextResponseEvent('run-current', 'request-i18n-source', {
        query: 'i18n',
        sourceOrdering: makeSourceOrderingFixture({
          sourceBlockCount: 2,
          firstSourceFiles: [
            'src/config/dock-i18n.config.ts',
            'src/app/features/parking/parking-dock.component.ts',
          ],
          rankedOverlayFiles: [
            'src/config/dock-i18n.config.ts',
            'src/app/features/parking/parking-dock.component.ts',
          ],
          rankedOverlayFileDetails: [
            {
              filePath: 'src/config/dock-i18n.config.ts',
              score: 2_000,
              matchRank: 0,
              nodeRank: 0,
              matchScore: 1_500,
              nodeScore: 400,
              pathScore: 50,
              symbolScore: 50,
              sourceBlockScore: 100,
              lowValuePenalty: 0,
            },
            {
              filePath: 'src/app/features/parking/parking-dock.component.ts',
              score: 1_000,
              matchRank: 1,
              nodeRank: 1,
              matchScore: 1_000,
              nodeScore: 0,
              pathScore: 0,
              symbolScore: 0,
              sourceBlockScore: 0,
              lowValuePenalty: 0,
            },
          ],
          topRankedOverlayFile: 'src/config/dock-i18n.config.ts',
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
