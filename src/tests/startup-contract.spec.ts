import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('startup launch contract', () => {
  it('ngsw-config app-core resources should explicitly cache polyfills entry chunks', () => {
    const ngswConfigPath = path.join(process.cwd(), 'ngsw-config.json');
    const ngswConfig = JSON.parse(fs.readFileSync(ngswConfigPath, 'utf8'));
    const appCore = ngswConfig.assetGroups.find((group: { name: string }) => group.name === 'app-core');

    expect(appCore?.resources?.files).toContain('/polyfills*.js');
  });

  it('ngsw-config app-core resources should keep launch.html as legacy compatibility shell', () => {
    const ngswConfigPath = path.join(process.cwd(), 'ngsw-config.json');
    const ngswConfig = JSON.parse(fs.readFileSync(ngswConfigPath, 'utf8'));
    const appCore = ngswConfig.assetGroups.find((group: { name: string }) => group.name === 'app-core');

    expect(appCore?.resources?.files).toContain('/launch.html');
  });

  it('ngsw-config should not proxy Supabase REST and RPC requests through dataGroups', () => {
    const ngswConfigPath = path.join(process.cwd(), 'ngsw-config.json');
    const ngswConfig = JSON.parse(fs.readFileSync(ngswConfigPath, 'utf8'));
    const dataGroups = Array.isArray(ngswConfig.dataGroups) ? ngswConfig.dataGroups : [];
    const urls = dataGroups.flatMap((group: { urls?: string[] }) => group.urls ?? []);

    expect(urls).not.toContain('https://*.supabase.co/rest/v1/*');
    expect(urls).not.toContain('https://*.supabase.co/rest/v1/rpc/*');
    expect(urls).not.toContain('https://*.supabase.co/rpc/v1/*');
  });

  it('manifest start_url should point to root startup path instead of launch.html', () => {
    const manifestPath = path.join(process.cwd(), 'public', 'manifest.webmanifest');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest.start_url).toBe('./');
  });
});
