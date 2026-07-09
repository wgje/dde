import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayAndroidAnnotationQuerySpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, writeFile, queryOverlay, expectSpawnSuccess } = context;

  it('projects Android Kotlin annotations as native decorator context', () => {
    const root = makeFixture();
    const annotatedPath = 'android/app/src/main/java/app/nanoflow/host/WidgetAnnotatedModels.kt';

    writeFile(
      root,
      annotatedPath,
      [
        'package app.nanoflow.host',
        '',
        'import kotlinx.serialization.SerialName',
        'import kotlinx.serialization.Serializable',
        'import org.junit.Test',
        '',
        '@Serializable',
        'data class WidgetEarlierAnnotatedAction(',
        '  val ignored: String,',
        ')',
        '',
        '@Serializable',
        'data class WidgetAnnotatedAction(',
        '  @SerialName("action_name")',
        '  val actionName: String,',
        ')',
        '',
        'class WidgetAnnotatedActionTest {',
        '  @Test',
        '  fun encodesAnnotatedAction(): Boolean = WidgetAnnotatedAction("open").actionName.isNotBlank()',
        '}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(root, 'Serializable SerialName Test WidgetAnnotatedAction encodesAnnotatedAction', ['--limit', '80']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const actionNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'class' && node.name === 'WidgetAnnotatedAction'
    ));
    const propertyNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'property' && node.name === 'actionName'
    ));
    const methodNode = response.nodes.find((node: { kind?: string; name?: string }) => (
      node.kind === 'method' && node.name === 'encodesAnnotatedAction'
    ));

    expect(actionNode).toEqual(expect.objectContaining({
      decorators: ['Serializable'],
      metadata: expect.objectContaining({
        annotationNames: ['Serializable'],
      }),
    }));
    expect(propertyNode).toEqual(expect.objectContaining({
      decorators: ['SerialName'],
      metadata: expect.objectContaining({
        annotationNames: ['SerialName'],
      }),
    }));
    expect(methodNode).toEqual(expect.objectContaining({
      decorators: ['Test'],
      metadata: expect.objectContaining({
        annotationNames: ['Test'],
      }),
    }));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'decorates',
        source: actionNode.id,
        line: 12,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-annotation',
          annotationName: 'Serializable',
        }),
      }),
      expect.objectContaining({
        kind: 'decorates',
        source: propertyNode.id,
        line: 14,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-annotation',
          annotationName: 'SerialName',
        }),
      }),
      expect.objectContaining({
        kind: 'decorates',
        source: methodNode.id,
        line: 19,
        metadata: expect.objectContaining({
          relation: 'android-kotlin-annotation',
          annotationName: 'Test',
        }),
      }),
    ]));
    expect(response.relationshipGroups.decorates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'WidgetAnnotatedAction',
        target: 'Serializable',
        relation: 'android-kotlin-annotation',
      }),
      expect.objectContaining({
        source: 'actionName',
        target: 'SerialName',
        relation: 'android-kotlin-annotation',
      }),
      expect.objectContaining({
        source: 'encodesAnnotatedAction',
        target: 'Test',
        relation: 'android-kotlin-annotation',
      }),
    ]));
    expect(response.markdown).toContain('@Serializable');
    expect(response.markdown).toContain('@SerialName("action_name")');

    const nativeResult = queryOverlay(
      root,
      'android-kotlin-annotation Serializable SerialName Test WidgetAnnotatedAction',
      ['--limit', '80', '--native-json'],
    );
    expectSpawnSuccess(nativeResult);
    const nativeResponse = JSON.parse(nativeResult.stdout);
    expect(nativeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'class',
        name: 'WidgetAnnotatedAction',
      }),
      expect.objectContaining({
        kind: 'property',
        name: 'actionName',
      }),
      expect.objectContaining({
        kind: 'method',
        name: 'encodesAnnotatedAction',
      }),
    ]));
    expect(nativeResponse.nodes.every((node: Record<string, unknown>) => !('metadata' in node))).toBe(true);
    expect(nativeResponse.nodes.every((node: Record<string, unknown>) => !('decorators' in node))).toBe(true);
    expect(nativeResponse.edges.every((edge: Record<string, unknown>) => !('metadata' in edge))).toBe(true);
    expect(nativeResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'decorates',
        line: 12,
      }),
      expect.objectContaining({
        kind: 'decorates',
        line: 14,
      }),
      expect.objectContaining({
        kind: 'decorates',
        line: 19,
      }),
    ]));
    expect(nativeResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: annotatedPath,
      nodeName: 'WidgetAnnotatedAction',
      nodeKind: 'class',
    }));
    expect(nativeResponse.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeKind: 'variable',
        nodeName: expect.stringMatching(/^(Serializable|SerialName|Test)$/),
      }),
    ]));
    expect(nativeResponse.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: annotatedPath,
        language: 'kotlin',
        nodeName: 'WidgetAnnotatedAction',
        nodeKind: 'class',
        content: expect.stringContaining('@Serializable'),
      }),
      expect.objectContaining({
        filePath: annotatedPath,
        language: 'kotlin',
        nodeName: 'actionName',
        nodeKind: 'property',
        content: expect.stringContaining('@SerialName("action_name")'),
      }),
    ]));
  });
}
