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
});
