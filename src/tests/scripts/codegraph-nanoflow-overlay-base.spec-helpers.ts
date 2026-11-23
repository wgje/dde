import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { assertBaseOverlayAngularAndGraph } from './codegraph-nanoflow-overlay-base-assertions.spec-helpers';
import { assertBaseOverlaySupabaseAndRules } from './codegraph-nanoflow-overlay-base-supabase-assertions.spec-helpers';

const requireCjs = createRequire(import.meta.url);

export function registerCodegraphOverlayBaseSpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, runOverlay, expectSpawnSuccess } = context;

  it('validates aliased decorator IO and canonical node metadata through the streaming schema', () => {
    const root = makeFixture();
    context.writeFile(
      root,
      'src/app/features/sample/sample.component.ts',
      [
        "import { Component, EventEmitter, Input, Output } from '@angular/core';",
        '',
        '@Component({',
        "  selector: 'app-sample',",
        '  standalone: true,',
        "  template: '<div>{{ legacyName }}</div>',",
        '})',
        'export class SampleComponent {',
        "  @Input('externalLabel') legacyName = '';",
        "  @Output('externalSaved') legacySaved = new EventEmitter<void>();",
        '}',
        '',
      ].join('\n'),
    );

    const result = runOverlay(root);
    expectSpawnSuccess(result);
    const overlay = JSON.parse(result.stdout);

    const collisionNode = overlay.graph.nodes.find((node: { metadata?: { relation?: string; sourcePath?: string } }) =>
      node.metadata?.relation === 'context7-source-path'
      && node.metadata?.sourcePath
      && Object.keys(node.metadata).sort().join('\0') === ['relation', 'source', 'sourcePath'].sort().join('\0'));
    expect(collisionNode).toBeTruthy();
    expect(Object.keys(collisionNode.metadata)).toEqual(['relation', 'source', 'sourcePath']);
    const graphSchema = requireCjs(path.join(context.repoRoot, 'scripts/lib/codegraph-nanoflow-overlay-v1-schema-graph.cjs'));
    const collisionOrders = new Map(graphSchema.nodeMetadataOrders).get('context7-source-path');
    expect(collisionOrders).toContainEqual(['relation', 'source', 'sourcePath']);

    const component = overlay.angular.components.find(
      (item: { className?: string }) => item.className === 'SampleComponent',
    );
    const input = component.inputs.find((item: { api?: string }) => item.api === '@Input');
    const output = component.outputs.find((item: { api?: string }) => item.api === '@Output');
    expect(input).toEqual({ name: 'legacyName', api: '@Input', line: expect.any(Number) });
    expect(output).toEqual({ name: 'legacySaved', api: '@Output', line: expect.any(Number) });
    expect(input).not.toHaveProperty('alias');
    expect(output).not.toHaveProperty('alias');

    const inputEdge = overlay.graph.edges.find((edge: { source?: string; target?: string; metadata?: { relation?: string } }) =>
      edge.source === 'class:src/app/features/sample/sample.component.ts:SampleComponent'
      && edge.target === 'property:src/app/features/sample/sample.component.ts:SampleComponent.legacyName'
      && edge.metadata?.relation === 'input');
    const outputEdge = overlay.graph.edges.find((edge: { source?: string; target?: string; metadata?: { relation?: string } }) =>
      edge.source === 'class:src/app/features/sample/sample.component.ts:SampleComponent'
      && edge.target === 'property:src/app/features/sample/sample.component.ts:SampleComponent.legacySaved'
      && edge.metadata?.relation === 'output');
    expect(inputEdge?.metadata).toEqual({ relation: 'input', api: '@Input' });
    expect(outputEdge?.metadata).toEqual({ relation: 'output', api: '@Output' });

    const schema = requireCjs(path.join(context.repoRoot, 'scripts/lib/codegraph-nanoflow-overlay-v1-schema.cjs'));
    const sourcePolicy = requireCjs(path.join(context.repoRoot, 'scripts/lib/codegraph-source-policy.cjs'));
    const validator = schema.createOverlayV1Validator({
      expectedProjectRoot: root.replace(/\\/g, '/'),
      expectedSourcePolicyDigest: sourcePolicy.SOURCE_POLICY_DIGEST,
    });
    const bytes = Buffer.from(`${JSON.stringify(overlay, null, 2)}\n`, 'utf8');
    for (let offset = 0; offset < bytes.length; offset += 65_536) {
      validator.write(bytes.subarray(offset, Math.min(bytes.length, offset + 65_536)));
    }
    expect(() => validator.finish()).not.toThrow();
  });

  it('emits NanoFlow-specific relationships that base codegraph misses', () => {
    const root = makeFixture();

    const result = runOverlay(root);

    expectSpawnSuccess(result);
    const overlay = JSON.parse(result.stdout);
    assertBaseOverlayAngularAndGraph(overlay, root);
    assertBaseOverlaySupabaseAndRules(overlay);
  });
}
