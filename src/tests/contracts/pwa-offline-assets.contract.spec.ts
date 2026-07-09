import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface NgswAssetGroup {
  name: string;
  installMode?: string;
  updateMode?: string;
  resources?: {
    files?: string[];
  };
}

interface NgswConfig {
  index?: string;
  navigationPreload?: boolean;
  navigationUrls?: string[];
  assetGroups?: NgswAssetGroup[];
}

function readNgswConfig(): NgswConfig {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'ngsw-config.json'), 'utf8'),
  ) as NgswConfig;
}

function getAssetGroup(config: NgswConfig, name: string): NgswAssetGroup {
  const group = config.assetGroups?.find(candidate => candidate.name === name);
  expect(group, `ngsw asset group "${name}" missing`).toBeDefined();
  return group as NgswAssetGroup;
}

describe('PWA offline app shell contract', () => {
  it('prefetches the app shell resources required for offline reload', () => {
    const config = readNgswConfig();
    const appCore = getAssetGroup(config, 'app-core');

    expect(appCore.installMode).toBe('prefetch');
    expect(appCore.resources?.files).toEqual(expect.arrayContaining([
      '/index.html',
      '/manifest.webmanifest',
      '/*.css',
      '/main*.js',
      '/polyfills*.js',
    ]));
  });

  it('keeps lazy chunks cacheable after a route or feature has been visited once', () => {
    const config = readNgswConfig();
    const appLazy = getAssetGroup(config, 'app-lazy');

    expect(appLazy.installMode).toBe('lazy');
    expect(appLazy.updateMode).toBe('prefetch');
    expect(appLazy.resources?.files).toContain('/chunk*.js');
  });

  it('routes navigations through the cached Angular shell', () => {
    const config = readNgswConfig();

    expect(config.index).toBe('/index.html');
    expect(config.navigationPreload).toBe(false);
    expect(config.navigationUrls).toContain('/**');
  });
});
