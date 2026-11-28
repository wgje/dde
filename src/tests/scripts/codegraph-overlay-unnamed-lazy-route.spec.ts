import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('CodeGraph import-only Angular lazy route', () => {
  it('keeps an unnamed lazy module endpoint without inventing an exported symbol', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-lazy-route-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'src/app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/app/app.routes.ts'),
      "import { Routes } from '@angular/router';\nexport const routes: Routes = [{path:'lazy',loadChildren:()=>import('./lazy.routes')}];\n");
    fs.writeFileSync(path.join(root, 'src/app/lazy.routes.ts'), 'export default [];\n');
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/generate-codegraph-nanoflow-overlay.mjs'), '--root', root, '--stdout'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NANOFLOW_CODEGRAPH_ANDROID_IMPORT_SOURCE_DEFAULT: 'local', NANOFLOW_CODEGRAPH_ANDROID_FUNCTION_SOURCE_DEFAULT: 'local' },
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const overlay = JSON.parse(result.stdout);
    const endpoint = overlay.graph.nodes.find((node: {id: string}) => node.id === 'file:src/app/lazy.routes.ts:src/app/lazy.routes.ts');
    expect(endpoint.metadata).toEqual({ relation: 'route-target', framework: 'angular', path: 'lazy' });
    expect(Object.keys(endpoint.metadata)).toEqual(['relation', 'framework', 'path']);
    expect(overlay.graph.edges).toEqual(expect.arrayContaining([expect.objectContaining({
      source: 'route:src/app/app.routes.ts:lazy', target: endpoint.id,
      metadata: expect.objectContaining({relation: 'route', path: 'lazy'}),
    })]));
  });
});
