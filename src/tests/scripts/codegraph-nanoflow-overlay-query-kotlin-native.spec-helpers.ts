import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayKotlinNativeQuerySpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { makeFixture, writeFile, queryOverlay, expectSpawnSuccess } = context;

  it('queries Android Kotlin methods and method calls as native context', () => {
    const root = makeFixture();
    const repositoryPath = 'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetRepository.kt';

    writeFile(
      root,
      repositoryPath,
      [
        'package app.nanoflow.host',
        '',
        'class NanoflowWidgetRepository(',
        '  private val store: NanoflowWidgetStore,',
        ') {',
        '  suspend fun consumeBootstrapUri(uri: android.net.Uri?): Boolean {',
        '    val payload = NanoflowBootstrapContract.parseBootstrapPayload(uri)',
        '    if (payload == null) {',
        '      store.clearPendingBootstrap()',
        '      return false',
        '    }',
        '    store.saveBootstrapPayload(payload)',
        '    return true',
        '  }',
        '}',
        '',
        'object NanoflowBootstrapContract {',
        '  fun parseBootstrapPayload(uri: android.net.Uri?): String? {',
        '    return uri?.getQueryParameter("payload")',
        '  }',
        '}',
        '',
        'class NanoflowWidgetStore {',
        '  fun clearPendingBootstrap(): Unit = Unit',
        '  fun saveBootstrapPayload(payload: String): Unit = Unit',
        '}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      'android-kotlin-method NanoflowWidgetRepository consumeBootstrapUri parseBootstrapPayload',
      ['--limit', '40'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'class',
        name: 'NanoflowWidgetRepository',
        filePath: repositoryPath,
        language: 'kotlin',
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'consumeBootstrapUri',
        qualifiedName: 'app.nanoflow.host.NanoflowWidgetRepository::consumeBootstrapUri',
        filePath: repositoryPath,
        language: 'kotlin',
        isAsync: true,
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'parseBootstrapPayload',
        qualifiedName: 'app.nanoflow.host.NanoflowBootstrapContract::parseBootstrapPayload',
        filePath: repositoryPath,
        language: 'kotlin',
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        source: `class:${repositoryPath}:app.nanoflow.host.NanoflowWidgetRepository`,
        target: `method:${repositoryPath}:app.nanoflow.host.NanoflowWidgetRepository::consumeBootstrapUri`,
      }),
      expect.objectContaining({
        kind: 'calls',
        source: `method:${repositoryPath}:app.nanoflow.host.NanoflowWidgetRepository::consumeBootstrapUri`,
        target: `method:${repositoryPath}:app.nanoflow.host.NanoflowBootstrapContract::parseBootstrapPayload`,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-call',
          callName: 'parseBootstrapPayload',
        }),
      }),
    ]));
    expect(response.relationshipGroups.contains).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'NanoflowWidgetRepository',
        target: 'consumeBootstrapUri',
      }),
    ]));
    expect(response.relationshipGroups.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'consumeBootstrapUri',
        target: 'parseBootstrapPayload',
        relation: 'android-kotlin-call',
      }),
    ]));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: repositoryPath,
      nodeName: 'consumeBootstrapUri',
      nodeKind: 'method',
    }));
    expect(response.markdown).toContain('suspend fun consumeBootstrapUri(uri: android.net.Uri?): Boolean');
    expect(response.markdown).toContain('fun parseBootstrapPayload(uri: android.net.Uri?): String?');

    const nativeResult = queryOverlay(
      root,
      'android-kotlin-call consumeBootstrapUri parseBootstrapPayload',
      ['--limit', '40', '--native-json'],
    );
    expectSpawnSuccess(nativeResult);
    const nativeResponse = JSON.parse(nativeResult.stdout);
    expect(nativeResponse.edges.every((edge: Record<string, unknown>) => !('metadata' in edge))).toBe(true);
    expect(nativeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'method',
        name: 'consumeBootstrapUri',
        language: 'kotlin',
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'parseBootstrapPayload',
        language: 'kotlin',
      }),
    ]));
    expect(nativeResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: repositoryPath,
        language: 'kotlin',
        nodeName: 'consumeBootstrapUri',
        nodeKind: 'method',
        content: expect.stringContaining('NanoflowBootstrapContract.parseBootstrapPayload(uri)'),
      }),
      expect.objectContaining({
        filePath: repositoryPath,
        language: 'kotlin',
        nodeName: 'parseBootstrapPayload',
        nodeKind: 'method',
        content: expect.stringContaining('return uri?.getQueryParameter("payload")'),
      }),
    ]));
  });
}
