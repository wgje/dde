import { expect, it } from 'vitest';

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import {
  registerCodegraphOverlaySupabasePolicyConstraintDataQuerySpecs,
} from './codegraph-nanoflow-overlay-query-policies-data-constraints.spec-helpers';
import {
  registerCodegraphOverlaySupabasePolicyRealtimeViewDataQuerySpecs,
} from './codegraph-nanoflow-overlay-query-policies-data-realtime.spec-helpers';
import {
  makeMultilinePolicyFixture,
  writeOverlayFixture,
} from './codegraph-nanoflow-overlay-query-policies-data-fixtures';

export function registerCodegraphOverlaySupabasePolicyDataQuerySpecs(context: CodegraphOverlaySpecContext): void {
  const {
    makeFixture,
    queryOverlay,
    expectSpawnSuccess,
    tempRoots,
    writeFile,
    repoRoot,
    queryScriptPath,
  } = context;

  registerCodegraphOverlaySupabasePolicyConstraintDataQuerySpecs(context);
  registerCodegraphOverlaySupabasePolicyRealtimeViewDataQuerySpecs(context);

  it('expands multiline migration validation strict native code blocks to complete SQL statements', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-multiline-validation-codeblock-'));
    tempRoots.push(root);
    const migrationFile = 'supabase/migrations/20260614031000_multiline_validation.sql';
    writeFile(
      root,
      migrationFile,
      [
        'alter table public.tasks',
        'validate constraint',
        'tasks_multiline_check;',
        '',
      ].join('\n'),
    );
    const fileNode = {
      id: `file:${migrationFile}:20260614031000_multiline_validation.sql`,
      kind: 'file',
      name: '20260614031000_multiline_validation.sql',
      qualifiedName: migrationFile,
      filePath: migrationFile,
      language: 'unknown',
      startLine: 1,
      endLine: 3,
    };
    const constraintNode = {
      id: `variable:${migrationFile}:tasks_multiline_check`,
      kind: 'variable',
      name: 'tasks_multiline_check',
      qualifiedName: 'tasks_multiline_check',
      filePath: migrationFile,
      language: 'unknown',
      startLine: 1,
      endLine: 1,
      signature: 'constraint tasks_multiline_check on public.tasks check',
      metadata: {
        relation: 'migration-constraint',
        table: 'public.tasks',
        constraintType: 'check',
      },
    };
    writeOverlayFixture(root, {
      nodes: [fileNode, constraintNode],
      edges: [{
        source: fileNode.id,
        target: constraintNode.id,
        kind: 'references',
        line: 1,
        column: 0,
        metadata: {
          relation: 'migration-constraint-validation',
          constraintName: 'tasks_multiline_check',
          table: 'public.tasks',
        },
      }],
    });

    const result = queryOverlay(root, 'migration-constraint-validation', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: migrationFile,
      nodeKind: 'file',
      nodeName: 'tasks_multiline_check',
      startLine: 1,
      endLine: 3,
      content: expect.stringContaining('tasks_multiline_check;'),
    }));
  });

  it('expands multiline migration index and constraint strict native code blocks to complete SQL statements', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-multiline-migration-codeblocks-'));
    tempRoots.push(root);
    const migrationFile = 'supabase/migrations/20260614030000_multiline_index_constraint.sql';
    writeFile(
      root,
      migrationFile,
      [
        'create index tasks_multiline_idx',
        'on public.tasks',
        'using btree (content)',
        'where deleted_at is null;',
        '',
        'alter table public.tasks',
        'add constraint tasks_multiline_check',
        'check (',
        '  char_length(content) <= 1000',
        ')',
        'not valid;',
        '',
      ].join('\n'),
    );
    const fileNode = {
      id: `file:${migrationFile}:20260614030000_multiline_index_constraint.sql`,
      kind: 'file',
      name: '20260614030000_multiline_index_constraint.sql',
      qualifiedName: migrationFile,
      filePath: migrationFile,
      language: 'unknown',
      startLine: 1,
      endLine: 11,
    };
    const indexNode = {
      id: `variable:${migrationFile}:tasks_multiline_idx`,
      kind: 'variable',
      name: 'tasks_multiline_idx',
      qualifiedName: 'tasks_multiline_idx',
      filePath: migrationFile,
      language: 'unknown',
      startLine: 1,
      endLine: 1,
      signature: 'index tasks_multiline_idx on public.tasks (content)',
      metadata: {
        relation: 'migration-index',
        table: 'public.tasks',
        columns: ['content'],
      },
    };
    const constraintNode = {
      id: `variable:${migrationFile}:tasks_multiline_check`,
      kind: 'variable',
      name: 'tasks_multiline_check',
      qualifiedName: 'tasks_multiline_check',
      filePath: migrationFile,
      language: 'unknown',
      startLine: 6,
      endLine: 6,
      signature: 'constraint tasks_multiline_check on public.tasks check',
      metadata: {
        relation: 'migration-constraint',
        table: 'public.tasks',
        constraintType: 'check',
        expression: 'char_length(content) <= 1000',
      },
    };
    writeOverlayFixture(root, {
      nodes: [fileNode, indexNode, constraintNode],
      edges: [
        {
          source: fileNode.id,
          target: indexNode.id,
          kind: 'references',
          line: 1,
          column: 0,
          metadata: {
            relation: 'migration-index',
            indexName: 'tasks_multiline_idx',
            table: 'public.tasks',
          },
        },
        {
          source: fileNode.id,
          target: constraintNode.id,
          kind: 'references',
          line: 6,
          column: 0,
          metadata: {
            relation: 'migration-constraint',
            constraintName: 'tasks_multiline_check',
            table: 'public.tasks',
          },
        },
      ],
    });

    const indexResult = queryOverlay(root, 'migration-index', ['--limit', '20', '--native-json']);
    const constraintResult = queryOverlay(root, 'migration-constraint', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(indexResult);
    expectSpawnSuccess(constraintResult);
    const indexResponse = JSON.parse(indexResult.stdout);
    const constraintResponse = JSON.parse(constraintResult.stdout);
    expect(indexResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: migrationFile,
      nodeName: 'tasks_multiline_idx',
      startLine: 1,
      endLine: 4,
      content: expect.stringContaining('where deleted_at is null;'),
    }));
    expect(constraintResponse.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: migrationFile,
      nodeName: 'tasks_multiline_check',
      startLine: 6,
      endLine: 11,
      content: expect.stringContaining('not valid;'),
    }));
  });

  it('queries Supabase migration row-level-security toggles as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'migration-rls', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges.length).toBeGreaterThan(0);
    expect(response.displayEdges.every((edge: { metadata?: { relation?: string } }) => (
      edge.metadata?.relation === 'migration-rls'
    ))).toBe(true);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:migration-rls:public.tasks:enable:10',
        kind: 'variable',
        name: 'public.tasks rls enable',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-rls',
          table: 'public.tasks',
          action: 'enable',
        }),
      }),
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:migration-rls:public.projects:no-force:51',
        kind: 'variable',
        name: 'public.projects rls no-force',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-rls',
          table: 'public.projects',
          action: 'no-force',
        }),
      }),
    ]));
    expect(response.relationshipGroups).toEqual({
      references: expect.arrayContaining([
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'public.tasks rls enable',
          relation: 'migration-rls',
          table: 'public.tasks',
          action: 'enable',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'public.projects rls no-force',
          relation: 'migration-rls',
          table: 'public.projects',
          action: 'no-force',
        }),
      ]),
    });
    expect(response.markdown).toContain('relation: migration-rls');
    expect(response.markdown).toContain('action: no-force');
  });

  it('includes row-level-security statement code blocks for strict native migration RLS queries', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'migration-rls', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBeGreaterThan(0);
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        nodeKind: 'variable',
        nodeName: 'public.tasks rls force',
        content: expect.stringContaining('alter table public.tasks force row level security;'),
      }),
      expect.objectContaining({
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        nodeKind: 'variable',
        nodeName: 'public.projects rls no-force',
        content: expect.stringContaining('alter table public.projects no force row level security;'),
      }),
    ]));
  });

  it('includes row-level-security statement code blocks for strict native migration RLS Markdown', () => {
    const root = makeFixture();

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'migration-rls',
      '--limit',
      '20',
      '--native-markdown',
      '--skip-refresh',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('## Code Context');
    expect(result.stdout).toContain('### Entry Points');
    expect(result.stdout).toContain('### Relationships');
    expect(result.stdout).toContain('**references:**');
    expect(result.stdout).toContain('- 20260609020000_drop_entity_uuid_defaults.sql -> public.tasks rls enable');
    expect(result.stdout).toContain('- 20260609020000_drop_entity_uuid_defaults.sql -> public.projects rls disable');
    expect(result.stdout).toContain('### Related Symbols');
    expect(result.stdout).toContain('### Code');
    expect(result.stdout).toContain('#### public.tasks rls force (supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:49)');
    expect(result.stdout).toContain('alter table public.tasks force row level security;');
    expect(result.stdout).toContain('#### public.projects rls no-force (supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:51)');
    expect(result.stdout).toContain('alter table public.projects no force row level security;');
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
    expect(result.stdout).not.toContain('relation: migration-rls');
    expect(result.stdout).not.toContain('metadata');
    expect(result.stdout).not.toContain('provenance');
  });

  it('expands policy-using native Markdown code blocks to the full SQL statement', () => {
    const root = makeMultilinePolicyFixture(context);

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'policy-using',
      '--limit',
      '20',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('create policy "tasks read nested"');
    expect(result.stdout).toContain('using (');
    expect(result.stdout).toContain('from public.projects');
    expect(result.stdout).toContain('where projects.id = tasks.project_id');
  });

  it('expands policy-with-check native Markdown code blocks to the full SQL statement', () => {
    const root = makeMultilinePolicyFixture(context);

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'policy-with-check',
      '--limit',
      '20',
      '--native-markdown',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expectSpawnSuccess(result);
    expect(result.stdout).toContain('create policy "tasks insert checked"');
    expect(result.stdout).toContain('with check (');
    expect(result.stdout).toContain('from public.projects');
    expect(result.stdout).toContain('where projects.id = tasks.project_id');
  });

  it('interleaves strict native code blocks for combined policy expression queries', () => {
    const root = makeMultilinePolicyFixture(context);

    const result = queryOverlay(root, 'policy-using/policy-with-check', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeName: 'tasks read nested',
        content: expect.stringContaining('using ('),
      }),
      expect.objectContaining({
        nodeName: 'tasks insert checked',
        content: expect.stringContaining('with check ('),
      }),
    ]));
  });

  it('queries Supabase Storage buckets from client calls and storage policies', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'supabase-storage-bucket', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'variable:src/services/attachment-storage.service.ts:supabase-storage-bucket:attachments',
        kind: 'variable',
        name: 'attachments',
        filePath: 'src/services/attachment-storage.service.ts',
        metadata: expect.objectContaining({
          relation: 'supabase-storage-bucket',
          bucket: 'attachments',
          storageSource: 'storage.from',
        }),
      }),
	      expect.objectContaining({
	        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:supabase-storage-bucket:attachments:policy:attachments owner upload:14',
	        kind: 'variable',
	        name: 'attachments',
	        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'supabase-storage-bucket',
          bucket: 'attachments',
          storageSource: 'storage-policy',
        }),
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'method:src/services/attachment-storage.service.ts:AttachmentStorageService.uploadAttachment',
        target: 'variable:src/services/attachment-storage.service.ts:supabase-storage-bucket:attachments',
        metadata: expect.objectContaining({
          relation: 'supabase-storage-bucket',
          bucket: 'attachments',
          storageSource: 'storage.from',
        }),
      }),
      expect.objectContaining({
	        kind: 'references',
	        source: 'file:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:20260609020000_drop_entity_uuid_defaults.sql',
	        target: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:supabase-storage-bucket:attachments:policy:attachments owner upload:14',
	        metadata: expect.objectContaining({
	          relation: 'supabase-storage-bucket',
          bucket: 'attachments',
          storageSource: 'storage-policy',
          policy: 'attachments owner upload',
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'uploadAttachment',
        target: 'attachments',
        relation: 'supabase-storage-bucket',
        bucket: 'attachments',
      }),
      expect.objectContaining({
        source: '20260609020000_drop_entity_uuid_defaults.sql',
        target: 'attachments',
        relation: 'supabase-storage-bucket',
        policy: 'attachments owner upload',
      }),
    ]));
	    expect(response.markdown).toContain('relation: supabase-storage-bucket');
	  });

	  it('keeps same-bucket storage policy evidence scoped per policy statement', () => {
	    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-storage-policy-scope-'));
	    tempRoots.push(root);
	    const migrationFile = 'supabase/migrations/20260615010000_storage_policy_scope.sql';
	    writeFile(
	      root,
	      migrationFile,
	      [
	        'create policy "attachments owner upload"',
	        'on storage.objects',
	        'for insert',
	        "with check (bucket_id = 'attachments');",
	        'create policy "attachments owner read"',
	        'on storage.objects',
	        'for select',
	        "using (bucket_id = 'attachments');",
	        '',
	      ].join('\n'),
	    );

	    const result = queryOverlay(root, 'supabase-storage-bucket', ['--limit', '20', '--native-json']);

	    expectSpawnSuccess(result);
	    const response = JSON.parse(result.stdout);
	    const migrationBucketNodes = response.nodes.filter((node: { id?: string; filePath?: string }) => (
	      node.filePath === migrationFile && node.id?.includes('supabase-storage-bucket:attachments')
	    ));
	    expect(migrationBucketNodes).toHaveLength(2);
	    expect(migrationBucketNodes.map((node: { id: string }) => node.id)).toEqual(expect.arrayContaining([
	      `variable:${migrationFile}:supabase-storage-bucket:attachments:policy:attachments owner upload:1`,
	      `variable:${migrationFile}:supabase-storage-bucket:attachments:policy:attachments owner read:5`,
	    ]));
	    const migrationBlocks = response.codeBlocks.filter((block: { filePath?: string }) => block.filePath === migrationFile);
	    expect(migrationBlocks).toEqual(expect.arrayContaining([
	      expect.objectContaining({
	        startLine: 1,
	        endLine: 4,
	        content: expect.stringContaining('create policy "attachments owner upload"'),
	      }),
	      expect.objectContaining({
	        startLine: 5,
	        endLine: 8,
	        content: expect.stringContaining('create policy "attachments owner read"'),
	      }),
	    ]));
	    expect(migrationBlocks.every((block: { content?: string }) => (
	      !block.content?.includes(');\ncreate policy')
	    ))).toBe(true);
	  });

	  it('queries Supabase RPC calls as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'supabase-rpc', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'variable:src/services/supabase-write-client.service.ts:supabase-rpc:sync_delete_project',
        kind: 'variable',
        name: 'sync_delete_project',
        filePath: 'src/services/supabase-write-client.service.ts',
        metadata: expect.objectContaining({
          relation: 'supabase-rpc',
          functionName: 'sync_delete_project',
        }),
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'method:src/services/supabase-write-client.service.ts:SupabaseWriteClientService.callProjectDelete',
        target: 'variable:src/services/supabase-write-client.service.ts:supabase-rpc:sync_delete_project',
        metadata: expect.objectContaining({
          relation: 'supabase-rpc',
          functionName: 'sync_delete_project',
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'callProjectDelete',
        target: 'sync_delete_project',
        relation: 'supabase-rpc',
        functionName: 'sync_delete_project',
      }),
    ]));
    expect(response.markdown).toContain('relation: supabase-rpc');
  });

  it('queries Supabase table write operations as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'supabase-table-write', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'variable:src/services/supabase-write-client.service.ts:supabase-table-write:projects:insert',
        kind: 'variable',
        name: 'projects.insert',
        filePath: 'src/services/supabase-write-client.service.ts',
        metadata: expect.objectContaining({
          relation: 'supabase-table-write',
          table: 'projects',
          writeOperation: 'insert',
        }),
      }),
      expect.objectContaining({
        id: 'variable:src/services/supabase-write-client.service.ts:supabase-table-write:tasks:upsert',
        kind: 'variable',
        name: 'tasks.upsert',
        filePath: 'src/services/supabase-write-client.service.ts',
        metadata: expect.objectContaining({
          relation: 'supabase-table-write',
          table: 'tasks',
          writeOperation: 'upsert',
        }),
      }),
      expect.objectContaining({
        id: 'variable:src/services/supabase-write-client.service.ts:supabase-table-write:connections:update',
        kind: 'variable',
        name: 'connections.update',
        filePath: 'src/services/supabase-write-client.service.ts',
        metadata: expect.objectContaining({
          relation: 'supabase-table-write',
          table: 'connections',
          writeOperation: 'update',
        }),
      }),
      expect.objectContaining({
        id: 'variable:src/services/supabase-write-client.service.ts:supabase-table-write:task_tombstones:delete',
        kind: 'variable',
        name: 'task_tombstones.delete',
        filePath: 'src/services/supabase-write-client.service.ts',
        metadata: expect.objectContaining({
          relation: 'supabase-table-write',
          table: 'task_tombstones',
          writeOperation: 'delete',
        }),
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'method:src/services/supabase-write-client.service.ts:SupabaseWriteClientService.upsertTask',
        target: 'variable:src/services/supabase-write-client.service.ts:supabase-table-write:tasks:upsert',
        metadata: expect.objectContaining({
          relation: 'supabase-table-write',
          table: 'tasks',
          writeOperation: 'upsert',
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'upsertTask',
        target: 'tasks.upsert',
        relation: 'supabase-table-write',
        table: 'tasks',
        writeOperation: 'upsert',
      }),
    ]));
    expect(response.markdown).toContain('relation: supabase-table-write');
  });
}
