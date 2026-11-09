import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import { registerCodegraphOverlayJsonProjectionOwnerCodeBudgetSpecs } from './codegraph-nanoflow-overlay-json-projection-owner-code-budget.spec-helpers';
import { registerCodegraphOverlayJsonProjectionRealtimeBudgetSpecs } from './codegraph-nanoflow-overlay-json-projection-realtime-budget.spec-helpers';
import { registerCodegraphOverlayJsonProjectionSyncRuleBudgetSpecs } from './codegraph-nanoflow-overlay-json-projection-sync-rule-budget.spec-helpers';
import { registerCodegraphOverlayJsonProjectionTestReferenceBudgetSpecs } from './codegraph-nanoflow-overlay-json-projection-test-reference-budget.spec-helpers';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayJsonProjectionBudgetSpecs(context: CodegraphOverlaySpecContext): void {
  const { writeFile, queryOverlay, expectSpawnSuccess, tempRoots } = context;


  it('returns template usage line code blocks for template declaration relation queries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-template-usage-budget-'));
    tempRoots.push(root);
    const componentFile = 'src/app/features/sample/sample.component.ts';
    const targetFile = 'src/app/features/sample/child.component.ts';
    const templateFile = 'src/app/features/sample/sample.component.html';
    writeFile(root, componentFile, [
      'export class SampleComponent {}',
      '',
    ].join('\n'));
    writeFile(root, targetFile, [
      'export class ChildComponent {}',
      '',
    ].join('\n'));
    writeFile(root, templateFile, [
      '<section>',
      '  <app-child [value]="value"></app-child>',
      '</section>',
      '',
    ].join('\n'));
    const sourceNode = {
      id: `class:${componentFile}:SampleComponent`,
      kind: 'class',
      name: 'SampleComponent',
      qualifiedName: 'SampleComponent',
      filePath: componentFile,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const targetNode = {
      id: `class:${targetFile}:ChildComponent`,
      kind: 'class',
      name: 'ChildComponent',
      qualifiedName: 'ChildComponent',
      filePath: targetFile,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [componentFile, targetFile],
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
      },
      graph: {
        nodes: [sourceNode, targetNode],
        edges: [
          {
            source: sourceNode.id,
            target: targetNode.id,
            kind: 'references',
            metadata: {
              relation: 'template-component',
              selector: 'app-child',
              element: 'app-child',
              templateFile,
              line: 2,
              matchedNeedle: 'app-child',
            },
          },
        ],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'template-component', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: templateFile,
      startLine: 2,
      endLine: 2,
      language: 'html',
      nodeKind: 'file',
      nodeName: 'app-child',
      content: expect.stringContaining('<app-child'),
    }));
  });

  it('prioritizes storage bucket owner methods without duplicating TypeScript bucket variables', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-storage-bucket-source-budget-'));
    tempRoots.push(root);
    const serviceFile = 'src/app/core/services/storage-cleanup.service.ts';
    const migrationFile = 'supabase/migrations/20260612030000_storage_bucket_policy.sql';
    writeFile(root, serviceFile, [
      'export class StorageCleanupService {',
      '  async cleanup(client: { storage: { from(bucket: string): { remove(paths: string[]): Promise<unknown> } } }): Promise<void> {',
      "    await client.storage",
      "      .from('attachments')",
      "      .remove(['demo']);",
      '  }',
      '}',
      '',
    ].join('\n'));
	    writeFile(root, migrationFile, [
	      'create policy "Users can upload attachments"',
	      '  on "storage"."objects"',
	      '  for insert',
	      "with check ((bucket_id = 'attachments'::text));",
	      'create policy "Users can view own attachments"',
	      '  on "storage"."objects"',
	      '  for select',
	      "using ((bucket_id = 'attachments'::text));",
	      '',
	    ].join('\n'));
    const methodNode = {
      id: `method:${serviceFile}:StorageCleanupService::cleanup`,
      kind: 'method',
      name: 'cleanup',
      qualifiedName: 'StorageCleanupService::cleanup',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 2,
      endLine: 6,
    };
    const tsBucketNode = {
      id: `variable:${serviceFile}:supabase-storage-bucket:attachments`,
      kind: 'variable',
      name: 'attachments',
      qualifiedName: 'storage.bucket:attachments',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 4,
      endLine: 4,
      signature: 'storage bucket attachments',
      metadata: { relation: 'supabase-storage-bucket' },
    };
    const migrationFileNode = {
      id: `file:${migrationFile}:20260612030000_storage_bucket_policy.sql`,
      kind: 'file',
      name: '20260612030000_storage_bucket_policy.sql',
      qualifiedName: '20260612030000_storage_bucket_policy.sql',
      filePath: migrationFile,
      language: 'unknown',
      startLine: 1,
      endLine: 1,
    };
    const migrationBucketNode = {
      id: `variable:${migrationFile}:supabase-storage-bucket:attachments`,
      kind: 'variable',
      name: 'attachments',
	      qualifiedName: 'storage.bucket:attachments',
	      filePath: migrationFile,
	      language: 'unknown',
	      startLine: 4,
	      endLine: 8,
	      signature: 'storage bucket attachments',
	      metadata: { relation: 'supabase-storage-bucket' },
	    };
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [serviceFile],
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
      },
      graph: {
        nodes: [methodNode, tsBucketNode, migrationFileNode, migrationBucketNode],
        edges: [
          {
            source: methodNode.id,
            target: tsBucketNode.id,
            kind: 'references',
            line: 4,
            column: 12,
            metadata: {
              relation: 'supabase-storage-bucket',
              bucket: 'attachments',
              storageSource: 'client',
            },
          },
          {
            source: migrationFileNode.id,
            target: migrationBucketNode.id,
            kind: 'references',
            line: 1,
            metadata: {
              relation: 'supabase-storage-bucket',
              bucket: 'attachments',
              storageSource: 'policy',
            },
          },
        ],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'supabase-storage-bucket', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBeGreaterThanOrEqual(2);
    expect(response.codeBlocks.slice(0, 2)).toEqual([
      expect.objectContaining({
        filePath: serviceFile,
        nodeKind: 'method',
        nodeName: 'cleanup',
        content: expect.stringContaining(".from('attachments')"),
      }),
	      expect.objectContaining({
	        filePath: migrationFile,
	        nodeKind: 'variable',
	        startLine: 1,
	        endLine: 4,
	        content: expect.stringContaining("bucket_id = 'attachments'"),
	      }),
	    ]);
	    expect(response.codeBlocks[1].content).toContain('create policy "Users can upload attachments"');
	    expect(response.codeBlocks[1].content).not.toContain('Users can view own attachments');
	    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: serviceFile,
        nodeKind: 'variable',
        nodeName: 'attachments',
        startLine: 4,
        endLine: 4,
      }),
    ]));
  });

  it('expands SQL function strict native code blocks to complete statements', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-sql-function-statement-budget-'));
    tempRoots.push(root);
    const migrationFile = 'supabase/migrations/20260612040000_sql_function_statement.sql';
    const longFunctionBody = Array.from(
      { length: 80 },
      (_, index) => `  perform 'padding line ${index.toString().padStart(2, '0')} to force this SQL function statement beyond the normal code block budget';`,
    );
    writeFile(root, migrationFile, [
      'create or replace function public.touch_updated_at()',
      'returns trigger',
      'language plpgsql',
      'security definer',
      'as $$',
      'begin',
      "  perform 'this semicolon must not terminate the statement;';",
      ...longFunctionBody,
      "  perform 'final sentinel after the normal code block budget';",
      '  new.updated_at = now();',
      '  return new;',
      'end;',
      '$$;',
      'create trigger tasks_touch before update on public.tasks for each row execute function public.touch_updated_at();',
      '',
    ].join('\n'));
    const migrationFileNode = {
      id: migrationFile,
      kind: 'file',
      name: path.basename(migrationFile),
      qualifiedName: migrationFile,
      filePath: migrationFile,
      language: 'unknown',
      startLine: 1,
      endLine: 12,
    };
    const functionNode = {
      id: `function:${migrationFile}:public.touch_updated_at`,
      kind: 'function',
      name: 'public.touch_updated_at',
      qualifiedName: 'public.touch_updated_at',
      filePath: migrationFile,
      language: 'unknown',
      startLine: 1,
      endLine: 1,
      signature: 'function public.touch_updated_at() returns trigger',
      metadata: {
        relation: 'sql-function',
        functionName: 'public.touch_updated_at',
        returnType: 'trigger',
        language: 'plpgsql',
        security: 'definer',
      },
    };
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
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
        nodes: [migrationFileNode, functionNode],
        edges: [
          {
            source: migrationFileNode.id,
            target: functionNode.id,
            kind: 'references',
            line: 1,
            metadata: {
              relation: 'sql-function',
              functionName: 'public.touch_updated_at',
              returnType: 'trigger',
              language: 'plpgsql',
              security: 'definer',
            },
          },
          {
            source: migrationFileNode.id,
            target: functionNode.id,
            kind: 'references',
            line: 12,
            metadata: {
              relation: 'trigger-function',
              trigger: 'tasks_touch',
              functionName: 'public.touch_updated_at',
            },
          },
        ],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const sqlFunctionResult = queryOverlay(root, 'sql-function', ['--limit', '20', '--native-json']);
    const triggerFunctionResult = queryOverlay(root, 'trigger-function', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(sqlFunctionResult);
    expectSpawnSuccess(triggerFunctionResult);
    const sqlFunctionResponse = JSON.parse(sqlFunctionResult.stdout);
    const triggerFunctionResponse = JSON.parse(triggerFunctionResult.stdout);
    const expectedFunctionEndLine = 12 + longFunctionBody.length;

    for (const response of [sqlFunctionResponse, triggerFunctionResponse]) {
      expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
        filePath: migrationFile,
        nodeKind: 'function',
        nodeName: 'public.touch_updated_at',
        startLine: 1,
        endLine: expectedFunctionEndLine,
        content: expect.stringContaining('begin'),
      }));
      expect(response.codeBlocks[0].content).toContain("perform 'this semicolon must not terminate the statement;';");
      expect(response.codeBlocks[0].content).toContain("perform 'final sentinel after the normal code block budget';");
      expect(response.codeBlocks[0].content).toContain('$$;');
    }
  });

  it('prioritizes production route code blocks over spec fixtures for Angular route redirects', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-route-redirect-source-budget-'));
    tempRoots.push(root);
    const routeFile = 'src/app.routes.ts';
    const fixtureFile = 'src/tests/scripts/route-fixture.spec-helpers.ts';
    writeFile(root, routeFile, [
      'export const routes = [',
      '  {',
      "    path: '',",
      '    children: [',
      "      { path: 'projects', redirectTo: 'workspace/projects', pathMatch: 'full' },",
      '    ],',
      '  },',
      '];',
      '',
    ].join('\n'));
    writeFile(root, fixtureFile, [
      'export const fixtureRoutes = [',
      '  {',
      "    path: '',",
      '    children: [',
      "      { path: 'admin-panel', redirectTo: 'fixture-panel', pathMatch: 'full' },",
      '    ],',
      '  },',
      '];',
      '',
    ].join('\n'));
    const productionRootRoute = {
      id: `route:${routeFile}:(root):3`,
      kind: 'route',
      name: '(root)',
      qualifiedName: '(root)',
      filePath: routeFile,
      language: 'typescript',
      startLine: 3,
      endLine: 7,
    };
    const productionRedirectRoute = {
      id: `route:${routeFile}:projects:5`,
      kind: 'route',
      name: 'projects',
      qualifiedName: '(root)::projects',
      filePath: routeFile,
      language: 'typescript',
      startLine: 5,
      endLine: 5,
    };
    const fixtureRootRoute = {
      id: `route:${fixtureFile}:(root):3`,
      kind: 'route',
      name: '(root)',
      qualifiedName: '(root)',
      filePath: fixtureFile,
      language: 'typescript',
      startLine: 3,
      endLine: 7,
    };
    const fixtureRedirectRoute = {
      id: `route:${fixtureFile}:admin-panel:5`,
      kind: 'route',
      name: 'admin-panel',
      qualifiedName: '(root)::admin-panel',
      filePath: fixtureFile,
      language: 'typescript',
      startLine: 5,
      endLine: 5,
    };
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [routeFile, fixtureFile],
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
      },
      graph: {
        nodes: [
          productionRootRoute,
          productionRedirectRoute,
          fixtureRootRoute,
          fixtureRedirectRoute,
        ],
        edges: [
          {
            source: fixtureRootRoute.id,
            target: fixtureRedirectRoute.id,
            kind: 'references',
            line: 5,
            metadata: {
              relation: 'angular-route-redirect',
              redirectTo: 'fixture-panel',
            },
          },
          {
            source: productionRootRoute.id,
            target: productionRedirectRoute.id,
            kind: 'references',
            line: 5,
            metadata: {
              relation: 'angular-route-redirect',
              redirectTo: 'workspace/projects',
            },
          },
        ],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'angular-route-redirect', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBe(2);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: routeFile,
      nodeKind: 'route',
      nodeName: '(root)',
      content: expect.stringContaining("redirectTo: 'workspace/projects'"),
    }));
    expect(response.codeBlocks.findIndex((block: { filePath?: string }) => block.filePath === fixtureFile))
      .toBeGreaterThan(0);
  });

  it('does not duplicate Edge Function source handler blocks with line-one or helper file fallbacks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-edge-function-source-budget-'));
    tempRoots.push(root);
    const functionFile = 'supabase/functions/widget-demo/index.ts';
    const helperFile = 'supabase/functions/_shared/widget-helper.ts';
    writeFile(root, functionFile, [
      "import { helper } from '../_shared/widget-helper.ts';",
      '',
      'Deno.serve(async req => {',
      '  return helper(req);',
      '});',
      '',
    ].join('\n'));
    writeFile(root, helperFile, [
      'export function helper(req: Request): Response {',
      "  return new Response(req.method);",
      '}',
      '',
    ].join('\n'));
    const functionNode = {
      id: `function:${functionFile}:widget-demo`,
      kind: 'function',
      name: 'widget-demo',
      qualifiedName: 'widget-demo',
      filePath: functionFile,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const helperFileNode = {
      id: `file:${helperFile}:${helperFile}`,
      kind: 'file',
      name: helperFile,
      qualifiedName: helperFile,
      filePath: helperFile,
      language: 'typescript',
      startLine: 1,
      endLine: 1,
    };
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [functionFile, helperFile],
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
      },
      graph: {
        nodes: [functionNode, helperFileNode],
        edges: [
          {
            source: functionNode.id,
            target: helperFileNode.id,
            kind: 'imports',
            metadata: {
              relation: 'edge-function-source',
              sourceFile: functionFile,
            },
          },
        ],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'edge-function-source', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBe(1);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: functionFile,
      nodeKind: 'function',
      nodeName: 'widget-demo',
      startLine: 3,
      content: expect.stringContaining('Deno.serve'),
    }));
    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: functionFile,
        nodeKind: 'function',
        nodeName: 'widget-demo',
        startLine: 1,
        endLine: 1,
      }),
    ]));
    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: helperFile,
        nodeKind: 'file',
      }),
    ]));
    expect(response.relatedFiles).toContain(helperFile);
  });

  registerCodegraphOverlayJsonProjectionTestReferenceBudgetSpecs(context);
  registerCodegraphOverlayJsonProjectionRealtimeBudgetSpecs(context);
  registerCodegraphOverlayJsonProjectionOwnerCodeBudgetSpecs(context);
  registerCodegraphOverlayJsonProjectionSyncRuleBudgetSpecs(context);
}
