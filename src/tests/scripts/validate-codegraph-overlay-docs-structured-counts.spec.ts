import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupCodegraphOverlayDocsFixtures,
  makeFixture,
  runSync,
  runValidator,
} from './validate-codegraph-overlay-docs.spec-helpers';

describe('validate-codegraph-overlay-docs structured detail counts', () => {
  afterEach(() => {
    cleanupCodegraphOverlayDocsFixtures();
  });

  it('does not fail validation when documented top-level graph projection counts drift from the overlay', () => {
    const root = makeFixture({ graphNodesInDocs: 0, graphEdgesInDocs: 0 });

    const result = runValidator(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('CodeGraph overlay documentation validation passed');
  });

  it('syncs documented top-level graph projection counts from the overlay baseline', () => {
    const root = makeFixture({ graphNodesInDocs: 0, graphEdgesInDocs: 0 });
    const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    const overlay = JSON.parse(fs.readFileSync(path.join(root, '.codegraph', 'nanoflow-overlay.json'), 'utf8')) as {
      graph?: { nodes?: unknown[]; edges?: unknown[] };
    };
    const graphNodes = overlay.graph?.nodes?.length ?? 0;
    const graphEdges = overlay.graph?.edges?.length ?? 0;

    const result = runSync(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.readFileSync(adaptationPath, 'utf8')).toContain(
      `${graphNodes} graph nodes and ${graphEdges} graph edges in the native-shaped projection;`,
    );
  });

  it('syncs documented top-level graph projection counts when the projection summary is line-wrapped', () => {
    const root = makeFixture({ graphNodesInDocs: 0, graphEdgesInDocs: 0 });
    const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    const overlay = JSON.parse(fs.readFileSync(path.join(root, '.codegraph', 'nanoflow-overlay.json'), 'utf8')) as {
      graph?: { nodes?: unknown[]; edges?: unknown[] };
    };
    const graphNodes = overlay.graph?.nodes?.length ?? 0;
    const graphEdges = overlay.graph?.edges?.length ?? 0;
    fs.writeFileSync(
      adaptationPath,
      fs.readFileSync(adaptationPath, 'utf8').replace(
        '0 graph nodes and 0 graph edges in the native-shaped projection;',
        '0 graph nodes and 0 graph edges in\n  the native-shaped projection;',
      ),
    );

    const result = runSync(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.readFileSync(adaptationPath, 'utf8').replace(/\s+/g, ' ')).toContain(
      `${graphNodes} graph nodes and ${graphEdges} graph edges in the native-shaped projection;`,
    );
  });

  it('syncs Android Manifest and Kotlin resource semantic counts from the overlay baseline', () => {
    const root = makeFixture();
    const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    fs.writeFileSync(
      adaptationPath,
      fs.readFileSync(adaptationPath, 'utf8').replace(
        /Android packaging\/resource graph summary:.*/,
        'Android packaging/resource graph summary: 0 androidManifestComponents, 0 androidManifestPermissions, 0 androidManifestUsesPermissionEdges, 0 androidManifestQueries, 0 androidManifestQueryEdges, 0 androidManifestComponentPermissions, 0 androidManifestComponentPermissionEdges, 0 androidManifestIntentFilters, 0 androidManifestIntentFilterActions, 0 androidManifestIntentFilterActionEdges, 0 androidManifestIntentFilterCategories, 0 androidManifestIntentFilterCategoryEdges, 0 androidManifestIntentFilterData, 0 androidManifestIntentFilterDataEdges, 0 androidWidgetProviders, 0 androidResourceReferences, 0 androidKotlinResourceReferences, and 0 androidKotlinResourceReferenceEdges.',
      ),
    );

    const result = runSync(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.readFileSync(adaptationPath, 'utf8')).toContain(
      'Android packaging/resource graph summary: 1 androidManifestComponents, 1 androidManifestPermissions, 1 androidManifestUsesPermissionEdges, 1 androidManifestQueries, 1 androidManifestQueryEdges, 1 androidManifestComponentPermissions, 1 androidManifestComponentPermissionEdges, 1 androidManifestIntentFilters, 1 androidManifestIntentFilterActions, 1 androidManifestIntentFilterActionEdges, 1 androidManifestIntentFilterCategories, 1 androidManifestIntentFilterCategoryEdges, 1 androidManifestIntentFilterData, 1 androidManifestIntentFilterDataEdges, 1 androidWidgetProviders, 1 androidResourceReferences, 1 androidKotlinResourceReferences, and 1 androidKotlinResourceReferenceEdges.',
    );
  });

  it('syncs every repeated inline semantic counter assignment', () => {
    const root = makeFixture();
    const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    fs.appendFileSync(
      adaptationPath,
      '\nRepeated counters: `angularInjectorFiles=0`, `context7SourceMapDocEdges=0`, `androidManifestPermissions=0`.\n',
    );

    const result = runSync(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.readFileSync(adaptationPath, 'utf8')).toContain(
      'Repeated counters: `angularInjectorFiles=1`, `context7SourceMapDocEdges=1`, `androidManifestPermissions=1`.',
    );
  });

  it('syncs hard-rule anchor and repeated evidence narrative counts', () => {
    const root = makeFixture({
      hardRulesInDocs: 0,
      hardRuleKeywordNodesInDocs: 0,
      hardRuleKeywordEdgesInDocs: 0,
      hardRuleKeywordMappingEdgesInDocs: 0,
      hardRuleImplementationTargetsInDocs: 0,
    });
    const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    fs.appendFileSync(
      adaptationPath,
      [
        '',
        '0 scoped hard-rule keyword nodes and',
        '  0 hard-rule keyword reference edges expose current constraints.',
        '  All 0 hard-rule keyword edges carry provenance.',
        '  The implementation evidence layer adds 0 `hard-rule-implementation` native `references` edges',
        '  from the AGENTS keyword to 0 callable symbols that contain AST-proven calls.',
        '',
      ].join('\n'),
    );

    const result = runSync(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toContain('hardRules=1');
    const synced = fs.readFileSync(adaptationPath, 'utf8');
    expect(synced).toContain('1 AGENTS hard-rule anchors');
    expect(synced).toContain('1 scoped hard-rule keyword nodes and\n  1 hard-rule keyword reference edges');
    expect(synced).toContain('All 1 hard-rule keyword edges carry');
    expect(synced).toContain('adds 1 `hard-rule-implementation` native `references` edges');
    expect(synced).toContain('to 1 callable symbols that');
  });

  it('syncs documented Angular host semantic counts from the overlay baseline', () => {
    const root = makeFixture();
    const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    fs.writeFileSync(
      adaptationPath,
      fs.readFileSync(adaptationPath, 'utf8').replace(
        /[\d,]+\s+host-directive edges,\s+[\d,]+\s+host-attribute edges,\s+[\d,]+\s+host-binding edges,\s+and\s+[\d,]+\s+host-listener edges/,
        '0 host-directive edges, 0 host-attribute edges, 0 host-binding edges, and 0 host-listener edges',
      ),
    );

    const result = runSync(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.readFileSync(adaptationPath, 'utf8')).toContain(
      '0 host-directive edges, 1 host-attribute edges, 1 host-binding edges, and 1 host-listener edges',
    );
  });

  it('syncs Angular host semantic counts when the documentation splits the host summaries', () => {
    const root = makeFixture();
    const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    fs.writeFileSync(
      adaptationPath,
      fs.readFileSync(adaptationPath, 'utf8').replace(
        /[\d,]+\s+host-directive edges,\s+[\d,]+\s+host-attribute edges,\s+[\d,]+\s+host-binding edges,\s+and\s+[\d,]+\s+host-listener edges/,
        [
          '0 host-directive edges because the real tree does not use this metadata yet.',
          'The current real tree has 0 host-attribute edges, 0 host-binding edges, and 0 host-listener edges.',
        ].join('\n'),
      ),
    );

    const result = runSync(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const synced = fs.readFileSync(adaptationPath, 'utf8');
    expect(synced).toContain(
      '0 host-directive edges because the real tree does not use this metadata yet.',
    );
    expect(synced).toContain(
      'The current real tree has 1 host-attribute edges, 1 host-binding edges, and 1 host-listener edges.',
    );
  });

  it('syncs documented Supabase Edge Function semantic counts from the overlay baseline', () => {
    const root = makeFixture();
    const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    fs.writeFileSync(
      adaptationPath,
      fs.readFileSync(adaptationPath, 'utf8').replace(
        /[\d,]+\s+Supabase Edge Functions[\s\S]*?[\d,]+\s+followed source\/helper files[\s\S]*?[\d,]+\s+recorded source import\s+relations,\s+[\d,]+\s+native\s+`?edge-function-source`?\s+import edges,\s+[\d,]+\s+generated[\s\S]*?route nodes\/edges,\s+[\d,]+\s+explicit\s+`?req\.method`?\s+method[\s\S]*?[\d,]+\s+implementation-side\s+`?edge-function-invoke`?\s+edges,\s+and\s+[\d,]+\s+native test-reference edges/,
        '0 Supabase Edge Functions with 0 env-var references after following relative helper imports under supabase/functions, 0 followed source/helper files counted per Edge Function, 0 recorded source import relations, 0 native edge-function-source import edges, 0 generated /functions/v1/<name> route nodes/edges, 0 explicit req.method method references currently found in the real tree, 0 implementation-side edge-function-invoke edges, and 0 native test-reference edges',
      ),
    );

    const result = runSync(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.readFileSync(adaptationPath, 'utf8')).toContain(
      '1 Supabase Edge Functions with 0 env-var references after following relative helper imports under supabase/functions, 2 followed source/helper files counted per Edge Function, 1 recorded source import relations, 1 native edge-function-source import edges, 1 generated /functions/v1/<name> route nodes/edges, 1 explicit req.method method references currently found in the real tree, 1 implementation-side edge-function-invoke edges, and 1 native test-reference edges',
    );
  });

  it('syncs documented Supabase Realtime node counts from the overlay baseline', () => {
    const root = makeFixture();
    const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    fs.writeFileSync(
      adaptationPath,
      fs.readFileSync(adaptationPath, 'utf8').replace(
        /Realtime node summary:\s+[\d,]+\s+supabase-realtime-channel nodes,\s+[\d,]+\s+supabase-realtime-postgres-change nodes,\s+[\d,]+\s+supabase-realtime-status nodes,\s+[\d,]+\s+supabase-realtime-remove-channel nodes,\s+[\d,]+\s+supabase-realtime-unsubscribe nodes,\s+and\s+[\d,]+\s+supabase-realtime-remove-all-channels nodes/,
        'Realtime node summary: 0 supabase-realtime-channel nodes, 0 supabase-realtime-postgres-change nodes, 0 supabase-realtime-status nodes, 0 supabase-realtime-remove-channel nodes, 0 supabase-realtime-unsubscribe nodes, and 0 supabase-realtime-remove-all-channels nodes',
      ),
    );

    const result = runSync(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.readFileSync(adaptationPath, 'utf8')).toContain(
      'Realtime node summary: 1 supabase-realtime-channel nodes, 1 supabase-realtime-postgres-change nodes, 1 supabase-realtime-status nodes, 1 supabase-realtime-remove-channel nodes, 1 supabase-realtime-unsubscribe nodes, and 1 supabase-realtime-remove-all-channels nodes',
    );
  });

  it('syncs documented Supabase select and storage counts from the overlay baseline', () => {
    const root = makeFixture();
    const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    fs.writeFileSync(
      adaptationPath,
      fs.readFileSync(adaptationPath, 'utf8')
        .replace(
          /Select and storage node summary:\s+[\d,]+\s+supabase-select-field nodes,\s+[\d,]+\s+inline select field nodes,\s+[\d,]+\s+supabase-incremental-predicate nodes,\s+and\s+[\d,]+\s+supabase-storage-bucket nodes/,
          'Select and storage node summary: 0 supabase-select-field nodes, 0 inline select field nodes, 0 supabase-incremental-predicate nodes, and 0 supabase-storage-bucket nodes',
        )
        .replace(
          /Select and storage graph summary:\s+[\d,]+\s+supabase-select-field edges,\s+[\d,]+\s+supabase-select-field reference edges,\s+[\d,]+\s+inline select provenance edges,\s+[\d,]+\s+sync-required-field edges,\s+[\d,]+\s+supabase-incremental-predicate edges,\s+[\d,]+\s+sync-required-predicate edges,\s+and\s+[\d,]+\s+supabase-storage-bucket edges/,
          'Select and storage graph summary: 0 supabase-select-field edges, 0 supabase-select-field reference edges, 0 inline select provenance edges, 0 sync-required-field edges, 0 supabase-incremental-predicate edges, 0 sync-required-predicate edges, and 0 supabase-storage-bucket edges',
        ),
    );
    fs.appendFileSync(
      adaptationPath,
      [
        '',
        '- The Supabase select-field layer adds 0 native `supabase-select-field`',
        '  property nodes, 0 `supabase-select-field` edges, 0 method/function',
        '  `references` edges from `.select(...)` call sites to selected fields, 0',
        '  inline select field nodes, 0 inline select provenance edges, and 0',
        '  `sync-required-field` edges from the AGENTS `content` hard-rule keyword to',
        '  tasks field nodes. The incremental-predicate layer adds 0',
        '  `supabase-incremental-predicate` nodes, 0 method/function predicate',
        '  `references` edges, and 0 `sync-required-predicate` edges from AGENTS',
        '  keywords to query predicates. The Storage bucket layer adds 0',
        '  `supabase-storage-bucket` nodes and 0 native `references` edges for buckets.',
      ].join('\n'),
    );

    const result = runSync(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const text = fs.readFileSync(adaptationPath, 'utf8');
    const normalizedText = text.replace(/\s+/g, ' ');
    expect(normalizedText).toContain(
      'The Supabase select-field layer adds 2 native `supabase-select-field` property nodes, 3 `supabase-select-field` edges, 2 method/function `references` edges from `.select(...)` call sites to selected fields, 1 inline select field nodes, 1 inline select provenance edges, and 1 `sync-required-field` edges',
    );
    expect(normalizedText).toContain(
      'The incremental-predicate layer adds 1 `supabase-incremental-predicate` nodes, 1 method/function predicate `references` edges, and 1 `sync-required-predicate` edges',
    );
    expect(normalizedText).toContain(
      'The Storage bucket layer adds 1 `supabase-storage-bucket` nodes and 1 native `references` edges for buckets.',
    );
    expect(text).toContain(
      'Select and storage node summary: 2 supabase-select-field nodes, 1 inline select field nodes, 1 supabase-incremental-predicate nodes, and 1 supabase-storage-bucket nodes',
    );
    expect(text).toContain(
      'Select and storage graph summary: 3 supabase-select-field edges, 2 supabase-select-field reference edges, 1 inline select provenance edges, 1 sync-required-field edges, 1 supabase-incremental-predicate edges, 1 sync-required-predicate edges, and 1 supabase-storage-bucket edges',
    );
  });

  it('syncs documented Supabase migration structured detail narrative counts from the overlay baseline', () => {
    const root = makeFixture();
    const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    fs.appendFileSync(
      adaptationPath,
      [
        '',
        'The structured policyDetails array currently contains 0 parsed policy detail records, functionDetails contains 0 parsed SQL function definitions, triggerDetails contains 0 parsed SQL trigger definitions, indexDetails contains 0 parsed SQL index definitions, and constraintDetails contains 0 parsed SQL constraints.',
        'constraintValidationDetails contains 0 parsed SQL constraint validation statements.',
        'The structured privilegeDetails array contains 0 parsed PostgreSQL GRANT / REVOKE statements.',
      ].join('\n'),
    );

    const result = runSync(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const text = fs.readFileSync(adaptationPath, 'utf8');
    expect(text).toContain(
      'policyDetails array currently contains 1 parsed policy detail records, functionDetails contains 1 parsed SQL function definitions, triggerDetails contains 1 parsed SQL trigger definitions, indexDetails contains 1 parsed SQL index definitions, and constraintDetails contains 1 parsed SQL constraints',
    );
    expect(text).toContain('constraintValidationDetails contains 1 parsed SQL constraint validation statements');
    expect(text).toContain('privilegeDetails array contains 1 parsed PostgreSQL GRANT / REVOKE statements');
  });

  it('syncs documented Supabase migration node and test counts from the overlay baseline', () => {
    const root = makeFixture();
    const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    fs.writeFileSync(
      adaptationPath,
      fs.readFileSync(adaptationPath, 'utf8')
        .replace(
          /[\d,]+\s+SQL function nodes,\s+[\d,]+\s+SQL function edges,\s+[\d,]+\s+trigger edges,\s+[\d,]+\s+trigger-function edges,\s+[\d,]+\s+migration-index nodes,\s+[\d,]+\s+migration-index edges,\s+[\d,]+\s+migration-constraint nodes,\s+[\d,]+\s+migration-constraint edges,\s+[\d,]+\s+migration-constraint-validation nodes,\s+[\d,]+\s+migration-constraint-validation edges,\s+and\s+[\d,]+\s+migration-rls edges/,
          '0 SQL function nodes, 0 SQL function edges, 0 trigger edges, 0 trigger-function edges, 0 migration-index nodes, 0 migration-index edges, 0 migration-constraint nodes, 0 migration-constraint edges, 0 migration-constraint-validation nodes, 0 migration-constraint-validation edges, and 0 migration-rls edges',
        )
        .replace(/[\d,]+\s+migration tests and\s+[\d,]+\s+migration test edges/, '0 migration tests and 0 migration test edges'),
    );

    const result = runSync(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const text = fs.readFileSync(adaptationPath, 'utf8');
    expect(text).toContain(
      '1 SQL function nodes, 1 SQL function edges, 1 trigger edges, 1 trigger-function edges, 1 migration-index nodes, 1 migration-index edges, 1 migration-constraint nodes, 1 migration-constraint edges, 0 migration-constraint-validation nodes, 1 migration-constraint-validation edges, and 1 migration-rls edges',
    );
    expect(text).toContain('1 migration tests and 1 migration test edges');
  });

  it('syncs documented Supabase policy and privilege counts from the overlay baseline', () => {
    const root = makeFixture();
    const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    fs.writeFileSync(
      adaptationPath,
      fs.readFileSync(adaptationPath, 'utf8')
        .replace(
          /[\d,]+\s+policy nodes,\s+[\d,]+\s+policy-command edges,\s+[\d,]+\s+policy-type edges,\s+[\d,]+\s+policy-role edges,\s+[\d,]+\s+policy-using edges,\s+[\d,]+\s+policy-with-check edges,\s+[\d,]+\s+privilege nodes,\s+[\d,]+\s+privilege-object nodes,\s+[\d,]+\s+privilege-grant edges,\s+[\d,]+\s+privilege-revoke edges,\s+[\d,]+\s+privilege-object edges,\s+[\d,]+\s+privilege-role nodes,\s+and\s+[\d,]+\s+privilege-role edges/,
          '0 policy nodes, 0 policy-command edges, 0 policy-type edges, 0 policy-role edges, 0 policy-using edges, 0 policy-with-check edges, 0 privilege nodes, 0 privilege-object nodes, 0 privilege-grant edges, 0 privilege-revoke edges, 0 privilege-object edges, 0 privilege-role nodes, and 0 privilege-role edges',
        )
        .replace(
          /[\d,]+\s+policy-command edges,\s+[\d,]+\s+policy-type edges,\s+[\d,]+\s+policy-role edges,\s+[\d,]+\s+policy-using edges,\s+[\d,]+\s+policy-with-check edges,\s+[\d,]+\s+privilege-grant edges,\s+[\d,]+\s+privilege-revoke edges,\s+[\d,]+\s+privilege-object edges,\s+and\s+[\d,]+\s+privilege-role edges/,
          '0 policy-command edges, 0 policy-type edges, 0 policy-role edges, 0 policy-using edges, 0 policy-with-check edges, 0 privilege-grant edges, 0 privilege-revoke edges, 0 privilege-object edges, and 0 privilege-role edges',
        ),
    );

    const result = runSync(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const text = fs.readFileSync(adaptationPath, 'utf8');
    expect(text).toContain(
      '1 policy nodes, 1 policy-command edges, 1 policy-type edges, 1 policy-role edges, 1 policy-using edges, 1 policy-with-check edges, 1 privilege nodes, 1 privilege-object nodes, 1 privilege-grant edges, 1 privilege-revoke edges, 1 privilege-object edges, 1 privilege-role nodes, and 1 privilege-role edges',
    );
    expect(text).toContain(
      '1 policy-command edges, 1 policy-type edges, 1 policy-role edges, 1 policy-using edges, 1 policy-with-check edges, 1 privilege-grant edges, 1 privilege-revoke edges, 1 privilege-object edges, and 1 privilege-role edges',
    );
  });

  it('fails when documented Supabase structured detail counts drift from the overlay', () => {
    const root = makeFixture();
    const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    fs.writeFileSync(
      adaptationPath,
      fs.readFileSync(adaptationPath, 'utf8').replace(
        /Supabase structured detail summary: [^\n]+/,
        'Supabase structured detail summary: 0 edgeFunctionTests, 0 migrationFunctionDetails, 0 migrationTriggers, 0 migrationRlsDetails, 0 migrationTests, and 0 policyDetails.',
      ),
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md edgeFunctionTests expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md migrationFunctionDetails expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md migrationTriggers expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md migrationRlsDetails expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md migrationTests expected 1, found 0');
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md policyDetails expected 1, found 0');
  });

  it('syncs documented Supabase structured detail counts from the overlay baseline', () => {
    const root = makeFixture();
    const adaptationPath = path.join(root, 'docs', 'codegraph-nanoflow-adaptation.md');
    fs.writeFileSync(
      adaptationPath,
      fs.readFileSync(adaptationPath, 'utf8').replace(
        /Supabase structured detail summary: [^\n]+/,
        'Supabase structured detail summary: 0 edgeFunctionTests, 0 migrationFunctionDetails, 0 migrationTriggers, 0 migrationRlsDetails, 0 migrationTests, and 0 policyDetails.',
      ),
    );

    const result = runSync(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.readFileSync(adaptationPath, 'utf8')).toContain(
      'Supabase structured detail summary: 1 edgeFunctionTests, 1 migrationFunctionDetails, 1 migrationTriggers, 1 migrationRlsDetails, 1 migrationTests, and 1 policyDetails.',
    );
  });
});
