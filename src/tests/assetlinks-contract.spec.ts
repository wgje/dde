import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  DEFAULT_RELATIONS,
  buildAssetLinksDocument,
  parseFingerprintList,
  resolveAssetLinksConfig,
  syncAssetLinksFile,
} = require('../../scripts/generate-assetlinks.cjs') as {
  DEFAULT_RELATIONS: string[];
  buildAssetLinksDocument: (config: {
    packageName: string | null;
    fingerprints: string[];
    relations: string[];
  }) => Array<{
    relation: string[];
    target: {
      namespace: string;
      package_name: string;
      sha256_cert_fingerprints: string[];
    };
  }>;
  parseFingerprintList: (raw: string | null | undefined) => string[];
  resolveAssetLinksConfig: (
    env: Record<string, string | undefined>,
    localEnv: Record<string, string | undefined>
  ) => {
    packageName: string | null;
    packageNameRaw: string | null;
    fingerprints: string[];
    fingerprintsRaw: string | null;
    relations: string[];
  };
  syncAssetLinksFile: (
    config: {
      packageName: string | null;
      packageNameRaw?: string | null;
      fingerprints: string[];
      fingerprintsRaw?: string | null;
      relations: string[];
    },
    outputPath: string
  ) => {
    ready: boolean;
    outputPath: string;
    removedStaleFile?: boolean;
    reason?: string;
  };
};

describe('Android assetlinks contract', () => {
  it('should normalize comma-separated certificate fingerprints', () => {
    expect(parseFingerprintList('aa bb cc, 11:22:33')).toEqual([]);
    expect(parseFingerprintList('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')).toEqual([
      '01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF',
    ]);
  });

  it('should resolve config from Android env keys with default relations', () => {
    const config = resolveAssetLinksConfig({
      ANDROID_TWA_PACKAGE_NAME: 'app.nanoflow.twa',
      ANDROID_TWA_SHA256_CERT_FINGERPRINTS: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    }, {});

    expect(config.packageName).toBe('app.nanoflow.twa');
    expect(config.fingerprints).toHaveLength(1);
    expect(config.relations).toEqual(DEFAULT_RELATIONS);
  });

  it('should build Android Digital Asset Links with the approved relations', () => {
    const document = buildAssetLinksDocument({
      packageName: 'app.nanoflow.twa',
      fingerprints: [
        '01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF',
      ],
      relations: DEFAULT_RELATIONS,
    });

    expect(document).toEqual([
      {
        relation: DEFAULT_RELATIONS,
        target: {
          namespace: 'android_app',
          package_name: 'app.nanoflow.twa',
          sha256_cert_fingerprints: [
            '01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF',
          ],
        },
      },
    ]);
  });

  it('should write and then remove stale generated assetlinks files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-assetlinks-'));
    const outputPath = path.join(tempDir, '.well-known', 'assetlinks.json');

    const writeResult = syncAssetLinksFile({
      packageName: 'app.nanoflow.twa',
      packageNameRaw: 'app.nanoflow.twa',
      fingerprints: [
        '01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF',
      ],
      fingerprintsRaw: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      relations: DEFAULT_RELATIONS,
    }, outputPath);

    expect(writeResult.ready).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);

    const deleteResult = syncAssetLinksFile({
      packageName: null,
      packageNameRaw: null,
      fingerprints: [],
      fingerprintsRaw: null,
      relations: DEFAULT_RELATIONS,
    }, outputPath);

    expect(deleteResult.ready).toBe(false);
    expect(deleteResult.removedStaleFile).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(false);
  });
});
