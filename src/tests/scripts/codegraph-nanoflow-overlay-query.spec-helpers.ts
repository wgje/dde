import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayAgentRuleQuerySpecs } from './codegraph-nanoflow-overlay-query-agents.spec-helpers';
import { registerCodegraphOverlayQueryLatencySpecs } from './codegraph-nanoflow-overlay-query-latency.spec-helpers';
import { registerCodegraphOverlaySupabasePolicyQuerySpecs } from './codegraph-nanoflow-overlay-query-policies.spec-helpers';
import { registerCodegraphOverlayRealtimeQuerySpecs } from './codegraph-nanoflow-overlay-query-realtime.spec-helpers';
import { registerCodegraphOverlayQueryOutputSpecs } from './codegraph-nanoflow-overlay-query-output.spec-helpers';
import { registerCodegraphOverlayEdgeFunctionQuerySpecs } from './codegraph-nanoflow-overlay-query-edge-functions.spec-helpers';
import { registerCodegraphOverlayAngularHostQuerySpecs } from './codegraph-nanoflow-overlay-query-angular-host.spec-helpers';
import { registerCodegraphOverlayAngularRouteQuerySpecs } from './codegraph-nanoflow-overlay-query-angular-routes.spec-helpers';
import { registerCodegraphOverlayAngularTemplateQuerySpecs } from './codegraph-nanoflow-overlay-query-angular-template.spec-helpers';
import { registerCodegraphOverlayQuerySourceFilteringSpecs } from './codegraph-nanoflow-overlay-query-source-filtering.spec-helpers';
import { registerCodegraphOverlayQueryTestMappingSpecs } from './codegraph-nanoflow-overlay-query-test-mapping.spec-helpers';
import { registerCodegraphOverlayQueryExplicitPathSpecs } from './codegraph-nanoflow-overlay-query-explicit-path.spec-helpers';
import { registerCodegraphOverlayQueryStrictNativeSpecs } from './codegraph-nanoflow-overlay-query-strict-native.spec-helpers';
import { registerCodegraphOverlayQueryCoreSpecs } from './codegraph-nanoflow-overlay-query-core.spec-helpers';
import { registerCodegraphOverlayAndroidQuerySpecs } from './codegraph-nanoflow-overlay-query-android.spec-helpers';
import { registerCodegraphOverlayKotlinNativeQuerySpecs } from './codegraph-nanoflow-overlay-query-kotlin-native.spec-helpers';
export function registerCodegraphOverlayQuerySpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, writeFile, queryOverlay, expectSpawnSuccess, tempRoots } = context;
  registerCodegraphOverlayQuerySourceFilteringSpecs(context);
  registerCodegraphOverlayQueryCoreSpecs(context);
  registerCodegraphOverlayAndroidQuerySpecs(context);
  registerCodegraphOverlayKotlinNativeQuerySpecs(context);

  it('queries Android Kotlin properties, constructors, objects, and companion constants as native context', () => {
    const root = makeFixture();
    const repositoryPath = 'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRepository.kt';

    writeFile(
      root,
      repositoryPath,
      [
        'package app.nanoflow.host',
        '',
        'data class WidgetGatePreview(val id: String)',
        '',
        'class NanoflowWidgetRepository(',
        '  private val store: NanoflowWidgetStore,',
        '  var appWidgetId: Int,',
        '  private val previewsById: Map<String, WidgetGatePreview> = emptyMap(),',
        ') {',
        '  private val json = Json { ignoreUnknownKeys = true }',
        '  private val gateEntriesById: Map<String, WidgetGatePreview> = emptyMap()',
        '',
        '  companion object {',
        '    const val EXTRA_WIDGET_ID = "extra_widget_id"',
        '  }',
        '}',
        '',
        'object NanoflowBootstrapContract {',
        '  const val PARAM_PAYLOAD = "payload"',
        '}',
        '',
        'data class WidgetBridgeContext(',
        '  val token: String,',
        '  val expiresAt: String?,',
        ')',
        '',
        'class NanoflowWidgetStore',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      'android-kotlin-property android-kotlin-constructor NanoflowWidgetRepository EXTRA_WIDGET_ID PARAM_PAYLOAD WidgetBridgeContext',
      ['--limit', '60'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'class',
        name: 'NanoflowBootstrapContract',
        qualifiedName: 'app.nanoflow.host.NanoflowBootstrapContract',
        filePath: repositoryPath,
        language: 'kotlin',
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'constructor',
        qualifiedName: 'app.nanoflow.host.NanoflowWidgetRepository::constructor',
        filePath: repositoryPath,
        language: 'kotlin',
      }),
      expect.objectContaining({
        kind: 'property',
        name: 'store',
        qualifiedName: 'app.nanoflow.host.NanoflowWidgetRepository::store',
        filePath: repositoryPath,
        language: 'kotlin',
        visibility: 'private',
      }),
      expect.objectContaining({
        kind: 'property',
        name: 'json',
        qualifiedName: 'app.nanoflow.host.NanoflowWidgetRepository::json',
        filePath: repositoryPath,
        language: 'kotlin',
        visibility: 'private',
      }),
      expect.objectContaining({
        kind: 'property',
        name: 'PARAM_PAYLOAD',
        qualifiedName: 'app.nanoflow.host.NanoflowBootstrapContract::PARAM_PAYLOAD',
        filePath: repositoryPath,
        language: 'kotlin',
        isStatic: true,
      }),
      expect.objectContaining({
        kind: 'property',
        name: 'EXTRA_WIDGET_ID',
        qualifiedName: 'app.nanoflow.host.NanoflowWidgetRepository::Companion::EXTRA_WIDGET_ID',
        filePath: repositoryPath,
        language: 'kotlin',
        isStatic: true,
      }),
      expect.objectContaining({
        kind: 'property',
        name: 'token',
        qualifiedName: 'app.nanoflow.host.WidgetBridgeContext::token',
        filePath: repositoryPath,
        language: 'kotlin',
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        source: `class:${repositoryPath}:app.nanoflow.host.NanoflowWidgetRepository`,
        target: `method:${repositoryPath}:app.nanoflow.host.NanoflowWidgetRepository::constructor`,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-constructor',
        }),
      }),
      expect.objectContaining({
        kind: 'contains',
        source: `class:${repositoryPath}:app.nanoflow.host.NanoflowWidgetRepository`,
        target: `property:${repositoryPath}:app.nanoflow.host.NanoflowWidgetRepository::store`,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-property',
        }),
      }),
      expect.objectContaining({
        kind: 'contains',
        source: `class:${repositoryPath}:app.nanoflow.host.NanoflowBootstrapContract`,
        target: `property:${repositoryPath}:app.nanoflow.host.NanoflowBootstrapContract::PARAM_PAYLOAD`,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-property',
        }),
      }),
      expect.objectContaining({
        kind: 'contains',
        source: `class:${repositoryPath}:app.nanoflow.host.NanoflowWidgetRepository::Companion`,
        target: `property:${repositoryPath}:app.nanoflow.host.NanoflowWidgetRepository::Companion::EXTRA_WIDGET_ID`,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-property',
        }),
      }),
    ]));
    expect(response.relationshipGroups.contains).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'NanoflowWidgetRepository',
        target: 'constructor',
        relation: 'android-kotlin-constructor',
      }),
      expect.objectContaining({
        source: 'NanoflowBootstrapContract',
        target: 'PARAM_PAYLOAD',
        relation: 'android-kotlin-property',
      }),
      expect.objectContaining({
        source: 'Companion',
        target: 'EXTRA_WIDGET_ID',
        relation: 'android-kotlin-property',
      }),
    ]));
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: repositoryPath,
        language: 'kotlin',
        nodeName: 'constructor',
        nodeKind: 'method',
        content: expect.stringContaining('class NanoflowWidgetRepository('),
      }),
      expect.objectContaining({
        filePath: repositoryPath,
        language: 'kotlin',
        nodeName: 'EXTRA_WIDGET_ID',
        nodeKind: 'property',
        content: expect.stringContaining('const val EXTRA_WIDGET_ID = "extra_widget_id"'),
      }),
    ]));
    expect(response.markdown).toContain('private val store: NanoflowWidgetStore');
    expect(response.markdown).toContain('const val EXTRA_WIDGET_ID = "extra_widget_id"');

    const typeResult = queryOverlay(
      root,
      'android-kotlin-type-reference WidgetGatePreview gateEntriesById previewsById NanoflowWidgetRepository',
      ['--limit', '80'],
    );
    expectSpawnSuccess(typeResult);
    const typeResponse = JSON.parse(typeResult.stdout);
    const widgetGatePreviewNode = typeResponse.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'class' && node.name === 'WidgetGatePreview'
    ));
    const previewsByIdNode = typeResponse.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'property' && node.name === 'previewsById'
    ));
    const gateEntriesByIdNode = typeResponse.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'property' && node.name === 'gateEntriesById'
    ));

    expect(typeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'class',
        name: 'WidgetGatePreview',
        qualifiedName: 'app.nanoflow.host.WidgetGatePreview',
        filePath: repositoryPath,
        language: 'kotlin',
      }),
      expect.objectContaining({
        kind: 'property',
        name: 'previewsById',
        qualifiedName: 'app.nanoflow.host.NanoflowWidgetRepository::previewsById',
        filePath: repositoryPath,
        language: 'kotlin',
        visibility: 'private',
      }),
      expect.objectContaining({
        kind: 'property',
        name: 'gateEntriesById',
        qualifiedName: 'app.nanoflow.host.NanoflowWidgetRepository::gateEntriesById',
        filePath: repositoryPath,
        language: 'kotlin',
        visibility: 'private',
      }),
    ]));
    expect(typeResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_of',
        source: previewsByIdNode.id,
        target: widgetGatePreviewNode.id,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-type-reference',
          typeName: 'WidgetGatePreview',
          typeRole: 'property',
        }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        source: gateEntriesByIdNode.id,
        target: widgetGatePreviewNode.id,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-type-reference',
          typeName: 'WidgetGatePreview',
          typeRole: 'property',
        }),
      }),
    ]));
    expect(typeResponse.relationshipGroups.type_of).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'previewsById',
        target: 'WidgetGatePreview',
        relation: 'android-kotlin-type-reference',
      }),
      expect.objectContaining({
        source: 'gateEntriesById',
        target: 'WidgetGatePreview',
        relation: 'android-kotlin-type-reference',
      }),
    ]));
    expect(typeResponse.markdown).toContain('private val gateEntriesById: Map<String, WidgetGatePreview>');

    const nativeResult = queryOverlay(
      root,
      'android-kotlin-property android-kotlin-constructor NanoflowWidgetRepository EXTRA_WIDGET_ID PARAM_PAYLOAD',
      ['--limit', '60', '--native-json'],
    );
    expectSpawnSuccess(nativeResult);
    const nativeResponse = JSON.parse(nativeResult.stdout);
    expect(nativeResponse.edges.every((edge: Record<string, unknown>) => !('metadata' in edge))).toBe(true);
    expect(nativeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'method',
        name: 'constructor',
        language: 'kotlin',
      }),
      expect.objectContaining({
        kind: 'property',
        name: 'PARAM_PAYLOAD',
        language: 'kotlin',
      }),
      expect.objectContaining({
        kind: 'property',
        name: 'EXTRA_WIDGET_ID',
        language: 'kotlin',
      }),
    ]));
    expect(nativeResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: repositoryPath,
        language: 'kotlin',
        nodeName: 'PARAM_PAYLOAD',
        nodeKind: 'property',
        content: expect.stringContaining('const val PARAM_PAYLOAD = "payload"'),
      }),
    ]));
  });

  it('keeps source blocks visible when a wide explicit file query would otherwise exhaust markdown budget', () => {
    const root = makeFixture();
    const targetPath = 'src/app/core/services/sync/realtime-polling.service.ts';
    writeFile(
      root,
      targetPath,
      [
        'export class RealtimePollingService {',
        '  cleanup(): void {',
        '    this.client.removeChannel(this.channel);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const noisyNodes = Array.from({ length: 360 }, (_, index) => ({
      id: `method:src/noisy/cleanup-service-${index}.ts:CleanupNoise${index}.cleanup`,
      kind: 'method',
      name: `cleanupServiceBudgetNoise${index}`,
      qualifiedName: `CleanupNoise${index}::cleanupServiceBudgetNoise${index}`,
      filePath: `src/noisy/cleanup-service-${index}.ts`,
      language: 'typescript',
      startLine: 1,
      endLine: 3,
      signature: `(): void // cleanup service budget noise ${index}`,
    }));
    const overlay = {
      typescript: {
        files: Array.from({ length: 600 }, (_, index) => ({ file: `src/noisy/coverage-${index}.ts` })),
        classes: [],
        functions: [],
        interfaces: [],
        types: [],
        variables: [],
        enums: [],
        namespaces: [],
        imports: [],
        exports: [],
      },
      angular: {
        components: [],
        directives: [],
        pipes: [],
        injectables: [],
        injectors: [],
        dynamicImports: [],
        routes: [],
      },
      supabase: {
        edgeFunctions: [],
        migrations: [],
      },
      agentRules: {
        hardRules: [],
        syncRules: [],
      },
      graph: {
        nodes: [
          {
            id: `method:${targetPath}:RealtimePollingService.cleanup`,
            kind: 'method',
            name: 'cleanup',
            qualifiedName: 'RealtimePollingService::cleanup',
            filePath: targetPath,
            language: 'typescript',
            startLine: 2,
            endLine: 4,
            signature: '(): void',
          },
          ...noisyNodes,
        ],
        edges: [],
      },
    };
    writeFile(root, '.codegraph/source-budget-overlay.json', `${JSON.stringify(overlay, null, 2)}\n`);

    const result = queryOverlay(
      root,
      String.raw`src\app\core\services\sync\realtime-polling.service.ts:733 cleanup service`,
      ['--overlay', '.codegraph/source-budget-overlay.json', '--skip-refresh', '--limit', '360'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.entryPoints[0]).toEqual(expect.objectContaining({
      filePath: targetPath,
    }));
    expect(response.markdown).toContain(`#### ${targetPath}`);
    expect(response.markdown).toContain('this.client.removeChannel(this.channel);');
  });

  it('prioritizes exact explicit service symbols over broad sync helper and migration term noise', () => {
    const root = makeFixture();
    const targetPath = 'src/app/core/services/sync/task-sync-push.service.ts';
    const helperPath = 'src/app/core/services/sync/task-sync-operations-rpc-upsert.spec-helpers.ts';
    const migrationPath = 'supabase/migrations/20260509145500_sync_rpc_lww_upsert_semantics.sql';
    writeFile(
      root,
      targetPath,
      [
        'export class TaskSyncPushService {',
        '  async pushTask(): Promise<void> {}',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      helperPath,
      [
        'export interface TaskSyncOperationsRpcUpsertRetryQueueTableFallbackSpecContext {',
        '  getUpsertPayload(): unknown;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      migrationPath,
      [
        'create or replace function public.sync_upsert_task_retryqueue_table_rpc_fallback(payload jsonb)',
        'returns jsonb language sql as $$ select payload $$;',
        '',
      ].join('\n'),
    );

    const overlay = {
      typescript: {
        files: [],
        classes: [],
        functions: [],
        interfaces: [],
        types: [],
        variables: [],
        enums: [],
        namespaces: [],
        imports: [],
        exports: [],
      },
      angular: {
        components: [],
        directives: [],
        pipes: [],
        injectables: [],
        injectors: [],
        dynamicImports: [],
        routes: [],
      },
      supabase: {
        edgeFunctions: [],
        migrations: [],
      },
      agentRules: {
        hardRules: [],
        syncRules: [],
      },
      graph: {
        nodes: [
          {
            id: `interface:${helperPath}:TaskSyncOperationsRpcUpsertRetryQueueTableFallbackSpecContext`,
            kind: 'interface',
            name: 'TaskSyncOperationsRpcUpsertRetryQueueTableFallbackSpecContext',
            qualifiedName: 'TaskSyncOperationsRpcUpsertRetryQueueTableFallbackSpecContext',
            filePath: helperPath,
            language: 'typescript',
            startLine: 1,
            endLine: 3,
          },
          {
            id: `function:${migrationPath}:public.sync_upsert_task_retryqueue_table_rpc_fallback`,
            kind: 'function',
            name: 'public.sync_upsert_task_retryqueue_table_rpc_fallback',
            qualifiedName: 'public.sync_upsert_task_retryqueue_table_rpc_fallback',
            filePath: migrationPath,
            language: 'sql',
            startLine: 1,
            endLine: 2,
          },
          {
            id: `class:${targetPath}:TaskSyncPushService`,
            kind: 'class',
            name: 'TaskSyncPushService',
            qualifiedName: 'TaskSyncPushService',
            filePath: targetPath,
            language: 'typescript',
            startLine: 1,
            endLine: 3,
          },
        ],
        edges: [],
      },
    };
    writeFile(root, '.codegraph/explicit-symbol-overlay.json', `${JSON.stringify(overlay, null, 2)}\n`);

    const result = queryOverlay(
      root,
      'TaskSyncOperationsService 本身只是转发。我要直接看 TaskSyncPushService，确认 RPC 被拒绝或不可用时是否会直接落到 table upsert，还是进入 RetryQueue。',
      ['--overlay', '.codegraph/explicit-symbol-overlay.json', '--skip-refresh', '--limit', '2'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.matches[0]).toEqual(expect.objectContaining({
      kind: 'class',
      name: 'TaskSyncPushService',
      file: targetPath,
    }));
    expect(response.nodes[0]).toEqual(expect.objectContaining({
      kind: 'class',
      name: 'TaskSyncPushService',
      filePath: targetPath,
    }));
    expect(response.markdown).toContain(`#### ${targetPath}`);
    expect(response.markdown).toContain('async pushTask(): Promise<void> {}');
    const targetHeaderIndex = response.markdown.indexOf(`#### ${targetPath}`);
    const helperHeaderIndex = response.markdown.indexOf(`#### ${helperPath}`);
    const migrationHeaderIndex = response.markdown.indexOf(`#### ${migrationPath}`);
    expect(targetHeaderIndex).toBeGreaterThanOrEqual(0);
    if (helperHeaderIndex >= 0) {
      expect(targetHeaderIndex).toBeLessThan(helperHeaderIndex);
    }
    if (migrationHeaderIndex >= 0) {
      expect(targetHeaderIndex).toBeLessThan(migrationHeaderIndex);
    }
  });

  it('queries direct Supabase select string fields as native field relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'supabase-select-field', ['--limit', '40']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'property',
        name: 'content',
        qualifiedName: 'TaskSyncQueryService.loadDirectTaskRows::tasks.content',
        filePath: 'src/app/core/services/sync/task-sync-query.service.ts',
        metadata: expect.objectContaining({
          relation: 'supabase-select-field',
          table: 'tasks',
          field: 'content',
          selectSource: 'inline-select',
        }),
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'method:src/app/core/services/sync/task-sync-query.service.ts:TaskSyncQueryService.loadDirectTaskRows',
        target: 'property:src/app/core/services/sync/task-sync-query.service.ts:TaskSyncQueryService.loadDirectTaskRows.tasks.content',
        metadata: expect.objectContaining({
          relation: 'supabase-select-field',
          table: 'tasks',
          field: 'content',
          selectSource: 'inline-select',
        }),
      }),
    ]));
    expect(response.markdown).toContain('selectSource: inline-select');
  });

  it('deduplicates strict native Supabase select field code blocks by source range', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-select-field-codeblock-dedupe-'));
    tempRoots.push(root);
    const sourceFile = 'src/config/sync.config.ts';
    writeFile(
      root,
      sourceFile,
      [
        'export const FIELD_SELECT_CONFIG = {',
        "  TASK_FIELDS: 'id,content,updated_at',",
        '} as const;',
        '',
      ].join('\n'),
    );
    const sourceNode = {
      id: `constant:${sourceFile}:FIELD_SELECT_CONFIG`,
      kind: 'constant',
      name: 'FIELD_SELECT_CONFIG',
      qualifiedName: 'FIELD_SELECT_CONFIG',
      filePath: sourceFile,
      language: 'typescript',
      startLine: 1,
      endLine: 3,
    };
    const fieldNodes = ['id', 'content', 'updated_at'].map(field => ({
      id: `property:${sourceFile}:FIELD_SELECT_CONFIG.TASK_FIELDS.${field}`,
      kind: 'property',
      name: field,
      qualifiedName: `FIELD_SELECT_CONFIG.TASK_FIELDS::${field}`,
      filePath: sourceFile,
      language: 'typescript',
      startLine: 2,
      endLine: 2,
      metadata: {
        relation: 'supabase-select-field',
        table: 'tasks',
        field,
        selectSource: 'config',
      },
    }));
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [sourceFile],
        classes: [],
        functions: [],
        interfaces: [],
        types: [],
        variables: [],
        enums: [],
        namespaces: [],
        imports: [],
        exports: [],
        parameters: [],
      },
      angular: {
        components: [],
        directives: [],
        pipes: [],
        injectables: [],
        injectors: [],
        dynamicImports: [],
        routes: [],
      },
      supabase: {
        edgeFunctions: [],
        migrations: [],
      },
      agentRules: {
        hardRules: [],
        syncRules: [],
      },
      graph: {
        nodes: [sourceNode, ...fieldNodes],
        edges: fieldNodes.map(fieldNode => ({
          source: sourceNode.id,
          target: fieldNode.id,
          kind: 'references',
          line: 2,
          column: 2,
          metadata: {
            relation: 'supabase-select-field',
            table: 'tasks',
            field: fieldNode.name,
            selectSource: 'config',
          },
        })),
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'supabase-select-field', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const sourceRanges = response.codeBlocks.map((block: { filePath: string; startLine: number; endLine: number }) => (
      `${block.filePath}:${block.startLine}:${block.endLine}`
    ));
    expect(new Set(sourceRanges).size).toBe(sourceRanges.length);
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: sourceFile,
        startLine: 2,
        endLine: 2,
        content: expect.stringContaining('TASK_FIELDS'),
      }),
    ]));
  });

  registerCodegraphOverlayAngularTemplateQuerySpecs(context);
  registerCodegraphOverlayAngularRouteQuerySpecs(context);
  registerCodegraphOverlayAngularHostQuerySpecs(context);
  registerCodegraphOverlayEdgeFunctionQuerySpecs(context);
  registerCodegraphOverlayAgentRuleQuerySpecs(context);
  registerCodegraphOverlaySupabasePolicyQuerySpecs(context);
  registerCodegraphOverlayRealtimeQuerySpecs(context);
  registerCodegraphOverlayQueryOutputSpecs(context);
  registerCodegraphOverlayQueryTestMappingSpecs(context);
  registerCodegraphOverlayQueryExplicitPathSpecs(context);
  registerCodegraphOverlayQueryStrictNativeSpecs(context);

  registerCodegraphOverlayQueryLatencySpecs(context);
}
