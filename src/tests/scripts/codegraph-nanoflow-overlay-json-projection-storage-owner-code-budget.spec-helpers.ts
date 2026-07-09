import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayJsonProjectionStorageOwnerCodeBudgetSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { writeFile, expectSpawnSuccess, tempRoots, queryScriptPath, repoRoot } = context;

  it('uses storage owner methods as strict native Markdown entry points while preserving migration bucket evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-storage-owner-native-markdown-'));
    tempRoots.push(root);
    const serviceFile = 'src/app/core/services/attachment-cleanup.service.ts';
    const migrationFile = 'supabase/migrations/20260610000000_storage_policy.sql';
    writeFile(root, serviceFile, [
      'export class AttachmentCleanupService {',
      '  async deleteAttachmentFilesFromStorage(client: { storage: { from(bucket: string): unknown } }, paths: string[]): Promise<unknown> {',
      "    return client.storage.from('attachments')",
      '      .remove(paths);',
      '  }',
      '}',
      '',
    ].join('\n'));
    writeFile(root, migrationFile, [
      'create policy "attachment owners can read"',
      'on storage.objects',
      'for select',
      "using (bucket_id = 'attachments');",
      '',
    ].join('\n'));
    const methodNode = {
      id: `method:${serviceFile}:AttachmentCleanupService::deleteAttachmentFilesFromStorage`,
      kind: 'method',
      name: 'deleteAttachmentFilesFromStorage',
      qualifiedName: 'AttachmentCleanupService::deleteAttachmentFilesFromStorage',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 2,
      endLine: 5,
    };
    const tsBucketNode = {
      id: `variable:${serviceFile}:supabase-storage-bucket:attachments:AttachmentCleanupService.deleteAttachmentFilesFromStorage`,
      kind: 'variable',
      name: 'attachments',
      qualifiedName: 'AttachmentCleanupService.deleteAttachmentFilesFromStorage::attachments',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 3,
      endLine: 3,
      signature: 'storage bucket attachments',
      metadata: { relation: 'supabase-storage-bucket' },
    };
    const migrationFileNode = {
      id: migrationFile,
      kind: 'file',
      name: path.basename(migrationFile),
      qualifiedName: migrationFile,
      filePath: migrationFile,
      language: 'unknown',
      startLine: 1,
      endLine: 4,
    };
    const migrationBucketNode = {
      id: `variable:${migrationFile}:supabase-storage-bucket:attachments:policy:attachment owners can read`,
      kind: 'variable',
      name: 'attachments',
      qualifiedName: 'policy attachment owners can read::attachments',
      filePath: migrationFile,
      language: 'unknown',
      startLine: 4,
      endLine: 4,
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
        nodes: [
          methodNode,
          tsBucketNode,
          migrationFileNode,
          migrationBucketNode,
        ],
        edges: [
          {
            source: methodNode.id,
            target: tsBucketNode.id,
            kind: 'references',
            line: 3,
            column: 27,
            metadata: {
              relation: 'supabase-storage-bucket',
              bucket: 'attachments',
              storageSource: 'typescript',
            },
          },
          {
            source: migrationFileNode.id,
            target: migrationBucketNode.id,
            kind: 'references',
            line: 4,
            column: 19,
            metadata: {
              relation: 'supabase-storage-bucket',
              bucket: 'attachments',
              storageSource: 'policy',
              policy: 'attachment owners can read',
              table: 'storage.objects',
            },
          },
        ],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'supabase-storage-bucket',
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
    const entryPoints = result.stdout.slice(
      result.stdout.indexOf('### Entry Points'),
      result.stdout.indexOf('### Related Symbols'),
    );
    expect(entryPoints).toContain(`- **deleteAttachmentFilesFromStorage** (method) - ${serviceFile}:2`);
    expect(entryPoints).toContain(`- **attachments** (variable) - ${migrationFile}:4`);
    expect(entryPoints).not.toContain(`- **attachments** (variable) - ${serviceFile}:3`);
    expect(result.stdout).toContain('#### deleteAttachmentFilesFromStorage (src/app/core/services/attachment-cleanup.service.ts:2)');
    expect(result.stdout).toContain("client.storage.from('attachments')");
    expect(result.stdout).toContain(`#### attachments (${migrationFile}:1)`);
    expect(result.stdout).toContain('create policy "attachment owners can read"');
    expect(result.stdout).toContain("using (bucket_id = 'attachments');");
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
  });
}
