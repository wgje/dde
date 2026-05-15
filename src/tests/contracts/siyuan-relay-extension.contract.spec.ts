import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const relayRoot = path.join(root, 'extensions', 'siyuan-relay');
const manifestPath = path.join(relayRoot, 'manifest.json');

interface ExtensionManifest {
  manifest_version?: number;
  background?: {
    service_worker?: string;
  };
  content_scripts?: Array<{
    js?: string[];
  }>;
  options_page?: string;
}

function readManifest(): ExtensionManifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ExtensionManifest;
}

function expectRelayFile(relativePath: string | undefined): void {
  if (!relativePath) {
    throw new Error('manifest must reference a concrete file path');
  }
  expect(fs.existsSync(path.join(relayRoot, relativePath))).toBe(true);
}

describe('SiYuan relay extension contract', () => {
  it('keeps the unpacked extension root loadable by Chrome', () => {
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = readManifest();
    expect(manifest.manifest_version).toBe(3);
    expectRelayFile(manifest.background?.service_worker);
    expectRelayFile(manifest.options_page);

    const contentScripts = manifest.content_scripts ?? [];
    expect(contentScripts.length).toBeGreaterThan(0);
    for (const script of contentScripts) {
      expect(script.js?.length ?? 0).toBeGreaterThan(0);
      for (const jsPath of script.js ?? []) {
        expectRelayFile(jsPath);
      }
    }
  });
});
