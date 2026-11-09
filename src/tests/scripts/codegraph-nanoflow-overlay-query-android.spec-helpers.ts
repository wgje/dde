import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayAndroidAnnotationQuerySpecs } from './codegraph-nanoflow-overlay-query-android-annotations.spec-helpers';
import { registerCodegraphOverlayAndroidCompanionQuerySpecs } from './codegraph-nanoflow-overlay-query-android-companion.spec-helpers';
import { registerCodegraphOverlayAndroidEdgeQuerySpecs } from './codegraph-nanoflow-overlay-query-android-edges.spec-helpers';

export function registerCodegraphOverlayAndroidQuerySpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, writeFile, queryOverlay, expectSpawnSuccess } = context;

  it('queries Android widget provider manifest, Kotlin class, and XML resource relationships as native context', () => {
    const root = makeFixture();
    const manifestPath = 'android/app/src/main/AndroidManifest.xml';
    const receiverPath = 'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt';
    const widgetInfoPath = 'android/app/src/main/res/xml/nanoflow_focus_widget_info.xml';
    const layoutPath = 'android/app/src/main/res/layout/nanoflow_widget_compact.xml';
    const stringsPath = 'android/app/src/main/res/values/strings.xml';

    writeFile(
      root,
      manifestPath,
      [
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
        '  <application android:label="NanoFlow">',
        '    <receiver',
        '      android:name=".host.NanoflowWidgetReceiver"',
        '      android:exported="false">',
        '      <intent-filter>',
        '        <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />',
        '      </intent-filter>',
        '      <meta-data',
        '        android:name="android.appwidget.provider"',
        '        android:resource="@xml/nanoflow_focus_widget_info" />',
        '    </receiver>',
        '  </application>',
        '</manifest>',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      receiverPath,
      [
        'package app.nanoflow.host',
        '',
        'import android.appwidget.AppWidgetProvider',
        '',
        'class NanoflowWidgetReceiver : AppWidgetProvider() {',
        '  fun refreshWidgets(): Unit = Unit',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      widgetInfoPath,
      [
        '<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"',
        '  android:description="@string/nanoflow_widget_description"',
        '  android:minWidth="180dp"',
        '  android:minHeight="72dp"',
        '  android:initialLayout="@layout/nanoflow_widget_compact"',
        '  android:updatePeriodMillis="0" />',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      stringsPath,
      [
        '<resources>',
        '  <string name="nanoflow_widget_description">NanoFlow widget</string>',
        '</resources>',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      layoutPath,
      [
        '<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"',
        '  android:layout_width="match_parent"',
        '  android:layout_height="wrap_content" />',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      'android-widget-provider NanoflowWidgetReceiver nanoflow_focus_widget_info',
      ['--limit', '40'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'class',
        name: 'NanoflowWidgetReceiver',
        filePath: receiverPath,
        language: 'kotlin',
      }),
      expect.objectContaining({
        kind: 'file',
        name: manifestPath,
        filePath: manifestPath,
        language: 'xml',
      }),
      expect.objectContaining({
        kind: 'file',
        name: widgetInfoPath,
        filePath: widgetInfoPath,
        language: 'xml',
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'android-manifest-component',
          componentType: 'receiver',
          className: 'app.nanoflow.host.NanoflowWidgetReceiver',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'android-widget-provider',
          resourceName: 'nanoflow_focus_widget_info',
          resourceType: 'xml',
        }),
      }),
      expect.objectContaining({
        kind: 'imports',
        metadata: expect.objectContaining({
          relation: 'android-resource-reference',
          resourceName: 'nanoflow_widget_compact',
          resourceType: 'layout',
        }),
      }),
      expect.objectContaining({
        kind: 'imports',
        target: `file:${stringsPath}:${stringsPath}`,
        metadata: expect.objectContaining({
          relation: 'android-resource-reference',
          resourceName: 'nanoflow_widget_description',
          resourceType: 'string',
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'NanoflowWidgetReceiver',
        target: widgetInfoPath,
        relation: 'android-widget-provider',
      }),
    ]));
    expect(response.entryPoints[0]).toEqual(expect.objectContaining({
      name: 'NanoflowWidgetReceiver',
      filePath: receiverPath,
    }));
    const codeBlockFiles = response.codeBlocks.map((block: { filePath: string }) => block.filePath);
    expect(codeBlockFiles.slice(0, 3)).toEqual(expect.arrayContaining([
      receiverPath,
      widgetInfoPath,
    ]));
    expect(codeBlockFiles[0]).not.toMatch(/^src\/app\//);
    expect(response.markdown).toContain('class NanoflowWidgetReceiver : AppWidgetProvider()');
    expect(response.markdown).toContain('android:initialLayout="@layout/nanoflow_widget_compact"');
    expect(response.relatedFiles).toContain(stringsPath);
    expect(response.relatedFiles).not.toContain('android/app/src/main/res/string/nanoflow_widget_description.xml');

    const nativeResult = queryOverlay(
      root,
      'android-widget-provider NanoflowWidgetReceiver nanoflow_focus_widget_info',
      ['--limit', '40', '--native-json'],
    );
    expectSpawnSuccess(nativeResult);
    const nativeResponse = JSON.parse(nativeResult.stdout);
    expect(nativeResponse.edges.every((edge: Record<string, unknown>) => !('metadata' in edge))).toBe(true);
    expect(nativeResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: receiverPath,
        language: 'kotlin',
        content: expect.stringContaining('class NanoflowWidgetReceiver : AppWidgetProvider()'),
      }),
      expect.objectContaining({
        filePath: widgetInfoPath,
        language: 'xml',
        content: expect.stringContaining('android:initialLayout="@layout/nanoflow_widget_compact"'),
      }),
    ]));
  });

  it('projects Android Kotlin enum classes and enum entries as native enum context', () => {
    const root = makeFixture();
    const enumPath = 'android/app/src/main/java/app/nanoflow/host/WidgetRefreshState.kt';

    writeFile(
      root,
      enumPath,
      [
        'package app.nanoflow.host',
        '',
        'enum class WidgetRefreshState {',
        '  Idle,',
        '  Scheduled,',
        '  Running',
        '}',
        '',
        'class WidgetRefreshController {',
        '  fun current(): WidgetRefreshState = WidgetRefreshState.Scheduled',
        '}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(root, 'WidgetRefreshState Scheduled', ['--limit', '40']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const enumNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'enum' && node.name === 'WidgetRefreshState'
    ));
    const memberNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'enum_member' && node.name === 'Scheduled'
    ));
    expect(enumNode).toEqual(expect.objectContaining({
      kind: 'enum',
      name: 'WidgetRefreshState',
      qualifiedName: 'app.nanoflow.host.WidgetRefreshState',
      filePath: enumPath,
      language: 'kotlin',
      startLine: 3,
      endLine: 7,
      signature: 'enum class WidgetRefreshState',
    }));
    expect(memberNode).toEqual(expect.objectContaining({
      kind: 'enum_member',
      name: 'Scheduled',
      qualifiedName: 'app.nanoflow.host.WidgetRefreshState::Scheduled',
      filePath: enumPath,
      language: 'kotlin',
      startLine: 5,
      endLine: 5,
      signature: 'Scheduled',
    }));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        source: enumNode.id,
        target: memberNode.id,
        line: 5,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-enum-member',
          ownerName: 'WidgetRefreshState',
          memberName: 'Scheduled',
        }),
      }),
    ]));
    expect(response.entryPoints[0]).toEqual(expect.objectContaining({
      kind: 'enum',
      name: 'WidgetRefreshState',
      filePath: enumPath,
    }));
    expect(response.markdown).toContain('enum class WidgetRefreshState');
    expect(response.markdown).toContain('Scheduled,');

    const nativeResult = queryOverlay(root, 'WidgetRefreshState Scheduled', ['--limit', '40', '--native-json']);
    expectSpawnSuccess(nativeResult);
    const nativeResponse = JSON.parse(nativeResult.stdout);
    expect(nativeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'enum',
        name: 'WidgetRefreshState',
        filePath: enumPath,
        language: 'kotlin',
      }),
      expect.objectContaining({
        kind: 'enum_member',
        name: 'Scheduled',
        filePath: enumPath,
        language: 'kotlin',
      }),
    ]));
    expect(nativeResponse.nodes.every((node: Record<string, unknown>) => !('metadata' in node))).toBe(true);
    expect(nativeResponse.edges.every((edge: Record<string, unknown>) => !('metadata' in edge))).toBe(true);
    expect(nativeResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: enumPath,
        language: 'kotlin',
        content: expect.stringContaining('enum class WidgetRefreshState'),
      }),
    ]));
  });

  it('projects imported Android Kotlin heritage as native extends and implements context', () => {
    const root = makeFixture();
    const receiverPath = 'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt';

    writeFile(
      root,
      receiverPath,
      [
        'package app.nanoflow.host',
        '',
        'import android.appwidget.AppWidgetProvider',
        'import android.os.Parcelable',
        '',
        'class NanoflowWidgetReceiver : AppWidgetProvider() {',
        '  fun refreshWidgets(): Unit = Unit',
        '}',
        '',
        'class WidgetActionPayload : Parcelable {',
        '  fun describeContents(): Int = 0',
        '}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      'android-kotlin-extends android-kotlin-implements NanoflowWidgetReceiver AppWidgetProvider Parcelable',
      ['--limit', '60'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const receiverNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'class' && node.name === 'NanoflowWidgetReceiver'
    ));
    const providerNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'variable' && node.name === 'android.appwidget.AppWidgetProvider'
    ));
    const payloadNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'class' && node.name === 'WidgetActionPayload'
    ));
    const parcelableNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'variable' && node.name === 'android.os.Parcelable'
    ));
    expect(receiverNode).toEqual(expect.objectContaining({
      kind: 'class',
      name: 'NanoflowWidgetReceiver',
      filePath: receiverPath,
      language: 'kotlin',
    }));
    expect(providerNode).toEqual(expect.objectContaining({
      kind: 'variable',
      name: 'android.appwidget.AppWidgetProvider',
      filePath: receiverPath,
      language: 'kotlin',
    }));
    expect(payloadNode).toEqual(expect.objectContaining({
      kind: 'class',
      name: 'WidgetActionPayload',
      filePath: receiverPath,
      language: 'kotlin',
    }));
    expect(parcelableNode).toEqual(expect.objectContaining({
      kind: 'variable',
      name: 'android.os.Parcelable',
      filePath: receiverPath,
      language: 'kotlin',
    }));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'extends',
        source: receiverNode.id,
        target: providerNode.id,
        line: 6,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-extends',
          typeName: 'AppWidgetProvider',
          targetName: 'android.appwidget.AppWidgetProvider',
        }),
      }),
      expect.objectContaining({
        kind: 'implements',
        source: payloadNode.id,
        target: parcelableNode.id,
        line: 10,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-implements',
          typeName: 'Parcelable',
          targetName: 'android.os.Parcelable',
        }),
      }),
    ]));
    expect(response.relationshipGroups.extends).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'NanoflowWidgetReceiver',
        target: 'android.appwidget.AppWidgetProvider',
        relation: 'android-kotlin-extends',
      }),
    ]));
    expect(response.relationshipGroups.implements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'WidgetActionPayload',
        target: 'android.os.Parcelable',
        relation: 'android-kotlin-implements',
      }),
    ]));
    expect(response.markdown).toContain('class NanoflowWidgetReceiver : AppWidgetProvider()');
    expect(response.markdown).toContain('class WidgetActionPayload : Parcelable');
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: receiverPath,
      language: 'kotlin',
      nodeName: 'NanoflowWidgetReceiver',
      nodeKind: 'class',
      content: expect.stringContaining('class NanoflowWidgetReceiver : AppWidgetProvider()'),
    }));

    const nativeResult = queryOverlay(
      root,
      'android-kotlin-extends android-kotlin-implements NanoflowWidgetReceiver AppWidgetProvider Parcelable',
      ['--limit', '60', '--native-json'],
    );
    expectSpawnSuccess(nativeResult);
    const nativeResponse = JSON.parse(nativeResult.stdout);
    expect(nativeResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'extends',
        source: receiverNode.id,
        target: providerNode.id,
      }),
      expect.objectContaining({
        kind: 'implements',
        source: payloadNode.id,
        target: parcelableNode.id,
      }),
    ]));
    expect(nativeResponse.nodes.every((node: Record<string, unknown>) => !('metadata' in node))).toBe(true);
    expect(nativeResponse.edges.every((edge: Record<string, unknown>) => !('metadata' in edge))).toBe(true);
    expect(nativeResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: receiverPath,
      language: 'kotlin',
      nodeName: 'NanoflowWidgetReceiver',
      nodeKind: 'class',
      content: expect.stringContaining('class NanoflowWidgetReceiver : AppWidgetProvider()'),
    }));
    expect(nativeResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: receiverPath,
        language: 'kotlin',
        nodeName: 'NanoflowWidgetReceiver',
        nodeKind: 'class',
        content: expect.stringContaining('class NanoflowWidgetReceiver : AppWidgetProvider()'),
      }),
    ]));
  });

  it('projects Android Kotlin object declarations as native class-shaped singleton context', () => {
    const root = makeFixture();
    const objectPath = 'android/app/src/main/java/app/nanoflow/host/WidgetRenderSingleton.kt';

    writeFile(
      root,
      objectPath,
      [
        'package app.nanoflow.host',
        '',
        'object WidgetRenderSingleton {',
        '  const val STATIC_TOKEN = "render"',
        '',
        '  fun render(): String = buildToken()',
        '',
        '  private fun buildToken(): String = STATIC_TOKEN',
        '}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(root, 'WidgetRenderSingleton buildToken', ['--limit', '40']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const objectNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'class' && node.name === 'WidgetRenderSingleton'
    ));
    const methodNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'method' && node.name === 'buildToken'
    ));
    expect(objectNode).toEqual(expect.objectContaining({
      kind: 'class',
      name: 'WidgetRenderSingleton',
      qualifiedName: 'app.nanoflow.host.WidgetRenderSingleton',
      filePath: objectPath,
      language: 'kotlin',
      startLine: 3,
      endLine: 9,
      signature: 'object WidgetRenderSingleton',
      metadata: expect.objectContaining({
        relation: 'android-kotlin-object',
        classKind: 'object',
      }),
    }));
    expect(methodNode).toEqual(expect.objectContaining({
      kind: 'method',
      name: 'buildToken',
      qualifiedName: 'app.nanoflow.host.WidgetRenderSingleton::buildToken',
      filePath: objectPath,
      language: 'kotlin',
      startLine: 8,
      endLine: 8,
      isStatic: true,
    }));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        source: objectNode.id,
        target: methodNode.id,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-method',
          ownerName: 'WidgetRenderSingleton',
          methodName: 'buildToken',
        }),
      }),
    ]));
    const relationResult = queryOverlay(root, 'android-kotlin-object WidgetRenderSingleton', ['--limit', '40']);
    expectSpawnSuccess(relationResult);
    const relationResponse = JSON.parse(relationResult.stdout);
    expect(relationResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        target: objectNode.id,
        line: 3,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-object',
          objectName: 'WidgetRenderSingleton',
        }),
      }),
    ]));
    expect(response.entryPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'class',
        name: 'WidgetRenderSingleton',
        filePath: objectPath,
      }),
    ]));
    expect(response.markdown).toContain('object WidgetRenderSingleton');
    expect(response.markdown).toContain('private fun buildToken()');

    const nativeResult = queryOverlay(root, 'WidgetRenderSingleton buildToken', ['--limit', '40', '--native-json']);
    expectSpawnSuccess(nativeResult);
    const nativeResponse = JSON.parse(nativeResult.stdout);
    expect(nativeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'class',
        name: 'WidgetRenderSingleton',
        filePath: objectPath,
        language: 'kotlin',
        signature: 'object WidgetRenderSingleton',
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'buildToken',
        filePath: objectPath,
        language: 'kotlin',
        isStatic: true,
      }),
    ]));
    expect(nativeResponse.nodes.every((node: Record<string, unknown>) => !('metadata' in node))).toBe(true);
    expect(nativeResponse.edges.every((edge: Record<string, unknown>) => !('metadata' in edge))).toBe(true);
    expect(nativeResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: objectPath,
        language: 'kotlin',
        content: expect.stringContaining('object WidgetRenderSingleton'),
      }),
    ]));
  });

  it('projects Android Kotlin interfaces and implementation edges as native interface context', () => {
    const root = makeFixture();
    const interfacePath = 'android/app/src/main/java/app/nanoflow/host/WidgetActionDispatching.kt';

    writeFile(
      root,
      interfacePath,
      [
        'package app.nanoflow.host',
        '',
        'interface WidgetActionDispatcher {',
        '  fun dispatch(action: WidgetAction): Boolean',
        '}',
        '',
        'data class WidgetAction(',
        '  val appWidgetId: Int,',
        '  val action: String,',
        ')',
        '',
        'sealed class WidgetDispatchResult',
        '',
        'class WidgetActionHandler : WidgetActionDispatcher {',
        '  override fun dispatch(action: WidgetAction): Boolean = action.action.isNotBlank()',
        '}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(root, 'WidgetActionDispatcher WidgetActionHandler dispatch', ['--limit', '60']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const interfaceNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'interface' && node.name === 'WidgetActionDispatcher'
    ));
    const handlerNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'class' && node.name === 'WidgetActionHandler'
    ));
    const actionNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'class' && node.name === 'WidgetAction'
    ));
    const resultNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'class' && node.name === 'WidgetDispatchResult'
    ));
    expect(interfaceNode).toEqual(expect.objectContaining({
      kind: 'interface',
      name: 'WidgetActionDispatcher',
      qualifiedName: 'app.nanoflow.host.WidgetActionDispatcher',
      filePath: interfacePath,
      language: 'kotlin',
      startLine: 3,
      endLine: 5,
      signature: 'interface WidgetActionDispatcher',
      metadata: expect.objectContaining({
        relation: 'android-kotlin-interface',
        classKind: 'interface',
      }),
    }));
    expect(handlerNode).toEqual(expect.objectContaining({
      kind: 'class',
      name: 'WidgetActionHandler',
      qualifiedName: 'app.nanoflow.host.WidgetActionHandler',
      filePath: interfacePath,
      language: 'kotlin',
    }));
    expect(actionNode).toEqual(expect.objectContaining({
      kind: 'class',
      name: 'WidgetAction',
      signature: 'data class WidgetAction',
      startLine: 7,
      endLine: 10,
      metadata: expect.objectContaining({
        modifiers: expect.arrayContaining(['data']),
      }),
    }));
    expect(resultNode).toEqual(expect.objectContaining({
      kind: 'class',
      name: 'WidgetDispatchResult',
      signature: 'sealed class WidgetDispatchResult',
      startLine: 12,
      endLine: 12,
      isAbstract: true,
      metadata: expect.objectContaining({
        modifiers: expect.arrayContaining(['sealed']),
      }),
    }));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'implements',
        source: handlerNode.id,
        target: interfaceNode.id,
        line: 14,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-implements',
          typeName: 'WidgetActionDispatcher',
        }),
      }),
    ]));
    expect(response.relationshipGroups.implements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'WidgetActionHandler',
        target: 'WidgetActionDispatcher',
        relation: 'android-kotlin-implements',
      }),
    ]));
    expect(response.markdown).toContain('interface WidgetActionDispatcher');
    expect(response.markdown).toContain('class WidgetActionHandler : WidgetActionDispatcher');

    const nativeResult = queryOverlay(
      root,
      'WidgetActionDispatcher WidgetActionHandler dispatch',
      ['--limit', '60', '--native-json'],
    );
    expectSpawnSuccess(nativeResult);
    const nativeResponse = JSON.parse(nativeResult.stdout);
    expect(nativeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'interface',
        name: 'WidgetActionDispatcher',
        filePath: interfacePath,
        language: 'kotlin',
      }),
      expect.objectContaining({
        kind: 'class',
        name: 'WidgetActionHandler',
        filePath: interfacePath,
        language: 'kotlin',
      }),
    ]));
    expect(nativeResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'implements',
        source: handlerNode.id,
        target: interfaceNode.id,
      }),
    ]));
    expect(nativeResponse.nodes.every((node: Record<string, unknown>) => !('metadata' in node))).toBe(true);
    expect(nativeResponse.edges.every((edge: Record<string, unknown>) => !('metadata' in edge))).toBe(true);
    expect(nativeResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: interfacePath,
        language: 'kotlin',
        nodeName: 'WidgetActionDispatcher',
        nodeKind: 'interface',
        content: expect.stringContaining('interface WidgetActionDispatcher'),
      }),
      expect.objectContaining({
        filePath: interfacePath,
        language: 'kotlin',
        nodeName: 'WidgetActionHandler',
        nodeKind: 'class',
        content: expect.stringContaining('class WidgetActionHandler : WidgetActionDispatcher'),
      }),
    ]));
  });

  registerCodegraphOverlayAndroidEdgeQuerySpecs(context);
  registerCodegraphOverlayAndroidCompanionQuerySpecs(context);
  registerCodegraphOverlayAndroidAnnotationQuerySpecs(context);
}
