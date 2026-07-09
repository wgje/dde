import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import {
  callContextPack,
  extractContextSourceHeaders,
  writeOverlayResponseScript,
} from './codegraph-nanoflow-overlay-mcp-context-quality.helpers';
import { writeFakeCodegraphExploreScript } from './codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpContextQualityToolingDiagnosticsSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    readJsonLine,
    waitForLogEvent,
  } = context;

  it('logs helper-only dedup maintenance query classification so source-ordering issues are not misread as generic pollution', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-dedup-helper-diagnostics-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/codegraph-nanoflow-mcp-stdio.cjs',
      [
        'function strictNativeCodeBlockBudgetReached() {',
        '  return false;',
        '}',
        'function summarizeContextPackSourceOrdering() {',
        '  return { sourceBlockCount: 1 };',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        'export function selectAngularSemanticApiEdges() {',
        '  return [];',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/app/core/services/logger.service.ts',
      [
        'export class LoggerService {',
        '  log(message: string): void {',
        '    console.log(message);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const query = 'dedup contract selectAngularSemanticApiEdges strictNativeCodeBlockBudgetReached summarizeContextPackSourceOrdering';
    writeOverlayResponseScript(projectRoot, {
      query,
      matches: [
        {
          kind: 'function',
          name: 'selectAngularSemanticApiEdges',
          file: 'scripts/query-codegraph-nanoflow-overlay.mjs',
        },
        {
          kind: 'function',
          name: 'strictNativeCodeBlockBudgetReached',
          file: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
        },
        {
          kind: 'function',
          name: 'summarizeContextPackSourceOrdering',
          file: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
        },
      ],
      nodes: [
        {
          id: 'function:scripts/query-codegraph-nanoflow-overlay.mjs:selectAngularSemanticApiEdges',
          kind: 'function',
          name: 'selectAngularSemanticApiEdges',
          qualifiedName: 'selectAngularSemanticApiEdges',
          filePath: 'scripts/query-codegraph-nanoflow-overlay.mjs',
          language: 'javascript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'function:scripts/codegraph-nanoflow-mcp-stdio.cjs:strictNativeCodeBlockBudgetReached',
          kind: 'function',
          name: 'strictNativeCodeBlockBudgetReached',
          qualifiedName: 'strictNativeCodeBlockBudgetReached',
          filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          language: 'javascript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'function:scripts/codegraph-nanoflow-mcp-stdio.cjs:summarizeContextPackSourceOrdering',
          kind: 'function',
          name: 'summarizeContextPackSourceOrdering',
          qualifiedName: 'summarizeContextPackSourceOrdering',
          filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          language: 'javascript',
          startLine: 4,
          endLine: 6,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 3, graphEdges: 0 },
    });

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-dedup-helper-diagnostics-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      sourceBlocks: [
        {
          header: 'src/app/core/services/logger.service.ts - LoggerService(class)',
          language: 'typescript',
          lines: [
            '1\texport class LoggerService {',
            '2\t  log(message: string): void {',
            '3\t    console.log(message);',
            '4\t  }',
            '5\t}',
          ],
        },
        {
          header: 'scripts/query-codegraph-nanoflow-overlay.mjs - selectAngularSemanticApiEdges(function)',
          language: 'javascript',
          lines: [
            '1\texport function selectAngularSemanticApiEdges() {',
            '2\t  return [];',
            '3\t}',
          ],
        },
        {
          header: 'scripts/codegraph-nanoflow-mcp-stdio.cjs - strictNativeCodeBlockBudgetReached(function)',
          language: 'javascript',
          lines: [
            '1\tfunction strictNativeCodeBlockBudgetReached() {',
            '2\t  return false;',
            '3\t}',
            '4\tfunction summarizeContextPackSourceOrdering() {',
            '5\t  return { sourceBlockCount: 1 };',
            '6\t}',
          ],
        },
      ],
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph,
      readJsonLine,
      query,
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(sourceHeaders.slice(0, 2).join('\n')).toContain('scripts/codegraph-nanoflow-mcp-stdio.cjs');
    expect(sourceHeaders.slice(0, 2).join('\n')).toContain('scripts/query-codegraph-nanoflow-overlay.mjs');
    expect(sourceHeaders[0]).not.toContain('src/app/core/services/logger.service.ts');

    const responseEvent = await waitForLogEvent(
      process.env.NANOFLOW_CODEGRAPH_MCP_LOG ?? '',
      'nanoflow.context.response',
      2_000,
      (entry) => entry.query === query,
    );
    const queryClassification = responseEvent.queryClassification as Record<string, unknown>;
    expect(queryClassification).toEqual(expect.objectContaining({
      codegraphDedupMaintenance: true,
      dedupMaintenanceReason: 'strong-maintenance-helper-signal',
      hasCodegraphAnchor: false,
      hasDedupMaintenanceHelperSignal: true,
    }));
    expect(queryClassification['matchedDedupMaintenanceHelperSegments'])
      .toEqual(expect.arrayContaining(['select', 'angular', 'semantic', 'api', 'edges', 'strict', 'native', 'code', 'block', 'budget', 'reached', 'summarize', 'context', 'pack', 'source', 'ordering']));
    expect(responseEvent.sourceOrdering).toEqual(expect.objectContaining({
      queryClassification: expect.objectContaining({
        codegraphDedupMaintenance: true,
        dedupMaintenanceReason: 'strong-maintenance-helper-signal',
      }),
      rankedOverlayFileDetails: expect.arrayContaining([
        expect.objectContaining({
          filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          dedupMaintenanceSource: true,
          lowValuePenalty: 0,
        }),
      ]),
    }));
    expect(responseEvent.sourceSelection).toEqual(expect.objectContaining({
      overlayCandidateFiles: expect.arrayContaining([
        expect.objectContaining({
          filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          dedupMaintenanceSource: true,
          lowValuePenalty: 0,
        }),
      ]),
    }));
  }, 12_000);

  it('keeps CodeGraph tooling source visible while suppressing app logger and telemetry noise for tooling diagnostics', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-timeout-tooling-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/analyze-codegraph-mcp-log.cjs',
      [
        'function analyzeLog(entries) {',
        '  return entries.filter(entry => entry.event === "nanoflow.context.response");',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/run-codegraph-adapter-gate.cjs',
      [
        'function runCodegraphAdapterGate(profile) {',
        '  return profile === "quick";',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/services/logger.service.ts',
      [
        'export class LoggerService {',
        '  log(message: string): void {',
        '    console.log(message);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetTelemetry.kt',
      [
        'package app.nanoflow.host',
        'class NanoflowWidgetTelemetry {',
        '  fun log(event: String) = event',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'main.ts',
      [
        'import { bootstrapApplication } from "@angular/platform-browser";',
        'bootstrapApplication(AppComponent);',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/tests/scripts/task-operation-adapter-guard.spec-helpers.ts',
      [
        'export interface TaskOperationAdapterGuardSpecContext {',
        '  readonly helper: string;',
        '}',
        '',
      ].join('\n'),
    );
    writeOverlayResponseScript(projectRoot, {
      query: 'mcp wrapper log guard',
      matches: [
        { kind: 'function', name: 'analyzeLog', file: 'scripts/analyze-codegraph-mcp-log.cjs' },
        { kind: 'function', name: 'runCodegraphAdapterGate', file: 'scripts/run-codegraph-adapter-gate.cjs' },
      ],
      nodes: [
        {
          id: 'function:scripts/analyze-codegraph-mcp-log.cjs:analyzeLog',
          kind: 'function',
          name: 'analyzeLog',
          qualifiedName: 'analyzeLog',
          filePath: 'scripts/analyze-codegraph-mcp-log.cjs',
          language: 'javascript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'function:scripts/run-codegraph-adapter-gate.cjs:runCodegraphAdapterGate',
          kind: 'function',
          name: 'runCodegraphAdapterGate',
          qualifiedName: 'runCodegraphAdapterGate',
          filePath: 'scripts/run-codegraph-adapter-gate.cjs',
          language: 'javascript',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 2, graphEdges: 0 },
    });
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-timeout-tooling-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const query = 'context source ordering tooling query codegraph adapter gate log guard LoggerService Android telemetry pollution tests';
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      includeMaxFiles: true,
      preludeLines: [
        '**Blast radius - what depends on these (update/verify before editing)**',
        '',
        '- `LoggerService` (src/services/logger.service.ts:1) - app logger dependency noise',
        '- `NanoflowWidgetTelemetry` (android/app/src/main/java/app/nanoflow/host/NanoflowWidgetTelemetry.kt:1) - Android telemetry noise',
        '- `TaskOperationAdapterGuardSpecContext` (src/tests/scripts/task-operation-adapter-guard.spec-helpers.ts:5) - test helper noise',
        '- `analyzeLog` (scripts/analyze-codegraph-mcp-log.cjs:1) - CodeGraph log guard evidence',
        '',
        '**Relationships**',
        '',
        '**calls:**',
        '- log -> normalizeValue',
        '- NanoflowWidgetTelemetry -> log',
        '- TaskOperationAdapterGuardSpecContext -> analyzeLog',
        '- analyzeLog -> parseLogLine',
        '',
        '**Related Symbols**',
        '',
        '- src/services/logger.service.ts: LoggerService:1',
        '- android/app/src/main/java/app/nanoflow/host/NanoflowWidgetTelemetry.kt: NanoflowWidgetTelemetry:1',
        '- src/tests/scripts/task-operation-adapter-guard.spec-helpers.ts: TaskOperationAdapterGuardSpecContext:5',
        '- scripts/analyze-codegraph-mcp-log.cjs: analyzeLog:1',
      ],
      sourceBlocks: [
        {
          header: 'src/services/logger.service.ts — LoggerService(class)',
          language: 'typescript',
          lines: [
            '1\texport class LoggerService {',
            '2\t  log(message: string): void {',
            '3\t    console.log(message);',
            '4\t  }',
            '5\t}',
          ],
        },
        {
          header: 'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetTelemetry.kt — NanoflowWidgetTelemetry(class)',
          language: 'kotlin',
          lines: [
            '1\tpackage app.nanoflow.host',
            '2\tclass NanoflowWidgetTelemetry {',
            '3\t  fun log(event: String) = event',
            '4\t}',
          ],
        },
        {
          header: 'main.ts — main(file)',
          language: 'typescript',
          lines: [
            '1\timport { bootstrapApplication } from "@angular/platform-browser";',
            '2\tbootstrapApplication(AppComponent);',
          ],
        },
        {
          header: 'scripts/analyze-codegraph-mcp-log.cjs — analyzeLog(function)',
          language: 'javascript',
          lines: [
            '1\tfunction analyzeLog(entries) {',
            '2\t  return entries.filter(entry => entry.event === "nanoflow.context.response");',
            '3\t}',
          ],
        },
        {
          header: 'scripts/run-codegraph-adapter-gate.cjs — runCodegraphAdapterGate(function)',
          language: 'javascript',
          lines: [
            '1\tfunction runCodegraphAdapterGate(profile) {',
            '2\t  return profile === "quick";',
            '3\t}',
          ],
        },
      ],
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph,
      readJsonLine,
      query,
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    const leadingContext = text.slice(0, text.indexOf('### Source Code'));
    const baseMetadata = leadingContext.slice(leadingContext.indexOf('**Blast radius'));
    expect(text).toContain('baseQuery=adapter gate log guard');
    expect(text).toContain('baseMaxFiles=1');
    expect(baseMetadata).toContain('scripts/analyze-codegraph-mcp-log.cjs');
    expect(baseMetadata).not.toContain('LoggerService');
    expect(baseMetadata).not.toContain('NanoflowWidgetTelemetry');
    expect(baseMetadata).not.toContain('TaskOperationAdapterGuardSpecContext');
    expect(sourceHeaders[0]).toMatch(/^scripts\/(?:analyze-codegraph-mcp-log|run-codegraph-adapter-gate)\.cjs/);
    expect(sourceHeaders[1]).toMatch(/^scripts\/(?:analyze-codegraph-mcp-log|run-codegraph-adapter-gate)\.cjs/);
    expect(sourceHeaders.join('\n')).toContain('scripts/run-codegraph-adapter-gate.cjs');
    expect(sourceHeaders.join('\n')).toContain('scripts/analyze-codegraph-mcp-log.cjs');
    expect(sourceHeaders.join('\n')).not.toContain('src/services/logger.service.ts');
    expect(sourceHeaders.join('\n')).not.toContain('NanoflowWidgetTelemetry.kt');
    expect(sourceHeaders.join('\n')).not.toContain('main.ts');

    const responseEvent = await waitForLogEvent(
      process.env.NANOFLOW_CODEGRAPH_MCP_LOG ?? '',
      'nanoflow.context.response',
      2_000,
      (entry) => entry.query === query,
    );
    const baseSectionFiltering = responseEvent.baseSectionFiltering as {
      filteredLineCount: unknown;
      keptLineCount: unknown;
      sectionsTouched: unknown[];
      filteredLineDetails: unknown[];
    };
    expect(baseSectionFiltering).toEqual(expect.objectContaining({
      filteredLineCount: expect.any(Number),
      keptLineCount: expect.any(Number),
      sectionsTouched: expect.arrayContaining(['Blast radius', 'Relationships', 'Related Symbols']),
    }));
    expect(Number(baseSectionFiltering.filteredLineCount)).toBeGreaterThanOrEqual(6);
    expect(baseSectionFiltering.filteredLineDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({
        section: 'Blast radius',
        filePath: 'src/services/logger.service.ts',
        reason: 'tooling-pollution-source',
      }),
      expect.objectContaining({
        section: 'Relationships',
        reason: 'tooling-pollution-symbol',
      }),
      expect.objectContaining({
        section: 'Related Symbols',
        filePath: 'src/tests/scripts/task-operation-adapter-guard.spec-helpers.ts',
        reason: 'tooling-test-source',
      }),
    ]));
    expect(responseEvent.sourceSelection).toEqual(expect.objectContaining({
      visibleSourceFiles: expect.arrayContaining([
        expect.objectContaining({
          filePath: 'scripts/analyze-codegraph-mcp-log.cjs',
          selected: true,
        }),
      ]),
      filteredSourceFiles: expect.arrayContaining([
        expect.objectContaining({
          filePath: 'src/services/logger.service.ts',
          reason: 'tooling-pollution-source',
          rawLowValuePenalty: expect.any(Number),
        }),
        expect.objectContaining({
          filePath: 'android/app/src/main/java/app/nanoflow/host/nanoflowwidgettelemetry.kt',
          reason: 'tooling-pollution-source',
          rawLowValuePenalty: expect.any(Number),
        }),
        expect.objectContaining({
          filePath: 'main.ts',
          reason: 'tooling-pollution-source',
          rawLowValuePenalty: expect.any(Number),
        }),
      ]),
      overlayCandidateFiles: expect.arrayContaining([
        expect.objectContaining({
          filePath: 'scripts/analyze-codegraph-mcp-log.cjs',
          lowValuePenalty: 0,
        }),
        expect.objectContaining({
          filePath: 'scripts/run-codegraph-adapter-gate.cjs',
          lowValuePenalty: 0,
        }),
      ]),
    }));
  }, 12_000);

  it('suppresses generic warning metadata noise for MCP response warning diagnostics', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-warning-tooling-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/codegraph-nanoflow-mcp-stdio.cjs',
      [
        'const diagnostics = createDiagnostics(projectRoot);',
        'function summarizeMcpTextWarnings(text) {',
        '  return { codegraphAutoSyncDisabled: text.includes("auto-sync is DISABLED") };',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/services/toast.service.ts',
      [
        'export class ToastService {',
        '  warning(message: string): void {',
        '    console.warn(message);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/services/logger.service.ts',
      [
        'export class LoggerService {',
        '  warn(message: string): void {',
        '    console.warn(message);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetTelemetry.kt',
      [
        'package app.nanoflow.host',
        'class NanoflowWidgetTelemetry {',
        '  fun warn(event: String) = event',
        '}',
        '',
      ].join('\n'),
    );
    writeOverlayResponseScript(projectRoot, {
      query: 'MCP warning diagnostics responseWarnings',
      matches: [
        { kind: 'constant', name: 'diagnostics', file: 'scripts/codegraph-nanoflow-mcp-stdio.cjs' },
      ],
      nodes: [
        {
          id: 'constant:scripts/codegraph-nanoflow-mcp-stdio.cjs:diagnostics',
          kind: 'constant',
          name: 'diagnostics',
          qualifiedName: 'diagnostics',
          filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          language: 'javascript',
          startLine: 1,
          endLine: 1,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 1, graphEdges: 0 },
    });
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-warning-tooling-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const query = 'MCP warning diagnostics responseWarnings';
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      includeMaxFiles: true,
      preludeLines: [
        '**Blast radius - what depends on these (update/verify before editing)**',
        '',
        '- `warn` (src/services/logger.service.ts:2) - app logger warning noise',
        '- `warn` (android/app/src/main/java/app/nanoflow/host/NanoflowWidgetTelemetry.kt:3) - Android telemetry warning noise',
        '- `diagnostics` (scripts/codegraph-nanoflow-mcp-stdio.cjs:1) - MCP wrapper response warning evidence',
        '',
        '**Relationships**',
        '',
        '**calls:**',
        '- warning -> warn',
        '- NanoflowWidgetTelemetry -> warn',
        '- diagnostics -> createDiagnostics',
        '',
        '**Related Symbols**',
        '',
        '- src/services/logger.service.ts: LoggerService:1, warn:2',
        '- android/app/src/main/java/app/nanoflow/host/NanoflowWidgetTelemetry.kt: NanoflowWidgetTelemetry:1, warn:3',
        '- scripts/codegraph-nanoflow-mcp-stdio.cjs: diagnostics:1',
      ],
      sourceBlocks: [
        {
          header: 'src/services/toast.service.ts — warning(method)',
          language: 'typescript',
          lines: [
            '1\texport class ToastService {',
            '2\t  warning(message: string): void {',
            '3\t    console.warn(message);',
            '4\t  }',
            '5\t}',
          ],
        },
        {
          header: 'scripts/codegraph-nanoflow-mcp-stdio.cjs — diagnostics(constant)',
          language: 'javascript',
          lines: [
            '1\tconst diagnostics = createDiagnostics(projectRoot);',
          ],
        },
      ],
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph,
      readJsonLine,
      query,
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    const leadingContext = text.slice(0, text.indexOf('### Source Code'));
    const baseMetadata = leadingContext.slice(leadingContext.indexOf('**Blast radius'));
    expect(text).toContain('baseQuery=mcp responsewarnings');
    expect(baseMetadata).toContain('scripts/codegraph-nanoflow-mcp-stdio.cjs');
    expect(baseMetadata).not.toContain('LoggerService');
    expect(baseMetadata).not.toContain('NanoflowWidgetTelemetry');
    expect(sourceHeaders[0]).toBe('scripts/codegraph-nanoflow-mcp-stdio.cjs — diagnostics(constant)');
    expect(sourceHeaders.join('\n')).not.toContain('src/services/toast.service.ts');

    const responseEvent = await waitForLogEvent(
      process.env.NANOFLOW_CODEGRAPH_MCP_LOG ?? '',
      'nanoflow.context.response',
      2_000,
      (entry) => entry.query === query,
    );
    const baseSectionFiltering = responseEvent.baseSectionFiltering as {
      filteredLineCount: unknown;
      sectionsTouched: unknown[];
      filteredLineDetails: unknown[];
    };
    expect(baseSectionFiltering).toEqual(expect.objectContaining({
      sectionsTouched: expect.arrayContaining(['Blast radius', 'Relationships', 'Related Symbols']),
    }));
    expect(Number(baseSectionFiltering.filteredLineCount)).toBeGreaterThanOrEqual(5);
    expect(baseSectionFiltering.filteredLineDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({
        section: 'Blast radius',
        filePath: 'src/services/logger.service.ts',
        reason: 'tooling-pollution-source',
      }),
      expect.objectContaining({
        section: 'Relationships',
        reason: 'tooling-pollution-symbol',
      }),
    ]));
  }, 12_000);
}
