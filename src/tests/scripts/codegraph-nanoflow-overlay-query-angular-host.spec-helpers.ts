import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayAngularHostQuerySpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const {
    makeFixture,
    tempRoots,
    writeFile,
    runOverlay,
    queryOverlay,
    expectSpawnSuccess,
    repoRoot,
    queryScriptPath,
  } = context;
  const queryNativeMarkdown = (root: string, query: string) => spawnSync(process.execPath, [
    queryScriptPath,
    '--root',
    root,
    '--query',
    query,
    '--limit',
    '20',
    '--native-markdown',
    '--skip-refresh',
  ], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });

  it('queries Angular host directive composition as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'host-directive', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'class', name: 'SampleComponent' }),
      expect.objectContaining({ kind: 'class', name: 'SampleHostDirective' }),
      expect.objectContaining({ kind: 'class', name: 'SampleBehaviorDirective' }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'class:src/app/features/sample/sample-host.directive.ts:SampleHostDirective',
        metadata: expect.objectContaining({
          relation: 'host-directive',
          inputs: [],
          outputs: [],
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'class:src/app/features/sample/sample-host.directive.ts:SampleBehaviorDirective',
        metadata: expect.objectContaining({
          relation: 'host-directive',
          inputs: ['mode: hostMode'],
          outputs: ['closed: hostClosed'],
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'SampleComponent',
        target: 'SampleBehaviorDirective',
        relation: 'host-directive',
      }),
    ]));
    expect(response.markdown).toContain('## Exploration: host-directive');
    expect(response.markdown).toContain('SampleComponent \u2192 SampleBehaviorDirective');
    expect(response.markdown).toContain('relation: host-directive');
  });

  it('uses hostDirectives metadata lines for strict native host directive code blocks', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'host-directive', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/features/sample/sample.component.ts',
      startLine: 12,
      endLine: 15,
      nodeKind: 'class',
      nodeName: 'SampleComponent',
      content: expect.stringContaining('hostDirectives: ['),
    }));
    expect(response.codeBlocks[0].content).toContain('SampleBehaviorDirective');
    expect(response.codeBlocks[0].content).toContain('hostClosed');
    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/app/features/sample/sample-host.directive.ts',
      }),
    ]));
  });

  it('uses hostDirectives metadata lines for strict native host directive Markdown code blocks', () => {
    const root = makeFixture();

    const result = queryNativeMarkdown(root, 'host-directive');

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('## Code Context');
    expect(result.stdout).toContain('### Entry Points');
    expect(result.stdout).toContain('### Relationships');
    expect(result.stdout).toContain('**references:**');
    expect(result.stdout).toContain('- SampleComponent -> SampleHostDirective');
    expect(result.stdout).toContain('- SampleComponent -> SampleBehaviorDirective');
    expect(result.stdout).toContain('### Related Symbols');
    expect(result.stdout).toContain('### Code');
    expect(result.stdout).toContain('#### SampleComponent (src/app/features/sample/sample.component.ts:12)');
    expect(result.stdout).toContain('hostDirectives: [');
    expect(result.stdout).toContain('SampleBehaviorDirective');
    expect(result.stdout).toContain('hostClosed');
    expect(result.stdout).not.toContain('#### SampleHostDirective (src/app/features/sample/sample-host.directive.ts');
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
    expect(result.stdout).not.toContain('relation: host-directive');
    expect(result.stdout).not.toContain('metadata');
    expect(result.stdout).not.toContain('provenance');
  });

  it('queries Angular host metadata object as focused native relationships', () => {
    const root = makeFixture();

    const attributeResult = queryOverlay(root, 'host-attribute', ['--limit', '20']);
    const listenerResult = queryOverlay(root, 'host-listener', ['--limit', '20']);

    expectSpawnSuccess(attributeResult);
    expectSpawnSuccess(listenerResult);
    const attributeResponse = JSON.parse(attributeResult.stdout);
    const listenerResponse = JSON.parse(listenerResult.stdout);

    expect(attributeResponse.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'class', name: 'SampleComponent' }),
      expect.objectContaining({
        kind: 'variable',
        name: 'role',
        filePath: 'src/app/features/sample/sample.component.ts',
        startLine: 17,
      }),
    ]));
    expect(attributeResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        target: 'variable:src/app/features/sample/sample.component.ts:role',
        metadata: expect.objectContaining({
          relation: 'host-attribute',
          api: 'host',
          attribute: 'role',
          value: 'slider',
        }),
      }),
    ]));
    expect(attributeResponse.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'SampleComponent',
        target: 'role',
        relation: 'host-attribute',
      }),
    ]));
    expect(attributeResponse.markdown).toContain('## Exploration: host-attribute');
    expect(attributeResponse.markdown).toContain('SampleComponent \u2192 role');
    expect(attributeResponse.markdown).toContain('relation: host-attribute');

    expect(listenerResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'calls',
        source: 'class:src/app/features/sample/sample.component.ts:SampleComponent',
        metadata: expect.objectContaining({
          relation: 'host-listener',
          api: 'host',
          event: 'keydown',
          expression: 'save($event)',
        }),
      }),
    ]));
  });

  it('uses host listener metadata lines for strict native host listener code blocks', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'keydown host-listener', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/features/sample/sample.component.ts',
      startLine: 20,
      endLine: 20,
      nodeKind: 'class',
      nodeName: 'SampleComponent',
      content: expect.stringContaining("'(keydown)': 'save($event)'"),
    }));
  });

  it('uses Angular host metadata lines for strict native host binding Markdown code blocks', () => {
    const root = makeFixture();

    const result = queryNativeMarkdown(root, 'host-binding');

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('## Code Context');
    expect(result.stdout).toContain('### Entry Points');
    expect(result.stdout).toContain('### Relationships');
    expect(result.stdout).toContain('**references:**');
    expect(result.stdout).toContain('- SampleComponent -> SampleComponent::active');
    expect(result.stdout).toContain('- SampleComponent -> SampleComponent::title');
    expect(result.stdout).toContain('### Related Symbols');
    expect(result.stdout).toContain('### Code');
    expect(result.stdout).toContain('#### SampleComponent (src/app/features/sample/sample.component.ts:19)');
    expect(result.stdout).toContain("'[class.active]': 'active'");
    expect(result.stdout).not.toContain('#### class.active (src/app/features/sample/sample.component.ts:19)');
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
    expect(result.stdout).not.toContain('relation: host-binding');
    expect(result.stdout).not.toContain('metadata');
    expect(result.stdout).not.toContain('provenance');
  });

  it('interleaves strict native code blocks for combined Angular host metadata queries', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'host-attribute/host-binding', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeName: 'SampleComponent',
        content: expect.stringContaining("role: 'slider'"),
      }),
      expect.objectContaining({
        nodeName: 'SampleComponent',
        content: expect.stringContaining("'[class.active]': 'active'"),
      }),
    ]));
    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/app/features/sample/sample.component.ts',
        startLine: 11,
        endLine: 21,
        nodeName: 'SampleComponent',
      }),
    ]));
  });

  it('keeps standalone host-attribute strict native code blocks limited to host metadata edge lines', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'host-attribute', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/app/features/sample/sample.component.ts',
        nodeName: 'SampleComponent',
        content: expect.stringContaining("role: 'slider'"),
      }),
    ]));
    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'src/app/features/sample/sample.component.ts',
        nodeName: 'SampleComponent',
        content: expect.stringContaining('@Component({'),
      }),
    ]));
  });

  it('keeps Angular providedIn decorator scope targets local to the injectable declaration', () => {
    const root = makeFixture();
    writeFile(
      root,
      'scripts/root-helper.mjs',
      [
        "const root = '/tmp/outside-angular';",
        'export { root };',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/features/sample/local-provider.service.ts',
      [
        "import { Injectable } from '@angular/core';",
        '',
        "@Injectable({ providedIn: 'root' })",
        'export class LocalProviderService {}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(root, 'providedIn', ['--limit', '40', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'variable',
        name: 'root',
        filePath: 'src/app/features/sample/local-provider.service.ts',
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'decorates',
        source: 'class:src/app/features/sample/local-provider.service.ts:LocalProviderService',
        target: 'variable:src/app/features/sample/local-provider.service.ts:root',
      }),
    ]));
    expect(response.edges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'constant:scripts/root-helper.mjs:root',
      }),
    ]));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/features/sample/local-provider.service.ts',
      nodeKind: 'class',
      nodeName: 'LocalProviderService',
      content: expect.stringContaining("@Injectable({ providedIn: 'root' })"),
    }));
  });

  it('prioritizes Angular host owners for attribute and binding relation code block budgets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-angular-host-budget-'));
    tempRoots.push(root);
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    const nodes = [];
    const edges = [];

    for (const [index, name] of names.entries()) {
      const className = `${name[0].toUpperCase()}${name.slice(1)}HostComponent`;
      const filePath = `src/app/features/host-budget/${name}-host.component.ts`;
      writeFile(
        root,
        filePath,
        [
          "import { Component } from '@angular/core';",
          '',
          '@Component({',
          `  selector: 'app-${name}-host',`,
          '  standalone: true,',
          '  host: {',
          `    'role': '${name}-region',`,
          `    '[class.${name}-active]': 'isActive()',`,
          '  },',
          `  template: '<p>${name}</p>',`,
          '})',
          `export class ${className} {`,
          '  isActive(): boolean {',
          '    return true;',
          '  }',
          '}',
          '',
        ].join('\n'),
      );
      const classNode = {
        id: `class:${filePath}:${className}`,
        kind: 'class',
        name: className,
        qualifiedName: className,
        filePath,
        language: 'typescript',
        startLine: 12,
        endLine: 16,
      };
      const attributeNode = {
        id: `variable:${filePath}:role:${index}`,
        kind: 'variable',
        name: 'role',
        qualifiedName: `${className}::role`,
        filePath,
        language: 'typescript',
        startLine: 7,
        endLine: 7,
      };
      const bindingNode = {
        id: `property:${filePath}:class.${name}-active:${index}`,
        kind: 'property',
        name: `class.${name}-active`,
        qualifiedName: `${className}::class.${name}-active`,
        filePath,
        language: 'typescript',
        startLine: 8,
        endLine: 8,
      };
      nodes.push(classNode, attributeNode, bindingNode);
      edges.push(
        {
          source: classNode.id,
          target: attributeNode.id,
          kind: 'references',
          line: 7,
          column: 5,
          metadata: {
            relation: 'host-attribute',
            api: 'host',
            attribute: 'role',
            value: `${name}-region`,
          },
        },
        {
          source: classNode.id,
          target: bindingNode.id,
          kind: 'references',
          line: 8,
          column: 5,
          metadata: {
            relation: 'host-binding',
            api: 'host',
            binding: `class.${name}-active`,
            expression: 'isActive()',
          },
        },
      );
    }

    writeHostBudgetOverlay(root, {
      files: names.map(name => `src/app/features/host-budget/${name}-host.component.ts`),
      nodes,
      edges,
    });

    const attributeResult = queryOverlay(root, 'host-attribute', ['--limit', '20', '--native-json']);
    const bindingResult = queryOverlay(root, 'host-binding', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(attributeResult);
    expectSpawnSuccess(bindingResult);
    const attributeResponse = JSON.parse(attributeResult.stdout);
    const bindingResponse = JSON.parse(bindingResult.stdout);
    expect(attributeResponse.edges.length).toBe(names.length);
    expect(bindingResponse.edges.length).toBe(names.length);
    expect(attributeResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/features/host-budget/alpha-host.component.ts',
      nodeKind: 'class',
      nodeName: 'AlphaHostComponent',
      content: expect.stringContaining("'role': 'alpha-region'"),
    }));
    expect(bindingResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/features/host-budget/alpha-host.component.ts',
      nodeKind: 'class',
      nodeName: 'AlphaHostComponent',
      content: expect.stringContaining("isActive()"),
    }));
    expect(attributeResponse.codeBlocks.slice(0, 5).every((block: { nodeName?: string }) => (
      block.nodeName?.endsWith('HostComponent')
    ))).toBe(true);
    expect(bindingResponse.codeBlocks.slice(0, 5).every((block: { nodeName?: string }) => (
      block.nodeName?.endsWith('HostComponent')
    ))).toBe(true);
  });

  it('demotes spec host metadata edge-line blocks when a production host owner is available', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-host-binding-low-value-order-'));
    tempRoots.push(root);
    const prodFile = 'src/app/features/host-budget/real-host.component.ts';
    const specFile = 'src/app/features/host-budget/real-host.component.spec.ts';
    writeFile(root, prodFile, [
      '@Component({',
      '  selector: "real-host",',
      '  host: {',
      "    '[class.ready]': 'isReady()',",
      '  },',
      '})',
      'export class RealHostComponent {',
      '  isReady(): boolean { return true; }',
      '}',
      '',
    ].join('\n'));
    writeFile(root, specFile, [
      '@Component({',
      '  selector: "real-host-spec",',
      '  host: {',
      "    '[class.ready]': 'isSpecReady()',",
      '  },',
      '})',
      'export class RealHostSpecComponent {',
      '  isSpecReady(): boolean { return true; }',
      '}',
      '',
    ].join('\n'));
    const prodClass = {
      id: `class:${prodFile}:RealHostComponent`,
      kind: 'class',
      name: 'RealHostComponent',
      qualifiedName: 'RealHostComponent',
      filePath: prodFile,
      language: 'typescript',
      startLine: 7,
      endLine: 9,
    };
    const specClass = {
      id: `class:${specFile}:RealHostSpecComponent`,
      kind: 'class',
      name: 'RealHostSpecComponent',
      qualifiedName: 'RealHostSpecComponent',
      filePath: specFile,
      language: 'typescript',
      startLine: 7,
      endLine: 9,
    };
    const prodBinding = {
      id: `property:${prodFile}:class.ready`,
      kind: 'property',
      name: 'class.ready',
      qualifiedName: 'RealHostComponent::class.ready',
      filePath: prodFile,
      language: 'typescript',
      startLine: 4,
      endLine: 4,
    };
    const specBinding = {
      id: `property:${specFile}:class.ready`,
      kind: 'property',
      name: 'class.ready',
      qualifiedName: 'RealHostSpecComponent::class.ready',
      filePath: specFile,
      language: 'typescript',
      startLine: 4,
      endLine: 4,
    };
    writeHostBudgetOverlay(root, {
      files: [specFile, prodFile],
      nodes: [specClass, specBinding, prodClass, prodBinding],
      edges: [
        {
          source: specClass.id,
          target: specBinding.id,
          kind: 'references',
          line: 4,
          column: 5,
          metadata: {
            relation: 'host-binding',
            api: 'host',
            binding: 'class.ready',
            expression: 'isSpecReady()',
          },
        },
        {
          source: prodClass.id,
          target: prodBinding.id,
          kind: 'references',
          line: 4,
          column: 5,
          metadata: {
            relation: 'host-binding',
            api: 'host',
            binding: 'class.ready',
            expression: 'isReady()',
          },
        },
      ],
    });

    const result = queryOverlay(root, 'host-binding', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: prodFile,
      nodeKind: 'class',
      nodeName: 'RealHostComponent',
      content: expect.stringContaining("isReady()"),
    }));
    const specBindingIndex = response.codeBlocks.findIndex((block: { filePath?: string; nodeName?: string }) => (
      block.filePath === specFile && block.nodeName === 'RealHostSpecComponent'
    ));
    if (specBindingIndex >= 0) {
      expect(specBindingIndex).toBeGreaterThan(0);
    }
  });

  it('keeps same-event HostListener decorator arguments scoped per declaring file', () => {
    const root = makeFixture();
    writeFile(
      root,
      'src/app/features/sample/first-host-listener.component.ts',
      [
        "import { Component, HostListener } from '@angular/core';",
        '',
        '@Component({',
        "  selector: 'app-first-host-listener',",
        '  standalone: true,',
        "  template: ''",
        '})',
        'export class FirstHostListenerComponent {',
        "  @HostListener('document:click')",
        '  closeFirst(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/features/sample/second-host-listener.component.ts',
      [
        "import { Component, HostListener } from '@angular/core';",
        '',
        '@Component({',
        "  selector: 'app-second-host-listener',",
        '  standalone: true,',
        "  template: ''",
        '})',
        'export class SecondHostListenerComponent {',
        "  @HostListener('document:click')",
        '  closeSecond(): void {}',
        '}',
        '',
      ].join('\n'),
    );

    const result = runOverlay(root);

    expectSpawnSuccess(result);
    const overlay = JSON.parse(result.stdout);
    const hostListenerArgumentEdges = overlay.graph.edges.filter((edge: { metadata?: { relation?: string }; source?: string }) =>
      edge.metadata?.relation === 'decorator-argument'
      && (
        edge.source === 'method:src/app/features/sample/first-host-listener.component.ts:FirstHostListenerComponent.closeFirst'
        || edge.source === 'method:src/app/features/sample/second-host-listener.component.ts:SecondHostListenerComponent.closeSecond'
      )
    );
    const hostListenerArgumentTargets = new Set(hostListenerArgumentEdges.map((edge: { target: string }) => edge.target));

    expect(hostListenerArgumentEdges).toHaveLength(2);
    expect(hostListenerArgumentTargets.size).toBe(2);
    expect(overlay.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'variable:src/app/features/sample/first-host-listener.component.ts:document:click',
        kind: 'variable',
        name: 'document:click',
        filePath: 'src/app/features/sample/first-host-listener.component.ts',
      }),
      expect.objectContaining({
        id: 'variable:src/app/features/sample/second-host-listener.component.ts:document:click',
        kind: 'variable',
        name: 'document:click',
        filePath: 'src/app/features/sample/second-host-listener.component.ts',
      }),
    ]));
  });
}

function writeHostBudgetOverlay(
  root: string,
  fixture: {
    files: string[];
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  },
): void {
  const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  fs.writeFileSync(overlayPath, `${JSON.stringify({
    generatedAt: '2026-06-14T00:00:00.000Z',
    version: 1,
    projectRoot: root,
    typescript: {
      files: fixture.files.map(filePath => ({ filePath })),
      classes: fixture.nodes.filter(node => node.kind === 'class'),
      functions: [],
      interfaces: [],
      types: [],
      constants: [],
      variables: fixture.nodes.filter(node => node.kind === 'variable'),
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
    },
    graph: {
      nodes: fixture.nodes,
      edges: fixture.edges,
    },
  }, null, 2)}\n`);
}
