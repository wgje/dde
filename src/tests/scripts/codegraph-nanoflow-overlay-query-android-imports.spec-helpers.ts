import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayAndroidImportQuerySpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, writeFile, queryOverlay, expectSpawnSuccess } = context;

  it('projects Android Kotlin imports as native import context', () => {
    const root = makeFixture();
    const receiverPath = 'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt';

    writeFile(
      root,
      receiverPath,
      [
        'package app.nanoflow.host',
        '',
        'import android.appwidget.AppWidgetProvider',
        'import android.content.Context as AndroidContext',
        'import androidx.work.*',
        '',
        'class NanoflowWidgetReceiver : AppWidgetProvider() {',
        '  fun refresh(context: AndroidContext): ExistingWorkPolicy = ExistingWorkPolicy.REPLACE',
        '}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      'android-kotlin-import AppWidgetProvider AndroidContext androidx.work NanoflowWidgetReceiver',
      ['--limit', '60'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const providerImportNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'import' && node.name === 'AppWidgetProvider'
    ));
    const aliasImportNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'import' && node.name === 'AndroidContext'
    ));
    const wildcardImportNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'import' && node.name === 'androidx.work.*'
    ));

    expect(providerImportNode).toEqual(expect.objectContaining({
      kind: 'import',
      name: 'AppWidgetProvider',
      qualifiedName: 'android.appwidget.AppWidgetProvider',
      filePath: receiverPath,
      language: 'kotlin',
      startLine: 3,
      endLine: 3,
      signature: 'import AppWidgetProvider from android.appwidget.AppWidgetProvider',
      metadata: expect.objectContaining({
        relation: 'android-kotlin-import',
        importedName: 'AppWidgetProvider',
        target: 'android.appwidget.AppWidgetProvider',
        packageName: 'android.appwidget',
      }),
    }));
    expect(aliasImportNode).toEqual(expect.objectContaining({
      kind: 'import',
      name: 'AndroidContext',
      qualifiedName: 'android.content.Context',
      signature: 'import AndroidContext from android.content.Context',
      metadata: expect.objectContaining({
        relation: 'android-kotlin-import',
        importedName: 'Context',
        alias: 'AndroidContext',
        target: 'android.content.Context',
      }),
    }));
    expect(wildcardImportNode).toEqual(expect.objectContaining({
      kind: 'import',
      name: 'androidx.work.*',
      qualifiedName: 'androidx.work.*',
      signature: 'import androidx.work.*',
      metadata: expect.objectContaining({
        relation: 'android-kotlin-import',
        importedName: '*',
        target: 'androidx.work.*',
        wildcard: true,
      }),
    }));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'imports',
        source: providerImportNode.id,
        line: 3,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-import',
          importedName: 'AppWidgetProvider',
          target: 'android.appwidget.AppWidgetProvider',
        }),
      }),
      expect.objectContaining({
        kind: 'imports',
        source: aliasImportNode.id,
        line: 4,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-import',
          alias: 'AndroidContext',
          target: 'android.content.Context',
        }),
      }),
      expect.objectContaining({
        kind: 'imports',
        source: wildcardImportNode.id,
        line: 5,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-import',
          wildcard: true,
          target: 'androidx.work.*',
        }),
      }),
    ]));
    expect(response.relationshipGroups.imports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'AppWidgetProvider',
        target: 'android.appwidget.AppWidgetProvider',
        relation: 'android-kotlin-import',
      }),
      expect.objectContaining({
        source: 'AndroidContext',
        target: 'android.content.Context',
        relation: 'android-kotlin-import',
      }),
    ]));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: receiverPath,
      language: 'kotlin',
    }));
    expect(response.markdown).toContain('import android.appwidget.AppWidgetProvider');
    expect(response.markdown).toContain('import android.content.Context as AndroidContext');

    const nativeResult = queryOverlay(
      root,
      'android-kotlin-import AppWidgetProvider AndroidContext androidx.work NanoflowWidgetReceiver',
      ['--limit', '60', '--native-json'],
    );
    expectSpawnSuccess(nativeResult);
    const nativeResponse = JSON.parse(nativeResult.stdout);
    expect(nativeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'import',
        name: 'AppWidgetProvider',
        filePath: receiverPath,
        language: 'kotlin',
      }),
      expect.objectContaining({
        kind: 'import',
        name: 'AndroidContext',
        filePath: receiverPath,
        language: 'kotlin',
      }),
    ]));
    expect(nativeResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'imports',
        source: providerImportNode.id,
      }),
      expect.objectContaining({
        kind: 'imports',
        source: aliasImportNode.id,
      }),
    ]));
    expect(nativeResponse.nodes.every((node: Record<string, unknown>) => !('metadata' in node))).toBe(true);
    expect(nativeResponse.edges.every((edge: Record<string, unknown>) => !('metadata' in edge))).toBe(true);
    expect(nativeResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: receiverPath,
      language: 'kotlin',
      content: expect.stringContaining('import android.appwidget.AppWidgetProvider'),
    }));
  });
}
