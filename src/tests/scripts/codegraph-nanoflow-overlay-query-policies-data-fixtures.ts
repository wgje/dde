import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

type OverlayNode = Record<string, unknown>;
type OverlayEdge = Record<string, unknown>;

interface OverlayGraphFixture {
  nodes: OverlayNode[];
  edges: OverlayEdge[];
}

type MultilinePolicyFixtureContext = Pick<
  CodegraphOverlaySpecContext,
  'tempRoots' | 'writeFile'
>;

interface PolicyFixtureNodes {
  fileNode: OverlayNode;
  usingNode: OverlayNode;
  withCheckNode: OverlayNode;
}

const MULTILINE_POLICY_MIGRATION_FILE =
  'supabase/migrations/20260614020000_multiline_policy.sql';

export function writeOverlayFixture(root: string, graph: OverlayGraphFixture): void {
  const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  fs.writeFileSync(overlayPath, JSON.stringify({
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
    graph,
  }, null, 2));
}

export function makeMultilinePolicyFixture(
  context: MultilinePolicyFixtureContext,
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-policy-markdown-'));
  context.tempRoots.push(root);
  context.writeFile(
    root,
    MULTILINE_POLICY_MIGRATION_FILE,
    createMultilinePolicySql(),
  );
  const nodes = createPolicyFixtureNodes(MULTILINE_POLICY_MIGRATION_FILE);
  writeOverlayFixture(root, {
    nodes: [nodes.fileNode, nodes.usingNode, nodes.withCheckNode],
    edges: createPolicyFixtureEdges(nodes),
  });
  return root;
}

function createMultilinePolicySql(): string {
  return [
    'create policy "tasks read nested"',
    'on public.tasks',
    'for select',
    'to authenticated',
    'using (',
    '  exists (',
    '    select 1',
    '    from public.projects',
    '    where projects.id = tasks.project_id',
    '  )',
    ');',
    'create policy "tasks insert checked"',
    'on public.tasks',
    'for insert',
    'with check (',
    '  content is not null',
    '  and exists (',
    '    select 1',
    '    from public.projects',
    '    where projects.id = tasks.project_id',
    '  )',
    ');',
    '',
  ].join('\n');
}

function createPolicyFixtureNodes(migrationFile: string): PolicyFixtureNodes {
  const fileNode = {
    id: `file:${migrationFile}:20260614020000_multiline_policy.sql`,
    kind: 'file',
    name: '20260614020000_multiline_policy.sql',
    qualifiedName: migrationFile,
    filePath: migrationFile,
    language: 'unknown',
    startLine: 1,
    endLine: 22,
  };
  const usingNode = {
    id: `variable:${migrationFile}:tasks read nested`,
    kind: 'variable',
    name: 'tasks read nested',
    qualifiedName: 'tasks read nested',
    filePath: migrationFile,
    language: 'unknown',
    startLine: 1,
    endLine: 1,
    signature: 'policy tasks read nested',
    metadata: {
      relation: 'policy',
      table: 'public.tasks',
    },
  };
  const withCheckNode = {
    id: `variable:${migrationFile}:tasks insert checked`,
    kind: 'variable',
    name: 'tasks insert checked',
    qualifiedName: 'tasks insert checked',
    filePath: migrationFile,
    language: 'unknown',
    startLine: 12,
    endLine: 12,
    signature: 'policy tasks insert checked',
    metadata: {
      relation: 'policy',
      table: 'public.tasks',
    },
  };
  return { fileNode, usingNode, withCheckNode };
}

function createPolicyFixtureEdges(nodes: PolicyFixtureNodes): OverlayEdge[] {
  return [
    {
      source: nodes.fileNode.id,
      target: nodes.usingNode.id,
      kind: 'references',
      line: 5,
      column: 0,
      metadata: {
        relation: 'policy-using',
        policy: 'tasks read nested',
        table: 'public.tasks',
      },
    },
    {
      source: nodes.fileNode.id,
      target: nodes.withCheckNode.id,
      kind: 'references',
      line: 15,
      column: 0,
      metadata: {
        relation: 'policy-with-check',
        policy: 'tasks insert checked',
        table: 'public.tasks',
      },
    },
  ];
}
