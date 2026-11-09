import fs from 'node:fs';
import path from 'node:path';

export interface EdgeFunctionFixtureOverlayOptions {
  files: string[];
  nodes: unknown[];
  edges: unknown[];
}

export function writeEdgeFunctionFixtureOverlay(
  root: string,
  options: EdgeFunctionFixtureOverlayOptions,
): void {
  const overlay = {
    schemaVersion: 1,
    generatedAt: '2026-06-10T00:00:00.000Z',
    project: { root },
    coverageTargets: {},
    typescript: {
      files: options.files,
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
      nodes: options.nodes,
      edges: options.edges,
    },
  };
  const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));
}
