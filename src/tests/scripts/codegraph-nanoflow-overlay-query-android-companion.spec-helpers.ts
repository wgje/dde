import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayAndroidCompanionQuerySpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, writeFile, queryOverlay, expectSpawnSuccess } = context;

  it('projects Android Kotlin companion objects as native nested owner context', () => {
    const root = makeFixture();
    const companionPath = 'android/app/src/main/java/app/nanoflow/host/WidgetLaunchBridge.kt';

    writeFile(
      root,
      companionPath,
      [
        'package app.nanoflow.host',
        '',
        'class WidgetLaunchBridge {',
        '  companion object Factory {',
        '    const val ROUTE = "widget"',
        '',
        '    fun open(): String = ROUTE',
        '  }',
        '',
        '  fun launch(): String = Factory.open()',
        '}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(root, 'WidgetLaunchBridge Factory open ROUTE', ['--limit', '60']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const ownerNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'class' && node.name === 'WidgetLaunchBridge'
    ));
    const companionNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'class' && node.name === 'Factory'
    ));
    const routeNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'property' && node.name === 'ROUTE'
    ));
    const openNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'method' && node.name === 'open'
    ));
    expect(ownerNode).toEqual(expect.objectContaining({
      kind: 'class',
      name: 'WidgetLaunchBridge',
      qualifiedName: 'app.nanoflow.host.WidgetLaunchBridge',
      filePath: companionPath,
      language: 'kotlin',
    }));
    expect(companionNode).toEqual(expect.objectContaining({
      kind: 'class',
      name: 'Factory',
      qualifiedName: 'app.nanoflow.host.WidgetLaunchBridge::Factory',
      filePath: companionPath,
      language: 'kotlin',
      startLine: 4,
      endLine: 8,
      signature: 'companion object Factory',
      metadata: expect.objectContaining({
        relation: 'android-kotlin-companion-object',
        classKind: 'object',
        ownerName: 'WidgetLaunchBridge',
        ownerQualifiedName: 'app.nanoflow.host.WidgetLaunchBridge',
      }),
    }));
    expect(routeNode).toEqual(expect.objectContaining({
      kind: 'property',
      name: 'ROUTE',
      qualifiedName: 'app.nanoflow.host.WidgetLaunchBridge::Factory::ROUTE',
      isStatic: true,
    }));
    expect(openNode).toEqual(expect.objectContaining({
      kind: 'method',
      name: 'open',
      qualifiedName: 'app.nanoflow.host.WidgetLaunchBridge::Factory::open',
      isStatic: true,
    }));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        source: companionNode.id,
        target: routeNode.id,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-property',
          ownerName: 'Factory',
          propertyName: 'ROUTE',
        }),
      }),
      expect.objectContaining({
        kind: 'contains',
        source: companionNode.id,
        target: openNode.id,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-method',
          ownerName: 'Factory',
          methodName: 'open',
        }),
      }),
    ]));
    const relationResult = queryOverlay(root, 'android-kotlin-companion-object WidgetLaunchBridge Factory', ['--limit', '60']);
    expectSpawnSuccess(relationResult);
    const relationResponse = JSON.parse(relationResult.stdout);
    expect(relationResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'contains',
        source: ownerNode.id,
        target: companionNode.id,
        line: 4,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-companion-object',
          ownerName: 'WidgetLaunchBridge',
          objectName: 'Factory',
        }),
      }),
    ]));
    expect(response.markdown).toContain('companion object Factory');
    expect(response.markdown).toContain('const val ROUTE = "widget"');

    const nativeResult = queryOverlay(root, 'WidgetLaunchBridge Factory open ROUTE', ['--limit', '60', '--native-json']);
    expectSpawnSuccess(nativeResult);
    const nativeResponse = JSON.parse(nativeResult.stdout);
    expect(nativeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'class',
        name: 'Factory',
        qualifiedName: 'app.nanoflow.host.WidgetLaunchBridge::Factory',
        filePath: companionPath,
        language: 'kotlin',
        signature: 'companion object Factory',
      }),
      expect.objectContaining({
        kind: 'property',
        name: 'ROUTE',
        filePath: companionPath,
        language: 'kotlin',
        isStatic: true,
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'open',
        filePath: companionPath,
        language: 'kotlin',
        isStatic: true,
      }),
    ]));
    expect(nativeResponse.nodes.every((node: Record<string, unknown>) => !('metadata' in node))).toBe(true);
    expect(nativeResponse.edges.every((edge: Record<string, unknown>) => !('metadata' in edge))).toBe(true);
    expect(nativeResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: companionPath,
        language: 'kotlin',
        content: expect.stringContaining('companion object Factory'),
      }),
    ]));
  });
}
