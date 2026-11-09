import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayAndroidEdgeQuerySpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, writeFile, queryOverlay, expectSpawnSuccess } = context;

  it('projects Android Kotlin overrides and type references as native edge context', () => {
    const root = makeFixture();
    const receiverPath = 'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt';

    writeFile(
      root,
      receiverPath,
      [
        'package app.nanoflow.host',
        '',
        'import android.appwidget.AppWidgetManager',
        'import android.appwidget.AppWidgetProvider',
        'import android.content.Context',
        'import android.widget.RemoteViews',
        '',
        'class NanoflowWidgetReceiver(',
        '  private val context: Context,',
        '  private val views: RemoteViews,',
        ') : AppWidgetProvider() {',
        '  override fun onUpdate(',
        '    context: Context,',
        '    appWidgetManager: AppWidgetManager,',
        '    appWidgetIds: IntArray,',
        '  ): Unit {',
        '    views.setTextViewText(1, appWidgetIds.size.toString())',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      'android-kotlin-override android-kotlin-type-reference NanoflowWidgetReceiver onUpdate AppWidgetManager RemoteViews',
      ['--limit', '80'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const onUpdateNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'method' && node.name === 'onUpdate'
    ));
    const viewsNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'property' && node.name === 'views'
    ));
    const appWidgetManagerNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'variable' && node.name === 'android.appwidget.AppWidgetManager'
    ));
    const remoteViewsNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'variable' && node.name === 'android.widget.RemoteViews'
    ));
    const overrideTargetNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'variable' && node.name === 'android.appwidget.AppWidgetProvider::onUpdate'
    ));

    expect(onUpdateNode).toEqual(expect.objectContaining({
      kind: 'method',
      name: 'onUpdate',
      filePath: receiverPath,
      language: 'kotlin',
      signature: expect.stringContaining('override fun onUpdate'),
    }));
    expect(viewsNode).toEqual(expect.objectContaining({
      kind: 'property',
      name: 'views',
      filePath: receiverPath,
      language: 'kotlin',
    }));
    expect(appWidgetManagerNode).toEqual(expect.objectContaining({
      kind: 'variable',
      name: 'android.appwidget.AppWidgetManager',
      filePath: receiverPath,
      language: 'kotlin',
    }));
    expect(remoteViewsNode).toEqual(expect.objectContaining({
      kind: 'variable',
      name: 'android.widget.RemoteViews',
      filePath: receiverPath,
      language: 'kotlin',
    }));
    expect(overrideTargetNode).toEqual(expect.objectContaining({
      kind: 'variable',
      name: 'android.appwidget.AppWidgetProvider::onUpdate',
      filePath: receiverPath,
      language: 'kotlin',
    }));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'overrides',
        source: onUpdateNode.id,
        target: overrideTargetNode.id,
        line: 12,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-override',
          memberName: 'onUpdate',
          targetName: 'android.appwidget.AppWidgetProvider::onUpdate',
        }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        source: viewsNode.id,
        target: remoteViewsNode.id,
        line: 10,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-type-reference',
          typeName: 'RemoteViews',
          targetName: 'android.widget.RemoteViews',
          typeRole: 'property',
        }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        source: onUpdateNode.id,
        target: appWidgetManagerNode.id,
        line: 14,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-type-reference',
          typeName: 'AppWidgetManager',
          targetName: 'android.appwidget.AppWidgetManager',
          typeRole: 'parameter',
          parameterName: 'appWidgetManager',
        }),
      }),
    ]));
    expect(response.relationshipGroups.overrides).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'onUpdate',
        target: 'android.appwidget.AppWidgetProvider::onUpdate',
        relation: 'android-kotlin-override',
      }),
    ]));
    expect(response.relationshipGroups.type_of).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'views',
        target: 'android.widget.RemoteViews',
        relation: 'android-kotlin-type-reference',
      }),
      expect.objectContaining({
        source: 'onUpdate',
        target: 'android.appwidget.AppWidgetManager',
        relation: 'android-kotlin-type-reference',
      }),
    ]));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: receiverPath,
      language: 'kotlin',
      nodeName: 'onUpdate',
      nodeKind: 'method',
      content: expect.stringContaining('override fun onUpdate'),
    }));
    expect(response.markdown).toContain('override fun onUpdate');
    expect(response.markdown).toContain('private val views: RemoteViews');

    const nativeResult = queryOverlay(
      root,
      'android-kotlin-override android-kotlin-type-reference NanoflowWidgetReceiver onUpdate AppWidgetManager RemoteViews',
      ['--limit', '80', '--native-json'],
    );
    expectSpawnSuccess(nativeResult);
    const nativeResponse = JSON.parse(nativeResult.stdout);
    expect(nativeResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'overrides',
        source: onUpdateNode.id,
        target: overrideTargetNode.id,
      }),
      expect.objectContaining({
        kind: 'type_of',
        source: viewsNode.id,
        target: remoteViewsNode.id,
      }),
      expect.objectContaining({
        kind: 'type_of',
        source: onUpdateNode.id,
        target: appWidgetManagerNode.id,
      }),
    ]));
    expect(nativeResponse.nodes.every((node: Record<string, unknown>) => !('metadata' in node))).toBe(true);
    expect(nativeResponse.edges.every((edge: Record<string, unknown>) => !('metadata' in edge))).toBe(true);
    expect(nativeResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: receiverPath,
      language: 'kotlin',
      nodeName: 'onUpdate',
      nodeKind: 'method',
      content: expect.stringContaining('override fun onUpdate'),
    }));
  });

  it('projects Android Kotlin top-level functions as native function context', () => {
    const root = makeFixture();
    const rendererPath = 'android/app/src/main/java/app/nanoflow/host/WidgetRenderer.kt';

    writeFile(
      root,
      rendererPath,
      [
        'package app.nanoflow.host',
        '',
        'import android.content.Context',
        'import android.widget.RemoteViews',
        '',
        'fun createWidgetViews(context: Context): RemoteViews = RemoteViews("app.nanoflow", 1)',
        '',
        'class WidgetRenderer {',
        '  fun render(context: Context): RemoteViews = createWidgetViews(context)',
        '}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      'createWidgetViews WidgetRenderer RemoteViews Context',
      ['--limit', '80'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const functionNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'function' && node.name === 'createWidgetViews'
    ));
    const renderNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'method' && node.name === 'render'
    ));
    const contextNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'variable' && node.name === 'android.content.Context'
    ));
    const remoteViewsNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'variable' && node.name === 'android.widget.RemoteViews'
    ));

    expect(functionNode).toEqual(expect.objectContaining({
      kind: 'function',
      name: 'createWidgetViews',
      qualifiedName: 'app.nanoflow.host.createWidgetViews',
      filePath: rendererPath,
      language: 'kotlin',
      startLine: 6,
      endLine: 6,
      signature: 'fun createWidgetViews(context: Context): RemoteViews',
      returnType: 'RemoteViews',
      metadata: expect.objectContaining({
        relation: 'android-kotlin-function',
        packageName: 'app.nanoflow.host',
      }),
    }));
    expect(renderNode).toEqual(expect.objectContaining({
      kind: 'method',
      name: 'render',
      filePath: rendererPath,
      language: 'kotlin',
    }));
    expect(contextNode).toEqual(expect.objectContaining({
      kind: 'variable',
      name: 'android.content.Context',
      filePath: rendererPath,
      language: 'kotlin',
    }));
    expect(remoteViewsNode).toEqual(expect.objectContaining({
      kind: 'variable',
      name: 'android.widget.RemoteViews',
      filePath: rendererPath,
      language: 'kotlin',
    }));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        target: functionNode.id,
        line: 6,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-function',
          functionName: 'createWidgetViews',
        }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        source: functionNode.id,
        target: contextNode.id,
        line: 6,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-type-reference',
          typeName: 'Context',
          targetName: 'android.content.Context',
          typeRole: 'parameter',
          parameterName: 'context',
        }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        source: functionNode.id,
        target: remoteViewsNode.id,
        line: 6,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-type-reference',
          typeName: 'RemoteViews',
          targetName: 'android.widget.RemoteViews',
          typeRole: 'return',
        }),
      }),
      expect.objectContaining({
        kind: 'calls',
        source: renderNode.id,
        target: functionNode.id,
        line: 9,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-call',
          callName: 'createWidgetViews',
        }),
      }),
    ]));
    expect(response.relationshipGroups.type_of).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'createWidgetViews',
        target: 'android.content.Context',
        relation: 'android-kotlin-type-reference',
      }),
      expect.objectContaining({
        source: 'createWidgetViews',
        target: 'android.widget.RemoteViews',
        relation: 'android-kotlin-type-reference',
      }),
    ]));
    expect(response.relationshipGroups.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'render',
        target: 'createWidgetViews',
        relation: 'android-kotlin-call',
      }),
    ]));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: rendererPath,
      language: 'kotlin',
      nodeName: 'createWidgetViews',
      nodeKind: 'function',
      content: expect.stringContaining('fun createWidgetViews(context: Context): RemoteViews'),
    }));
    expect(response.markdown).toContain('fun createWidgetViews(context: Context): RemoteViews');

    const nativeResult = queryOverlay(
      root,
      'createWidgetViews WidgetRenderer RemoteViews Context',
      ['--limit', '80', '--native-json'],
    );
    expectSpawnSuccess(nativeResult);
    const nativeResponse = JSON.parse(nativeResult.stdout);
    expect(nativeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'function',
        name: 'createWidgetViews',
        filePath: rendererPath,
        language: 'kotlin',
      }),
    ]));
    expect(nativeResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_of',
        source: functionNode.id,
        target: contextNode.id,
      }),
      expect.objectContaining({
        kind: 'type_of',
        source: functionNode.id,
        target: remoteViewsNode.id,
      }),
      expect.objectContaining({
        kind: 'calls',
        source: renderNode.id,
        target: functionNode.id,
      }),
    ]));
    expect(nativeResponse.nodes.every((node: Record<string, unknown>) => !('metadata' in node))).toBe(true);
    expect(nativeResponse.edges.every((edge: Record<string, unknown>) => !('metadata' in edge))).toBe(true);
    expect(nativeResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: rendererPath,
      language: 'kotlin',
      nodeName: 'createWidgetViews',
      nodeKind: 'function',
      content: expect.stringContaining('fun createWidgetViews(context: Context): RemoteViews'),
    }));
  });

  it('keeps Android Kotlin multiline top-level function signatures through default parameter calls', () => {
    const root = makeFixture();
    const rendererPath = 'android/app/src/main/java/app/nanoflow/host/WidgetOptimisticPatch.kt';

    writeFile(
      root,
      rendererPath,
      [
        'package app.nanoflow.host',
        '',
        'import java.time.Instant',
        '',
        'data class WidgetBlackBoxSummary(val id: String)',
        'data class WidgetGatePreview(val id: String)',
        'enum class BlackBoxEntryAction { Open }',
        'data class WidgetBlackBoxOptimisticPatch(val entryId: String)',
        '',
        'internal fun buildOptimisticBlackBoxActionPatch(',
        '  blackBox: WidgetBlackBoxSummary,',
        '  entryId: String,',
        '  action: BlackBoxEntryAction,',
        '  gateEntries: List<WidgetGatePreview>,',
        '  selectedGateIndex: Int,',
        '  previousSelectedEntryId: String?,',
        '  now: Instant = Instant.now(),',
        '): WidgetBlackBoxOptimisticPatch? {',
        '  return WidgetBlackBoxOptimisticPatch(entryId)',
        '}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      'buildOptimisticBlackBoxActionPatch WidgetBlackBoxOptimisticPatch Instant',
      ['--limit', '80'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const functionNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'function' && node.name === 'buildOptimisticBlackBoxActionPatch'
    ));
    const returnTypeNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'class' && node.name === 'WidgetBlackBoxOptimisticPatch'
    ));
    const instantNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'variable' && node.name === 'java.time.Instant'
    ));

    expect(functionNode).toEqual(expect.objectContaining({
      kind: 'function',
      name: 'buildOptimisticBlackBoxActionPatch',
      filePath: rendererPath,
      language: 'kotlin',
      startLine: 10,
      endLine: 20,
      signature: [
        'internal fun buildOptimisticBlackBoxActionPatch(',
        'blackBox: WidgetBlackBoxSummary,',
        'entryId: String,',
        'action: BlackBoxEntryAction,',
        'gateEntries: List<WidgetGatePreview>,',
        'selectedGateIndex: Int,',
        'previousSelectedEntryId: String?,',
        'now: Instant = Instant.now(),',
        '): WidgetBlackBoxOptimisticPatch?',
      ].join(' '),
      returnType: 'WidgetBlackBoxOptimisticPatch',
    }));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type_of',
        source: functionNode.id,
        target: returnTypeNode.id,
        line: 18,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-type-reference',
          typeName: 'WidgetBlackBoxOptimisticPatch',
          typeRole: 'return',
        }),
      }),
      expect.objectContaining({
        kind: 'type_of',
        source: functionNode.id,
        target: instantNode.id,
        line: 17,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-type-reference',
          typeName: 'Instant',
          targetName: 'java.time.Instant',
          typeRole: 'parameter',
          parameterName: 'now',
        }),
      }),
    ]));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: rendererPath,
      language: 'kotlin',
      nodeName: 'buildOptimisticBlackBoxActionPatch',
      nodeKind: 'function',
      content: expect.stringContaining('): WidgetBlackBoxOptimisticPatch? {'),
    }));
    expect(response.markdown).toContain('now: Instant = Instant.now(),');
    expect(response.markdown).toContain('): WidgetBlackBoxOptimisticPatch? {');
  });

  it('projects Android Manifest permissions queries intent filters and Kotlin resources as native references', () => {
    const root = makeFixture();
    const manifestPath = 'android/app/src/main/AndroidManifest.xml';
    const receiverPath = 'android/app/src/main/java/app/nanoflow/host/NanoflowWidgetReceiver.kt';
    const layoutPath = 'android/app/src/main/res/layout/nanoflow_widget_compact.xml';
    const drawablePath = 'android/app/src/main/res/drawable/nanoflow_widget_background.xml';
    const stringsPath = 'android/app/src/main/res/values/strings.xml';

    writeFile(root, manifestPath, [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="app.nanoflow">',
      '  <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
      '  <queries>',
      '    <package android:name="com.example.calendar" />',
      '    <intent>',
      '      <action android:name="android.intent.action.VIEW" />',
      '      <category android:name="android.intent.category.BROWSABLE" />',
      '      <data android:scheme="https" android:host="nanoflow.app" />',
      '    </intent>',
      '  </queries>',
      '  <application android:label="NanoFlow">',
      '    <receiver',
      '      android:name=".host.NanoflowWidgetReceiver"',
      '      android:permission="android.permission.BIND_APPWIDGET"',
      '      android:exported="false">',
      '      <intent-filter>',
      '        <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />',
      '        <category android:name="android.intent.category.DEFAULT" />',
      '        <data android:scheme="nanoflow" android:host="widget" />',
      '      </intent-filter>',
      '    </receiver>',
      '  </application>',
      '</manifest>',
      '',
    ].join('\n'));
    writeFile(root, receiverPath, [
      'package app.nanoflow.host',
      '',
      'class NanoflowWidgetReceiver {',
      '  val title = R.string.nanoflow_widget_title',
      '  val layout = R.layout.nanoflow_widget_compact',
      '  val background = R.drawable.nanoflow_widget_background',
      '  val titleView = R.id.widget_title',
      '  val secondaryView = R.id.secondary_widget_action',
      '  val missingView = R.id.missing_widget',
      '  val platformContent = android.R.id.content',
      '  val debugLayout = "R.layout.nanoflow_widget_compact"',
      '  // R.drawable.nanoflow_widget_background is documentation only.',
      '}',
      '',
    ].join('\n'));
    writeFile(root, layoutPath, [
      '<TextView xmlns:android="http://schemas.android.com/apk/res/android"',
      '  android:id="@+id/widget_title"',
      '  android:background="@drawable/nanoflow_widget_background"',
      '  android:layout_width="match_parent"',
      '  android:layout_height="wrap_content" />',
      '',
    ].join('\n'));
    writeFile(root, drawablePath, [
      '<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle" />',
      '',
    ].join('\n'));
    writeFile(root, stringsPath, [
      '<resources>',
      '  <string name="nanoflow_widget_title">NanoFlow</string>',
      '  <item type="id" name="secondary_widget_action" />',
      '</resources>',
      '',
    ].join('\n'));

    const result = queryOverlay(root, [
      'android-manifest-uses-permission',
      'android-manifest-query',
      'android-manifest-component-permission',
      'android-manifest-intent-filter-action',
      'android-manifest-intent-filter-category',
      'android-manifest-intent-filter-data',
      'android-kotlin-resource-reference',
    ].join(' '), ['--limit', '120']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'android-manifest-uses-permission',
          permission: 'android.permission.POST_NOTIFICATIONS',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'android-manifest-query',
          queryType: 'package',
          queryValue: 'com.example.calendar',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'android-manifest-query',
          queryType: 'intent',
          queryValue: 'android.intent.action.VIEW',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'android-manifest-component-permission',
          permission: 'android.permission.BIND_APPWIDGET',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'android-manifest-intent-filter-action',
          action: 'android.appwidget.action.APPWIDGET_UPDATE',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'android-manifest-intent-filter-category',
          category: 'android.intent.category.DEFAULT',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        metadata: expect.objectContaining({
          relation: 'android-manifest-intent-filter-data',
          scheme: 'nanoflow',
          host: 'widget',
        }),
      }),
    ]));
    const kotlinResourceEdges = response.edges.filter((edge: {
      metadata?: { relation?: string };
    }) => edge.metadata?.relation === 'android-kotlin-resource-reference');
    expect(kotlinResourceEdges.map((edge: {
      metadata: { resourceType: string; resourceName: string };
    }) => `${edge.metadata.resourceType}/${edge.metadata.resourceName}`).sort()).toEqual([
      'drawable/nanoflow_widget_background',
      'id/secondary_widget_action',
      'id/widget_title',
      'layout/nanoflow_widget_compact',
      'string/nanoflow_widget_title',
    ]);
    expect(kotlinResourceEdges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.objectContaining({
          resourceType: 'id',
          resourceName: 'content',
        }),
      }),
    ]));
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'file', filePath: receiverPath, language: 'kotlin' }),
      expect.objectContaining({ kind: 'file', filePath: layoutPath, language: 'xml' }),
      expect.objectContaining({ kind: 'file', filePath: drawablePath, language: 'xml' }),
      expect.objectContaining({ kind: 'file', filePath: stringsPath, language: 'xml' }),
    ]));
    expect(response.coverage).toEqual(expect.objectContaining({
      androidManifestPermissions: 1,
      androidManifestUsesPermissionEdges: 1,
      androidManifestQueries: 2,
      androidManifestQueryEdges: 2,
      androidManifestComponentPermissions: 1,
      androidManifestComponentPermissionEdges: 1,
      androidManifestIntentFilters: 1,
      androidManifestIntentFilterActions: 1,
      androidManifestIntentFilterActionEdges: 1,
      androidManifestIntentFilterCategories: 1,
      androidManifestIntentFilterCategoryEdges: 1,
      androidManifestIntentFilterData: 1,
      androidManifestIntentFilterDataEdges: 1,
      androidKotlinResourceReferences: 5,
      androidKotlinResourceReferenceEdges: 5,
    }));
  });
}
