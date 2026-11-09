import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import {
  callContextPack,
  extractContextSourceHeaders,
  writeOverlayResponseScript,
  writeQueryAwareOverlayResponseScript,
} from './codegraph-nanoflow-overlay-mcp-context-quality.helpers';
import { registerCodegraphOverlayMcpContextQualityNoiseSpecs } from './codegraph-nanoflow-overlay-mcp-context-quality-noise.spec-helpers';
import { registerCodegraphOverlayMcpContextQualityToolingSpecs } from './codegraph-nanoflow-overlay-mcp-context-quality-tooling.spec-helpers';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpContextQualitySpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    readJsonLine,
    makeFakeCodegraph,
  } = context;

  it('keeps explicitly requested i18n source files eligible for context-pack source blocks', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-i18n-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'src/config/dock-i18n.config.ts',
      [
        'export const DOCK_I18N_CONFIG = {',
        "  empty: 'No parked items',",
        "  restore: 'Restore item',",
        '} as const;',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/app/features/parking/parking-dock.component.ts',
      [
        'export class ParkingDockComponent {',
        "  label = 'parking';",
        '}',
        '',
      ].join('\n'),
    );
    writeOverlayResponseScript(projectRoot, {
      query: 'i18n',
      matches: [
        { kind: 'constant', name: 'DOCK_I18N_CONFIG', file: 'src/config/dock-i18n.config.ts' },
        { kind: 'class', name: 'ParkingDockComponent', file: 'src/app/features/parking/parking-dock.component.ts' },
      ],
      nodes: [
        {
          id: 'constant:src/config/dock-i18n.config.ts:DOCK_I18N_CONFIG',
          kind: 'constant',
          name: 'DOCK_I18N_CONFIG',
          qualifiedName: 'DOCK_I18N_CONFIG',
          filePath: 'src/config/dock-i18n.config.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 4,
        },
        {
          id: 'class:src/app/features/parking/parking-dock.component.ts:ParkingDockComponent',
          kind: 'class',
          name: 'ParkingDockComponent',
          qualifiedName: 'ParkingDockComponent',
          filePath: 'src/app/features/parking/parking-dock.component.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {},
      coverage: { typescriptFiles: 2, graphNodes: 2, graphEdges: 0 },
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph: makeFakeCodegraph(),
      readJsonLine,
      query: 'i18n',
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(sourceHeaders[0]).toContain('src/config/dock-i18n.config.ts');
    expect(text).toContain('DOCK_I18N_CONFIG');
  }, 12_000);

  it('keeps Android widget provider Kotlin and XML source blocks ahead of web bootstrap noise', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-android-widget-'));
    tempRoots.push(projectRoot);
    const receiverPath = 'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt';
    const widgetInfoPath = 'android/app/src/main/res/xml/nanoflow_focus_widget_info.xml';
    const layoutPath = 'android/app/src/main/res/layout/nanoflow_widget_loading.xml';
    const bootstrapPath = 'src/app/core/shell/workspace-shell-android-widget-bootstrap.helpers.ts';
    writeFile(
      projectRoot,
      receiverPath,
      [
        'package app.nanoflow.host',
        '',
        'import android.appwidget.AppWidgetProvider',
        '',
        'class NanoflowWidgetReceiver : AppWidgetProvider() {',
        '  fun renderWidget(): Unit = Unit',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      widgetInfoPath,
      [
        '<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"',
        '  android:initialLayout="@layout/nanoflow_widget_loading"',
        '  android:updatePeriodMillis="0" />',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      layoutPath,
      [
        '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"',
        '  android:layout_width="match_parent"',
        '  android:layout_height="wrap_content" />',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      bootstrapPath,
      [
        'export function openAndroidWidgetBootstrap(): void {',
        '  console.log("web bootstrap noise");',
        '}',
        '',
      ].join('\n'),
    );
    writeOverlayResponseScript(projectRoot, {
      query: 'android-widget-provider NanoflowWidgetReceiver',
      matches: [
        { kind: 'class', name: 'NanoflowWidgetReceiver', file: receiverPath },
        { kind: 'file', name: widgetInfoPath, file: widgetInfoPath },
        { kind: 'function', name: 'openAndroidWidgetBootstrap', file: bootstrapPath },
      ],
      nodes: [
        {
          id: `class:${receiverPath}:app.nanoflow.host.NanoflowWidgetReceiver`,
          kind: 'class',
          name: 'NanoflowWidgetReceiver',
          qualifiedName: 'app.nanoflow.host.NanoflowWidgetReceiver',
          filePath: receiverPath,
          language: 'kotlin',
          startLine: 5,
          endLine: 7,
          metadata: { relation: 'android-kotlin-class' },
        },
        {
          id: `file:${widgetInfoPath}:${widgetInfoPath}`,
          kind: 'file',
          name: widgetInfoPath,
          qualifiedName: widgetInfoPath,
          filePath: widgetInfoPath,
          language: 'xml',
          startLine: 1,
          endLine: 3,
          metadata: { relation: 'android-widget-provider' },
        },
        {
          id: `file:${layoutPath}:${layoutPath}`,
          kind: 'file',
          name: layoutPath,
          qualifiedName: layoutPath,
          filePath: layoutPath,
          language: 'xml',
          startLine: 1,
          endLine: 3,
          metadata: { relation: 'android-resource-file' },
        },
        {
          id: `function:${bootstrapPath}:openAndroidWidgetBootstrap`,
          kind: 'function',
          name: 'openAndroidWidgetBootstrap',
          qualifiedName: 'openAndroidWidgetBootstrap',
          filePath: bootstrapPath,
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {
        references: [
          { source: 'NanoflowWidgetReceiver', target: widgetInfoPath, relation: 'android-widget-provider' },
        ],
        imports: [
          { source: widgetInfoPath, target: layoutPath, relation: 'android-resource-reference' },
        ],
      },
      coverage: { androidWidgetProviders: 1, graphNodes: 4, graphEdges: 2 },
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph: makeFakeCodegraph(),
      readJsonLine,
      query: 'android-widget-provider NanoflowWidgetReceiver android widget provider receiver',
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(sourceHeaders.slice(0, 3).join('\n')).toContain(receiverPath);
    expect(sourceHeaders.slice(0, 3).join('\n')).toContain(widgetInfoPath);
    expect(sourceHeaders[0]).not.toContain(bootstrapPath);
    expect(text).toContain('class NanoflowWidgetReceiver : AppWidgetProvider()');
    expect(text).toContain('android:initialLayout="@layout/nanoflow_widget_loading"');
  }, 12_000);

  it('suppresses spec-helper related symbols for broad service context-pack queries', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-service-related-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'src/app/core/services/project-sync.service.ts',
      [
        'export class ProjectSyncService {',
        '  service(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/tests/scripts/project-sync.spec-helpers.ts',
      [
        'export const service = {',
        '  mock: true,',
        '};',
        '',
      ].join('\n'),
    );
    writeOverlayResponseScript(projectRoot, {
      query: 'service',
      matches: [
        { kind: 'constant', name: 'service', file: 'src/tests/scripts/project-sync.spec-helpers.ts' },
        { kind: 'class', name: 'ProjectSyncService', file: 'src/app/core/services/project-sync.service.ts' },
      ],
      nodes: [
        {
          id: 'constant:src/tests/scripts/project-sync.spec-helpers.ts:service',
          kind: 'constant',
          name: 'service',
          qualifiedName: 'service',
          filePath: 'src/tests/scripts/project-sync.spec-helpers.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'class:src/app/core/services/project-sync.service.ts:ProjectSyncService',
          kind: 'class',
          name: 'ProjectSyncService',
          qualifiedName: 'ProjectSyncService',
          filePath: 'src/app/core/services/project-sync.service.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {
        references: [
          { source: 'service', target: 'ProjectSyncService', relation: 'test-helper' },
          { source: 'ProjectSyncService', target: 'service', relation: 'implementation' },
        ],
      },
      coverage: { typescriptFiles: 2, graphNodes: 2, graphEdges: 2 },
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph: makeFakeCodegraph(),
      readJsonLine,
      query: 'service',
    });

    const relatedSymbols = text.slice(text.indexOf('### Related Symbols'));
    const productionIndex = relatedSymbols.indexOf('src/app/core/services/project-sync.service.ts');
    const helperIndex = relatedSymbols.indexOf('src/tests/scripts/project-sync.spec-helpers.ts');
    expect(productionIndex).toBeGreaterThanOrEqual(0);
    expect(helperIndex).toBe(-1);
  }, 12_000);

  it('suppresses related symbols when broad context-pack overlay results are only spec helpers', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-service-helper-only-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'src/app/core/services/simple-sync-batch-retry.spec-helpers.ts',
      [
        'export interface SimpleSyncBatchRetrySpecContext {',
        '  service: unknown;',
        '}',
        '',
      ].join('\n'),
    );
    writeOverlayResponseScript(projectRoot, {
      query: 'service',
      matches: [
        { kind: 'interface', name: 'SimpleSyncBatchRetrySpecContext', file: 'src/app/core/services/simple-sync-batch-retry.spec-helpers.ts' },
        { kind: 'property', name: 'service', file: 'src/app/core/services/simple-sync-batch-retry.spec-helpers.ts' },
      ],
      nodes: [
        {
          id: 'interface:src/app/core/services/simple-sync-batch-retry.spec-helpers.ts:SimpleSyncBatchRetrySpecContext',
          kind: 'interface',
          name: 'SimpleSyncBatchRetrySpecContext',
          qualifiedName: 'SimpleSyncBatchRetrySpecContext',
          filePath: 'src/app/core/services/simple-sync-batch-retry.spec-helpers.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'property:src/app/core/services/simple-sync-batch-retry.spec-helpers.ts:service',
          kind: 'property',
          name: 'service',
          qualifiedName: 'SimpleSyncBatchRetrySpecContext::service',
          filePath: 'src/app/core/services/simple-sync-batch-retry.spec-helpers.ts',
          language: 'typescript',
          startLine: 2,
          endLine: 2,
        },
      ],
      relationshipGroups: {},
      coverage: { typescriptFiles: 1, graphNodes: 2, graphEdges: 0 },
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph: makeFakeCodegraph(),
      readJsonLine,
      query: 'service',
    });

    const relatedSymbols = text.slice(text.indexOf('### Related Symbols'), text.indexOf('### Source Code'));
    expect(relatedSymbols).toContain('No overlay symbols matched this query.');
    expect(relatedSymbols).not.toContain('simple-sync-batch-retry.spec-helpers.ts');
  }, 12_000);

  it('merges overlay evidence into existing native relationship sections without duplicate headings', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-native-sections-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'src/app/core/services/project-sync.service.ts',
      [
        'export class ProjectSyncService {',
        '  sync(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    writeOverlayResponseScript(projectRoot, {
      query: 'ProjectSyncService',
      matches: [
        { kind: 'class', name: 'ProjectSyncService', file: 'src/app/core/services/project-sync.service.ts' },
      ],
      nodes: [
        {
          id: 'class:src/app/core/services/project-sync.service.ts:ProjectSyncService',
          kind: 'class',
          name: 'ProjectSyncService',
          qualifiedName: 'ProjectSyncService',
          filePath: 'src/app/core/services/project-sync.service.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
          metadata: { relation: 'angular-injectable' },
        },
      ],
      relationshipGroups: {
        calls: [
          { source: 'ProjectSyncService', target: 'sync', relation: 'call' },
        ],
        references: [
          { source: 'ProjectSyncService', target: 'sync-rpc', relation: 'nanoflow-sync-service' },
        ],
      },
      coverage: { typescriptFiles: 1, graphNodes: 1, graphEdges: 1 },
    });
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-native-section-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph-native-sections.cjs');
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  if (!line.trim()) return;",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'tools/list') {",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] } }));",
        "    return;",
        "  }",
        "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
        "    const query = message.params.arguments.query;",
        "    const text = ['**Exploration: ' + query + '**', '', 'base codegraph context', '', '**Relationships**', '', '**calls:**', '- nativeEntry → ProjectSyncService', '', '**Related Symbols**', '', '- src/native.ts: nativeEntry:1', ''].join('\\n');",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } }));",
        "    return;",
        "  }",
        "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
        "});",
        '',
      ].join('\n'),
    );

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph,
      readJsonLine,
      query: 'ProjectSyncService',
    });

    const relationshipsHeadingCount = (text.match(/^(?:### Relationships|\*\*Relationships\*\*)$/gm) ?? []).length;
    const relatedSymbolsHeadingCount = (text.match(/^(?:### Related Symbols|\*\*Related Symbols\*\*)$/gm) ?? []).length;
    const callsSubsectionCount = (text.match(/^\*\*calls:\*\*$/gm) ?? []).length;
    expect(relationshipsHeadingCount).toBe(1);
    expect(relatedSymbolsHeadingCount).toBe(1);
    expect(callsSubsectionCount).toBe(1);
    expect(text).toContain('- nativeEntry → ProjectSyncService');
    expect(text).toContain('- ProjectSyncService → sync (relation: call)');
    expect(text).toContain('- ProjectSyncService → sync-rpc (relation: nanoflow-sync-service)');
    expect(text).toContain('- src/native.ts: nativeEntry:1');
    expect(text).toContain('- src/app/core/services/project-sync.service.ts: ProjectSyncService:1');
  }, 12_000);

  it('keeps compound AGENTS config hard-rule evidence ahead of generic context-pack noise', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-floating-config-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'AGENTS.md',
      [
        '## 5.4 树遍历',
        '- 仅允许迭代算法。',
        '- 深度上限：`FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH = 100`。',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/config/layout.config.ts',
      [
        'export const FLOATING_TREE_CONFIG = {',
        '  MAX_SUBTREE_DEPTH: 100,',
        '} as const;',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/tests/scripts/codegraph-nanoflow-overlay.spec-context.ts',
      [
        'export interface CodegraphOverlaySpecContext {',
        '  overlaySourceOrdering: string;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/app/features/flow/components/flow-minimap.component.ts',
      [
        'export class FlowMinimapComponent {',
        '  private readonly config = inject(FlowDiagramConfigService);',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        'export function readContextPackSourceOrdering(): string[] {',
        '  return [];',
        '}',
        '',
      ].join('\n'),
    );
    const noisyQuery = 'floating tree config context-pack quality source ordering low-value related symbols codegraph nanoflow overlay';
    const focusedQuery = 'floating tree config';
    const noisyResponse = {
      query: noisyQuery,
      matches: [
        { kind: 'interface', name: 'CodegraphOverlaySpecContext', file: 'src/tests/scripts/codegraph-nanoflow-overlay.spec-context.ts' },
        { kind: 'method', name: 'config', file: 'src/app/features/flow/components/flow-minimap.component.ts' },
        { kind: 'function', name: 'readContextPackSourceOrdering', file: 'scripts/query-codegraph-nanoflow-overlay.mjs' },
      ],
      nodes: [
        {
          id: 'interface:src/tests/scripts/codegraph-nanoflow-overlay.spec-context.ts:CodegraphOverlaySpecContext',
          kind: 'interface',
          name: 'CodegraphOverlaySpecContext',
          qualifiedName: 'CodegraphOverlaySpecContext',
          filePath: 'src/tests/scripts/codegraph-nanoflow-overlay.spec-context.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'method:src/app/features/flow/components/flow-minimap.component.ts:config',
          kind: 'method',
          name: 'config',
          qualifiedName: 'FlowMinimapComponent::config',
          filePath: 'src/app/features/flow/components/flow-minimap.component.ts',
          language: 'typescript',
          startLine: 2,
          endLine: 2,
        },
        {
          id: 'function:scripts/query-codegraph-nanoflow-overlay.mjs:readContextPackSourceOrdering',
          kind: 'function',
          name: 'readContextPackSourceOrdering',
          qualifiedName: 'readContextPackSourceOrdering',
          filePath: 'scripts/query-codegraph-nanoflow-overlay.mjs',
          language: 'javascript',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {
        references: [
          { source: 'readContextPackSourceOrdering', target: 'CodegraphOverlaySpecContext', relation: 'tooling-helper' },
          { source: 'FlowMinimapComponent::config', target: 'CodegraphOverlaySpecContext', relation: 'generic-config' },
        ],
      },
      coverage: { typescriptFiles: 3, graphNodes: 3, graphEdges: 2 },
    };
    const focusedResponse = {
      query: focusedQuery,
      matches: [
        { kind: 'interface', name: 'CodegraphOverlaySpecContext', file: 'src/tests/scripts/codegraph-nanoflow-overlay.spec-context.ts' },
        { kind: 'method', name: 'config', file: 'src/app/features/flow/components/flow-minimap.component.ts' },
        { kind: 'function', name: 'readContextPackSourceOrdering', file: 'scripts/query-codegraph-nanoflow-overlay.mjs' },
        { kind: 'constant', name: 'FLOATING_TREE_CONFIG', file: 'src/config/layout.config.ts' },
        { kind: 'variable', name: 'FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH', file: 'AGENTS.md' },
      ],
      nodes: [
        {
          id: 'interface:src/tests/scripts/codegraph-nanoflow-overlay.spec-context.ts:CodegraphOverlaySpecContext',
          kind: 'interface',
          name: 'CodegraphOverlaySpecContext',
          qualifiedName: 'CodegraphOverlaySpecContext',
          filePath: 'src/tests/scripts/codegraph-nanoflow-overlay.spec-context.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'method:src/app/features/flow/components/flow-minimap.component.ts:config',
          kind: 'method',
          name: 'config',
          qualifiedName: 'FlowMinimapComponent::config',
          filePath: 'src/app/features/flow/components/flow-minimap.component.ts',
          language: 'typescript',
          startLine: 2,
          endLine: 2,
        },
        {
          id: 'function:scripts/query-codegraph-nanoflow-overlay.mjs:readContextPackSourceOrdering',
          kind: 'function',
          name: 'readContextPackSourceOrdering',
          qualifiedName: 'readContextPackSourceOrdering',
          filePath: 'scripts/query-codegraph-nanoflow-overlay.mjs',
          language: 'javascript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'constant:src/config/layout.config.ts:FLOATING_TREE_CONFIG',
          kind: 'constant',
          name: 'FLOATING_TREE_CONFIG',
          qualifiedName: 'FLOATING_TREE_CONFIG',
          filePath: 'src/config/layout.config.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'variable:AGENTS.md:FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH',
          kind: 'variable',
          name: 'FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH',
          qualifiedName: 'FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH',
          filePath: 'AGENTS.md',
          language: 'markdown',
          startLine: 3,
          endLine: 3,
          metadata: {
            relation: 'sync-rule-keyword',
            keywordMapping: 'sync-body-keyword',
            matchedNeedle: 'FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH',
          },
        },
      ],
      relationshipGroups: {
        references: [
          { source: 'readContextPackSourceOrdering', target: 'CodegraphOverlaySpecContext', relation: 'tooling-helper' },
          { source: 'FlowMinimapComponent::config', target: 'CodegraphOverlaySpecContext', relation: 'generic-config' },
          { source: '深度上限', target: 'FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH', relation: 'sync-rule-keyword' },
          { source: 'FLOATING_TREE_CONFIG', target: 'FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH', relation: 'config-source' },
        ],
      },
      coverage: { typescriptFiles: 3, graphNodes: 5, graphEdges: 4 },
    };
    writeQueryAwareOverlayResponseScript(projectRoot, focusedQuery, focusedResponse, noisyResponse);

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph: makeFakeCodegraph(),
      readJsonLine,
      query: noisyQuery,
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    const firstTwoHeaders = sourceHeaders.slice(0, 2).join('\n');
    expect(firstTwoHeaders).toContain('AGENTS.md');
    expect(firstTwoHeaders).toContain('src/config/layout.config.ts');
    expect(text).toContain('FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH');
  }, 12_000);

  registerCodegraphOverlayMcpContextQualityToolingSpecs(context);

  registerCodegraphOverlayMcpContextQualityNoiseSpecs(context);
}
