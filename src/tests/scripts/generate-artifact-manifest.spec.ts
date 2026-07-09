import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const sourceScriptPath = path.join(repoRoot, 'scripts', 'generate-artifact-manifest.cjs');
const tempRoots: string[] = [];

function writeChunk(dist: string, name: string, content: string): number {
  const filePath = path.join(dist, name);
  fs.writeFileSync(filePath, content);
  return fs.statSync(filePath).size;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

describe('generate-artifact-manifest', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses stats inputs for GoJS and Flow chunk bytes without counting sync chunks that mention gojs-node anchors', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-artifact-manifest-'));
    tempRoots.push(root);
    const scriptsDir = path.join(root, 'scripts');
    const dist = path.join(root, 'dist', 'browser');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(dist, { recursive: true });
    fs.copyFileSync(sourceScriptPath, path.join(scriptsDir, 'generate-artifact-manifest.cjs'));

    const gojsBytes = writeChunk(dist, 'chunk-GOJS.js', '/* gojs runtime */\n'.repeat(10));
    const flowBytes = writeChunk(dist, 'chunk-FLOW.js', 'console.log("feature chunk");\n'.repeat(10));
    writeChunk(dist, 'chunk-SYNC.js', 'const anchor = "gojs-node";\n'.repeat(20));
    writeChunk(dist, 'main-APP.js', 'console.log("main");\n');
    writeJson(path.join(root, 'dist', 'stats.json'), {
      outputs: {
        'chunk-GOJS.js': {
          bytes: gojsBytes,
          inputs: {
            'node_modules/gojs/release/go.mjs': { bytesInOutput: gojsBytes },
          },
        },
        'chunk-FLOW.js': {
          bytes: flowBytes,
          inputs: {
            'src/app/features/flow/components/flow-view.component.ts': { bytesInOutput: flowBytes },
          },
        },
        'chunk-SYNC.js': {
          bytes: 560,
          inputs: {
            'src/services/sync-anchor-normalizer.ts': { bytesInOutput: 560 },
          },
        },
      },
    });

    const result = spawnSync(process.execPath, [path.join(scriptsDir, 'generate-artifact-manifest.cjs')], {
      cwd: root,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'artifact-manifest.json'), 'utf-8'));
    expect(manifest.metrics.gojsFlowChunkBytes).toBe(gojsBytes + flowBytes);
  });
});
