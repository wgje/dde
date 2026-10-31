import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupCodegraphOverlayDocsFixtures,
  makeFixture,
  runValidator,
} from './validate-codegraph-overlay-docs.spec-helpers';
import { registerValidateCodegraphOverlayDocsDedupContractSpecs } from './validate-codegraph-overlay-docs-dedup-contract.spec-helpers';
import { registerValidateCodegraphOverlayDocsDriftCountSpecs } from './validate-codegraph-overlay-docs-drift-counts.spec-helpers';
import { registerValidateCodegraphOverlayDocsIssueRegistrySpecs } from './validate-codegraph-overlay-docs-issue-registry.spec-helpers';
import { registerValidateCodegraphOverlayDocsPackageSpecs } from './validate-codegraph-overlay-docs-package.spec-helpers';
import { registerValidateCodegraphOverlayDocsTailSpecs } from './validate-codegraph-overlay-docs-tail.spec-helpers';

describe('validate-codegraph-overlay-docs', { timeout: 30_000 }, () => {
  afterEach(() => {
    cleanupCodegraphOverlayDocsFixtures();
  });

  registerValidateCodegraphOverlayDocsPackageSpecs();
  registerValidateCodegraphOverlayDocsIssueRegistrySpecs();

  it('passes when AGENTS and adaptation docs match the generated overlay baseline', () => {
    const root = makeFixture();

    const result = runValidator(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('CodeGraph overlay documentation validation passed');
    expect(result.stdout).toContain('graph shape passed');
  });

  it('fails when the overlay graph no longer has native-shaped nodes and closed edges', () => {
    const root = makeFixture();
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8')) as {
      graph: {
        nodes: Array<Record<string, unknown>>;
        edges: Array<Record<string, unknown>>;
      };
    };
    overlay.graph.nodes.push({ ...overlay.graph.nodes[0] });
    overlay.graph.nodes[0].filePath = '../outside.ts';
    overlay.graph.nodes[1].startLine = 0;
    overlay.graph.edges.push({
      source: 'missing:source',
      target: 'missing:target',
      kind: 'nanoflow-only-edge-kind',
      metadata: { relation: 'invalid-fixture-edge' },
    });
    overlay.graph.edges.push({
      source: 'class:src/a.ts:A',
      target: 'class:src/b.ts:B',
      kind: 'references',
      metadata: { relation: 'sql-function' },
    });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('overlay graph has duplicate node id class:src/a.ts:A');
    expect(result.stderr).toContain('overlay graph class:src/a.ts:A has non-project filePath ../outside.ts');
    expect(result.stderr).toContain('overlay graph class:src/b.ts:B has invalid startLine 0');
    expect(result.stderr).toContain('has non-native edge kind nanoflow-only-edge-kind');
    expect(result.stderr).toContain('has missing source endpoint missing:source');
    expect(result.stderr).toContain('relation sql-function must start from a migration file node, found class');
  });

  it('fails closed when migration table relations target a same-named TypeScript member', () => {
    const root = makeFixture();
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8')) as {
      graph: {
        nodes: Array<Record<string, unknown>>;
        edges: Array<Record<string, unknown>>;
      };
    };
    const targetId = 'method:src/app/core/state/stores.ts:TaskStore.tasks';
    overlay.graph.nodes.push({
      ...overlay.graph.nodes[0],
      id: targetId,
      kind: 'method',
      name: 'tasks',
      qualifiedName: 'TaskStore::tasks',
      filePath: 'src/app/core/state/stores.ts',
      language: 'typescript',
      startLine: 43,
      endLine: 43,
      startColumn: 2,
      endColumn: 57,
      metadata: { relation: 'class-member' },
    });
    const migrationFiles = [
      'supabase/migrations/20260126074130_remote_commit.sql',
      'supabase/migrations/20260222000000_add_parking_meta.sql',
      'supabase/migrations/20260317000000_security_grant_tightening.sql',
    ];
    for (const migrationFile of migrationFiles) {
      const migrationName = path.basename(migrationFile);
      const sourceId = `file:${migrationFile}:${migrationName}`;
      overlay.graph.nodes.push({
        ...overlay.graph.nodes[0],
        id: sourceId,
        kind: 'file',
        name: migrationName,
        qualifiedName: migrationName,
        filePath: migrationFile,
        language: 'unknown',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        metadata: { platform: 'supabase-migration' },
      });
      overlay.graph.edges.push({
        source: sourceId,
        target: targetId,
        kind: 'references',
        line: null,
        column: null,
        metadata: { relation: 'table' },
      });
    }
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    for (const migrationFile of migrationFiles) {
      expect(result.stderr).toContain(
        `relation table from ${migrationFile} must target a SQL table node in the same migration`,
      );
    }
  });

  it('fails when project semantic relations or required metadata are not registered', () => {
    const root = makeFixture();
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8')) as {
      graph: {
        edges: Array<Record<string, unknown> & {
          metadata?: Record<string, unknown>;
        }>;
      };
    };
    overlay.graph.edges.push({
      source: 'class:src/a.ts:A',
      target: 'class:src/b.ts:B',
      kind: 'references',
      metadata: { relation: 'supabase-undocumented-fixture' },
    });
    const edgeFunctionHeader = overlay.graph.edges.find(edge => (
      edge.metadata?.relation === 'edge-function-header'
    ));
    if (edgeFunctionHeader?.metadata) {
      delete edgeFunctionHeader.metadata.header;
    }
    const testMappingEdge = overlay.graph.edges.find(edge => edge.metadata?.testMapping === 'path-reference');
    if (testMappingEdge?.metadata) {
      delete testMappingEdge.metadata.matchedNeedle;
    }
    const androidResourceEdge = overlay.graph.edges.find(edge => (
      edge.metadata?.relation === 'android-kotlin-resource-reference'
    ));
    if (androidResourceEdge?.metadata) {
      delete androidResourceEdge.metadata.resourceName;
    }
    const androidIntentDataEdge = overlay.graph.edges.find(edge => (
      edge.metadata?.relation === 'android-manifest-intent-filter-data'
    ));
    if (androidIntentDataEdge?.metadata) {
      delete androidIntentDataEdge.metadata.scheme;
    }
    const envVarEdge = overlay.graph.edges.find(edge => edge.metadata?.relation === 'env-var');
    if (envVarEdge?.metadata) {
      delete envVarEdge.metadata.envVar;
    }
    const riskTagEdge = overlay.graph.edges.find(edge => edge.metadata?.relation === 'risk-tag');
    if (riskTagEdge?.metadata) {
      delete riskTagEdge.metadata.riskTag;
      delete riskTagEdge.metadata.riskSource;
    }
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/testEdgesWithMatchedNeedle=3/g, 'testEdgesWithMatchedNeedle=2')
          .replace(/3 path\/route\/filename-derived edges also render matchedNeedle/g, '2 path/route/filename-derived edges also render matchedNeedle'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('relation supabase-undocumented-fixture is not registered');
    expect(result.stderr).toContain('relation edge-function-header missing metadata.header');
    expect(result.stderr).toContain('relation android-kotlin-resource-reference missing metadata.resourceName');
    expect(result.stderr).toContain('relation android-manifest-intent-filter-data missing one of metadata.scheme, metadata.host, metadata.path, metadata.pathPrefix, metadata.pathPattern, metadata.mimeType, metadata.port');
    expect(result.stderr).toContain('relation env-var missing metadata.envVar');
    expect(result.stderr).toContain('relation risk-tag missing metadata.riskTag');
    expect(result.stderr).toContain('relation risk-tag missing metadata.riskSource');
    expect(result.stderr).toContain('testMapping path-reference missing metadata.matchedNeedle');
  });

  it('fails when Supabase environment and risk-tag coverage drops to zero', () => {
    const root = makeFixture();
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
    const relations = new Set(['env-var', 'risk-tag']);
    overlay.graph.nodes = overlay.graph.nodes.filter((node: { metadata?: { relation?: string } }) => (
      !relations.has(node.metadata?.relation ?? '')
    ));
    overlay.graph.edges = overlay.graph.edges.filter((edge: { metadata?: { relation?: string } }) => (
      !relations.has(edge.metadata?.relation ?? '')
    ));
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'project semantic coverage Supabase Edge Functions requires edgeFunctionEnvVarEdges > 0',
    );
    expect(result.stderr).toContain(
      'project semantic coverage Supabase environment and risk semantics requires supabaseRiskTagEdges > 0',
    );
  });

  it('fails when required project semantic coverage drops to zero without a zero reason', () => {
    const root = makeFixture({ edgeFunctionHeaderEdgesInDocs: 0 });
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8')) as {
      graph: {
        edges: Array<Record<string, unknown> & {
          metadata?: Record<string, unknown>;
        }>;
      };
    };
    overlay.graph.edges = overlay.graph.edges.filter(edge => (
      edge.metadata?.relation !== 'edge-function-header'
    ));
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'project semantic coverage Supabase Edge Functions requires edgeFunctionHeaderEdges > 0',
    );
  });

  it('fails when Android project semantic coverage drops to zero', () => {
    const root = makeFixture();
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
    overlay.android = {
      ...(overlay.android ?? {}),
      kotlinClasses: [],
    };
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'project semantic coverage Android/Kotlin symbols requires androidKotlinClasses > 0',
    );
  });

  it('fails when Android Manifest and Kotlin resource semantic coverage drops to zero', () => {
    const root = makeFixture();
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
    overlay.android = {
      ...(overlay.android ?? {}),
      manifestPermissions: [],
      manifestQueries: [],
      manifestComponents: [],
      kotlinResourceReferences: [],
    };
    const relations = new Set([
      'android-manifest-uses-permission',
      'android-manifest-query',
      'android-manifest-component-permission',
      'android-manifest-intent-filter-action',
      'android-manifest-intent-filter-category',
      'android-manifest-intent-filter-data',
      'android-kotlin-resource-reference',
    ]);
    overlay.graph.edges = overlay.graph.edges.filter((edge: { metadata?: { relation?: string } }) => (
      !relations.has(edge.metadata?.relation ?? '')
    ));
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'project semantic coverage Android Manifest, widgets, and resources requires androidManifestPermissions > 0',
    );
    expect(result.stderr).toContain(
      'project semantic coverage Android Manifest, widgets, and resources requires androidKotlinResourceReferenceEdges > 0',
    );
  });

  it('fails when Context7 project semantic coverage drops to zero', () => {
    const root = makeFixture();
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
    overlay.context7 = {
      ...(overlay.context7 ?? {}),
      sourceMapRoutes: [],
    };
    overlay.graph.edges = overlay.graph.edges.filter((edge: { metadata?: { relation?: string } }) => (
      edge.metadata?.relation !== 'context7-source-map-doc'
    ));
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'project semantic coverage Context7 retrieval and source maps requires context7SourceMapDocEdges > 0',
    );
  });

  it('fails when Angular dependency-injection coverage drops to zero', () => {
    const root = makeFixture();
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8'));
    overlay.angular = {
      ...(overlay.angular ?? {}),
      injectors: [],
    };
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'project semantic coverage Angular declarations and dependency injection requires angularInjectorDependencyReferences > 0',
    );
  });

  it('fails when an unregistered generic graph helper bypasses the de-duplication manifest', () => {
    const root = makeFixture();
    fs.appendFileSync(
      path.join(root, 'scripts', 'generate-codegraph-nanoflow-overlay.mjs'),
      '\nfunction addLocalDeclarationUnregisteredHelper() {}\n',
    );

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('addLocalDeclarationUnregisteredHelper');
    expect(result.stderr).toContain('missing TypeScript de-duplication sourceSymbols or coveredChildSymbols');
  });

  it('fails when Codex config documentation contradicts project-over-user precedence', () => {
    const root = makeFixture();
    const staleContract = [
      'Codex sessions use C:\\Users\\MI\\.codex\\config.toml as the current MCP source.',
      'Active wrapper, CodeGraph target, and MCP environment changes belong in C:\\Users\\MI\\.codex\\config.toml.',
    ].join(' ');
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      fs.appendFileSync(path.join(root, relativePath), `\n${staleContract}\n`);
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('conflicting Codex MCP config scope');
    expect(result.stderr).toContain('D:\\Code\\dde\\.codex\\config.toml');
  });

  it('fails when context-pack source ordering diagnostics are not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/.*sourceOrdering.*\n?/g, ''),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing context-pack sourceOrdering diagnostics');
    expect(result.stderr).toContain('AGENTS.md missing context-pack sourceOrdering diagnostics');
  });

  it('fails when context-pack source section diagnostics are not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/sourceSectionCount/g, 'source-section-count')
          .replace(/duplicateSourceSectionCount/g, 'duplicate-source-section-count')
          .replace(/sourceBlockScore/g, 'source-block-score')
          .replace(/firstSourceBlockIsTopRankedOverlayFile/g, 'first-source-block-is-top-ranked-overlay-file'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing context-pack sourceOrdering diagnostics');
    expect(result.stderr).toContain('sourceSectionCount');
    expect(result.stderr).toContain('duplicateSourceSectionCount');
    expect(result.stderr).toContain('sourceBlockScore');
    expect(result.stderr).toContain('firstSourceBlockIsTopRankedOverlayFile');
    expect(result.stderr).toContain('AGENTS.md missing context-pack sourceOrdering diagnostics');
  });

  it('fails when MCP log guard source-ordering summary diagnostics are not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/.*MCP log guard diagnostics.*\n?/g, '')
          .replace(/.*Stale wrapper handling.*\n?/g, ''),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing MCP log guard diagnostics');
    expect(result.stderr).toContain('wrapperStarts');
    expect(result.stderr).toContain('currentWrapper');
    expect(result.stderr).toContain('currentWrapper.diskScriptSha256');
    expect(result.stderr).toContain('currentWrapper.matchesDisk');
    expect(result.stderr).toContain('currentWrapper.staleAgainstDisk');
    expect(result.stderr).toContain('currentDiskWrapper');
    expect(result.stderr).toContain('currentDiskWrapper.latestRequestKind');
    expect(result.stderr).toContain('currentContextWrapper');
    expect(result.stderr).toContain('currentContextWrapper.diskScriptSha256');
    expect(result.stderr).toContain('currentContextWrapper.matchesDisk');
    expect(result.stderr).toContain('currentContextWrapper.staleAgainstDisk');
    expect(result.stderr).toContain('currentDiskContextWrapper');
    expect(result.stderr).toContain('currentDiskContextWrapper.latestRequestKind');
    expect(result.stderr).toContain('currentContextSourceOrdering');
    expect(result.stderr).toContain('contextSourceOrdering');
    expect(result.stderr).toContain('lowValueVisibleSourceBlocks');
    expect(result.stderr).toContain('lowValueSourcePollution');
    expect(result.stderr).toContain('wrapper.script.stale.continue');
    expect(result.stderr).toContain('AGENTS.md missing MCP log guard diagnostics');
  });

  it('fails when query-path relevance output ordering is not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/.*query-path relevance.*\n?/g, ''),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing query-path relevance contract');
    expect(result.stderr).toContain('AGENTS.md missing query-path relevance contract');
  });

  it('fails when Codex MCP configuration ownership is not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/source=codex/g, 'source=vscode')
          .replace(/C:\\Users\\MI\\.codex\\config\.toml/g, '.vscode/mcp.json')
          .replace(/NANOFLOW_CODEGRAPH_CODEX_CONFIG/g, 'NANOFLOW_CODEGRAPH_VSCODE_CONFIG'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing Codex MCP config contract');
    expect(result.stderr).toContain('AGENTS.md missing Codex MCP config contract');
  });

  it('fails when Codex MCP configuration docs still allow VS Code fallback', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(
            'codegraph:adapter:context, codegraph:mcp:smoke, and codegraph:adapter:doctor do not read or fall back to .vscode/mcp.json',
            'only when no applicable Codex config exists may the adapter fall back to .vscode/mcp.json',
          ),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing Codex MCP config contract');
    expect(result.stderr).toContain('AGENTS.md missing Codex MCP config contract');
  });

  it('fails when Codex MCP configuration docs omit the active .codex repair boundary', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/.*active CodeGraph MCP.*\n?/g, '')
          .replace(/.*edited, repaired, or diagnosed.*\n?/g, ''),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing Codex MCP config contract');
    expect(result.stderr).toContain('AGENTS.md missing Codex MCP config contract');
  });

  it('fails when Codex MCP configuration docs omit required wrapper environment', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS/g, 'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MISSING'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing Codex MCP config contract');
    expect(result.stderr).toContain('AGENTS.md missing Codex MCP config contract');
    expect(result.stderr).toContain('NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS');
  });

  registerValidateCodegraphOverlayDocsDedupContractSpecs();

  it('fails when strict native source evidence quality rules are not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/.*strict native source evidence contract.*\n?/g, ''),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing strict native source evidence contract');
    expect(result.stderr).toContain('AGENTS.md missing strict native source evidence contract');
  });

  it('fails when relation-specific strict native source evidence rules are not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/host-attribute/g, 'host_attr')
          .replace(/edge-function-header/g, 'edge_function_header')
          .replace(/template-url/g, 'template_url')
          .replace(/supabase-realtime-remove-channel/g, 'realtime_remove_channel'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing strict native source evidence contract');
    expect(result.stderr).toContain('host-attribute');
    expect(result.stderr).toContain('edge-function-header');
    expect(result.stderr).toContain('template-url');
    expect(result.stderr).toContain('supabase-realtime-remove-channel');
    expect(result.stderr).toContain('AGENTS.md missing strict native source evidence contract');
  });

  it('fails when strict native output order contracts are not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/strict native output order/g, 'strict-native-output-order')
          .replace(/query\/summary\/entryPoints\/nodes\/edges\/codeBlocks\/relatedFiles\/stats/g, 'native-json-field-list')
          .replace(/Code Context -> Entry Points -> Relationships -> Related Symbols -> Code/g, 'native-markdown-section-list'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing strict native output order contract');
    expect(result.stderr).toContain('query/summary/entryPoints/nodes/edges/codeBlocks/relatedFiles/stats');
    expect(result.stderr).toContain('Code Context -> Entry Points -> Relationships -> Related Symbols -> Code');
    expect(result.stderr).toContain('AGENTS.md missing strict native output order contract');
  });

  it('fails when strict native object projection contracts are not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/strict native object projection/g, 'strict-native-object-projection')
          .replace(/id\/kind\/name\/qualifiedName\/filePath\/language\/startLine\/endLine\/signature\/docstring\/visibility\/isExported\/isAsync\/isStatic\/isAbstract/g, 'native-node-field-list')
          .replace(/source\/target\/kind\/line\/column/g, 'native-edge-field-list')
          .replace(/filePath\/startLine\/endLine\/language\/content\/nodeName\/nodeKind/g, 'native-codeblock-field-list')
          .replace(/metadata\/provenance\/sourceName\/targetName/g, 'native-extension-field-list'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing strict native object projection contract');
    expect(result.stderr).toContain('id/kind/name/qualifiedName/filePath/language/startLine/endLine/signature/docstring/visibility/isExported/isAsync/isStatic/isAbstract');
    expect(result.stderr).toContain('source/target/kind/line/column');
    expect(result.stderr).toContain('filePath/startLine/endLine/language/content/nodeName/nodeKind');
    expect(result.stderr).toContain('metadata/provenance/sourceName/targetName');
    expect(result.stderr).toContain('AGENTS.md missing strict native object projection contract');
  });

  it('fails when the adapter gate infrastructure self-test step is not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8').replace(/codegraph:adapter:infra:test/g, 'codegraph-adapter-infra-test'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing adapter gate contract');
    expect(result.stderr).toContain('codegraph:adapter:infra:test');
    expect(result.stderr).toContain('AGENTS.md missing adapter gate contract');
  });

  it('fails when the adapter gate fresh wrapper log contract is not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/codegraph-adapter-gate-mcp-wrapper\.log/g, 'codegraph-adapter-gate-wrapper-log')
          .replace(/--fail-on-stale-current-wrapper/g, '--fail-on-stale-wrapper'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing adapter gate contract');
    expect(result.stderr).toContain('codegraph-adapter-gate-mcp-wrapper.log');
    expect(result.stderr).toContain('--fail-on-stale-current-wrapper');
    expect(result.stderr).toContain('AGENTS.md missing adapter gate contract');
  });

  it('fails when single shared tree freshness and multi-agent conflict handling is not documented', () => {
    const root = makeFixture();
    for (const relativePath of ['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']) {
      const filePath = path.join(root, relativePath);
      fs.writeFileSync(
        filePath,
        fs.readFileSync(filePath, 'utf8')
          .replace(/single shared tree/g, 'single-shared-tree')
          .replace(/freshness and multi-agent conflict handling/g, 'freshness-and-multi-agent-conflict-handling')
          .replace(/pending index sync/g, 'pending-index-sync')
          .replace(/latest changed files/g, 'latest-changed-files')
          .replace(/git status --short/g, 'git-status-short')
          .replace(/git diff --name-only/g, 'git-diff-name-only')
          .replace(/claim file set/g, 'claim-file-set')
          .replace(/file lease/g, 'file-lease')
          .replace(/skipRefresh=true/g, 'skipRefresh=false')
          .replace(/NANOFLOW_OVERLAY_SKIP_REFRESH=1/g, 'NANOFLOW_OVERLAY_SKIP_REFRESH=0'),
      );
    }

    const result = runValidator(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/codegraph-nanoflow-adaptation.md missing single shared tree freshness contract');
    expect(result.stderr).toContain('single shared tree');
    expect(result.stderr).toContain('freshness and multi-agent conflict handling');
    expect(result.stderr).toContain('pending index sync');
    expect(result.stderr).toContain('latest changed files');
    expect(result.stderr).toContain('git status --short');
    expect(result.stderr).toContain('git diff --name-only');
    expect(result.stderr).toContain('claim file set');
    expect(result.stderr).toContain('file lease');
    expect(result.stderr).toContain('skipRefresh=true');
    expect(result.stderr).toContain('NANOFLOW_OVERLAY_SKIP_REFRESH=1');
    expect(result.stderr).toContain('AGENTS.md missing single shared tree freshness contract');
  });

  registerValidateCodegraphOverlayDocsTailSpecs();
  registerValidateCodegraphOverlayDocsDriftCountSpecs();

});
