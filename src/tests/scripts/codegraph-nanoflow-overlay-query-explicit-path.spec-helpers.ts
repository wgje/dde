import { expect, it } from 'vitest';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayQueryExplicitPathSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { writeFile, makeFixture, queryOverlay, expectSpawnSuccess } = context;

  it('prioritizes explicit root config file tokens over generic lifecycle terms', () => {
    const root = makeFixture();
    writeFile(
      root,
      'vitest.config.mts',
      [
        "import { defineConfig } from 'vitest/config';",
        '',
        'export default defineConfig({',
        '  test: {',
        "    setupFiles: ['./src/test-setup.ts'],",
        "    pool: 'threads',",
        '    isolate: false,',
        '  },',
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'vitest.services.config.mts',
      [
        "import { defineConfig } from 'vitest/config';",
        "import base from './vitest.config.mts';",
        '',
        'export default defineConfig({',
        '  ...base,',
        '  test: {',
        '    ...base.test,',
        '    maxWorkers: 1,',
        '    isolate: true,',
        '    fileParallelism: false,',
        "    setupFiles: ['./src/test-setup.services.ts'],",
        "    pool: 'threads',",
        "    // fake-indexeddb, afterEach cleanup, and timers are configured in setup.",
        '  },',
        '});',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      'vitest.services.config.mts setupFiles test isolation workers pool fake-indexeddb afterEach cleanup timers service tests config',
      ['--limit', '8'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.matches[0]).toEqual(expect.objectContaining({
      file: 'vitest.services.config.mts',
    }));
    expect(response.entryPoints[0]).toEqual(expect.objectContaining({
      filePath: 'vitest.services.config.mts',
    }));
    expect(response.markdown).toContain('#### vitest.services.config.mts');
    expect(response.markdown).toContain("setupFiles: ['./src/test-setup.services.ts']");
  });

  it('prioritizes tokenized file-stem coverage for the more specific config file', () => {
    const root = makeFixture();
    writeFile(
      root,
      'vitest.config.mts',
      [
        "import { defineConfig } from 'vitest/config';",
        '',
        'export default defineConfig({',
        '  test: {',
        "    setupFiles: ['./src/test-setup.ts'],",
        '  },',
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'vitest.services.config.mts',
      [
        "import { defineConfig } from 'vitest/config';",
        "import base from './vitest.config.mts';",
        '',
        'export default defineConfig({',
        '  ...base,',
        '  test: {',
        '    ...base.test,',
        "    setupFiles: ['./src/test-setup.services.ts'],",
        '    fileParallelism: false,',
        '  },',
        '});',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      'vitest services config mts setupFiles file parallelism',
      ['--limit', '8'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.entryPoints[0]).toEqual(expect.objectContaining({
      filePath: 'vitest.services.config.mts',
    }));
    const sourceHeaders = [...response.markdown.matchAll(/^#### (.+)$/gm)].map(match => match[1]);
    expect(sourceHeaders[0]).toBe('vitest.services.config.mts — default(constant)');
    expect(response.markdown).toContain("setupFiles: ['./src/test-setup.services.ts']");
  });

  it('treats Windows paths and line-qualified file tokens as exact file evidence', () => {
    const root = makeFixture();
    writeFile(
      root,
      'src/app/config/sync-service.config.ts',
      [
        'export const SYNC_SERVICE_CONFIG = {',
        "  retryQueue: 'enabled',",
        '  debounceMs: 3000,',
        "  conflictPolicy: 'LWW',",
        '};',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/app/services/generic-cleanup.service.ts',
      [
        'export class GenericCleanupService {',
        '  cleanupServiceConfig(): void {',
        '    const retryQueue = true;',
        '    const debounceMs = 3000;',
        "    const conflictPolicy = 'LWW';",
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      String.raw`src\app\config\sync-service.config.ts:3 retryQueue debounce LWW cleanup service config`,
      ['--limit', '8'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.matches[0]).toEqual(expect.objectContaining({
      file: 'src/app/config/sync-service.config.ts',
    }));
    expect(response.entryPoints[0]).toEqual(expect.objectContaining({
      filePath: 'src/app/config/sync-service.config.ts',
    }));
    expect(response.markdown).toContain('#### src/app/config/sync-service.config.ts');
    expect(response.markdown).toContain('debounceMs: 3000');
  });

  it('prioritizes explicit SQL migration paths over contract constants that mention the same file', () => {
    const root = makeFixture();
    const migrationPath = 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql';
    writeFile(
      root,
      migrationPath,
      [
        '-- Client-generated IDs are required; remove database-side UUID defaults.',
        'ALTER TABLE public.tasks ALTER COLUMN id DROP DEFAULT;',
        'ALTER TABLE public.projects ALTER COLUMN id DROP DEFAULT;',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/tests/contracts/init-supabase-sync-bootstrap.contract.spec.ts',
      [
        `const dropEntityUuidDefaultsMigrationPath = '${migrationPath}';`,
        "it('documents client id policy migration', () => {",
        '  expect(dropEntityUuidDefaultsMigrationPath).toContain("drop_entity_uuid_defaults");',
        '});',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      String.raw`supabase\migrations\20260609020000_drop_entity_uuid_defaults.sql:1 drop default client id policy`,
      ['--limit', '8'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.matches[0]).toEqual(expect.objectContaining({
      kind: 'file',
      file: migrationPath,
    }));
    expect(response.entryPoints[0]).toEqual(expect.objectContaining({
      kind: 'file',
      filePath: migrationPath,
    }));
    expect(response.markdown).toContain(`#### ${migrationPath}`);
    expect(response.markdown).toContain('ALTER TABLE public.tasks ALTER COLUMN id DROP DEFAULT;');
  });

  it('keeps explicit SQL migration native JSON focused on the requested file', () => {
    const root = makeFixture();
    const migrationPath = 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql';
    const noisyPath = 'src/services/default-client-policy.service.ts';
    writeFile(
      root,
      migrationPath,
      [
        '-- Client-generated IDs are required; remove database-side UUID defaults.',
        'ALTER TABLE public.tasks ALTER COLUMN id DROP DEFAULT;',
        'ALTER TABLE public.projects ALTER COLUMN id DROP DEFAULT;',
        '',
      ].join('\n'),
    );
    writeFile(
      root,
      noisyPath,
      [
        'export class DefaultClientPolicyService {',
        '  defaultClientIdPolicy(): void {',
        "    const defaultClientPolicy = 'default client id policy';",
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(
      root,
      String.raw`supabase\migrations\20260609020000_drop_entity_uuid_defaults.sql:1 drop default client id policy`,
      ['--native-json', '--limit', '8'],
    );

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.entryPoints[0]).toEqual(expect.objectContaining({
      kind: 'file',
      filePath: migrationPath,
    }));
    expect(response.relatedFiles).toContain(migrationPath);
    expect(response.relatedFiles).not.toContain(noisyPath);
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: noisyPath }),
    ]));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: migrationPath,
    }));
  });
}
