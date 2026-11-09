import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import {
  callContextPack,
  extractContextSourceHeaders,
  writeOverlayResponseScript,
} from './codegraph-nanoflow-overlay-mcp-context-quality.helpers';
import { registerCodegraphOverlayMcpContextQualityNoiseTailSpecs } from './codegraph-nanoflow-overlay-mcp-context-quality-noise-tail.spec-helpers';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpContextQualityNoiseSpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    readJsonLine,
    makeFakeCodegraph,
    waitForLogEvent,
  } = context;
  const writeSource = (projectRoot: string, filePath: string, lines: string[]) => {
    writeFile(projectRoot, filePath, [...lines, ''].join('\n'));
  };

  it('demotes script, worker, and drawable source blocks for generic icon context-pack queries', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-icon-quality-'));
    tempRoots.push(projectRoot);
    writeSource(projectRoot, 'src/app/shared/components/icon-button.component.ts', [
      'export class IconButtonComponent {',
      "  icon = 'plus';",
      '}',
    ]);
    writeSource(projectRoot, 'scripts/ci/check-deploy-artifacts.cjs', [
      "const iconManifest = 'icons.json';",
      'module.exports = { iconManifest };',
    ]);
    writeSource(projectRoot, 'cloudflare/workers-static-assets/shell-worker.js', [
      "const iconCacheKey = 'app-icons';",
      'export default { iconCacheKey };',
    ]);
    writeSource(projectRoot, 'android/app/src/main/res/drawable/nano_widget_icon_archive.xml', [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<vector android:width="24dp" android:height="24dp" />',
    ]);
    writeSource(projectRoot, 'android/app/src/main/res/layout/nano_widget_large.xml', [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<ImageView android:src="@drawable/nano_widget_icon_archive" />',
    ]);
    writeOverlayResponseScript(projectRoot, {
      query: 'icon',
      matches: [
        { kind: 'constant', name: 'iconManifest', file: 'scripts/ci/check-deploy-artifacts.cjs' },
        { kind: 'constant', name: 'iconCacheKey', file: 'cloudflare/workers-static-assets/shell-worker.js' },
        { kind: 'class', name: 'IconButtonComponent', file: 'src/app/shared/components/icon-button.component.ts' },
        { kind: 'file', name: 'android/app/src/main/res/drawable/nano_widget_icon_archive.xml', file: 'android/app/src/main/res/drawable/nano_widget_icon_archive.xml' },
      ],
      nodes: [
        {
          id: 'constant:scripts/ci/check-deploy-artifacts.cjs:iconManifest',
          kind: 'constant',
          name: 'iconManifest',
          qualifiedName: 'iconManifest',
          filePath: 'scripts/ci/check-deploy-artifacts.cjs',
          language: 'javascript',
          startLine: 1,
          endLine: 2,
        },
        {
          id: 'constant:cloudflare/workers-static-assets/shell-worker.js:iconCacheKey',
          kind: 'constant',
          name: 'iconCacheKey',
          qualifiedName: 'iconCacheKey',
          filePath: 'cloudflare/workers-static-assets/shell-worker.js',
          language: 'javascript',
          startLine: 1,
          endLine: 2,
        },
        {
          id: 'class:src/app/shared/components/icon-button.component.ts:IconButtonComponent',
          kind: 'class',
          name: 'IconButtonComponent',
          qualifiedName: 'IconButtonComponent',
          filePath: 'src/app/shared/components/icon-button.component.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'file:android/app/src/main/res/drawable/nano_widget_icon_archive.xml',
          kind: 'file',
          name: 'nano_widget_icon_archive.xml',
          qualifiedName: 'android/app/src/main/res/drawable/nano_widget_icon_archive.xml',
          filePath: 'android/app/src/main/res/drawable/nano_widget_icon_archive.xml',
          language: 'xml',
          startLine: 1,
          endLine: 2,
        },
        {
          id: 'file:android/app/src/main/res/layout/nano_widget_large.xml',
          kind: 'file',
          name: 'nano_widget_large.xml',
          qualifiedName: 'android/app/src/main/res/layout/nano_widget_large.xml',
          filePath: 'android/app/src/main/res/layout/nano_widget_large.xml',
          language: 'xml',
          startLine: 1,
          endLine: 2,
        },
      ],
      relationshipGroups: {
        imports: [
          {
            source: 'nano_widget_large.xml',
            target: 'nano_widget_icon_archive.xml',
            relation: 'android-resource-reference',
            resourceType: 'drawable',
            resourceName: 'nano_widget_icon_archive',
          },
        ],
      },
      coverage: { typescriptFiles: 1, graphNodes: 5, graphEdges: 1 },
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph: makeFakeCodegraph(),
      readJsonLine,
      query: 'icon',
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(sourceHeaders[0]).toContain('src/app/shared/components/icon-button.component.ts');
    expect(sourceHeaders).not.toContain('android/app/src/main/res/drawable/nano_widget_icon_archive.xml');
    const relationships = text.slice(text.indexOf('### Relationships'), text.indexOf('### Related Symbols'));
    expect(relationships).not.toContain('nano_widget_icon_archive.xml');
    const relatedSymbols = text.slice(text.indexOf('### Related Symbols'));
    const uiIndex = relatedSymbols.indexOf('src/app/shared/components/icon-button.component.ts');
    const scriptIndex = relatedSymbols.indexOf('scripts/ci/check-deploy-artifacts.cjs');
    const workerIndex = relatedSymbols.indexOf('cloudflare/workers-static-assets/shell-worker.js');
    const drawableIndex = relatedSymbols.indexOf('android/app/src/main/res/drawable/nano_widget_icon_archive.xml');
    expect(uiIndex).toBeGreaterThanOrEqual(0);
    expect(scriptIndex).toBe(-1);
    expect(workerIndex).toBe(-1);
    expect(drawableIndex).toBe(-1);
  }, 12_000);

  it('filters tokenized script matches from route guard relationships and related symbols', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-route-guard-quality-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'src/app.routes.ts',
      [
        'export const routes = [',
        '  { path: "projects", canActivate: [projectGuard] },',
        '];',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/services/guards/project.guard.ts',
      [
        'export function projectGuard(): boolean {',
        '  return true;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/generate-codegraph-nanoflow-overlay.mjs',
      [
        'export function readRouteGuardReferences(): string[] {',
        '  return [];',
        '}',
        '',
      ].join('\n'),
    );
    writeOverlayResponseScript(projectRoot, {
      query: 'route guard',
      matches: [
        { kind: 'function', name: 'readRouteGuardReferences', file: 'scripts/generate-codegraph-nanoflow-overlay.mjs' },
        { kind: 'constant', name: 'routes', file: 'src/app.routes.ts' },
        { kind: 'function', name: 'projectGuard', file: 'src/services/guards/project.guard.ts' },
      ],
      nodes: [
        {
          id: 'function:scripts/generate-codegraph-nanoflow-overlay.mjs:readRouteGuardReferences',
          kind: 'function',
          name: 'readRouteGuardReferences',
          qualifiedName: 'readRouteGuardReferences',
          filePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs',
          language: 'javascript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'constant:src/app.routes.ts:routes',
          kind: 'constant',
          name: 'routes',
          qualifiedName: 'routes',
          filePath: 'src/app.routes.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'function:src/services/guards/project.guard.ts:projectGuard',
          kind: 'function',
          name: 'projectGuard',
          qualifiedName: 'projectGuard',
          filePath: 'src/services/guards/project.guard.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {
        references: [
          { source: 'readRouteGuardReferences', target: 'routes', relation: 'tooling-helper' },
          { source: 'routes', target: 'projectGuard', relation: 'angular-route-guard' },
        ],
      },
      coverage: { typescriptFiles: 2, graphNodes: 3, graphEdges: 2 },
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph: makeFakeCodegraph(),
      readJsonLine,
      query: 'route guard',
    });

    const relationships = text.slice(text.indexOf('### Relationships'), text.indexOf('### Related Symbols'));
    expect(relationships).toContain('routes → projectGuard');
    expect(relationships).not.toContain('readRouteGuardReferences');
    const relatedSymbols = text.slice(text.indexOf('### Related Symbols'));
    const routesIndex = relatedSymbols.indexOf('src/app.routes.ts');
    const guardIndex = relatedSymbols.indexOf('src/services/guards/project.guard.ts');
    const scriptIndex = relatedSymbols.indexOf('scripts/generate-codegraph-nanoflow-overlay.mjs');
    expect(routesIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(scriptIndex).toBe(-1);
  }, 12_000);

  it('does not restore all low-value relationships when scoped relationship filtering is empty', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-low-value-relationships-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/generate-codegraph-nanoflow-overlay.mjs',
      [
        'export function readRouteGuardReferences(): string[] {',
        '  return [];',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/tests/scripts/route-guard.spec-helpers.ts',
      [
        'export function registerRouteGuardSpecs(): void {',
        '  readRouteGuardReferences();',
        '}',
        '',
      ].join('\n'),
    );
    writeOverlayResponseScript(projectRoot, {
      query: 'route guard',
      matches: [
        { kind: 'function', name: 'readRouteGuardReferences', file: 'scripts/generate-codegraph-nanoflow-overlay.mjs' },
        { kind: 'function', name: 'registerRouteGuardSpecs', file: 'src/tests/scripts/route-guard.spec-helpers.ts' },
      ],
      nodes: [
        {
          id: 'function:scripts/generate-codegraph-nanoflow-overlay.mjs:readRouteGuardReferences',
          kind: 'function',
          name: 'readRouteGuardReferences',
          qualifiedName: 'readRouteGuardReferences',
          filePath: 'scripts/generate-codegraph-nanoflow-overlay.mjs',
          language: 'javascript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'function:src/tests/scripts/route-guard.spec-helpers.ts:registerRouteGuardSpecs',
          kind: 'function',
          name: 'registerRouteGuardSpecs',
          qualifiedName: 'registerRouteGuardSpecs',
          filePath: 'src/tests/scripts/route-guard.spec-helpers.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {
        calls: [
          { source: 'registerRouteGuardSpecs', target: 'readRouteGuardReferences', relation: 'test-helper' },
        ],
      },
      coverage: { typescriptFiles: 1, graphNodes: 2, graphEdges: 1 },
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph: makeFakeCodegraph(),
      readJsonLine,
      query: 'route guard',
    });

    const relationships = text.slice(text.indexOf('### Relationships'), text.indexOf('### Related Symbols'));
    expect(relationships).not.toContain('registerRouteGuardSpecs');
    expect(relationships).not.toContain('readRouteGuardReferences');
    const relatedSymbols = text.slice(text.indexOf('### Related Symbols'), text.indexOf('### Source Code'));
    expect(relatedSymbols).not.toContain('scripts/generate-codegraph-nanoflow-overlay.mjs');
    expect(relatedSymbols).not.toContain('src/tests/scripts/route-guard.spec-helpers.ts');
  }, 12_000);

  it('filters story demo and sample source blocks from broad component context-pack queries', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-story-demo-quality-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'src/app/shared/components/action-button.component.ts',
      [
        'export class ActionButtonComponent {',
        "  readonly label = 'Run';",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/app/shared/components/action-button-menu.component.ts',
      [
        'export class ActionButtonMenuComponent {',
        '  readonly items = [ActionButtonComponent];',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/stories/action-button.stories.tsx',
      [
        'export const PrimaryActionButtonStory = {',
        "  args: { label: 'Story' },",
        '};',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/demo/action-button-demo.ts',
      [
        'export function actionButtonDemo(): string {',
        "  return 'demo';",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/samples/action-button-sample.ts',
      [
        'export const actionButtonSample = {',
        '  sample: true,',
        '};',
        '',
      ].join('\n'),
    );
    writeOverlayResponseScript(projectRoot, {
      query: 'action button component',
      matches: [
        { kind: 'constant', name: 'PrimaryActionButtonStory', file: 'src/stories/action-button.stories.tsx' },
        { kind: 'function', name: 'actionButtonDemo', file: 'src/demo/action-button-demo.ts' },
        { kind: 'constant', name: 'actionButtonSample', file: 'src/samples/action-button-sample.ts' },
        { kind: 'class', name: 'ActionButtonComponent', file: 'src/app/shared/components/action-button.component.ts' },
        { kind: 'class', name: 'ActionButtonMenuComponent', file: 'src/app/shared/components/action-button-menu.component.ts' },
      ],
      nodes: [
        {
          id: 'constant:src/stories/action-button.stories.tsx:PrimaryActionButtonStory',
          kind: 'constant',
          name: 'PrimaryActionButtonStory',
          qualifiedName: 'PrimaryActionButtonStory',
          filePath: 'src/stories/action-button.stories.tsx',
          language: 'tsx',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'function:src/demo/action-button-demo.ts:actionButtonDemo',
          kind: 'function',
          name: 'actionButtonDemo',
          qualifiedName: 'actionButtonDemo',
          filePath: 'src/demo/action-button-demo.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'constant:src/samples/action-button-sample.ts:actionButtonSample',
          kind: 'constant',
          name: 'actionButtonSample',
          qualifiedName: 'actionButtonSample',
          filePath: 'src/samples/action-button-sample.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'class:src/app/shared/components/action-button.component.ts:ActionButtonComponent',
          kind: 'class',
          name: 'ActionButtonComponent',
          qualifiedName: 'ActionButtonComponent',
          filePath: 'src/app/shared/components/action-button.component.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'class:src/app/shared/components/action-button-menu.component.ts:ActionButtonMenuComponent',
          kind: 'class',
          name: 'ActionButtonMenuComponent',
          qualifiedName: 'ActionButtonMenuComponent',
          filePath: 'src/app/shared/components/action-button-menu.component.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {},
      coverage: { typescriptFiles: 5, graphNodes: 5, graphEdges: 0 },
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph: makeFakeCodegraph(),
      readJsonLine,
      query: 'action button component',
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(sourceHeaders.join('\n')).toContain('src/app/shared/components/action-button.component.ts');
    expect(sourceHeaders.join('\n')).toContain('src/app/shared/components/action-button-menu.component.ts');
    expect(sourceHeaders.join('\n')).not.toContain('src/stories/action-button.stories.tsx');
    expect(sourceHeaders.join('\n')).not.toContain('src/demo/action-button-demo.ts');
    expect(sourceHeaders.join('\n')).not.toContain('src/samples/action-button-sample.ts');
  }, 12_000);

  it('filters generated source blocks from broad implementation context-pack queries', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-generated-noise-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'src/app/core/services/contract.service.ts',
      [
        'export class ContractService {',
        '  load(): ContractMessage {',
        '    return { id: "contract" };',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/generated/contracts.pb.ts',
      [
        'export interface ContractMessage {',
        '  id: string;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/generated/contracts.generated.ts',
      [
        'export const ContractWireSchema = {',
        '  name: "ContractMessage",',
        '};',
        '',
      ].join('\n'),
    );
    writeOverlayResponseScript(projectRoot, {
      query: 'contract service',
      matches: [
        { kind: 'interface', name: 'ContractMessage', file: 'src/generated/contracts.pb.ts' },
        { kind: 'constant', name: 'ContractWireSchema', file: 'src/generated/contracts.generated.ts' },
        { kind: 'class', name: 'ContractService', file: 'src/app/core/services/contract.service.ts' },
      ],
      nodes: [
        {
          id: 'interface:src/generated/contracts.pb.ts:ContractMessage',
          kind: 'interface',
          name: 'ContractMessage',
          qualifiedName: 'ContractMessage',
          filePath: 'src/generated/contracts.pb.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'constant:src/generated/contracts.generated.ts:ContractWireSchema',
          kind: 'constant',
          name: 'ContractWireSchema',
          qualifiedName: 'ContractWireSchema',
          filePath: 'src/generated/contracts.generated.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'class:src/app/core/services/contract.service.ts:ContractService',
          kind: 'class',
          name: 'ContractService',
          qualifiedName: 'ContractService',
          filePath: 'src/app/core/services/contract.service.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 5,
        },
      ],
      relationshipGroups: {
        references: [
          { source: 'ContractService', target: 'ContractMessage', relation: 'return-type' },
          { source: 'ContractWireSchema', target: 'ContractMessage', relation: 'generated-schema' },
        ],
      },
      coverage: { typescriptFiles: 3, graphNodes: 3, graphEdges: 2 },
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph: makeFakeCodegraph(),
      readJsonLine,
      query: 'contract service',
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(sourceHeaders.join('\n')).toContain('src/app/core/services/contract.service.ts');
    expect(sourceHeaders.join('\n')).not.toContain('src/generated/contracts.pb.ts');
    expect(sourceHeaders.join('\n')).not.toContain('src/generated/contracts.generated.ts');

    const relationships = text.slice(text.indexOf('### Relationships'), text.indexOf('### Related Symbols'));
    expect(relationships).not.toContain('ContractWireSchema');
    const relatedSymbols = text.slice(text.indexOf('### Related Symbols'), text.indexOf('### Source Code'));
    expect(relatedSymbols).toContain('src/app/core/services/contract.service.ts');
    expect(relatedSymbols).not.toContain('src/generated/contracts.pb.ts');
    expect(relatedSymbols).not.toContain('src/generated/contracts.generated.ts');

    const responseEvent = await waitForLogEvent(
      process.env.NANOFLOW_CODEGRAPH_MCP_LOG ?? '',
      'nanoflow.context.response',
      2_000,
      (entry) => entry.query === 'contract service',
    );
    expect(responseEvent.sourceSelection).toEqual(expect.objectContaining({
      filteredSourceFiles: expect.arrayContaining([
        expect.objectContaining({
          filePath: 'src/generated/contracts.pb.ts',
          reason: 'low-value-source-path',
        }),
        expect.objectContaining({
          filePath: 'src/generated/contracts.generated.ts',
          reason: 'low-value-source-path',
        }),
      ]),
    }));
  }, 12_000);

  registerCodegraphOverlayMcpContextQualityNoiseTailSpecs(context);
}
